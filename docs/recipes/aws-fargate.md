# Recipe: a Clodex node on AWS Fargate

The node contract (docs/deployment-plan.md): the published image is
self-configuring — `ghcr.io/avirtual/clodex:<version>` boots
`headless-main.js` with the peer wire enabled on port 7900. Fargate deployment
is therefore *a task definition and nothing else*. Clodex contains zero AWS
code; everything below is standard ECS/SSM tooling you already run.

Audience: an operator with an AWS account, the `aws` CLI, and `clodexctl`.
Every step is copy-paste; replace the ALL-CAPS placeholders.

## 1. Secrets (once per engagement)

Two independent credentials — mint both in Secrets Manager:

```sh
aws secretsmanager create-secret --name clodex/node/wire-token \
  --secret-string "$(openssl rand -hex 24)"
# Model credential — EITHER a Claude token (from `claude setup-token`):
aws secretsmanager create-secret --name clodex/node/oauth-token \
  --secret-string "<paste the setup-token output>"
# OR skip this secret entirely and use Bedrock via the task role (§4).
```

## 2. Task definition

`clodex-node.task.json` (register with
`aws ecs register-task-definition --cli-input-json file://clodex-node.task.json`):

```json
{
  "family": "clodex-node",
  "requiresCompatibilities": ["FARGATE"],
  "networkMode": "awsvpc",
  "cpu": "1024",
  "memory": "4096",
  "runtimePlatform": { "cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX" },
  "executionRoleArn": "arn:aws:iam::ACCOUNT:role/clodexNodeExecutionRole",
  "taskRoleArn": "arn:aws:iam::ACCOUNT:role/clodexNodeTaskRole",
  "containerDefinitions": [{
    "name": "clodex",
    "image": "ghcr.io/avirtual/clodex:VERSION",
    "portMappings": [{ "containerPort": 7900, "protocol": "tcp" }],
    "environment": [
      { "name": "CLODEX_DATA_DIR", "value": "/data" }
    ],
    "secrets": [
      { "name": "CLODEX_REMOTE_TOKEN",     "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:clodex/node/wire-token" },
      { "name": "CLAUDE_CODE_OAUTH_TOKEN", "valueFrom": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:clodex/node/oauth-token" }
    ],
    "linuxParameters": { "initProcessEnabled": true },
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": { "awslogs-group": "/clodex/node", "awslogs-region": "REGION", "awslogs-stream-prefix": "clodex" }
    }
  }]
}
```

Notes:
- The image already sets `CLODEX_REMOTE_ENABLE=1` / `CLODEX_REMOTE_HOST=0.0.0.0`
  — the wire is token-gated by `CLODEX_REMOTE_TOKEN`, so a non-loopback bind
  inside the task's own netns is safe *provided you do NOT open 7900 in the
  security group* (you won't — access is via SSM, §3).
- `initProcessEnabled` matters: agents spawn PTYs and child processes; an init
  reaps them.
- Ephemeral storage is fine to start; sessions die with the task. For durable
  session state attach EFS at `/data`.
- The execution role needs `secretsmanager:GetSecretValue` on the two secrets;
  the task role needs `ssmmessages:*` (for ECS Exec) — and Bedrock invoke
  permissions if you use §4.

## 3. Run it and reach it (no inbound network at all)

```sh
aws ecs run-task --cluster CLUSTER --launch-type FARGATE \
  --task-definition clodex-node --enable-execute-command \
  --network-configuration 'awsvpcConfiguration={subnets=[SUBNET],securityGroups=[SG],assignPublicIp=ENABLED}'
```

`--enable-execute-command` puts the SSM agent in the task — that is the whole
reachability story: no public port, no ALB, no sshd. The security group can be
fully closed inbound.

Register a context once with the typed `--ssm-ecs` kind — no task-id copy-paste:

```sh
clodexctl ctx add fargate --ssm-ecs CLUSTER/clodex-node --token <wire-token from §1>
#   [--region R] [--profile P] if not your default aws config

clodexctl --ctx fargate ctx test    # opens the SSM tunnel, verifies hello
```

`--ssm-ecs CLUSTER/FAMILY` **resolves the running task at connect time** — the
context stores the cluster/family (stable), and each open does the
`aws ecs list-tasks` → `describe-tasks` lookup to find the current task's SSM
target. That's the whole reason for derive-at-open: a Fargate task id is
ephemeral, so a stored `ecs:CLUSTER_<taskId>_<runtimeId>` target goes stale on
every redeploy. The typed kind is also **data** — safe to `ctx import` or commit
to a shared team file, unlike a raw `--tunnel` argv.

<details><summary>What <code>--ssm-ecs</code> expands to (the raw form)</summary>

```sh
# The equivalent explicit tunnel, if you ever need to hand-build it — you must
# re-derive TASK_ID/RUNTIME_ID after every redeploy, which --ssm-ecs does for you:
TASK_ID=$(aws ecs list-tasks --cluster CLUSTER --family clodex-node --query 'taskArns[0]' --output text | awk -F/ '{print $NF}')
RUNTIME_ID=$(aws ecs describe-tasks --cluster CLUSTER --tasks $TASK_ID \
  --query 'tasks[0].containers[0].runtimeId' --output text)

clodexctl ctx add fargate --token <wire-token> --tunnel \
  aws ssm start-session --target ecs:CLUSTER_${TASK_ID}_${RUNTIME_ID} \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["7900"],"localPortNumber":["{port}"]}'
```
</details>

From here it's the normal surface: `spawn`, `run`, `logs`, `sessions`.
Support boundary (docs/client-story.md): clodexctl substitutes `{port}`,
waits for the port, relays `aws`'s own stderr verbatim on failure —
`ctx test --verbose` is the diagnosis surface; the SSM plugin's errors are
AWS's, not ours.

## 4. Bedrock variant (no Anthropic secret on the node)

For engagements where the model credential must be the customer's cloud
account: drop the `oauth-token` secret, give the *task role* Bedrock invoke
permissions, and add to `environment`:

```json
{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" },
{ "name": "AWS_REGION", "value": "REGION" }
```

Claude Code inside the node then signs requests with the task role — no
long-lived model secret exists anywhere.

## 5. Teardown

`aws ecs stop-task` — the node is disposable by design. Per-engagement
task + per-engagement secrets, deleted after. The node is a trust boundary
(deployment-plan §threat): anyone who can command a shell-capable agent can
read the node's env, so scope credentials to what that engagement may touch.
