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
// One entry per top-level verb users TYPE (multi-word families — ctx, args,
// deploy — are one entry at the granularity `help <verb>` is invoked). Fields:
//   name, group, summary (one line, for the index)
//   usage       one or more invocation lines
//   args        [placeholder, desc] positional arguments
//   subcommands [usage, desc] for multi-word families
//   flags       [flag, desc] — PER-VERB only; global flags (--ctx/--url/--token/
//               --json/-h/-V) are documented once, in the index footer
//   examples    real, copy-pasteable
//   notes       gotchas the accuracy pass surfaced
const VERB_REGISTRY = [
  // ── daily ──────────────────────────────────────────────────────────────
  {
    name: 'run', group: 'daily',
    summary: 'make a session do something and show the result',
    usage: 'run <name> <text…> [--timeout N] [--quiet-ms N] [--raw] [--json]',
    args: [['name', 'target session'], ['text…', 'a prompt (agent) or a command (bash)']],
    flags: [
      ['--timeout N', 'seconds — hard ceiling on the whole verb (agent: 300, bash-exec: 30)'],
      ['--quiet-ms N', 'bash path: idle window that ends collection (default 750)'],
      ['--raw', 'bash path: keep ANSI (default strips it)'],
    ],
    examples: [
      'clodexctl run builder "npm test"',
      'clodexctl run bob "summarize docs/architecture.md" --timeout 600',
    ],
    notes: [
      'ROUTES by the session\'s authoritative type (one GET /api/sessions): an agent (claude/codex/anything not bash) gets a prompt + waits for the turn to end, then prints the reply; a bash session runs the command and prints the terminal output.',
      '--json carries mode:"agent"|"pty" so a script can tell which path ran.',
      'run ALWAYS executes — there is no --no-enter (use `input` for raw partial keystrokes).',
    ],
  },
  {
    name: 'sessions', group: 'daily',
    summary: 'list running sessions',
    usage: 'sessions [--json]',
    examples: ['clodexctl sessions', 'clodexctl --ctx work sessions --json'],
  },
  {
    name: 'logs', group: 'daily',
    summary: 'print a transcript slice, or follow it live',
    usage: 'logs <name> [--tail N] [-f|--follow] [--json]',
    args: [['name', 'session whose transcript to read']],
    flags: [
      ['--tail N', 'last N entries (default: the server\'s slice)'],
      ['-f, --follow', 'kubectl -f: print the tail, then stream new entries as each turn lands'],
    ],
    examples: ['clodexctl logs bob --tail 20', 'clodexctl logs bob -f --json | jq'],
    notes: [
      'follow subscribes to /api/events and refetches the delta on an activity for NAME. Ctrl-C exits 0 (it\'s a pager); non-TTY stdout is fine (pipe into grep).',
      '--json = messages array one-shot; --json with --follow = NDJSON (one object per entry).',
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
      'Needs a REAL TTY on stdin and stdout (exit 2 otherwise — use run/logs for scripting).',
      'run = ask and wait; attach = be there. Survives a dropped stream (auto reconnect + full re-replay). Replay is recent scrollback, NOT exact terminal state.',
    ],
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
    usage: 'info [--json]',
    examples: ['clodexctl info', 'clodexctl --url http://127.0.0.1:7900 --token T info'],
    notes: ['GET /api/peer/hello — the cheapest reachability check for a context.'],
  },

  // ── sessions ───────────────────────────────────────────────────────────
  {
    name: 'spawn', group: 'sessions',
    summary: 'create a new session on the node',
    usage: 'spawn <name> --cwd DIR --type claude|codex|bash [--model M] [--arg X …] [--fork] [--json]',
    args: [['name', 'new session name ([a-zA-Z0-9._-], 1-64)']],
    flags: [
      ['--cwd DIR', 'working directory for the session'],
      ['--type T', 'claude | codex | bash'],
      ['--model M', 'agent model (rides extraArgs, same as any raw CLI flag)'],
      ['--arg X', 'raw passthrough CLI arg — repeatable (rides extraArgs)'],
      ['--fork', 'fork mode (agents)'],
    ],
    examples: [
      'clodexctl spawn worker --cwd /home/clodex/work --type claude',
      'clodexctl spawn b --cwd /w --type claude --model opus --arg --foo',
    ],
    notes: [
      'Post-spawn liveness check: a child that dies on exec (e.g. the agent CLI isn\'t on the node\'s PATH) STILL returns a pid, so spawn waits a beat and re-checks the live list — gone → it says WHY instead of reporting a dead pid.',
    ],
  },
  {
    name: 'kill', group: 'sessions',
    summary: 'HARD DELETE a session on the engine (no resume)',
    usage: 'kill <name> [--force] [--json]',
    args: [['name', 'session to delete']],
    flags: [['--force', 'skip the type-the-name confirm (REQUIRED with --json)']],
    examples: ['clodexctl kill doomed', 'clodexctl kill doomed --force --json'],
    notes: [
      'This is a hard delete on the engine — no resume. Confirms by typing the name back unless --force. In --json/non-interactive mode --force is required (there is no prompt to answer).',
    ],
  },
  {
    name: 'restart', group: 'sessions',
    summary: 'restart a session (resume, or a fresh conversation)',
    usage: 'restart <name> [--fresh] [--json]',
    args: [['name', 'session to restart']],
    flags: [['--fresh', 'start a NEW conversation (default resumes the existing one)']],
    examples: ['clodexctl restart bob', 'clodexctl restart bob --fresh'],
  },
  {
    name: 'restart-app', group: 'sessions',
    summary: 'relaunch the WHOLE engine',
    usage: 'restart-app [--force] [--json]',
    flags: [['--force', 'skip the confirm (REQUIRED with --json)']],
    examples: ['clodexctl restart-app --force'],
    notes: ['Relaunches the whole engine — every session respawns and the wire drops out from under every client. Confirms unless --force.'],
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
  {
    name: 'skills', group: 'sessions',
    summary: 'the session\'s skill catalog (JSON)',
    usage: 'skills <name>',
    args: [['name', 'session whose skill catalog to read']],
    examples: ['clodexctl skills bob'],
  },
  {
    name: 'args', group: 'sessions',
    summary: 'read or patch a session\'s launch args',
    usage: 'args <get|set> <name> [flags]',
    subcommands: [
      ['args get <name>', 'the session\'s current args (JSON)'],
      ['args set <name> [--arg X…] [--proxy URL] [--restart]', 'patch args — only the keys you pass change'],
    ],
    flags: [
      ['--arg X', 'set extraArgs — repeatable (replaces the whole list)'],
      ['--proxy URL', 'set the session proxy'],
      ['--restart', 'respawn the session so the new args take effect'],
    ],
    examples: ['clodexctl args get bob', 'clodexctl args set bob --arg --model --arg opus --restart'],
    notes: ['`set` needs at least one of --arg / --proxy / --restart. Undefined keys are left untouched owner-side.'],
  },

  // ── contexts ───────────────────────────────────────────────────────────
  {
    name: 'ctx', group: 'contexts',
    summary: 'manage connection contexts (the kubeconfig)',
    usage: 'ctx <add|use|list|show|rm|import|test> [args]',
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
    ],
  },

  // ── deploy ─────────────────────────────────────────────────────────────
  {
    name: 'deploy', group: 'deploy',
    summary: 'install/UPDATE a headless node (ssh, ssm, or docker)',
    usage: 'deploy <user@host|ssm <name>|docker <name>> [flags]',
    subcommands: [
      ['deploy <user@host> [flags]', 'ssh flavor — drives clodex-deploy.sh over ssh (installs the agent CLIs)'],
      ['deploy ssm <name> --target i-INSTANCE [flags]', 'OS flavor over AWS SSM RunCommand — no ssh, no open ports'],
      ['deploy docker <name> [flags]', 'a CONTAINER node — one docker run of the published image'],
    ],
    flags: [
      ['--port N', 'wire port on the box (default 7900)'],
      ['--repo URL --branch B', 'source to install (default: the public Clodex repo, master) [ssh/ssm]'],
      ['--src DIR', 'push a local source tree instead of cloning [ssh]'],
      ['--name N', 'saved context name (ssh; defaults to the host short name)'],
      ['--target i-INSTANCE', 'the SSM-managed instance [ssm, required]'],
      ['--region R --profile P', 'AWS selectors [ssm]'],
      ['--image I / --tag T', 'container image / tag [docker]'],
      ['--env-file F', 'secrets file passed straight to docker (unread) [docker]'],
      ['--host ssh://u@box', 'run docker on a remote box (sets DOCKER_HOST) [docker]'],
      ['--volume V', 'extra docker volume — repeatable [docker]'],
      ['--ssh-opt X', 'extra ssh option — repeatable [ssh]'],
      ['--claude-token-file FILE', 'authenticate Claude on the box (never argv/logs) [ssh/ssm]'],
      ['--no-ctx', 'skip saving a context'],
      ['--force', 'overwrite an existing context on a name collision'],
      ['--dry-run', 'print what would run, do nothing'],
    ],
    examples: [
      'clodexctl deploy user@box --claude-token-file ./token',
      'clodexctl deploy ssm mybox --target i-0123456789abcdef0 --region us-west-2',
      'clodexctl deploy docker edge --host user@box --tag v3.5.2 --env-file ./auth.env',
    ],
    notes: [
      'The flavor is sniffed on the LITERAL first token: `docker` / `ssm` / `ssh`; anything else is the ssh flavor (a host literally named `ssm`/`docker` → `deploy ssh ssm`).',
      'Re-running deploy on the same host is the UPDATE path — the installer is idempotent. --json emits NDJSON (one object per ::marker).',
      'ssh saves a tokenless context (the tunnel is the auth boundary); ssm stores the wire token it minted. --claude-token-file rides the ssh stdin (ssh) or the encrypted wire post-verify (ssm) — NEVER via SSM params/CloudTrail. Fargate/k8s nodes stay recipe-based (docs/recipes/).',
    ],
  },

  // ── plumbing ───────────────────────────────────────────────────────────
  {
    name: 'send', group: 'plumbing',
    summary: 'DM an agent (fire-and-forget, or wait for the turn)',
    usage: 'send <name> <text…> [--wait [--timeout N]] [--json]',
    args: [['name', 'target agent'], ['text…', 'the message']],
    flags: [
      ['--wait', 'block until the agent\'s turn ends, then print the new entries'],
      ['--timeout N', 'seconds to wait with --wait (default 300)'],
    ],
    examples: ['clodexctl send bob "status?"', 'clodexctl send bob "run the build" --wait'],
    notes: [
      'Prefer `run` — on an agent, run IS this send --wait path.',
      '--wait means "the agent went IDLE" (turn ended), NOT "declared the work done" — a long task that parks mid-work still ends its turn. The formal completion contract is T38.',
    ],
  },
  {
    name: 'input', group: 'plumbing',
    summary: 'raw keystrokes into a session (no wait, no guardrail)',
    usage: 'input <name> <text…> [--no-enter] [--json]',
    args: [['name', 'target session'], ['text…', 'keystrokes to send']],
    flags: [['--no-enter', 'post the text verbatim (default appends Enter/\\r)']],
    examples: ['clodexctl input bob "yes"', 'clodexctl input bob $\'\\x1b[A\' --no-enter'],
    notes: [
      'The deliberate LOW-LEVEL channel — no agent guardrail. Acquires + releases control around the write. "Send a command" means run it, so Enter is appended unless --no-enter (partial input / key sequences).',
    ],
  },
  {
    name: 'exec', group: 'plumbing',
    summary: 'run one command in a session\'s PTY, print the output',
    usage: 'exec <name> <cmd…> [--quiet-ms N] [--timeout N] [--raw] [--pty] [--json]',
    args: [['name', 'target session'], ['cmd…', 'the command (use -- before dashes)']],
    flags: [
      ['--quiet-ms N', 'idle window that ends collection (default 750)'],
      ['--timeout N', 'seconds — hard cap on the whole wait (default 30)'],
      ['--raw', 'keep ANSI (default strips it)'],
      ['--pty', 'allow exec on an AGENT (types into its TUI — deliberate)'],
    ],
    examples: ['clodexctl exec builder "ls -la"', 'clodexctl exec builder -- grep -n foo file'],
    notes: [
      'Prefer `run` — on a bash session, run IS this exec path.',
      'On an AGENT session exec REFUSES without --pty (it types into the live TUI screen; --pty is for answering a dialog). Use -- before a command with dashes.',
      'Exit reflects DELIVERY (typed + went quiet), NOT the remote command\'s status — screen bytes carry no exit code. The echoed command + prompt are part of the printed output (honest terminal truth).',
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
  ['plumbing', 'PLUMBING (prefer `run` — these are the raw paths it routes over)'],
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
  lines.push('  --json                   machine-stable output on read verbs');
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
  lines.push('Global flags (--ctx/--url/--token/--json) and exit codes: clodexctl --help');
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
