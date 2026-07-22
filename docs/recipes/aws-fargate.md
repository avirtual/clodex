# Recipe: a Clodex node on AWS Fargate

The node contract (docs/deployment-plan.md): the published image is
self-configuring — `ghcr.io/avirtual/clodex:<version>` boots
`headless-main.js` with the peer wire enabled on port 7900. Fargate deployment
is therefore *a task definition and nothing else*. Clodex contains zero AWS
code; everything below is standard ECS/SSM tooling you already run.

Audience: an operator with an AWS account, the `aws` CLI, and `clodexctl`.
Every step is copy-paste; replace the ALL-CAPS placeholders.

> **Prefer the CloudFormation template.** `cli/deploy/clodex-fargate.yaml` builds
> everything below — cluster, roles, the wire-token secret, log group, task
> definition, optional self-healing Service, and an operator IAM policy — as one
> reviewable, Delete-clean stack. Its parameters are `ImageUri` (tag OR digest;
> mirror-and-pin into your own ECR for a real engagement), `AssignPublicIp`
> (ENABLED for public-subnet/no-NAT, DISABLED for private subnets), `UseBedrock`
> (§4), `DisableWirescope` (opt the node out of the wirescope proxy —
> Bedrock nodes auto-disable it anyway), `Cpu`/`Memory` (validated Fargate
> pairings), `Persistent` (§3),
> `SubnetIds`, `SecurityGroupId`, `ClusterName`. It mints the wire token itself
> and outputs the exact `ctx add`, `run-task`, and `put-secret-value` commands.
> The manual walkthrough below is the same shape, spelled out.

## 0. One command (`clodexctl deploy fargate`)

`clodexctl` drives the whole template for you — `aws cloudformation deploy` of
`cli/deploy/clodex-fargate.yaml`, populate the model credential, read the
stack's self-minted wire token, save a ready-to-use context, and verify the
node over the SSM tunnel:

```sh
clodexctl deploy fargate clodex-node \
  --token-file ./claude-token          # from `claude setup-token`; omit for Bedrock (--use-bedrock)
# then:
clodexctl --ctx clodex-node sessions   # the saved context is ready
```

No `--subnets` / `--security-group`? They're **auto-detected from the account's
default VPC** — the common first-run case, no console archaeology. When either
flag is omitted, `clodexctl` resolves it read-only (`aws ec2 describe-vpcs`
filtered to the default VPC, then its `default-for-az` subnets / `default`
security group) and prints exactly what it detected before deploying. It never
guesses among non-default VPCs — no default VPC in the region and it stops,
telling you to pass both flags explicitly. Because auto-detected default-VPC
subnets are public, `--assign-public-ip` defaults to `ENABLED` in that case (the
task needs egress to pull its image; DISABLED there would hang the pull). If the
detected default SG has any inbound rules, it prints a loud WARNING (the node
needs no inbound) but proceeds. An **explicit flag always wins** — pass
`--subnets`/`--security-group`/`--assign-public-ip` for private subnets or a
locked-down SG, and no detection runs for the flag you gave.

What it does, and the discipline it keeps:

- **`aws cloudformation deploy`** creates OR idempotently updates the stack
  (`--no-fail-on-empty-changeset`), so a re-run is the update path. `ClusterName`
  defaults to the stack name (two stacks never collide on the template's
  `clodex` default). Pass any template parameter through with `--param KEY=VALUE`
  (e.g. `--param Cpu=2048 --param Memory=8192`), and networking with
  `--assign-public-ip`, `--subnets`, `--security-group`. When the same key
  appears twice (e.g. your `--param ClusterName=x` after the verb's own
  default), CloudFormation's last-value-wins ordering applies — your `--param`
  trails the verb-emitted keys, so it wins.
- **No secret value ever rides argv.** The wire token is the stack's — read
  into memory for the context entry only, never printed, never rotated on a
  re-run. `--token-file` (or `CLODEX_CLAUDE_TOKEN_FILE`) rides `file://` into
  `put-secret-value`, so only the *path* crosses argv; `--use-bedrock` skips the
  oauth secret entirely.
- **Region is resolved and recorded.** With `--region` given it behaves as
  before (used, printed, pinned). Without it, `clodexctl` mirrors the aws CLI's
  own precedence — `AWS_REGION`/`AWS_DEFAULT_REGION` env first, then the
  profile's config (`aws configure get region`, profile-aware) — and prints the
  result on
  the `identity:` line so a wrong-region deploy is caught before it lands, then
  **pins that region into the saved context** so future connects don't depend on
  the same implicit resolution staying stable. If nothing resolves it warns
  loudly (the stack still goes wherever AWS defaults — pass `--region`). This is
  observe-and-record only; it never changes which region the deploy uses.
- **The saved context knows the web port.** The entry pins `webPort: 8080` (the
  image's fixed web-GUI port), so `clodexctl web <ctx>` tunnels to the right
  place — the SSM tunnel reaches any in-task port.
- **`--persistent` (default `true`)** adds the self-healing ECS Service and
  verifies the node end-to-end over the real SSM tunnel. `--persistent false` is
  the disposable, infra-only shape: it prints the `run-task` command and skips
  verify (nothing is running yet).
- **`--dry-run`** prints every `aws` argv (with a `file://` placeholder for the
  token) and runs nothing; **`--json`** emits one NDJSON object per step.

The manual walkthrough below is the same stack spelled out by hand — the
review-posture alternative, and the reference for what the one command
automates.

## 1. Secrets (once per engagement)

Two independent credentials — mint both in Secrets Manager:

```sh
aws secretsmanager create-secret --name clodex/node/wire-token \
  --secret-string "$(openssl rand -hex 24)"
# Model credential — a Claude token (from `claude setup-token`). Create it with a
# placeholder, then PUT the real value (same flow the template's PutTokenCommand
# output prints):
aws secretsmanager create-secret --name clodex/node/oauth-token \
  --secret-string "REPLACE-ME"
aws secretsmanager put-secret-value --secret-id clodex/node/oauth-token \
  --secret-string "$(cat TOKEN-FILE)"   # TOKEN-FILE = your `claude setup-token` output
# A running task must be (re)started to pick up a new value.
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
- The execution role needs `secretsmanager:GetSecretValue` on the secret(s) it
  injects (wire token always; oauth token unless §4); the task role needs
  `ssmmessages:*` (for ECS Exec) — and Bedrock invoke permissions if you use §4.
- A container `healthCheck` (the template ships one) can curl the node's own
  `http://127.0.0.1:7900/api/peer/hello` — a token-gated wire answers 401 and an
  ungated one 200, so treat **either** as alive; a wedged engine that answers
  neither gets the task replaced by the Service.

## 3. Run it and reach it (no inbound network at all)

```sh
aws ecs run-task --cluster CLUSTER --launch-type FARGATE \
  --task-definition clodex-node --enable-execute-command \
  --network-configuration 'awsvpcConfiguration={subnets=[SUBNET],securityGroups=[SG],assignPublicIp=ENABLED}'
```

`--enable-execute-command` puts the SSM agent in the task — that is the whole
reachability story: no public port, no ALB, no sshd. The security group can be
fully closed inbound.

`assignPublicIp=ENABLED` is **required** in a public subnet with no NAT: the
task pulls its image and reaches the model API + SSM/logs/Secrets Manager over
egress, and without a public IP that egress has no path. In a private subnet
with a NAT gateway or VPC endpoints, use `DISABLED`. The outbound the task needs
(inbound: none) is `ghcr.io` (or your ECR mirror), `api.anthropic.com` (or
`bedrock-runtime.<region>` for §4), `ssmmessages.<region>`, `logs.<region>`,
and `secretsmanager.<region>` — allowlist exactly these on a locked-down egress.

> **The real access boundary is IAM, not the wire token.** Anyone with
> `ecs:ExecuteCommand` on the cluster gets a root shell in the task and can read
> both secrets out of the environment — the wire token is defense-in-depth on top
> of that. The template ships an `OperatorPolicy` managed policy granting exactly
> what `clodexctl --ssm-ecs` needs (list/describe the task, `ssm:StartSession` to
> this cluster's task targets + the port-forward document, and `GetSecretValue`
> on the wire token only) — and deliberately NOT `ecs:ExecuteCommand`. Grant exec
> separately and knowingly.

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
account: drop the `oauth-token` secret entirely, give the *task role* Bedrock
invoke permissions (`bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`
— Resource `*`, since foundation models aren't stack-scoped; narrow to specific
model ARNs if you like), and add to `environment`:

```json
{ "name": "CLAUDE_CODE_USE_BEDROCK", "value": "1" },
{ "name": "AWS_REGION", "value": "REGION" }
```

Claude Code inside the node then signs requests with the task role — with
Bedrock there is **no long-lived model credential anywhere in the account**.

In the CloudFormation template this is the single parameter `UseBedrock=true`:
it conditions the oauth-token secret off (not created, not injected), turns the
two env vars on, and adds the Bedrock statement to the task role. The Bedrock
env also auto-disables the wirescope proxy in the engine (Bedrock traffic
bypasses it — the tee would see no bytes); to turn wirescope off on a
non-Bedrock node, set the template's `DisableWirescope=true` parameter
(`CLODEX_WIRESCOPE=off` in the container env).

## 5. Teardown

`aws ecs stop-task` — the node is disposable by design. Per-engagement
task + per-engagement secrets, deleted after. The node is a trust boundary
(deployment-plan §threat): anyone who can command a shell-capable agent can
read the node's env, so scope credentials to what that engagement may touch.
