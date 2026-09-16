// help.js — contextual help: ONE verb registry, TWO renderings (T43).
//
// The old monolithic HELP string is gone. `VERB_REGISTRY` is the single source
// of truth: the grouped top-level index (`clodexctl` / `--help`) and every
// per-verb view (`help <verb>` / `<verb> --help`) render FROM it — no duplicated
// prose. Adding a verb to main.js's dispatch without an entry here fails the
// registry-completeness test (help.test.js pins the registry against main.js's
// TOP_VERBS), so a future verb can't ship helpless.
//
// The exit-code contract still lives in three places kept in sync: errors.js
// (EXIT), the index footer below, and README.md.
'use strict';

const pkg = require('../package.json');
const { EXIT } = require('./errors');

const VERSION = `clodexctl ${pkg.version}`;

// ── the registry ─────────────────────────────────────────────────────────────
// One entry per top-level verb users TYPE (multi-word families — ctx, deploy, the
// resource-word verbs — are one entry at the granularity `help <verb>` is invoked). Fields:
//   name, group, summary (one line, for the index)
//   usage       one or more invocation lines
//   args        [placeholder, desc] positional arguments
//   subcommands [usage, desc] for multi-word families
//   flags       [flag, desc] — PER-VERB only; global flags (--ctx/--url/--token/
//               -o json/-h/-V) are documented once, in the index footer
//   examples    real, copy-pasteable
//   notes       gotchas the accuracy pass surfaced
const VERB_REGISTRY = [
  // ── daily ──────────────────────────────────────────────────────────────
  {
    name: 'get', group: 'daily',
    summary: 'list or fetch a resource',
    usage: [
      'get sessions [-n WORKSPACE] [-A] [-o json|yaml|wide|name]',
      'get session <name> [-o json|yaml|wide|name]',
      'get workspaces [-o json|yaml|name]',
      'get peers [-o json|yaml|wide|name]',
      'get teams [-o json|yaml|wide|name]',
      'get tickets [--team T] [--state open|done|cancelled|all] [-o json|yaml|wide|name]',
      'get sandboxes [-o json|yaml|wide|name]',
      'get agents [-o json|yaml|wide|name]',
      'get worktrees --repo DIR [-o json|yaml|wide|name]',
      'get catalogs [-o json|yaml]',
      'get session <name> --subresource skills|args|transcript',
    ],
    args: [['resource', 'sessions|workspaces|peers|teams|tickets|sandboxes|agents|worktrees|catalogs (singular accepted too)'], ['name', 'one object (also accepted as session/<name>)']],
    flags: [
      ['-n, --workspace W', 'filter sessions to one workspace (client-side; default is every workspace)'],
      ['-A, --all-workspaces', 'accepted for muscle memory — already the default'],
      ['--team T', 'tickets only — one team\'s board'],
      ['--state S', 'tickets only — open|done|cancelled|all (human default: open)'],
      ['--repo DIR', 'worktrees only — the repo to list (required; resolved to an absolute path here)'],
      ['-o FORMAT', 'json (raw wire payload) | yaml (the same payload as YAML) | wide (extra columns) | name (<singular>/<id> per line)'],
      ['--subresource S', 'sessions only — read one subresource of a named session: skills|args|transcript'],
    ],
    examples: [
      'clodexctl get sessions',
      'clodexctl get sessions -n main -o wide',
      'clodexctl get session bob -o json',
      'clodexctl get tickets --team clodex --state open',
      'clodexctl get sessions -o name | xargs -n1 clodexctl logs',
      'clodexctl get session bob --subresource skills',
      'clodexctl get session bob --subresource args',
    ],
    notes: [
      'get sessions and get catalogs run against a node of ANY version. Every other resource needs the resources API — an older node, or one that does not serve that resource (a headless node has no sandboxes), answers with the upgrade line and exit 1.',
      '-n filters on each row\'s own workspace field, so it needs nothing from the node. It is ignored on the node-scoped resources (peers, teams, tickets, sandboxes, agents, worktrees).',
      'Default columns: sessions NAME TYPE ACTIVITY CWD; workspaces ID NAME; peers ID LABEL ONLINE HOST VERSION; teams NAME; tickets ID TEAM STATE TITLE; sandboxes ID LABEL; agents NAME MODEL DESCRIPTION; worktrees PATH BRANCH HEAD.',
      '-o wide adds: sessions WORKSPACE; peers URL PLATFORM; tickets ASSIGNEE BRANCH; agents TOOLS; worktrees MAIN DETACHED LOCKED PRUNABLE. workspaces, teams and sandboxes have no wide columns.',
      'get tickets without --state shows the OPEN board; -o json sends no state and returns every state, the server\'s own default. A ticket id (t42) and a --state value are both checked here, before any request.',
      '--subresource skills|args print the raw JSON payload; --subresource transcript is a one-shot read of the same transcript `logs` reads (use `logs -f` to follow; -f here is forced off, not honoured). -o wide|name are accepted by the parser and ignored on all three: skills and args are always JSON, transcript renders exactly as `logs` does.',
    ],
  },
  {
    name: 'exec', group: 'daily',
    summary: 'make a session do something and show the result',
    usage: 'exec <name> <text…> [--timeout N] [--quiet-ms N] [--raw] [--pty] [-o json|yaml]',
    args: [['name', 'target session'], ['text…', 'a prompt (agent) or a command (bash)']],
    flags: [
      ['--timeout N', 'seconds — hard ceiling on the whole verb (agent: 300, bash/pty: 30)'],
      ['--quiet-ms N', 'pty mode: idle window that ends collection (default 750)'],
      ['--raw', 'pty mode: keep ANSI (default strips it)'],
      ['--pty', 'force the PTY mode — type into the live TUI screen of an AGENT (deliberate)'],
    ],
    examples: [
      'clodexctl exec builder "npm test"',
      'clodexctl exec bob "summarize docs/architecture.md" --timeout 600',
      'clodexctl exec bob y --pty',
      'clodexctl exec builder -- grep -n foo file',
    ],
    notes: [
      'ROUTES by the session\'s authoritative type (one GET /api/sessions): an agent (claude/codex/anything not bash) gets a prompt + waits for the turn to end, then prints the reply; a bash session runs the command in its PTY and prints the terminal output.',
      '--pty takes the PTY path whatever the type — the way to answer a dialog on an agent. It skips the type lookup entirely.',
      '-o json carries mode:"agent"|"pty" so a script can tell which path ran.',
      'exec ALWAYS executes — there is no --no-enter (use `input` for raw partial keystrokes). Use -- before a command with dashes.',
      'In pty mode exit reflects DELIVERY (typed + went quiet), NOT the remote command\'s status — screen bytes carry no exit code. The echoed command + prompt are part of the printed output (honest terminal truth).',
    ],
  },
  {
    name: 'logs', group: 'daily',
    summary: 'print a transcript slice, or follow it live',
    usage: 'logs <name> [--tail N] [-f|--follow] [-o json|yaml]',
    args: [['name', 'session whose transcript to read']],
    flags: [
      ['--tail N', 'last N entries (default: the server\'s slice)'],
      ['-f, --follow', 'kubectl -f: print the tail, then stream new entries as each turn lands'],
    ],
    examples: ['clodexctl logs bob --tail 20', 'clodexctl logs bob -f -o json | jq'],
    notes: [
      'follow subscribes to /api/events and refetches the delta on an activity for NAME. Ctrl-C exits 0 (it\'s a pager); non-TTY stdout is fine (pipe into grep).',
      '-o json = messages array one-shot; -o json with --follow = NDJSON (one object per entry).',
      'Survives a dropped stream (60s staleness watchdog + bounded reconnect); a reconnect re-snapshots silently (no duplicate lines).',
    ],
  },
  {
    name: 'attach', group: 'daily',
    summary: 'open a LIVE terminal on a session (ssh-for-agents)',
    usage: 'attach <name> [--read-only]',
    args: [['name', 'session to attach to (any type, any transport)']],
    flags: [['--read-only', 'mirror the screen without taking control (shoulder-surfing)']],
    examples: ['clodexctl attach worker', 'clodexctl attach worker --read-only'],
    notes: [
      'Streams the screen (best-effort scrollback replay, then raw output) and forwards your keystrokes. Ctrl-\\ detaches and is never sent to the remote.',
      'Needs a REAL TTY on stdin and stdout (exit 2 otherwise — use exec/logs for scripting).',
      'exec = ask and wait; attach = be there. Survives a dropped stream (auto reconnect + full re-replay). Replay is recent scrollback, NOT exact terminal state.',
    ],
  },
  {
    name: 'describe', group: 'daily',
    summary: 'every field of one object, as labeled lines',
    usage: [
      'describe session <name>', 'describe workspace <name>', 'describe peer <id>',
      'describe team <name>', 'describe ticket <id> [--team T]', 'describe sandbox <id>',
      'describe agent <name>', 'describe catalogs',
    ],
    args: [['resource', 'session|workspace|peer|team|ticket|sandbox|agent|catalogs'], ['name', 'the object (also accepted as session/<name>)']],
    examples: ['clodexctl describe session bob', 'clodexctl describe workspace main', 'clodexctl describe ticket t42 --team clodex'],
    notes: [
      'A composed human view — there is no -o json here (kubectl\'s describe has none either). For machine output use `get <resource> <name> -o json`.',
      'Needs the resources API; an older node answers with the upgrade line and exit 1.',
      'A ticket id is unique per TEAM, not per node: an id on more than one board asks you to add --team and exits 2.',
      'describe peer lists the peer\'s sessions, describe team its roles and activity, describe sandbox its ports, and describe agent prints the definition file verbatim after the key block.',
    ],
  },
  {
    name: 'api-resources', group: 'daily',
    summary: 'what this node can serve — NAME SINGULAR SCOPE VERBS',
    usage: 'api-resources [-o json|yaml]',
    examples: ['clodexctl api-resources'],
    notes: ['The discovery document (GET /api/resources). A node too old to serve it answers with the upgrade line and exit 1.'],
  },
  {
    name: 'version', group: 'daily',
    summary: 'this client\'s version and the node\'s',
    usage: 'version [-o json|yaml]',
    examples: ['clodexctl version', 'clodexctl version -o json'],
    notes: ['-V/--version prints the client line alone and opens no wire; `version` asks the node too.'],
  },
  {
    name: 'web', group: 'daily',
    summary: 'open the node\'s web GUI in your browser',
    usage: 'web [ctx] [--port N] [--no-open]',
    args: [['ctx', 'optional context name (else the current/--ctx context)']],
    flags: [
      ['--port N', 'pin the local port (default: first free of 8080..8090)'],
      ['--no-open', 'print the URL but do not pop the browser'],
    ],
    examples: ['clodexctl web', 'clodexctl web mybox', 'clodexctl web work --port 9000 --no-open'],
    notes: [
      'Opens a FOREGROUND tunnel to the node\'s web-GUI port (saved ctx webPort, else wire-port+1), prints http://127.0.0.1:PORT, and pops your browser (best-effort; skipped under --no-open or a non-TTY stdout — the URL is always printed). Holds until Ctrl-C (exit 0).',
      'A keep-alive probe rides the tunnel: a node that stops answering ends the hold with exit 3 instead of serving a zombie tab.',
      'Same tunnel machinery as port-forward — a url (direct) context has no tunnel to ride → usage error.',
    ],
  },
  {
    name: 'info', group: 'daily',
    summary: 'identity + caps + version (also a connectivity test)',
    usage: 'info [-o json|yaml]',
    examples: ['clodexctl info', 'clodexctl --url http://127.0.0.1:7900 --token T info'],
    notes: ['GET /api/peer/hello — the cheapest reachability check for a context.'],
  },

  // ── sessions ───────────────────────────────────────────────────────────
  {
    name: 'create', group: 'sessions',
    summary: 'create a resource on the node',
    usage: 'create session <name> --cwd DIR --type claude|codex|bash [--model M] [--arg X …] [--env KEY=VALUE …] [--fork] [-o json|yaml]',
    args: [['resource', 'session (singular or plural spelling)'], ['name', 'new session name ([a-zA-Z0-9._-], 1-64)']],
    flags: [
      ['--cwd DIR', 'working directory for the session'],
      ['--type T', 'claude | codex | bash'],
      ['--model M', 'agent model (rides extraArgs, same as any raw CLI flag)'],
      ['--arg X', 'raw passthrough CLI arg — repeatable (rides extraArgs)'],
      ['--env KEY=VALUE', 'session env var — repeatable. Merged over the node\'s global/workspace scopes. The node re-validates + deny-lists; the ack echoes the keys actually applied and create warns loudly if any were dropped.'],
      ['--fork', 'fork mode (agents)'],
    ],
    examples: [
      'clodexctl create session worker --cwd /home/clodex/work --type claude',
      'clodexctl create session b --cwd /w --type claude --model opus --arg --foo',
      'clodexctl create session w --cwd /w --type claude --env AWS_PROFILE=acct --env AWS_ROLE_SESSION_NAME=w',
    ],
    notes: [
      'Post-create liveness check: a child that dies on exec (e.g. the agent CLI isn\'t on the node\'s PATH) STILL returns a pid, so create waits a beat and re-checks the live list — gone → it says WHY instead of reporting a dead pid.',
      '--env is applied ONLY at create; `exec`/`dm` target an existing session and cannot change its env. A node predating env support drops the keys silently on its side — create detects the missing ack echo and warns.',
      'Only `session` is creatable today; any other resource word is a usage error naming what is supported.',
    ],
  },
  {
    name: 'delete', group: 'sessions',
    summary: 'HARD DELETE a resource on the engine (no resume)',
    usage: 'delete session <name> [--force] [-o json|yaml]',
    args: [['resource', 'session (singular or plural spelling)'], ['name', 'session to delete']],
    flags: [['--force', 'skip the type-the-name confirm (REQUIRED with -o json)']],
    examples: ['clodexctl delete session doomed', 'clodexctl delete session doomed --force -o json'],
    notes: [
      'This is a hard delete on the engine — no resume. Confirms by typing the name back unless --force. In -o json/non-interactive mode --force is required (there is no prompt to answer).',
    ],
  },
  {
    name: 'restart', group: 'sessions',
    summary: 'restart a session, or the whole node',
    usage: [
      'restart session <name> [--fresh] [-o json|yaml]',
      'restart node [--force] [-o json|yaml]',
    ],
    args: [['resource', 'session | node — REQUIRED (a bare `restart <name>` is a usage error)'], ['name', 'session to restart (session form only)']],
    flags: [
      ['--fresh', 'session form: start a NEW conversation (default resumes the existing one)'],
      ['--force', 'node form: skip the confirm (REQUIRED with -o json)'],
    ],
    examples: ['clodexctl restart session bob', 'clodexctl restart session bob --fresh', 'clodexctl restart node --force'],
    notes: [
      'The resource word is mandatory — the two forms do very different things and a bare name would silently pick one.',
      'restart node relaunches the whole engine — every session respawns and the wire drops out from under every client. Confirms unless --force.',
    ],
  },
  {
    name: 'patch', group: 'sessions',
    summary: 'patch a resource — only the keys you pass change',
    usage: 'patch session <name> [--arg X…] [--proxy URL] [--restart] [-o json|yaml]',
    args: [['resource', 'session (singular or plural spelling)'], ['name', 'session to patch']],
    flags: [
      ['--arg X', 'set extraArgs — repeatable (replaces the whole list)'],
      ['--proxy URL', 'set the session proxy'],
      ['--restart', 'respawn the session so the new args take effect'],
    ],
    examples: ['clodexctl patch session bob --arg --model --arg opus --restart'],
    notes: [
      'Needs at least one of --arg / --proxy / --restart. Undefined keys are left untouched owner-side.',
      'To READ the same args: clodexctl get session <name> --subresource args.',
    ],
  },
  {
    name: 'query', group: 'sessions',
    summary: 'read structured session telemetry (JSON)',
    usage: 'query <name> <kind> [--path P] [--detail]',
    args: [['name', 'session to query'], ['kind', 'ctx | report | bust | files | filePeek | fileDiff']],
    flags: [
      ['--path P', 'file path (filePeek / fileDiff)'],
      ['--detail', 'expanded payload where the kind supports it'],
    ],
    examples: ['clodexctl query bob report', 'clodexctl query bob filePeek --path src/main.js'],
    notes: ['Output is always JSON — these are structured telemetry payloads with no compact human form.'],
  },

  // ── contexts ───────────────────────────────────────────────────────────
  {
    name: 'ctx', group: 'contexts',
    summary: 'manage connection contexts (the kubeconfig)',
    usage: 'ctx <add|use|current|list|show|rm|import|test> [args]',
    subcommands: [
      ['ctx add <name> --url URL [--token T]', 'a direct context (speak http straight at it)'],
      ['ctx add <name> --ssh HOST [--remote-port N] [--token T]', 'ssh -L tunnel (remotePort default 7900)'],
      ['ctx add <name> --ssm TARGET [--region R] [--profile P]', 'AWS SSM port-forward tunnel'],
      ['ctx add <name> --ssm-ecs CLUSTER/FAMILY [--region R] [--profile P]', 'Fargate — task id resolved at connect'],
      ['ctx add <name> --kubectl POD_OR_SVC [--namespace NS] [--kube-context C]', 'kubectl port-forward tunnel'],
      ['ctx add <name> --gcloud-iap INSTANCE [--zone Z] [--project P]', 'GCP IAP tunnel'],
      ['ctx add <name> --az-bastion NAME --az-resource-group G --az-target ID', 'Azure Bastion tunnel'],
      ['ctx add <name> --token T --tunnel CMD… {port}…', 'generalized tunnel argv ({port} substituted; must be LAST)'],
      ['ctx use <name>', 'set the current context'],
      ['ctx current', 'print the current context NAME (exit 5 when none is set)'],
      ['ctx list  (ctx ls)', 'list contexts (* = current)'],
      ['ctx show [name]', 'show a context (token redacted)'],
      ['ctx rm <name>  (ctx remove)', 'remove a context'],
      ['ctx import [--data-dir DIR] [--dry-run] [--force]', 'seed contexts from the LOCAL GUI\'s stores (read-only)'],
      ['ctx test [--verbose]', 'open the transport + GET hello; relays child stderr verbatim'],
    ],
    examples: [
      'clodexctl ctx add home --url http://127.0.0.1:7900 --token T',
      'clodexctl ctx add cust --ssm-ecs my-cluster/clodex --token T',
      'clodexctl --ctx cust ctx test --verbose',
    ],
    notes: [
      'Stored at ~/.clodex/cli/contexts.json (0600 — it holds tokens; a loose mode warns on read).',
      'The typed cloud kinds (ssm/ssm-ecs/kubectl/gcloud-iap/az) are DATA — safe to ctx import or commit to a shared team file; a raw --tunnel argv is code and is never shared by import. --ssm and --ssm-ecs are mutually exclusive; --tunnel is greedy (must be last).',
      'import: collisions skip unless --force; --dry-run writes nothing; `current` is never touched. Tokens flow file→file, never printed.',
      'ctx current prints the name alone, kubectl\'s `config current-context`. With no current context it exits 5 and names the fix.',
    ],
  },

  // ── deploy ─────────────────────────────────────────────────────────────
  {
    name: 'deploy', group: 'deploy',
    summary: 'install/UPDATE a headless node (ssh, ssm, docker, helm, or fargate)',
    usage: 'deploy node <name> (--ssh user@host | --ssm i-INSTANCE | --docker | --helm | --fargate) [flags]',
    subcommands: [
      ['--ssh user@host', 'ssh flavor — drives clodex-deploy.sh over ssh (installs the agent CLIs)'],
      ['--ssm i-INSTANCE', 'OS flavor over AWS SSM RunCommand — no ssh, no open ports'],
      ['--docker', 'a CONTAINER node — one docker run of the published image'],
      ['--helm', 'a KUBERNETES node — helm upgrade --install of the packaged chart'],
      ['--fargate', 'an AWS FARGATE node — cloudformation deploy of the packaged template'],
    ],
    flags: [
      ['--port N', 'wire port on the box (default 7900)'],
      ['--repo URL --branch B', 'source to install (default: the public Clodex repo, master) [ssh/ssm]'],
      ['--src DIR', 'push a local source tree instead of cloning [ssh]'],
      ['--region R --profile P', 'AWS selectors [ssm]'],
      ['--image I / --tag T', 'container image / tag [docker]'],
      ['--env-file F', 'secrets file passed straight to docker (unread) [docker]'],
      ['--host ssh://u@box', 'run docker on a remote box (sets DOCKER_HOST) [docker]'],
      ['--volume V', 'extra docker volume — repeatable [docker]'],
      ['--ssh-opt X', 'extra ssh option — repeatable [ssh]'],
      ['--namespace NS --kube-context C', 'target namespace (default clodex) / kube context (default: current) [helm]'],
      ['--chart PATH', 'chart to install (default: the packaged cli/deploy/helm/clodex) [helm]'],
      ['--set k=v / --values F', 'raw helm value passthrough (repeatable / a values file) [helm]'],
      ['--cluster NAME', 'ECS cluster (default: the stack name — avoids a two-stack collision) [fargate]'],
      ['--image URI --region R --profile P', 'container image / AWS selectors — region unset is resolved (AWS_REGION env, then profile), printed + pinned into the ctx (warns if unresolvable) [fargate]'],
      ['--use-bedrock', 'model access via the TaskRole — no oauth-token secret [fargate]'],
      ['--subnets IDs / --security-group ID', 'task ENI networking — comma list / one (default: auto-detected from the account\'s default VPC) [fargate]'],
      ['--assign-public-ip E|D', 'ENABLED|DISABLED (default: ENABLED when subnets were auto-detected — default-VPC subnets are public; explicit wins) [fargate]'],
      ['--persistent true|false', 'ECS Service (verified, default true) vs infra-only run-task shape [fargate]'],
      ['--param KEY=VALUE', 'raw CloudFormation parameter override — repeatable; last value wins, incl. over verb-emitted keys [fargate]'],
      ['--token-file FILE', "claude oauth token into the stack's oauth-token secret (file://, never argv) [fargate]"],
      ['--ctx NAME', 'saved context name (default: the stack name) [fargate]'],
      ['--claude-token-file FILE', 'authenticate Claude on the box (never argv/logs) [ssh/ssm/helm]'],
      ['--no-wirescope', 'disable the wirescope proxy on the node (CLODEX_WIRESCOPE=off; Bedrock/Vertex nodes auto-disable it anyway) [ssh/ssm/docker/fargate]'],
      ['--force-conflicts', 'take ownership of fields another manager owns [helm] — see the conflict note below'],
      ['--no-ctx', 'skip saving a context'],
      ['--force', 'overwrite an existing context on a name collision'],
      ['--dry-run', 'print what would run, do nothing'],
    ],
    examples: [
      'clodexctl deploy node box --ssh user@box --claude-token-file ./token',
      'clodexctl deploy node mybox --ssm i-0123456789abcdef0 --region us-west-2',
      'clodexctl deploy node edge --docker --host user@box --tag v3.5.2 --env-file ./auth.env',
      'clodexctl deploy node mynode --helm --namespace clodex --claude-token-file ./token',
      'clodexctl deploy node clodex-node --fargate --subnets subnet-a,subnet-b --security-group sg-x --token-file ./token',
    ],
    notes: [
      'Exactly one flavor flag is required: --ssh / --ssm / --docker / --helm / --fargate. The positional <name> is the saved context name for every flavor (the helm release, the fargate stack), so it is never derived from the host.',
      'Re-running deploy on the same host is the UPDATE path — the installer is idempotent; `deploy helm` re-run is `helm upgrade` in place and REUSES the release\'s wire token (no rotation).',
      'ssh saves a tokenless context (the tunnel is the auth boundary); ssm/helm store the wire token they minted. --claude-token-file rides the ssh stdin (ssh), the encrypted wire post-verify (ssm — NEVER via SSM params/CloudTrail), or a 0600 tempfile into helm --set-file (helm — only PATHS in argv). fargate takes --token-file (file:// into the stack\'s oauth-token secret, never argv; --use-bedrock skips it).',
      'helm verifies laptop-side through the real `kubectl port-forward` transport and saves a typed {kubectl: svc/<name>} context. -o json emits NDJSON (one object per ::marker/step).',
      'helm re-runs CARRY FORWARD your prior --set/--values/--port: they are read back off the release (`helm get values`, user-supplied only) and re-applied, so an explicit pin survives. Precedence is chart defaults < carried-forward < this run\'s flags; the carried keys are named in the output. Not `--reuse-values` — that would also freeze the chart\'s own defaults, including the image tag.',
      'fargate runs `aws cloudformation deploy` of the packaged cli/deploy/clodex-fargate.yaml (create OR idempotent update), then reads the stack\'s self-minted wire token into a typed {ssm-ecs CLUSTER/<stack>-node} context. ClusterName defaults to the stack name. No secret value ever rides argv: the wire token is the STACK\'s (read into memory, never rotated on re-run) and --token-file rides file:// into put-secret-value (--use-bedrock skips the oauth secret entirely). A persistent stack (default) adds an ECS Service and is verified over the SSM tunnel; --persistent false is infra-only (prints the run-task command, skips verify).',
      '[helm] "Apply failed with N conflicts" means someone changed a field OUT OF BAND (`kubectl edit`/`patch`), which permanently claimed it — and a release that applies server-side may not change a field it does not own. Re-running cannot help; the error names the owning manager and field. Either revert the out-of-band change, or re-run with --force-conflicts to take the field. Check first that the owner is not a controller entitled to it (an HPA on replicas, a sidecar injector) — forcing takes the field from that too, which is why it is opt-in. Whether a release applies server-side is per-RELEASE, inherited from the helm that installed it: `helm get metadata <release> -n <ns>`.',
      '--no-wirescope writes CLODEX_WIRESCOPE=off into the node env (systemd drop-in on ssh/ssm, -e on docker); helm uses the chart value instead (--set wirescope.enabled=false) and fargate the DisableWirescope stack parameter. Nodes with CLAUDE_CODE_USE_BEDROCK/VERTEX in the node env auto-disable wirescope regardless.',
    ],
  },

  // ── undeploy ───────────────────────────────────────────────────────────
  {
    name: 'undeploy', group: 'deploy',
    summary: 'tear down a node deployed with `deploy` (fargate, helm, or docker)',
    usage: 'undeploy <fargate <stack>|helm <name>|docker <name>> [flags]',
    subcommands: [
      ['undeploy fargate <stack> [flags]', 'delete the CloudFormation stack (stops stray tasks first)'],
      ['undeploy helm <name> [flags]', 'helm uninstall + delete the StatefulSet PVC (--keep-data keeps it)'],
      ['undeploy docker <name> [flags]', 'docker rm -f + delete the named data volume (--keep-data keeps it)'],
    ],
    flags: [
      ['--force', 'skip the type-the-name confirmation (required in -o json/non-TTY)'],
      ['--keep-ctx', 'do not remove the saved context'],
      ['--dry-run', 'print every command that would run; execute nothing destructive'],
      ['--region R --profile P', 'AWS selectors (default: the ctx\'s pinned region/profile, else aws default) [fargate]'],
      ['--wait', 'poll until the stack reaches DELETE_COMPLETE (default: return once deletion starts) [fargate]'],
      ['--namespace NS --kube-context C', 'target namespace (default clodex) / kube context [helm]'],
      ['--host ssh://u@box', 'run docker on a remote box (sets DOCKER_HOST) [docker]'],
      ['--keep-data', 'keep the persistent volume/PVC (default: delete it for a full teardown) [helm/docker]'],
    ],
    examples: [
      'clodexctl undeploy fargate clodex-node --wait',
      'clodexctl undeploy helm mynode --keep-data',
      'clodexctl undeploy docker mybox --host ssh://user@box',
    ],
    notes: [
      'The flavor is sniffed on the LITERAL first token exactly like `deploy`. ssh/ssm undeploy is not supported (it needs an uninstall mode in the byte-pinned installer catalog — a separate task); remove those by hand: `systemctl --user disable --now clodex.service` on the node.',
      'Teardown is DESTRUCTIVE and confirm-by-default: it previews what dies, then prompts for the exact name; --force skips the prompt (scripts). --dry-run and -o json without --force in a non-TTY refuse rather than silently destroy.',
      'DATA doctrine: a full teardown removes the persistent store too — helm\'s StatefulSet PVC (survives `helm uninstall` by k8s design) and docker\'s named data volume (survives `docker rm -f`). --keep-data opts out and names what was kept. fargate is stateless (nothing to keep).',
      'fargate resolves the region flag > the ctx\'s pinned region (deploy pins it) > aws default, stops any stray (non-service) tasks that would block cluster teardown, then `delete-stack`. Secrets enter Secrets Manager\'s recovery window (gone in 7–30 days). A pre-existing --cluster the stack did not create is never deleted.',
    ],
  },

  {
    name: 'upgrade', group: 'deploy',
    summary: 'move an EXISTING node to a new version (routes on how it was deployed)',
    usage: 'upgrade [ctx] [--tag T | --image URI] [--dry-run] [--force] [-o json|yaml]',
    args: [['ctx', 'context to upgrade (else the current/--ctx context)']],
    flags: [
      ['--tag T', 'target version [helm/fargate] — beats the packaged pin AND a carried image.tag'],
      ['--image URI', 'full image reference, incl. a repo@sha256:… digest [helm/fargate]'],
      ['--force', 're-run even when already at the target; also repairs a node that is not answering [ssh/ssm]'],
      ['--dry-run', 'print the plan and the flavor\'s own dry-run; touch nothing'],
      ['--branch B', 'the version knob for the source-installed flavors [ssh/ssm]'],
      ['--force-conflicts', 'take ownership of fields another manager owns [helm] — see the conflict note below'],
    ],
    examples: [
      'clodexctl upgrade mynode',
      'clodexctl upgrade mynode --tag 4.6.0 --dry-run',
      'clodexctl upgrade clodex-node --image ghcr.io/you/clodex@sha256:abc…',
    ],
    notes: [
      'Routes on the context\'s STORED deploy flavor, never on its transport — an ssh deploy and a remote `deploy docker` save byte-identical entries, so sniffing would be a guess. A context written before clodexctl recorded that (or by a NEWER clodexctl, with a flavor this build cannot route) is refused by name, saying to re-run the flavor\'s own deploy; every other verb keeps working with it.',
      'REFUSES TO CREATE: helm probes `helm status`, fargate `describe-stacks`, and the source-installed flavors treat a node that does not answer as unconfirmed (--force installs anyway). An upgrade against something that is not there is an error, not a silent install.',
      'Reports what it is moving FROM (the node\'s live `hello.version` — never a stored guess) and TO (the version this clodexctl SHIPS, read from the packaged chart/template, unless --tag/--image overrides), and no-ops when they are equal (--force re-runs).',
      'It delegates to the flavor\'s own deploy verb rather than reimplementing it — so a helm upgrade keeps the release\'s wire token, preserves its claude auth, and carries every prior --set/--values forward (an explicit --tag on this run still beats a carried image.tag). fargate always passes ImageUri explicitly: omitting it makes CloudFormation reuse the prior value and report SUCCESS — a silent no-op that looks like it worked.',
      'The source-installed flavors (ssh/ssm) track a BRANCH and deploy no pinned artifact, so they have no target version and never no-op. Flags a context does not store REVERT on a re-run (--no-wirescope, --repo, --branch, --src, --ssh-opt, --claude-token-file) — they are named before anything runs, so pass them again if you set them. `deploy ssm` also MINTS A FRESH WIRE TOKEN each run: an ssm upgrade ROTATES the token, and any other holder of the old one stops being able to reach the node.',
      'docker is deliberately NOT upgradable: a container is remove-and-recreate, and the recreate needs run arguments a context does not store (--env-file, --volume) and must not recover — reading them back from `docker inspect` would spell resolved secrets into argv. It refuses with the two-step undeploy --keep-data / deploy path instead.',
      '[helm] "Apply failed with N conflicts" means someone changed a field OUT OF BAND (`kubectl edit`/`patch`), which permanently claimed it — and a release that applies server-side may not change a field it does not own. Re-running cannot help; the error names the owning manager and field. Either revert the out-of-band change, or re-run with --force-conflicts to take the field. Check first that the owner is not a controller entitled to it (an HPA on replicas, a sidecar injector) — forcing takes the field from that too, which is why it is opt-in. Whether a release applies server-side is per-RELEASE, inherited from the helm that installed it: `helm get metadata <release> -n <ns>`.',
    ],
  },

  // ── plumbing ───────────────────────────────────────────────────────────
  {
    name: 'dm', group: 'plumbing',
    summary: 'DM an agent, fire-and-forget',
    usage: 'dm <name> <text…> [-o json|yaml]',
    args: [['name', 'target agent'], ['text…', 'the message']],
    examples: ['clodexctl dm bob "status?"'],
    notes: [
      'Fire-and-forget only — it returns as soon as the node accepts the message. To send and WAIT for the reply use `exec <name> <text…>`, which is this POST plus the turn-end wait.',
      '--wait is not a flag here and is a usage error naming exec.',
    ],
  },
  {
    name: 'input', group: 'plumbing',
    summary: 'raw keystrokes into a session (no wait, no guardrail)',
    usage: 'input <name> <text…> [--no-enter] [-o json|yaml]',
    args: [['name', 'target session'], ['text…', 'keystrokes to send']],
    flags: [['--no-enter', 'post the text verbatim (default appends Enter/\\r)']],
    examples: ['clodexctl input bob "yes"', 'clodexctl input bob $\'\\x1b[A\' --no-enter'],
    notes: [
      'The deliberate LOW-LEVEL channel — no agent guardrail. Acquires + releases control around the write. "Send a command" means run it, so Enter is appended unless --no-enter (partial input / key sequences).',
    ],
  },
  {
    name: 'port-forward', group: 'plumbing',
    summary: 'a foreground tunnel to ANY remote port on the node',
    usage: 'port-forward LOCAL:REMOTE [--probe-http]',
    args: [['LOCAL:REMOTE', 'local port : remote port (or `web` for the web-GUI port)']],
    flags: [['--probe-http', 'add the keep-alive HTTP probe (catches a silently dead data channel)']],
    examples: ['clodexctl port-forward 8080:7900', 'clodexctl port-forward 9000:web --probe-http'],
    notes: [
      '`web` is the friendly shortcut for the common case; this is the general plumbing over whatever transport the context carries (ssh -L / ssm / kubectl / gcloud IAP / az bastion / custom {port} argv).',
      'Prints the local address once it is up, then HOLDS — Ctrl-C exits 0. LOCAL binds 127.0.0.1 only. Single-shot: a dropped tunnel exits 3 with the child\'s stderr (no reconnect — the consumer retries).',
      'A url (direct) context has no tunnel → usage error. Non-TTY OK.',
    ],
  },
];

// ── groups (ordered) ─────────────────────────────────────────────────────────
const GROUPS = [
  ['daily', 'DAILY'],
  ['sessions', 'SESSIONS'],
  ['contexts', 'CONTEXTS'],
  ['deploy', 'DEPLOY'],
  ['plumbing', 'PLUMBING (prefer `exec` — these are the raw paths it routes over)'],
];

const BY_NAME = new Map(VERB_REGISTRY.map((e) => [e.name, e]));

// Resolve a token users type to a registry entry. `ls`/`remove` land on `ctx`
// only via ctx's own subcommands, so we resolve on the top-level name only.
function resolveEntry(token) {
  return BY_NAME.get(token) || null;
}

// ── renderers ────────────────────────────────────────────────────────────────

// The grouped top-level index: a MAP, not a manual. One line per verb.
function renderIndex() {
  const lines = [];
  lines.push('clodexctl — a text client for the Clodex engine wire (kubectl-for-Clodex)');
  lines.push('');
  lines.push('USAGE');
  lines.push('  clodexctl [global flags] <verb> [args] [flags]');
  const width = Math.max(...VERB_REGISTRY.map((e) => e.name.length));
  for (const [id, title] of GROUPS) {
    lines.push('');
    lines.push(title);
    for (const e of VERB_REGISTRY.filter((v) => v.group === id)) {
      lines.push(`  ${e.name.padEnd(width)}  ${e.summary}`);
    }
  }
  lines.push('');
  lines.push('GLOBAL FLAGS (any verb)');
  lines.push('  --ctx NAME               use a named context (overrides current)');
  lines.push('  --url URL --token T      one-shot direct context (no file needed)');
  lines.push('  -o json                  machine-stable output on read verbs');
  lines.push('  -h, --help   -V, --version');
  lines.push('');
  lines.push('ENV (between file and flags; flags win)   CLODEX_URL   CLODEX_TOKEN');
  lines.push('');
  lines.push('EXIT CODES  0 ok · 1 server · 2 usage · 3 connect · 4 auth · 5 not found');
  lines.push('');
  lines.push('  clodexctl help <verb>    full detail for a verb (usage/flags/examples/notes)');
  lines.push('');
  lines.push('The token travels only as an Authorization: Bearer header — never in argv,');
  lines.push('URLs, or logs.');
  return lines.join('\n');
}

// The full per-verb view: usage / arguments / subcommands / flags / examples /
// notes — every section rendered only when the entry populates it.
function renderVerb(e) {
  const lines = [];
  lines.push(`${e.name} — ${e.summary}`);
  lines.push('');
  lines.push('USAGE');
  for (const u of [].concat(e.usage)) lines.push(`  clodexctl ${u}`);
  const section = (title, rows) => {
    if (!rows || !rows.length) return;
    lines.push('');
    lines.push(title);
    const w = Math.max(...rows.map((r) => r[0].length));
    for (const [k, v] of rows) lines.push(`  ${k.padEnd(w)}  ${v}`);
  };
  section('ARGUMENTS', e.args);
  section('SUBCOMMANDS', e.subcommands);
  section('FLAGS', e.flags);
  if (e.examples && e.examples.length) {
    lines.push('');
    lines.push('EXAMPLES');
    for (const ex of e.examples) lines.push(`  ${ex}`);
  }
  if (e.notes && e.notes.length) {
    lines.push('');
    lines.push('NOTES');
    for (const n of e.notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push('Global flags (--ctx/--url/--token/-o json) and exit codes: clodexctl --help');
  return lines.join('\n');
}

// A cheap edit distance for the unknown-verb near-miss hint (same spirit as the
// sessionType near-miss aid: name the candidates rather than fail blind).
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

function nearest(token) {
  let best = null, bestD = Infinity;
  for (const e of VERB_REGISTRY) {
    const dist = editDistance(token, e.name);
    if (dist < bestD) { bestD = dist; best = e.name; }
  }
  // Only suggest a genuinely-close match (guard against a wild miss suggesting
  // something unrelated). Threshold scales a little with the typed length.
  return bestD <= Math.max(2, Math.ceil(token.length / 3)) ? best : null;
}

// help(tokens) → { text, code }. The single entry both `help <verb…>` and
// `<verb> --help` route through (and the bare index for []).
//   []            → the grouped index (OK)
//   known verb    → the per-verb view (OK)
//   unknown verb  → usage + nearest-match hint (USAGE)
function help(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const first = list[0];
  if (!first || first === 'help') return { text: renderIndex(), code: EXIT.OK };
  const entry = resolveEntry(first);
  if (entry) return { text: renderVerb(entry), code: EXIT.OK };
  const hint = nearest(first);
  const suffix = hint ? ` — did you mean \`${hint}\`?` : '';
  return {
    text: `clodexctl: no help for "${first}"${suffix}\nRun \`clodexctl help\` for the list of verbs.`,
    code: EXIT.USAGE,
  };
}

module.exports = { help, renderIndex, renderVerb, VERSION, VERB_REGISTRY, GROUPS, resolveEntry, nearest };
