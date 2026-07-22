// help.js — the --help text and --version string. The exit-code contract lives
// here (and, identically, in errors.js:EXIT and README.md) — keep the three in
// sync.
'use strict';

const pkg = require('../package.json');

const VERSION = `clodexctl ${pkg.version}`;

const HELP = `clodexctl — a text client for the Clodex engine wire (kubectl-for-Clodex)

USAGE
  clodexctl [global flags] <verb> [args] [flags]

CONTEXT (local ~/.clodex/cli/contexts.json, 0600)
  ctx add <name> --url URL [--token T]        add a direct context
  ctx add <name> --ssh HOST [--remote-port N] [--token T]
  ctx add <name> --ssm TARGET [--region R] [--profile P]      AWS SSM tunnel
  ctx add <name> --ssm-ecs CLUSTER/FAMILY [--region R] [--profile P]  (Fargate —
                                                    task id resolved at connect)
  ctx add <name> --kubectl POD_OR_SVC [--namespace NS] [--kube-context C]
  ctx add <name> --gcloud-iap INSTANCE [--zone Z] [--project P]   GCP IAP tunnel
  ctx add <name> --az-bastion NAME --az-resource-group G --az-target ID  (Azure)
  ctx add <name> --token T --tunnel CMD… {port}…   generalized tunnel (argv,
                                                    {port} substituted; must be
                                                    LAST — it consumes the rest)
  ctx use <name>                              set the current context
  ctx list                                    list contexts (* = current)
  ctx show [name]                             show a context (token redacted)
  ctx rm <name>                               remove a context
  ctx import [--data-dir DIR] [--dry-run] [--force]
                                              seed contexts from the LOCAL GUI's
                                              own stores (engine + peers +
                                              sandboxes); read-only, skips
                                              collisions unless --force
  ctx test [--verbose]                        open the transport + GET hello;
                                              relays child stderr verbatim

READ VERBS (all support --json: stable raw wire payload)
  info                     identity + caps + version (also a connectivity test)
  sessions                 list running sessions
  logs <name> [--tail N]   transcript slice (role-prefixed; --json = messages)
             [-f|--follow]  follow mode (kubectl -f): print the tail, then stream
                          new entries as the turn lands. --json = NDJSON (one
                          object per entry). Ctrl-C exits 0; non-TTY stdout OK
                          (pipe it into grep). Survives a dropped stream (60s
                          staleness watchdog + bounded reconnect).
  query <name> <kind>      telemetry read; kind ∈ ctx report bust files
                           filePeek fileDiff  (--path P, --detail)
  args get <name>          session args (JSON)
  skills <name>            session skill catalog (JSON)

THE VERB
  run <name> <text…>       make a session do something and show the result. The
             [--timeout N] [--quiet-ms N] [--raw] [--json]  client looks up the
                          session's type and ROUTES: an agent (claude/codex) gets
                          a prompt + waits for its turn to end, then prints the
                          reply; a bash session runs the command and prints the
                          terminal output. --json carries mode:"agent"|"pty".
                          run ALWAYS executes (no --no-enter — use \`input\` for
                          raw partial keystrokes).
  attach <name>            a LIVE terminal on a session — ssh-for-agents. Streams
             [--read-only]  the screen (best-effort scrollback replay, then raw
                          output) and forwards your keystrokes. Ctrl-\\ detaches
                          (never sent to the remote). --read-only mirrors without
                          taking control (shoulder-surfing). Needs a TTY (use run/
                          logs for scripting). run = ask and wait; attach = be
                          there. Survives a dropped stream (auto reconnect + full
                          re-replay). Works on any session type, any transport.
  port-forward LOCAL:REMOTE  a kubectl-style FOREGROUND tunnel to an arbitrary
                          remote port on the node, over whatever transport the
                          context carries (ssh -L / ssm / kubectl / gcloud IAP /
                          az bastion / custom {port} argv). Prints the local
                          address once it is up, then holds — Ctrl-C exits 0.
                          LOCAL binds 127.0.0.1 only. REMOTE is a port number or
                          \`web\` (the node's web-GUI port: saved ctx webPort, else
                          wire-port+1). Single-shot: a dropped tunnel exits with
                          the child's stderr (no reconnect — the consumer retries).
                          A url (direct) context has no tunnel → usage error.
                          Non-TTY OK (a script can hold it open).

WRITE VERBS
  spawn <name> --cwd DIR --type claude|codex|bash [--model M] [--arg X …] [--fork]
  kill <name> [--force]    HARD DELETE on the engine — no resume. Confirms
                           unless --force (--force required with --json).
  restart <name> [--fresh] restart a session (--fresh = new conversation)
  args set <name> [--arg X…] [--proxy URL] [--restart]
  restart-app [--force]    relaunch the WHOLE engine (confirms unless --force)

PLUMBING (prefer \`run\` — these are the raw paths it routes over)
  send <name> <text…>      fire-and-forget DM to an agent (scripting; no wait)
             [--wait [--timeout N]]  block until the turn ends (goes IDLE — NOT
                          "declared done"; formal contract is T38), then print the
                          new transcript entries. Default 300s. (\`run\` on an
                          agent IS this path.)
  input <name> <text…>     raw keystrokes, no wait (acquires control around the
             [--no-enter]  write); sends Enter by default — --no-enter posts raw.
                          The deliberate low-level channel — no agent guardrail.
  exec <name> <cmd…>       run one command in the session's PTY and print what
             [--quiet-ms N] [--timeout N] [--raw] [--pty]  the terminal produced.
                          Waits for output to go quiet (no bytes for --quiet-ms,
                          default 750) or --timeout (secs, default 30) caps it.
                          ANSI stripped unless --raw. Exit reflects DELIVERY, not
                          the remote command's status. Use -- before a cmd with
                          dashes. On an AGENT session exec refuses without --pty
                          (it types into the TUI screen — prefer \`run\`; --pty is
                          for answering a dialog). (\`run\` on bash IS this path.)

DEPLOY
  deploy <user@host>       install/UPDATE a headless Clodex node on an
             [--port N] [--repo URL] [--branch B] [--src DIR]  ssh-reachable box
             [--name N] [--no-ctx] [--force] [--ssh-opt X …] [--dry-run]
             [--claude-token-file FILE]
                          Drives peering/clodex-deploy.sh over ssh (idempotent —
                          re-run = update), streams ::step/::ok progress
                          (--json = NDJSON per marker), verifies hello through an
                          ssh tunnel, then saves a context {ssh, remotePort} (no
                          token — the tunnel is the auth boundary). Installs the
                          claude/codex CLIs on the box. --no-ctx skips the ctx;
                          collision kept unless --force. ssh-reachable boxes
                          only — Fargate/k8s nodes stay recipe-based. Exit 42
                          from the script = run the printed sudo commands on the
                          box, then re-run deploy. --claude-token-file reads
                          CLAUDE_CODE_OAUTH_TOKEN from a local file (raw token or
                          a CLAUDE_CODE_OAUTH_TOKEN=… env-file line) and rides the
                          ssh stdin into a 0600 unit drop-in — never argv/logs.
  deploy ssm <name> --target i-INSTANCE   deploy a node over AWS SSM RunCommand
             [--region R] [--profile P] [--branch B] [--repo URL] [--port N]
             [--no-ctx] [--force] [--dry-run] [--json] [--claude-token-file FILE]
                          no ssh, no open ports (OS flavor — a dedicated clodex
                          host user + systemd --user service, same as the ssh
                          flavor): mint a wire token, one root AWS-RunShellScript
                          (prereqs → the pinned installer as the clodex user →
                          token drop-in → on-box hello), poll to completion
                          (10min budget), verify from here through the real SSM
                          port-forward, save a typed ssm context (+token). Wire
                          token rides the send-command parameters → visible in the
                          account's SSM history/CloudTrail; the port stays on
                          loopback, re-run to rotate. --claude-token-file delivers
                          CLAUDE_CODE_OAUTH_TOKEN over the ENCRYPTED WIRE after
                          verify (NEVER via SSM params/CloudTrail) into a 0600 unit
                          drop-in — never argv/logs.
                          (A host literally named \`ssm\` → \`deploy ssh ssm\`.)
  deploy docker <name>     birth a CONTAINER node — one \`docker run\` of the
             [--port N] [--image I] [--tag T] [--env-file F] [--host ssh://u@box]
             [--volume V …] [--no-ctx] [--force] [--dry-run]
                          published, self-configuring image (wire baked in).
                          Publishes 127.0.0.1:N→7900, verifies hello, saves a
                          context (url local / ssh remote — no token). --host
                          sets DOCKER_HOST (docker's own ssh). Secrets go ONLY in
                          --env-file (CLAUDE_CODE_OAUTH_TOKEN + optional
                          CLODEX_REMOTE_TOKEN) — passed to docker unread. NOT a
                          GUI sandbox (plain peer clodexctl-<name>). A pinned
                          --tag is the reproducible choice.

GLOBAL FLAGS
  --ctx NAME               use a named context (overrides current)
  --url URL --token T      one-shot direct context (no file needed)
  --json                   machine-stable output on read verbs
  -h, --help   -V, --version

ENV (between file and flags; flags win)
  CLODEX_URL   CLODEX_TOKEN

EXIT CODES
  0 ok   1 server error   2 usage error   3 connect failure
  4 auth (401/403)   5 not found (404, unknown session)

The token travels only as an Authorization: Bearer header — never in argv,
URLs, or logs.`;

module.exports = { HELP, VERSION };
