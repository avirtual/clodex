# Recipe: a Clodex node on an EC2 instance (or any customer VM)

The simplest cloud path — a VM is just "a machine we can connect to", and
clodexctl already automates that end-to-end. Two flavors depending on what
the customer allows.

## Flavor A: ssh reachable (bastion/VPN/direct)

One command — `clodexctl deploy` drives the same idempotent installer the
desktop app's add-peer wizard uses (git clone → npm install → systemd --user
service on 127.0.0.1:7900), verifies the wire answers, and registers a
context:

```sh
clodexctl deploy ubuntu@ec2-host          # re-running IS the update path
clodexctl --ctx ec2-host spawn worker --type claude --cwd /srv/work
clodexctl --ctx ec2-host run worker "…"
```

Jump hosts, ProxyCommand, non-standard ports: all of it comes free because
clodexctl shells out to *your* ssh — whatever `ssh ubuntu@ec2-host` does on
your machine, deploy does. If the installer needs root for missing OS deps
it stops and prints the exact sudo commands rather than guessing (exit 42).

Credential seeding (the installer does not handle model credentials): put
`CLAUDE_CODE_OAUTH_TOKEN` in the service environment, e.g.
`systemctl --user edit clodex` → `[Service] Environment=CLAUDE_CODE_OAUTH_TOKEN=…`,
or use an instance role + `CLAUDE_CODE_USE_BEDROCK=1` for the
no-secret-on-box variant (see the Fargate recipe §4 — identical here).

No wire token needed in this flavor: the node binds loopback and the ssh
tunnel is the auth boundary (same posture as the GUI's peers).

## Flavor B: no ssh allowed — SSM-managed instance

Many customer environments close port 22 entirely and mandate Session
Manager. `clodexctl deploy ssm` automates the whole thing over SSM RunCommand —
no ssh, nothing open inbound, and the node is the **same OS-flavor install** the
ssh flavor produces (a dedicated `clodex` host user + systemd --user service, not
a container):

```sh
clodexctl deploy ssm ec2ssm --target i-INSTANCE --region us-west-2 --profile prod
#   [--branch B] [--repo URL] [--port N] [--no-ctx] [--force] [--dry-run] [--json]

clodexctl --ctx ec2ssm sessions      # ready — the deploy saved the context
```

It mints a wire token, preflights the instance (registered + `Online`), sends
one **root** `AWS-RunShellScript` that installs prereqs (incl. node ≥ 20), mints
the `clodex` user, runs the pinned installer as that user (`sudo -iu clodex bash
-s`), injects the token into the service env, and does an on-box hello check —
polling to completion (10 min budget) with the `::` marker trail
**pseudo-streamed** as it grows. Then it verifies from your laptop **through the
real SSM port-forward** and saves a typed `{ssm, token}` context. Re-running is
the update path (every step is idempotent).

> **Token visibility.** The wire token rides inside the `send-command`
> parameters → visible in the account's SSM command history / CloudTrail to
> anyone with `ssm:GetCommandInvocation`. Acceptable **because the port never
> leaves the instance's loopback** (reaching the wire needs `ssm:StartSession`
> on the same account); **re-run `deploy ssm` to rotate** the token. Model
> credentials go on the instance role (Bedrock, Fargate recipe §4) or seeded on
> the box — never through `send-command`.

**SSM: what works, what's limited.** Two channels, very different constraints:

| Channel | What it is | Limits |
|---|---|---|
| **Runtime tunnel** (`--ssm` transport: sessions, `send`, `run`, `logs -f`, `attach`) | `aws ssm start-session` port-forward to the box's loopback | **None** — full wire parity, verified live; a normal Clodex peer over the tunnel |
| **Deploy channel** (`deploy ssm` → RunCommand) | one async `AWS-RunShellScript`, polled | no live stdin/stdout → marker **trail at the end** (+ full log at `/home/clodex/clodex-deploy.log`); **24 KB** output cap; **async poll** (10 min budget); token **visible in SSM history** → loopback-only + re-run to rotate |

So the *limits are the deploy step's*, not the running node's — once deployed,
the `--ssm` context behaves exactly like an `--ssh` one.

<details><summary>The appliance variant (run the container yourself)</summary>

If you specifically want a **container** node instead of the OS install, run it
yourself over a Session Manager shell and point a typed context at its loopback:

```sh
aws ssm start-session --target i-INSTANCE
$ docker run -d --name clodex-ec2ssm --restart unless-stopped \
    -p 127.0.0.1:7900:7900 -v clodex-ec2ssm-data:/data \
    -e CLODEX_REMOTE_TOKEN=<minted> ghcr.io/avirtual/clodex:VERSION
```

Then reach it with the typed `--ssm` transport (the same context `deploy ssm`
saves):

```sh
clodexctl ctx add ec2ssm --ssm i-INSTANCE --token <wire-token>   # [--region R] [--profile P]
clodexctl --ctx ec2ssm ctx test
```

`--ssm i-INSTANCE` expands to `aws ssm start-session --target i-INSTANCE
--document-name AWS-StartPortForwardingSession --parameters {…}`. The typed kind
is **data** (safe to `ctx import`/share); the raw `--tunnel aws ssm
start-session …` form still works if you need to customize the argv.
</details>

**ssh-flavor over SSM (the ProxyCommand bridge).** `deploy ssm` already gives you
the git-clone installer, so you rarely need this — but if you want plain `deploy
<user@host>` to reach an SSM-only box directly (e.g. an ssh key already exists on
it), bridge ssh through SSM: add to `~/.ssh/config` a
`ProxyCommand sh -c "aws ssm start-session --target %h --document-name
AWS-StartSSHSession --parameters portNumber=%p"` for the instance id as the
host, then run `clodexctl deploy i-INSTANCE`. (SSM must permit
`AWS-StartSSHSession` and the box must run sshd on loopback.)

The instance role needs the standard `AmazonSSMManagedInstanceCore` policy;
nothing is open inbound. All auditing lands in the customer's own
CloudTrail/SSM session logs — usually a selling point in an engagement.

## Which flavor?

| Customer says | Use |
|---|---|
| "here's ssh access" | Flavor A — one `clodexctl deploy` |
| "SSM only, port 22 closed" | Flavor B |
| "we don't give VMs, only tasks" | the Fargate recipe |
| "we run everything in EKS/k8s" | the k8s recipe |
