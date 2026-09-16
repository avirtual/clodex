# How to: run, build and drive Clodex

Task-oriented recipes for the command line. The README pitches the product and
`docs/recipes/` goes deep on one platform each; this page answers "I have the
repo or the DMG — how do I do X?" Replace ALL-CAPS placeholders; every command
here is one the source actually runs.

## Run the desktop app

**From a release DMG.** The builds are unsigned, so Gatekeeper refuses a
double-click the first time. Right-click the app in `/Applications` and choose
**Open**, or clear the quarantine attribute:

```sh
xattr -cr /Applications/Clodex.app
```

**From source.** Apple Silicon or Intel Mac, Node 20+. `electron-rebuild` is
not optional: node-pty is native and must match Electron's ABI.

```sh
git clone https://github.com/avirtual/clodex
cd clodex
npm install            # postinstall renames dev Electron.app to Clodex
npx electron-rebuild   # rebuild node-pty against Electron's ABI
npm start              # dev mode
```

`npm run dev` is the same thing with `CLODEX_DEV=1`.

## Build the DMG

When you want an installable artifact from your own tree — an Intel build, a
patched build, or a bisect:

```sh
npm run dist:mac       # electron-builder --mac --arm64 → dist/
```

Releases on the repo are cut by the maintainer's `scripts/release.sh` (the
`npm run release` script), which tags, builds and publishes. That is not a user
step: to run Clodex from source you want `npm start`, and to ship it to a
server you want a headless node.

## Run a headless node locally

The engine runs under plain Node with no Electron, no Xvfb and no GUI
libraries — this is what a Linux server runs. The entry point is
`headless-main.js`, launched directly; there is no npm script for it, and it
takes **no CLI flags at all**. Everything is environment:

```sh
export CLODEX_HOME=~/clodex-a          # registry root (default ~/.clodex)
export CLODEX_DATA_DIR=~/clodex-a/data # persistence dir (sessions.json + stores)
export CLODEX_LABEL=box-a              # the name peers see
export CLODEX_WEB_PORT=8080            # unset ⇒ no browser GUI at all
export CLODEX_WEB_HOST=127.0.0.1       # unset ⇒ all interfaces
export CLODEX_REMOTE_ENABLE=1          # bring the peer wire up
export CLODEX_REMOTE_PORT=7900         # wire port (default 7900)
export CLODEX_REMOTE_TOKEN=$(openssl rand -hex 16)
node headless-main.js
```

**Not from your Electron dev checkout.** That tree's node-pty is built against
Electron's ABI, so `node headless-main.js` there fails to load it. Use a
separate clone with a plain `npm install` (which builds node-pty against
Node's ABI) — never `npx electron-rebuild` on the headless clone.

The full environment table, including `CLODEX_WEB_TOKEN`,
`CLODEX_WORKSPACES`, `CLODEX_REMOTE_HOST` and `CLODEX_WIRESCOPE_PORT`, is in
[`docs/recipes/two-instances.md`](recipes/two-instances.md).

As a service, the shape the installer writes is
`ExecStart=/usr/bin/env node headless-main.js` with `CLODEX_SUPERVISED=1`
(see [`peering/clodex.service`](../peering/clodex.service)); `clodexctl deploy`
installs it for you.

## Run a node in Docker

The published image is self-configuring: `ghcr.io/avirtual/clodex:latest` boots
`headless-main.js` with the peer wire on 7900, the web GUI on 8080 and the data
dir at `/data`. A plain `docker run` — the shape `clodexctl` itself generates:

```sh
docker run -d --name clodexctl-edge --hostname edge \
  --restart unless-stopped \
  -p 127.0.0.1:7900:7900 \
  -v clodexctl-edge-data:/data \
  --env-file ./auth.env \
  ghcr.io/avirtual/clodex:latest
```

The wire port binds loopback only; reach it over a tunnel. Secrets
(`CLODEX_REMOTE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) go in the env-file, never on
the command line. The one-command form does all of the above, mints the wire
token and saves a context:

```sh
clodexctl deploy node edge --docker [--tag TAG] [--env-file ./auth.env] [--volume V]
clodexctl deploy node edge --docker --host ssh://user@box   # run it on a remote daemon
```

## Deploy to a server, Kubernetes or Fargate

**A VM you can ssh to.** Drives the idempotent installer over ssh — git clone,
prod-only `npm ci`, the headless engine as a systemd `--user` service on
127.0.0.1:7900 — then verifies the wire and saves a context. Re-running is the
update path.

```sh
clodexctl deploy node ec2box --ssh ubuntu@ec2-host --claude-token-file ./token
```

**A VM with no ssh (AWS SSM).** The same OS-flavor install over SSM
RunCommand — nothing open inbound.

```sh
clodexctl deploy node ec2ssm --ssm i-INSTANCE --region us-west-2 --profile prod
```

Depth for both: [`docs/recipes/aws-ec2.md`](recipes/aws-ec2.md).

**Kubernetes.** `helm upgrade --install` of the packaged chart
(`cli/deploy/helm/clodex`), verified through a real `kubectl port-forward`.

```sh
clodexctl deploy node mynode --helm --namespace clodex --claude-token-file ./token
```

Depth, and the manual manifest path: [`docs/recipes/kubernetes.md`](recipes/kubernetes.md).

**AWS Fargate.** `aws cloudformation deploy` of the packaged
`cli/deploy/clodex-fargate.yaml` — cluster, roles, wire-token secret, task
definition and an optional Service, as one Delete-clean stack.

```sh
clodexctl deploy node clodex-node --fargate \
  --subnets subnet-a,subnet-b --security-group sg-x --token-file ./token
```

Depth: [`docs/recipes/aws-fargate.md`](recipes/aws-fargate.md).

**Tear down and upgrade.** Teardown is destructive and confirms by default;
`upgrade node` routes on how the context was deployed.

```sh
clodexctl undeploy node mynode [--keep-data] [--keep-ctx] [--force]
clodexctl upgrade node mynode [--tag TAG] [--dry-run]
```

## clodexctl, every day

`clodexctl` is a dependency-free Node client for the same wire the GUI peers
speak. Nothing to build — running it from a checkout is a first-class path:

```sh
node cli/bin/clodexctl.js get sessions
npm i -g --prefix ~/.local ./cli     # bin → ~/.local/bin/clodexctl
npm i -g ./cli                       # if your global prefix is writable
```

**Contexts.** A deploy saves one (`~/.clodex/cli/contexts.json`, 0600) and
makes it current if there was none. Contexts are the kubeconfig: which node,
and how to reach it.

```sh
clodexctl ctx current        # the current context NAME (exit 5 when none)
clodexctl ctx use mynode
clodexctl ctx test --verbose # open the transport, GET hello
```

**The fleet.**

```sh
clodexctl get sessions
clodexctl get sessions -n main -o wide
clodexctl describe session bob
```

**Sessions.**

```sh
clodexctl create session worker --cwd /srv/work --type claude
clodexctl exec worker "summarize docs/architecture.md"
clodexctl dm worker "status?"                 # fire-and-forget; exec waits for the reply
clodexctl logs worker --tail 20
clodexctl logs worker -f                      # follow, kubectl-style
clodexctl attach worker                       # a LIVE terminal (needs a real TTY)
clodexctl delete session worker --force
```

**The node itself.**

```sh
clodexctl restart node --force                # relaunches the engine; every session respawns
clodexctl port-forward 8080:7900              # foreground tunnel, Ctrl-C to stop
clodexctl web                                 # tunnel the web GUI and pop a browser
clodexctl api-resources                       # what this node can serve
```

**Machine output.** `-o json` is the raw wire payload, `-o yaml` the same
payload as YAML, `-o wide` extra columns, `-o name` one `<singular>/<id>` per
line:

```sh
clodexctl get sessions -o name | xargs -n1 clodexctl logs
```

Per-verb detail, flags and gotchas: `clodexctl help <verb>`.

## Where next

- [`docs/architecture.md`](architecture.md) — how the engine, the frontends and the wire fit together.
- [`cli/README.md`](../cli/README.md) — the full clodexctl reference, exit codes and transports.
- [`docs/recipes/`](recipes/) — EC2, Fargate, Kubernetes, and two nodes on one box.
