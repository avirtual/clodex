// deploy.js — `clodexctl deploy <user@host>`: the CLI twin of the GUI's
// add-peer deploy wizard. Drives the SAME battle-tested installer
// (peering/clodex-deploy.sh, copied to cli/deploy/ for the published package)
// over the system ssh binary, streams its ::marker progress, verifies the wire
// through an ssh tunnel, and upserts a ready-to-use context.
//
// STANDALONE by construction: node:* + the CLI's own sibling modules only,
// never an app require(). The env mechanism, the marker grammar and the ssh
// runner are reimplemented here from their documented contracts (the same
// standalone rule import.js follows) — ipc-handlers.js / ssh-run.js /
// peer-deploy.js are the reference, not a dependency.
//
// NO TOKEN anywhere: the deploy path has none (loopback bind + ssh tunnel is
// the auth boundary, same posture as the GUI's peers), and we keep it so.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { CliError, EXIT } = require('./errors');
const { openTransport } = require('./transport');
const { WireClient } = require('./client');
const contexts = require('./contexts');

const execFileP = promisify(execFile);

const DEFAULT_REPO = 'https://github.com/avirtual/clodex';
const DEFAULT_BRANCH = 'master';
const DEFAULT_PORT = 7900;
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;   // a cold clone+install+rebuild is minutes
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
// A strict git-ref / repo-URL charset for values interpolated into the SSM
// wrapper. Covers https + git@ URLs and normal branch/tag names; REJECTS
// whitespace, newlines and shell/heredoc metachars — the single-quote escaping
// in buildPreamble does NOT neutralize a newline, and a newline can smuggle a
// heredoc-terminator line into the outer root wrapper (validate before interp).
const REF_RE = /^[A-Za-z0-9._:/@+~-]{1,256}$/;

// docker flavor (deploy docker <name>): birth a container node from the
// published, self-configuring image. The image bakes CLODEX_REMOTE_ENABLE/HOST
// + the headless CMD, so one `docker run` = one node (docker/web/Dockerfile).
const DOCKER_IMAGE_REPO = 'ghcr.io/avirtual/clodex';
const DOCKER_DEFAULT_TAG = 'latest';
const CONTAINER_PREFIX = 'clodexctl-';
const CONTAINER_WIRE_PORT = 7900;           // the wire's in-container port (baked)
const DOCKER_VERIFY_TIMEOUT_MS = 60 * 1000; // pull already happened in `run`; boot is seconds
const DOCKER_VERIFY_POLL_MS = 1000;

// ssh posture mirrors ssh-run.js: key-auth only (BatchMode), bounded dial,
// TOFU first contact, keepalives so a wedged step is caught. No shell string —
// argv is spawned directly.
const SSH_DEPLOY_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
];
const SSH_EXIT = 255;  // ssh's own connect/auth failure code

// Single-quote a value for POSIX sh: wrap in '…', escape embedded quotes. One
// safe literal word (peer-deploy.js:shSingleQuote, reimplemented).
function shSingleQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;
}

// Resolve the packaged script relative to THIS module (cli/src/deploy.js →
// cli/deploy/clodex-deploy.sh). Works for `npm i -g` and in-repo runs both.
function scriptPath() {
  return path.join(__dirname, '..', 'deploy', 'clodex-deploy.sh');
}
function readScript() {
  try { return fs.readFileSync(scriptPath(), 'utf8'); }
  catch (e) { throw new CliError(EXIT.SERVER, `deploy script unreadable at ${scriptPath()}: ${e.message}`); }
}

// Build the export preamble the remote bash inherits (params ride the
// environment, NOT the shell command). Each value single-quote-escaped so a
// quote/space in a repo URL or path can't break out. CLODEX_SRC only when set —
// otherwise the script's own $HOME/wb-wrap-ui default stands (one source of
// truth). Returns a string ending in '\n', prepend it to the script.
//
// claudeToken (ssh flavor ONLY): the Claude OAuth token rides the SAME stdin the
// script does (`ssh host 'bash -s'`) — the ssh channel is the auth boundary and
// isn't logged, so a secret in its env-export line is fine (never argv, never
// ps). The installer's service step writes it into the unit drop-in when
// CLODEX_CLAUDE_TOKEN is set. The SSM flavor MUST NOT use this — its wrapper text
// lands in CloudTrail; buildSsmScript calls this with no claudeToken and delivers
// the secret post-verify over the encrypted wire instead.
//
// noWirescope (--no-wirescope, T49): CLODEX_NO_WIRESCOPE=1 tells the installer
// to (a) skip the wirescope-only python venv/pip sys-deps (best-effort) and
// (b) pin CLODEX_WIRESCOPE=off into the service env via a systemd drop-in —
// the engine's autoStartWanted() honors that over the proxyEnabled pref.
function buildPreamble({ port = DEFAULT_PORT, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, src = null, claudeToken = null, noWirescope = false } = {}) {
  let line = `export PORT=${shSingleQuote(port)} REPO_URL=${shSingleQuote(repo)} BRANCH=${shSingleQuote(branch)}`;
  if (src) line += ` CLODEX_SRC=${shSingleQuote(src)}`;
  if (claudeToken) line += ` CLODEX_CLAUDE_TOKEN=${shSingleQuote(claudeToken)}`;
  if (noWirescope) line += ` CLODEX_NO_WIRESCOPE='1'`;
  return line + '\n';
}

// Read a Claude OAuth token from a local FILE (never argv — argv leaks via ps,
// mirroring docker's --env-file posture). Accepts either a RAW token or an
// env-file: a `CLAUDE_CODE_OAUTH_TOKEN=VALUE` line wins (docker --env-file
// shape), else the whole trimmed file is the token. Rejects empty / multi-line /
// control-char values (a token is a single opaque word; a newline could smuggle
// a second env-export line into the ssh preamble). Never printed — a bad file is
// a coded CliError with the PATH, never the contents.
function readClaudeToken(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new CliError(EXIT.USAGE, `--claude-token-file unreadable at ${file}: ${e.message}`); }
  let tok = null;
  // env-file line takes precedence (KEY=VALUE, optional surrounding whitespace).
  for (const ln of raw.split('\n')) {
    const m = ln.match(/^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*)$/);
    if (m) { tok = m[1].trim().replace(/^["']|["']$/g, ''); break; }
  }
  if (tok == null) tok = raw.trim();   // raw-token file
  if (!tok) throw new CliError(EXIT.USAGE, `--claude-token-file ${file} has no token (empty, or no CLAUDE_CODE_OAUTH_TOKEN=… line)`);
  if (/[\s\x00-\x1f]/.test(tok)) throw new CliError(EXIT.USAGE, `--claude-token-file ${file}: token has whitespace/control chars — expected a single opaque token or a CLAUDE_CODE_OAUTH_TOKEN=… line`);
  return tok;
}

// Build the shell snippet that writes the Claude-token systemd drop-in as the
// clodex user, fed over the wire into a throwaway bash session (ssm flavor). The
// token rides a shell VARIABLE assignment (single-quote-escaped) → it never
// enters a process argv/ps on the box; printf is a builtin. The drop-in lands
// 0600 (umask 077 for the mkdir, explicit chmod belt), then daemon-reload +
// restart pick it up (the restart drops the wire — the expected end of the
// delivery session). Pure + test-pinned; token is the ONLY interpolated value
// and it is shell-quoted.
function buildTokenDropinScript(token) {
  return [
    'set -e',
    `CLODEX_CLAUDE_TOKEN=${shSingleQuote(token)}`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DROPIN_DIR="$HOME/.config/systemd/user/clodex.service.d"',
    'DROPIN="$DROPIN_DIR/claude-token.conf"',
    '(umask 077; mkdir -p "$DROPIN_DIR"; printf \'[Service]\\nEnvironment=CLAUDE_CODE_OAUTH_TOKEN=%s\\n\' "$CLODEX_CLAUDE_TOKEN" > "$DROPIN")',
    'chmod 600 "$DROPIN"',
    'unset CLODEX_CLAUDE_TOKEN',
    'systemctl --user daemon-reload',
    'systemctl --user restart clodex.service',
  ].join('\n');
}

// Parse ONE line of the deploy script's ::marker stdout into a structured
// event. Fresh minimal parse of the documented grammar (spec: do NOT fork
// peer-deploy.js). Non-marker lines → { type:'log' }.
function parseMarker(rawLine) {
  const line = String(rawLine == null ? '' : rawLine);
  const m = line.match(/^::(\S+)\s?(.*)$/);
  if (!m) return { type: 'log', text: line };
  const rest = m[2];
  switch (m[1]) {
    case 'step': return { type: 'step', name: rest.trim() };
    case 'ok': return { type: 'ok', name: rest.trim() };
    case 'fail': {
      const sp = rest.indexOf(' ');
      const name = (sp >= 0 ? rest.slice(0, sp) : rest).trim();
      const reason = sp >= 0 ? rest.slice(sp + 1).trim() : '';
      return { type: 'fail', name, reason };
    }
    case 'need-sudo': return { type: 'need-sudo', what: rest.trim() };
    case 'sudo-cmd': return { type: 'sudo-cmd', command: rest.trim() };
    case 'done': return { type: 'done' };
    default: return { type: 'log', text: line };
  }
}

// The ssh argv for the deploy run: `ssh <opts> <extra> <host> 'bash -s'`.
// sshOpts is the repeatable raw --ssh-opt passthrough (typed strings only).
function sshDeployArgs(host, sshOpts = []) {
  return [...SSH_DEPLOY_ARGS, ...sshOpts, host, 'bash -s'];
}

// Derive a context name from an ssh destination: the bare host's short name,
// sanitized to the ctx-name charset. `user@host.example.com` → `host`.
function deriveCtxName(dest) {
  const host = String(dest || '').split('@').pop() || '';
  const short = host.split(':')[0].split('.')[0];
  const stem = short.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return NAME_RE.test(stem) ? stem : '';
}

// Run the script on the box over ssh, streaming stdout line-by-line to onLine
// (the marker stream) and stderr to onStderr (the script's human detail
// channel). Resolves { code, timedOut } — a non-zero/42 exit is a normal
// outcome the caller classifies, not a throw. Only a spawn failure (no ssh
// binary) rejects. Mirrors ssh-run.js; spawnFn is the test seam.
function runDeploy({ host, sshOpts = [], stdin, spawnFn = spawn, onLine = null, onStderr = null, timeoutMs = DEPLOY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('ssh', sshDeployArgs(host, sshOpts), { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return reject(e); }

    let lineBuf = '';
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);

    const emitLines = (chunk) => {
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const l = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (onLine) { try { onLine(l); } catch {} }
      }
    };

    if (child.stdout) child.stdout.on('data', (c) => emitLines(c.toString()));
    if (child.stderr) child.stderr.on('data', (c) => { if (onStderr) { try { onStderr(c.toString()); } catch {} } });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (onLine && lineBuf.length) { try { onLine(lineBuf); } catch {} }   // flush trailing partial
      resolve({ code: timedOut ? null : code, timedOut });
    });

    try { if (child.stdin) { child.stdin.write(stdin); child.stdin.end(); } } catch {}
  });
}

// Probe the freshly-deployed wire through an ssh tunnel (the existing
// openTransport ssh path, remotePort = the deploy port). Returns the hello
// payload, or throws a coded CliError. spawnFn is the tunnel's test seam.
async function probeHello(dest, port, { spawnFn } = {}) {
  const t = await openTransport({ ssh: dest, remotePort: port }, { spawnFn });
  try {
    const client = new WireClient(t.baseUrl, null);   // no token — tunnel is the boundary
    return await client.get('/api/peer/hello', 'deploy (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

// An ssh destination is the same charset the GUI's classifyPeerDest accepts:
// user@host / bare host / IPv4 / ssh-config alias. No spaces, no scheme.
const DEST_RE = /^[a-zA-Z0-9._@-]{1,128}$/;

function parsePortOr(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) throw new CliError(EXIT.USAGE, '--port must be a port number (1-65535)');
  return n;
}

// deploy verb — orchestration. Throws CliError (caught by main.run's try). io
// carries the injectable seams: spawnFn (ssh child, for both the deploy run and
// the verify tunnel), probeHello (verify override for tests), contextsFile.
//
// --json emits an NDJSON stream: one object per marker line, then a final
// { type:'verify'|'context'|'error' } object — the machine binding for a deploy.
async function deployVerb({ printer, flags, args, io = {} }) {
  const dest = args[0];
  if (!dest) throw new CliError(EXIT.USAGE, 'deploy needs an ssh destination (e.g. user@host)');
  if (!DEST_RE.test(dest)) throw new CliError(EXIT.USAGE, `bad ssh destination "${dest}" — use user@host / host / IP (set a port in ~/.ssh/config, not host:port)`);

  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  const repo = flags.repo ? String(flags.repo) : DEFAULT_REPO;
  const branch = flags.branch ? String(flags.branch) : DEFAULT_BRANCH;
  const src = flags.src ? String(flags.src) : null;
  const sshOpts = Array.isArray(flags['ssh-opt']) ? flags['ssh-opt'] : (flags['ssh-opt'] ? [String(flags['ssh-opt'])] : []);
  // Claude auth (optional): read the OAuth token from a local file (never argv),
  // then let it ride the ssh stdin as an env-export in the preamble — the ssh
  // channel is the auth boundary. Never printed, never in argv.
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const noWirescope = !!flags['no-wirescope'];
  const script = readScript();
  const preamble = buildPreamble({ port, repo, branch, src, claudeToken, noWirescope });
  const stdin = preamble + script;
  const ctxName = flags.name ? String(flags.name) : deriveCtxName(dest);
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);

  // --dry-run: describe, run nothing.
  if (flags['dry-run']) {
    if (json) { emit({ type: 'dry-run', host: dest, port, repo, branch, src: src || null, scriptBytes: script.length, claudeToken: !!claudeToken, noWirescope, ctxName: flags['no-ctx'] ? null : (ctxName || null) }); return; }
    printer.line([
      `dry-run — would deploy to ${dest}:`,
      `  port    ${port}`,
      `  repo    ${repo}`,
      `  branch  ${branch}`,
      src ? `  src     ${src}` : null,
      `  script  ${script.length} bytes (${scriptPath()})`,
      claudeToken ? '  claude  token from --claude-token-file (rides ssh stdin, redacted)' : null,
      noWirescope ? '  wirescope disabled (CLODEX_WIRESCOPE=off drop-in; python venv/pip deps skipped)' : null,
      flags['no-ctx'] ? '  context (skipped — --no-ctx)' : `  context ${ctxName || '(none — pass --name)'}`,
    ].filter(Boolean).join('\n'));
    return;
  }

  // Stream the marker run. Human mode renders a live step list; --json emits one
  // object per marker line. Script stderr passes through to our stderr.
  const sudoCmds = [];
  let sawDone = false;
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  const onLine = (raw) => {
    const ev = parseMarker(raw);
    if (json) { emit(ev); }
    else {
      switch (ev.type) {
        case 'step': printer.line(`→ ${ev.name} …`); break;
        case 'ok': printer.line(`  ${ev.name} ok`); break;
        case 'fail': printer.line(`  ${ev.name} FAILED${ev.reason ? ` — ${ev.reason}` : ''}`); break;
        case 'need-sudo': printer.line(`  needs sudo: ${ev.what}`); break;
        case 'sudo-cmd': printer.line(`    ${ev.command}`); break;
        case 'done': /* summarized below */ break;
        default: if (ev.text) printer.line(`  ${ev.text}`); break;
      }
    }
    if (ev.type === 'sudo-cmd') sudoCmds.push(ev.command);
    if (ev.type === 'done') sawDone = true;
  };

  let res;
  try {
    res = await runDeploy({ host: dest, sshOpts, stdin, spawnFn: io.spawnFn, onLine, onStderr: (s) => writeErr(s) });
  } catch (e) {
    throw new CliError(EXIT.CONNECT, `deploy could not start ssh: ${e.message}`);
  }

  if (res.timedOut) throw new CliError(EXIT.SERVER, `deploy timed out on ${dest} — re-run to resume (the script is idempotent)`);
  if (res.code === SSH_EXIT) throw new CliError(EXIT.CONNECT, `ssh could not connect to ${dest} (auth/host/network) — check \`ssh ${dest}\` works`);

  // exit 42 = the script needs root it can't get non-interactively. Surface the
  // exact commands and stop — the operator runs them on the box, then re-runs.
  if (res.code === 42) {
    if (json) { emit({ type: 'error', reason: 'need-sudo', sudoCmds }); }
    else {
      printer.line('');
      printer.line(`deploy needs root on ${dest}. Run these on the box, then re-run \`clodexctl deploy ${dest}\`:`);
      for (const c of sudoCmds) printer.line(`  ${c}`);
    }
    throw new CliError(EXIT.SERVER, `deploy incomplete — ${sudoCmds.length} sudo command(s) must be run on ${dest} first`);
  }
  if (res.code !== 0 || !sawDone) {
    if (json) emit({ type: 'error', reason: 'failed', code: res.code });
    throw new CliError(EXIT.SERVER, `deploy failed on ${dest} (exit ${res.code == null ? '?' : res.code})`);
  }

  // Verify the wire through an ssh tunnel — deploy is not "done" until it answers.
  let hello;
  try {
    const probe = io.probeHello || probeHello;
    hello = await probe(dest, port, { spawnFn: io.spawnFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`installed, but the wire did not answer through the tunnel: ${e.message}`);
    throw e instanceof CliError ? e : new CliError(EXIT.SERVER, `deploy verify failed: ${e.message}`);
  }
  if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
  else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} on ${dest}:${port}`);

  // Upsert the context (no token — tunnel is the auth boundary). Collision:
  // skip+warn unless --force. --no-ctx opts out.
  if (flags['no-ctx']) {
    if (json) emit({ type: 'context', action: 'skipped', reason: '--no-ctx' });
    return;
  }
  if (!ctxName) {
    if (json) emit({ type: 'context', action: 'skipped', reason: 'no valid name — pass --name' });
    else printer.line(`(no context saved — could not derive a name from ${dest}; pass --name)`);
    return;
  }
  const store = safeLoadContexts(io);
  const exists = Object.prototype.hasOwnProperty.call(store.contexts, ctxName);
  if (exists && !flags.force) {
    if (json) emit({ type: 'context', action: 'skipped', name: ctxName, reason: 'exists — --force to overwrite' });
    else printer.line(`context "${ctxName}" already exists — kept it (--force to overwrite). Use: clodexctl --ctx ${ctxName} sessions`);
    return;
  }
  // webPort (T42): the installer enables the web GUI on wire-port+1 (loopback);
  // save it so `clodexctl web <ctx>` tunnels to the right remote port.
  const webPort = port + 1;
  store.contexts[ctxName] = { ssh: dest, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}), webPort };
  if (!store.current) store.current = ctxName;
  contexts.save(store, io.contextsFile);
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name: ctxName, webPort });
  else {
    printer.line(`context "${ctxName}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${ctxName} sessions`);
    printer.line(`  see it in your browser: clodexctl web ${ctxName}`);
  }
}

// Tolerant contexts load (an absent/garbled file → empty store; deploy still
// wrote a live node, so never fail the whole deploy over the local ctx file).
function safeLoadContexts(io) {
  try { return contexts.load(io.contextsFile, { warn: () => {} }); }
  catch { return { current: null, contexts: {} }; }
}

// ── docker flavor: `clodexctl deploy docker <name>` ──────────────────────────
//
// A CLI-owned container node is the MINIMAL box — one `docker run` of the
// published, self-configuring image (NOT the GUI's managed sandbox: no compose,
// no registry row, no library binds; a plain peer named clodexctl-<name>). The
// system `docker` binary is the operator's tool, spawned argv-direct like ssh —
// zero SDKs, never a shell. Secrets only ride the operator's --env-file, passed
// straight through by PATH; we never read or print it.

// Normalize a --host value into a DOCKER_HOST URL. Bare `user@box` is sugar for
// `ssh://user@box` (docker's own ssh transport). A value that already carries a
// scheme (ssh:// tcp:// unix://) is passed through untouched.
function normalizeDockerHost(h) {
  const s = String(h == null ? '' : h).trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `ssh://${s}`;
}

// Derive the ssh destination (user@host) for our verify tunnel from a
// ssh://user@host[:port][/path] DOCKER_HOST. Only ssh:// hosts are tunnel-able;
// a non-ssh DOCKER_HOST (tcp/unix) returns '' (no ssh verify path).
function dockerHostToSshDest(dockerHost) {
  const s = String(dockerHost || '');
  const m = s.match(/^ssh:\/\/([^/]+)/i);
  if (!m) return '';
  return m[1].replace(/:\d+$/, '');   // strip a trailing :port — belongs in ~/.ssh/config
}

// Compose the `docker run` argv (pure — leaf-tested). Loopback publish is the
// trust boundary; --hostname is the engine's SELF_LABEL on the peer wire (must
// be unique per node or DM routing collides). --env-file and extra -v ride
// straight through in the operator's order.
// --no-wirescope (T49) rides as -e CLODEX_WIRESCOPE=off — the engine-level
// kill-switch (a fixed literal, no value interpolation).
function dockerRunArgs({ name, port = DEFAULT_PORT, image, envFile = null, volumes = [], noWirescope = false } = {}) {
  const cname = CONTAINER_PREFIX + name;
  const argv = [
    'run', '-d',
    '--name', cname,
    '--hostname', name,
    '--restart', 'unless-stopped',
    '-p', `127.0.0.1:${port}:${CONTAINER_WIRE_PORT}`,
    '-v', `${cname}-data:/data`,
  ];
  if (noWirescope) argv.push('-e', 'CLODEX_WIRESCOPE=off');
  if (envFile) argv.push('--env-file', envFile);
  for (const v of volumes) { argv.push('-v', v); }
  argv.push(image);
  return argv;
}

// Run the system docker binary argv-direct. DOCKER_HOST rides the child env when
// remote (docker handles its own ssh). stdout is captured (the container id);
// stderr streams through onStderr (pull progress, errors). Resolves
// { code, stdout } on exit; rejects only on a spawn failure (e.g. no docker
// binary → ENOENT) so the caller can render a clear "is docker installed?".
// spawnFn is the test seam.
function runDocker({ args, env = null, spawnFn = spawn, onStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    const opts = { stdio: ['ignore', 'pipe', 'pipe'] };
    if (env) opts.env = env;
    try {
      child = spawnFn('docker', args, opts);
    } catch (e) { return reject(e); }

    let stdout = '';
    let done = false;
    if (child.stdout) child.stdout.on('data', (c) => { stdout += c.toString(); });
    if (child.stderr) child.stderr.on('data', (c) => { if (onStderr) { try { onStderr(c.toString()); } catch {} } });
    child.on('error', (e) => { if (done) return; done = true; reject(e); });
    child.on('exit', (code) => { if (done) return; done = true; resolve({ code, stdout: stdout.trim() }); });
  });
}

// Poll the freshly-run node's wire until it answers or the deadline lapses.
// ctx is a transport descriptor ({url} local / {ssh,remotePort} remote) with NO
// token — we never saw one. A 200 hello → { ok:true, hello }. A 401/403 (the
// image was seeded a CLODEX_REMOTE_TOKEN via --env-file) → { ok:true,
// tokenGated:true } and we STOP: the node is up, auth is the operator's setting.
// A connect/other failure retries to the deadline; timeout → coded CliError.
async function pollHello(ctx, { spawnFn, timeoutMs = DOCKER_VERIFY_TIMEOUT_MS, pollMs = DOCKER_VERIFY_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    let t = null;
    try {
      t = await openTransport(ctx, { spawnFn });
      const client = new WireClient(t.baseUrl, null);   // no token — probe unauthenticated
      const hello = await client.get('/api/peer/hello', 'deploy docker (verify)');
      return { ok: true, hello };
    } catch (e) {
      if (e instanceof CliError && e.exitCode === EXIT.AUTH) return { ok: true, tokenGated: true };
      lastErr = e;
    } finally {
      if (t) { try { t.close(); } catch {} }
    }
    if (Date.now() >= deadline) {
      throw new CliError(EXIT.SERVER, `container is up but its wire did not answer within ${Math.round(timeoutMs / 1000)}s${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// deploy docker <name> — orchestration. Same io seams as deployVerb, plus
// io.pollHello (verify override for tests). Throws CliError (caught by main.run).
async function deployDockerVerb({ printer, flags, args, io = {} }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy docker needs a node name (e.g. deploy docker mybox)');
  if (!NAME_RE.test(name)) throw new CliError(EXIT.USAGE, `bad node name "${name}" — use ${NAME_RE.source}`);

  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  const tag = flags.tag ? String(flags.tag) : DOCKER_DEFAULT_TAG;
  const image = flags.image ? String(flags.image) : `${DOCKER_IMAGE_REPO}:${tag}`;
  const envFile = flags['env-file'] ? String(flags['env-file']) : null;
  const volumes = Array.isArray(flags.volume) ? flags.volume : (flags.volume ? [String(flags.volume)] : []);
  const dockerHost = flags.host ? normalizeDockerHost(flags.host) : '';
  const sshDest = dockerHost ? dockerHostToSshDest(dockerHost) : '';
  const noWirescope = !!flags['no-wirescope'];
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);

  const runArgs = dockerRunArgs({ name, port, image, envFile, volumes, noWirescope });

  // --dry-run: describe the exact argv (secrets never appear — the env-file is a
  // PATH, its contents are docker's to read), run nothing.
  if (flags['dry-run']) {
    if (json) { emit({ type: 'dry-run', name, container: CONTAINER_PREFIX + name, port, image, dockerHost: dockerHost || null, argv: runArgs, envFile: envFile || null }); return; }
    printer.line([
      `dry-run — would run docker to birth "${name}":`,
      dockerHost ? `  DOCKER_HOST=${dockerHost}` : null,
      `  docker ${runArgs.join(' ')}`,
      envFile ? `  (env-file ${envFile} passed to docker unread)` : '  (no --env-file — loopback, no token)',
      flags['no-ctx'] ? '  context (skipped — --no-ctx)' : `  context ${name}`,
    ].filter(Boolean).join('\n'));
    return;
  }

  // Spawn docker argv-direct. DOCKER_HOST in the child env when remote.
  const childEnv = dockerHost ? { ...(io.env || process.env), DOCKER_HOST: dockerHost } : null;
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  let res;
  try {
    res = await runDocker({ args: runArgs, env: childEnv, spawnFn: io.spawnFn, onStderr: (s) => { if (!json) writeErr(s); } });
  } catch (e) {
    // ENOENT-shape spawn failure = docker isn't installed / not on PATH. Not a
    // usage error (the argv was fine) nor a wire-connect failure — it's an
    // environment/server-side failure with a pointed hint. (journal choice #2)
    if (e && (e.code === 'ENOENT' || /ENOENT|not found/i.test(e.message || ''))) {
      throw new CliError(EXIT.SERVER, `could not run docker: ${e.message} — is docker installed and on PATH?`);
    }
    throw new CliError(EXIT.SERVER, `could not run docker: ${e.message}`);
  }
  if (res.code !== 0) {
    if (json) emit({ type: 'error', reason: 'docker-run-failed', code: res.code });
    throw new CliError(EXIT.SERVER, `docker run failed (exit ${res.code == null ? '?' : res.code}) — see docker's output above`);
  }
  const containerId = res.stdout ? res.stdout.split('\n').pop().trim() : '';
  if (!json) printer.line(`started container ${CONTAINER_PREFIX + name}${containerId ? ` (${containerId.slice(0, 12)})` : ''}`);

  // Verify: poll hello. Local → direct url. Remote → ssh tunnel to the box's
  // loopback (only ssh:// DOCKER_HOSTs are tunnel-able).
  let ctx;
  if (sshDest) ctx = { ssh: sshDest, remotePort: port };
  else ctx = { url: `http://127.0.0.1:${port}` };

  let probe;
  try {
    const poll = io.pollHello || pollHello;
    probe = await poll(ctx, { spawnFn: io.spawnFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`container started, but the wire did not answer: ${e.message}`);
    throw e instanceof CliError ? e : new CliError(EXIT.SERVER, `verify failed: ${e.message}`);
  }

  if (probe.tokenGated) {
    if (json) emit({ type: 'verify', ok: true, tokenGated: true });
    else printer.line('node is up and token-gated (401) — add the context with your token: clodexctl ctx add …');
  } else {
    const hello = probe.hello || {};
    if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
    else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'}`);
  }

  // Upsert the context (no token — we never saw the operator's env-file).
  // Local → {url}; remote → {ssh, remotePort}. Collision skip unless --force.
  if (flags['no-ctx']) {
    if (json) emit({ type: 'context', action: 'skipped', reason: '--no-ctx' });
    return;
  }
  const store = safeLoadContexts(io);
  const exists = Object.prototype.hasOwnProperty.call(store.contexts, name);
  if (exists && !flags.force) {
    if (json) emit({ type: 'context', action: 'skipped', name, reason: 'exists — --force to overwrite' });
    else printer.line(`context "${name}" already exists — kept it (--force to overwrite). Use: clodexctl --ctx ${name} sessions`);
    return;
  }
  const entry = sshDest
    ? { ssh: sshDest, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}) }
    : { url: `http://127.0.0.1:${port}` };
  store.contexts[name] = entry;
  if (!store.current) store.current = name;
  contexts.save(store, io.contextsFile);
  const hint = probe.tokenGated ? ' (token-gated — add your token: clodexctl ctx add …)' : '';
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name, tokenGated: !!probe.tokenGated });
  else printer.line(`context "${name}" ${exists ? 'updated' : 'saved'}${hint} — you can now: clodexctl --ctx ${name} sessions`);
}

// ── ssm flavor: `clodexctl deploy ssm <name> --target i-INSTANCE` ────────────
//
// The OS flavor (NOT docker) over AWS SSM RunCommand — no ssh, no open ports.
// The agent is a first-class citizen of the box: a dedicated `clodex` host user
// running the SAME systemd --user service the ssh flavor installs (docker adds
// no real security on an instance we already own; the boundary is SSM/IAM).
//
// SSM has no clean stdin/stdout exec pipe (send-command is async, output polled,
// 24KB capped), so the interactive git-clone-over-ssh path can't ride it. Since
// RunCommand runs as ROOT, the exit-42 "needs sudo" dance INVERTS: one root
// wrapper installs prereqs itself, mints the clodex user, then runs the PINNED
// clodex-deploy.sh (byte-for-byte the drift-gated installer) as that user via
// `sudo -iu clodex bash -s`. Streaming loss is accepted: send one command, poll
// status, relay the ^:: marker trail (pseudo-streamed as partial output grows).
//
// Zero AWS SDK: we shell out to the operator's own `aws` binary argv-direct
// (execFn seam, same pattern as transport.js:resolveEcsTarget), never a shell.
// The wire is always token-gated (a minted CLODEX_REMOTE_TOKEN). The installer
// itself is TOKENLESS (ssh flavor = tunnel-is-auth); the token is injected AFTER
// it runs, via a systemd --user drop-in the app reads through its native env
// precedence (CLODEX_REMOTE_TOKEN wins) — so the installer bytes stay identical
// (the drift test is the gate; we never fork it). That token rides inside the
// send-command parameters → visible in the account's SSM history/CloudTrail;
// acceptable ONLY because the port never leaves loopback (reaching it needs
// ssm:StartSession on the same account) — say it out loud in the docs, and
// "re-run deploy to rotate" is the mitigation.
const SSM_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;  // a cold clone+install+rebuild is minutes
const SSM_POLL_MS = 5000;                       // get-command-invocation cadence
const SSM_PREPOLL_MS = 2000;                    // let SSM register the invocation before the first poll
const SSM_SEND_RETRY_MS = 2000;                 // backoff between send-command retries
const SSM_SEND_RETRIES = 3;                     // InvalidInstanceId is eventually-consistent post-registration

// A no-op-in-tests sleep seam (injected via io.sleepFn; real setTimeout by default).
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build the root wrapper script for AWS-RunShellScript — pure and test-pinned.
// port is int and token is hex by construction; repo/branch are validated
// against REF_RE by the caller (deploySsmVerb) before they reach here, so no
// interpolated value can carry a newline. Defense-in-depth: the two embedding
// heredocs use a per-run RANDOM nonce delimiter (CLODEX_EOF_<hex>), so even a
// field that slipped validation could not guess the terminator line. No
// `set -e`: each load-bearing step gates explicitly with
// `|| { echo "::fail …"; exit 1; }` (mirrors the installer's discipline),
// best-effort steps use `|| true`.
//
// Five steps, each emitting a ::step marker so the relayed trail reads like the
// ssh flavor's; the installer's own ^:: markers are filtered in from its log.
function buildSsmScript({ port = DEFAULT_PORT, token, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, noWirescope = false } = {}) {
  // preamble + the byte-identical installer, fed verbatim to the clodex user's
  // bash. The installer bytes are the SAME readScript() the drift test pins —
  // the token is NOT here (installer is tokenless); it's injected in step 4.
  // noWirescope rides the preamble (CLODEX_NO_WIRESCOPE=1): the installer
  // itself writes the CLODEX_WIRESCOPE=off drop-in and skips the python
  // venv/pip deps — same mechanism as the ssh flavor, not a fork.
  const embedded = buildPreamble({ port, repo, branch, noWirescope }) + readScript();
  // Unguessable per-run heredoc delimiters (hex can't contain the delimiter, and
  // a validated repo/branch can't either — this is the belt to validation's
  // suspenders).
  const nonce = crypto.randomBytes(8).toString('hex');
  const INSTALL_EOF = `CLODEX_EOF_${nonce}`;
  const TOKEN_EOF = `CLODEX_TOKEN_EOF_${nonce}`;
  return [
    '#!/bin/sh',
    '# clodex deploy ssm wrapper — runs as root via AWS-RunShellScript. Emits',
    '# ::step/::ok/::fail markers on stdout; the pinned installer runs as the',
    '# clodex user and its own marker trail is filtered in from its log.',
    '',
    '# 0. portcheck (root): fail FAST if the wire PORT is already held by something',
    "#    that ISN'T our clodex service. Run 3's silent 30s-then-no-hello was a",
    '#    manual container squatting on the wire port — root sees every listener, so',
    '#    we can name the holder. Held by the clodex USER = a prior deploy (redeploy',
    '#    restarts it) → normal. Anything else → ::fail with the holder named. Only',
    '#    ${port} (numerically validated by parsePortOr) enters these lines — every',
    '#    other value is on-box command output, never caller data.',
    'echo "::step portcheck"',
    'PORT_LINE=""',
    `command -v ss >/dev/null 2>&1 && PORT_LINE=$(ss -tlnpH "sport = :${port}" 2>/dev/null | head -n1)`,
    'if [ -n "$PORT_LINE" ]; then',
    "  HPID=$(printf '%s' \"$PORT_LINE\" | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)",
    '  HUSER=""; HCMD=""',
    '  if [ -n "$HPID" ]; then',
    '    HUSER=$(ps -o user= -p "$HPID" 2>/dev/null | tr -d "[:space:]")',
    '    HCMD=$(ps -o comm= -p "$HPID" 2>/dev/null | tr -d "[:space:]")',
    '  fi',
    '  if [ "$HUSER" = "clodex" ]; then',
    `    echo "::log port ${port} already held by our clodex service (pid \${HPID:-?}) — redeploy restarts it"`,
    '  elif [ -z "$HPID" ]; then',
    '    # Listener present but ss gave no pid= (unusual ss output). Ambiguous data',
    '    # must not hard-block a legitimate redeploy — warn and fall through to the',
    '    # old behavior (verify times out if the holder really is foreign).',
    `    echo "::log port ${port} is held but the holder could not be identified — continuing; verify will catch a real conflict"`,
    '  else',
    `    echo "::fail portcheck port-${port}-held-by-\${HUSER:-unknown}-\${HCMD:-proc}-pid-\${HPID:-unknown}"`,
    '    exit 1',
    '  fi',
    'fi',
    'echo "::ok portcheck"',
    '',
    '# 1. prereqs (root): git, curl, node>=20, npm + the node-pty build toolchain —',
    '#    best-effort, PER-PACKAGE so one conflicting package (e.g. full curl vs',
    '#    curl-minimal on AL2023) cannot take down the rest of the transaction. A',
    '#    package whose command already exists is skipped (curl-minimal already',
    '#    provides curl(1), avoiding the conflict). The toolchain (compiler+make+',
    '#    python3) is what the pinned installer needs to rebuild node-pty for the',
    "#    Node ABI — it's family-named (rpm: gcc-c++; apt: build-essential).",
    'echo "::step prereqs"',
    'PM= ; TOOLCHAIN=',
    'if command -v dnf >/dev/null 2>&1; then PM="dnf install -y"; TOOLCHAIN="gcc-c++ make python3"',
    'elif command -v yum >/dev/null 2>&1; then PM="yum install -y"; TOOLCHAIN="gcc-c++ make python3"',
    'elif command -v apt-get >/dev/null 2>&1; then apt-get update >&2 || true; PM="apt-get install -y"; TOOLCHAIN="build-essential python3"',
    'fi',
    'if [ -n "$PM" ]; then',
    '  for pkg in git curl nodejs npm $TOOLCHAIN; do',
    '    case "$pkg" in',
    '      nodejs) cmd=node ;;',
    '      gcc-c++|build-essential) cmd=g++ ;;',
    '      *) cmd=$pkg ;;',
    '    esac',
    '    command -v "$cmd" >/dev/null 2>&1 && continue',
    '    $PM "$pkg" >&2 || true',
    '  done',
    'fi',
    "NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)",
    'if [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then',
    '  # packaged node too old/missing — NodeSource setup_20.x fallback per family.',
    '  if command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then',
    '    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >&2 || true',
    '    { dnf install -y nodejs >&2 || yum install -y nodejs >&2; } || true',
    '  elif command -v apt-get >/dev/null 2>&1; then',
    '    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >&2 || true',
    '    apt-get install -y nodejs >&2 || true',
    '  fi',
    "  NODE_MAJOR=$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)",
    'fi',
    '[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || { echo "::fail prereqs node-missing-or-too-old-need-20+"; exit 1; }',
    'command -v git >/dev/null 2>&1 || { echo "::fail prereqs git-not-found"; exit 1; }',
    'command -v npm >/dev/null 2>&1 || { echo "::fail prereqs npm-not-found"; exit 1; }',
    'echo "::ok prereqs"',
    '',
    '# 2. user (root): a dedicated clodex user + linger so the --user service runs loginless.',
    'echo "::step user"',
    'id clodex >/dev/null 2>&1 || useradd -m clodex >&2 || { echo "::fail user useradd-failed"; exit 1; }',
    'loginctl enable-linger clodex >/dev/null 2>&1 || true',
    'echo "::ok user"',
    '',
    '# 3. installer (as clodex): the PINNED clodex-deploy.sh, byte-for-byte. Full',
    '#    output is parked in a log; only its ^:: marker lines are surfaced (24KB cap).',
    'echo "::step install"',
    'CLODEX_LOG=/home/clodex/clodex-deploy.log',
    `sudo -iu clodex bash -s > "$CLODEX_LOG" 2>&1 <<'${INSTALL_EOF}'`,
    embedded,
    INSTALL_EOF,
    'rc=$?',
    "grep -E '^::' \"$CLODEX_LOG\" 2>/dev/null || true",
    'echo "::log $CLODEX_LOG"',
    '[ "$rc" = "0" ] || { echo "::fail install installer-rc=$rc"; exit 1; }',
    'echo "::ok install"',
    '',
    '# 4. token (as clodex): inject the minted wire token into the --user service',
    '#    environment via a systemd drop-in, then reload+restart to pick it up.',
    'echo "::step token"',
    `sudo -iu clodex bash -s <<'${TOKEN_EOF}'`,
    'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DROPIN_DIR="$HOME/.config/systemd/user/clodex.service.d"',
    'DROPIN="$DROPIN_DIR/remote-token.conf"',
    'mkdir -p "$DROPIN_DIR" || exit 1',
    'chmod 700 "$DROPIN_DIR" || exit 1',
    'umask 077',
    'cat > "$DROPIN" <<\'CONF\'',
    '[Service]',
    `Environment=CLODEX_REMOTE_TOKEN=${token}`,
    'CONF',
    'chmod 600 "$DROPIN" || exit 1',
    'systemctl --user daemon-reload || exit 1',
    'systemctl --user restart clodex.service || exit 1',
    TOKEN_EOF,
    'rc=$?',
    '[ "$rc" = "0" ] || { echo "::fail token drop-in-rc=$rc"; exit 1; }',
    'echo "::ok token"',
    '',
    '# 5. verify (root): bounded on-box hello WITH the token → a parseable marker.',
    '#    Laptop-side verify through the real SSM tunnel is the authoritative gate,',
    '#    so this marker is NON-FATAL: ::ok verify only on 200, else ::fail verify',
    '#    (distinguishes "node never came up" from "tunnel/IAM problem").',
    'echo "::step verify"',
    'code=000',
    'i=0',
    'while [ "$i" -lt 30 ]; do',
    `  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" http://127.0.0.1:${port}/api/peer/hello 2>/dev/null || echo 000)`,
    '  [ "$code" = "200" ] && break',
    '  i=$((i+1)); sleep 1',
    'done',
    'echo "::verify http=$code"',
    'if [ "$code" = "200" ]; then echo "::ok verify"; else echo "::fail verify http=$code"; fi',
    'echo "::done"',
  ].join('\n') + '\n';
}

// The `aws` base flags in the SAME order as transport.js:resolveEcsTarget
// (profile before region) so a reader compares them one-to-one.
function awsBase({ region, profile } = {}) {
  return [
    ...(profile ? ['--profile', profile] : []),
    ...(region ? ['--region', region] : []),
  ];
}

// argv builders — full argv (leading 'aws') so they double as the single source
// for both execution and --dry-run display. --parameters is real JSON built
// with JSON.stringify (never string-pasted), same discipline as ssmArgv.
function ssmDescribeArgs({ target, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ssm', 'describe-instance-information',
    '--filters', `Key=InstanceIds,Values=${target}`,
    '--output', 'json'];
}
function ssmSendCommandArgs({ target, region, profile, script } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ssm', 'send-command',
    '--document-name', 'AWS-RunShellScript',
    '--instance-ids', target,
    '--parameters', JSON.stringify({ commands: [script] }),
    '--query', 'Command.CommandId', '--output', 'text'];
}
function ssmGetInvocationArgs({ commandId, target, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ssm', 'get-command-invocation',
    '--command-id', commandId,
    '--instance-id', target,
    '--output', 'json'];
}

// Run an aws argv through the injectable execFn (default promisified execFile —
// NEVER a shell). ENOENT → the "is aws installed?" hint; any other failure →
// a coded CliError with aws's own stderr relayed. Returns trimmed stdout.
async function runAws(execFn = execFileP, argv, what, code = EXIT.CONNECT) {
  try {
    const { stdout } = await execFn(argv[0], argv.slice(1));
    return String(stdout).trim();
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || ''))) {
      throw new CliError(EXIT.CONNECT, 'aws CLI not found — is it installed and on PATH?');
    }
    const stderr = ((e && (e.stderr || e.message)) || '').toString().trim();
    throw new CliError(code, `aws ${what} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

// Preflight: the instance must be registered with SSM and online, or the
// RunCommand will silently never arrive. describe-instance-information returns
// an InstanceInformationList; empty → not registered; PingStatus!=Online →
// offline. Both are EXIT.CONNECT with a pointed hint.
async function ssmPreflight({ target, region, profile }, { execFn = execFileP } = {}) {
  const out = await runAws(execFn, ssmDescribeArgs({ target, region, profile }), 'describe-instance-information');
  let list = [];
  try { list = (JSON.parse(out || '{}').InstanceInformationList) || []; } catch { list = []; }
  const info = list.find((x) => x && x.InstanceId === target) || list[0];
  if (!info) {
    throw new CliError(EXIT.CONNECT,
      `instance ${target} is not registered with SSM — install/start the SSM agent and attach the AmazonSSMManagedInstanceCore role`);
  }
  if (info.PingStatus && info.PingStatus !== 'Online') {
    throw new CliError(EXIT.CONNECT, `instance ${target} is registered but ${info.PingStatus} (SSM agent not reporting)`);
  }
  return info;
}

// Fire the RunShellScript. Returns the CommandId (send-command --query yields
// the bare id via --output text). InvalidInstanceId is eventually-consistent
// right after the SSM agent registers (preflight saw it Online, but send-command
// can still 400 for a beat) — retry a bounded few times with a short backoff.
async function ssmSendCommand({ target, region, profile, script }, { execFn = execFileP, retries = SSM_SEND_RETRIES, retryMs = SSM_SEND_RETRY_MS, sleepFn = defaultSleep } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const id = await runAws(execFn, ssmSendCommandArgs({ target, region, profile, script }), 'send-command', EXIT.SERVER);
      const commandId = id.split('\n').pop().trim();
      if (!commandId) throw new CliError(EXIT.SERVER, 'send-command returned no CommandId');
      return commandId;
    } catch (e) {
      if (attempt++ < retries && e instanceof CliError && /InvalidInstanceId/.test(e.message || '')) {
        await sleepFn(retryMs);
        continue;
      }
      throw e;
    }
  }
}

// Pseudo-streaming: get-command-invocation returns PARTIAL
// StandardOutputContent while InProgress, so we surface NEW ::marker lines as
// they appear. Keep a rendered cursor (count of ^:: lines already emitted); each
// tick, diff the current output's ^:: lines against it and fire onMarker only for
// the fresh ones. A line rendered mid-run never re-fires when the final superset
// arrives (the trail is monotonic: partial output is a prefix that only grows).
//
// Only lines TERMINATED by a newline count: a poll that catches output mid-echo
// (a partial trailing `::ok prer`) must not fire a truncated marker that the
// cursor would then swallow when the real line arrives. The final invocation's
// output is newline-terminated by the wrapper's `echo`s, so no marker is lost.
function ssmMarkerLines(stdout) {
  const s = String(stdout || '');
  const nl = s.lastIndexOf('\n');
  if (nl < 0) return [];
  return s.slice(0, nl).split('\n').filter((l) => /^::/.test(l));
}

// Poll get-command-invocation until a terminal status or the budget lapses.
// A freshly-issued command 404s as InvocationDoesNotExist for a beat — tolerate
// it until the deadline. onStatus fires on each observed (changed) status;
// onMarker fires once per fresh ^:: line as partial output grows. Returns
// { status, responseCode, stdout, stderr, markersStreamed }. Deadline → a
// synthetic TimedOut (the caller maps non-Success → EXIT.SERVER).
const SSM_TERMINAL = new Set(['Success', 'Failed', 'Cancelled', 'TimedOut']);
async function ssmPoll({ commandId, target, region, profile }, { execFn = execFileP, timeoutMs = SSM_DEPLOY_TIMEOUT_MS, pollMs = SSM_POLL_MS, prePollMs = SSM_PREPOLL_MS, sleepFn = defaultSleep, onStatus = null, onMarker = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let cursor = 0;   // count of ^:: lines already handed to onMarker
  if (prePollMs) await sleepFn(prePollMs);   // let SSM register the invocation
  const drainMarkers = (out) => {
    if (!onMarker || !out) return;
    const lines = ssmMarkerLines(out.StandardOutputContent);
    for (let i = cursor; i < lines.length; i++) onMarker(lines[i]);
    if (lines.length > cursor) cursor = lines.length;
  };
  for (;;) {
    let out = null;
    try {
      const { stdout } = await execFn('aws', ssmGetInvocationArgs({ commandId, target, region, profile }).slice(1));
      out = JSON.parse(String(stdout) || '{}');
    } catch (e) {
      if (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || ''))) {
        throw new CliError(EXIT.CONNECT, 'aws CLI not found — is it installed and on PATH?');
      }
      const stderr = ((e && (e.stderr || e.message)) || '').toString();
      // The invocation isn't registered for a moment right after send-command.
      if (!/InvocationDoesNotExist/.test(stderr) && Date.now() >= deadline) {
        throw new CliError(EXIT.SERVER, `aws get-command-invocation failed: ${stderr.trim()}`);
      }
      out = null;
    }
    if (out) {
      drainMarkers(out);
      const status = out.Status || 'Pending';
      if (status !== last) { last = status; if (onStatus) onStatus(status); }
      if (SSM_TERMINAL.has(status)) {
        return {
          status,
          responseCode: out.ResponseCode != null ? out.ResponseCode : null,
          stdout: out.StandardOutputContent || '',
          stderr: out.StandardErrorContent || '',
          markersStreamed: cursor,
        };
      }
    }
    if (Date.now() >= deadline) {
      return { status: 'TimedOut', responseCode: null, stdout: (out && out.StandardOutputContent) || '', stderr: (out && out.StandardErrorContent) || '', markersStreamed: cursor };
    }
    await sleepFn(pollMs);
  }
}

// Pull the http code the on-box verify loop echoed (`::verify http=NNN`)
// — informational; the authoritative verify is the laptop-side tunnel probe.
function parseHelloMarker(stdout) {
  const m = String(stdout || '').match(/::verify\s+http=(\d{3})/);
  return m ? m[1] : null;
}

// Verify from the laptop through the REAL ssm tunnel the user will use: open the
// typed-ssm transport and GET hello with the minted token. io.probeSsm overrides
// for unit tests. Returns the hello payload or throws a coded CliError.
async function ssmVerifyHello(entry, token, { spawnFn, execFn } = {}) {
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, token);
    return await client.get('/api/peer/hello', 'deploy ssm (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

// Deliver the Claude OAuth token to the freshly-deployed ssm node over the
// AUTHENTICATED WIRE (the tunnel is encrypted; the secret never touches SSM
// send-command parameters, so it stays out of SSM history/CloudTrail — the
// non-negotiable constraint). Opens the same typed-ssm transport the verify
// used, with the minted WIRE token, then: spawn a throwaway bash session →
// acquire control → type the drop-in script (token rides a shell VAR, never a
// process argv) → the script's `systemctl restart` drops the engine, which
// tears the wire down under us (the throwaway session dies with it — a
// post-input connection error is the EXPECTED end, not a failure). We then poll
// hello with the wire token until the engine is back. NOTE the epistemics of a
// fire-over-PTY design: success here confirms input-accepted + engine-reachable-
// after, NOT that the drop-in write itself succeeded — if the typed script fails
// partway and the engine restarts (or stays up) without the env, this still
// reports delivered while `claude` stays unauthenticated. The first `spawn
// --type claude` is the real proof; re-running deploy retries idempotently.
// io.* seams thread through; token is NEVER logged.
const TOKEN_SESSION_PREFIX = 'clodex-token-';
async function deliverClaudeToken(entry, wireToken, oauthToken, { spawnFn, execFn, timeoutMs = 60000, pollMs = 1000, sleepFn = defaultSleep } = {}) {
  const sessName = TOKEN_SESSION_PREFIX + crypto.randomBytes(4).toString('hex');
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, wireToken);
    // 1. throwaway bash session (as the clodex user the engine runs as). The
    //    engine REJECTS a create without cwd; /tmp exists on any box we deploy.
    await client.post('/api/sessions', 'deploy ssm (token session)', { name: sessName, type: 'bash', cwd: '/tmp' });
    // 2. acquire control (input is gated on the per-acquire capability token).
    const acq = await client.post(`/api/control/${encodeURIComponent(sessName)}`, 'deploy ssm (token control)', { action: 'acquire', client: 'clodexctl' });
    const ctrlToken = acq && acq.token;
    if (!ctrlToken) throw new CliError(EXIT.SERVER, 'token delivery: could not acquire session control');
    // 3. type the drop-in script + Enter. The trailing restart kills the engine.
    const dropin = buildTokenDropinScript(oauthToken) + '\n';
    try {
      await client.post(`/api/input/${encodeURIComponent(sessName)}`, 'deploy ssm (token write)', { token: ctrlToken, data: dropin });
    } catch (e) {
      // A connection death right after the restart line is the expected outcome
      // (the engine went down mid-request). Only a CONNECT-class error is benign;
      // anything else (4xx/5xx from a still-up engine) is a real failure.
      if (!(e instanceof CliError && e.exitCode === EXIT.CONNECT)) throw e;
    }
  } finally {
    try { t.close(); } catch {}
  }
  // 4. wait for the engine to come back up authenticated (restart → wire drops →
  //    reappears). Poll hello with the wire token until 200 or the deadline.
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    let t2 = null;
    try {
      t2 = await openTransport(entry, { spawnFn, execFn });
      const client = new WireClient(t2.baseUrl, wireToken);
      const hello = await client.get('/api/peer/hello', 'deploy ssm (token verify)');
      return { ok: true, hello };
    } catch (e) { lastErr = e; }
    finally { if (t2) { try { t2.close(); } catch {} } }
    if (Date.now() >= deadline) {
      throw new CliError(EXIT.SERVER, `token delivered but the engine did not come back within ${Math.round(timeoutMs / 1000)}s${lastErr ? `: ${lastErr.message}` : ''}`);
    }
    await sleepFn(pollMs);
  }
}

// deploy ssm <name> — orchestration. io seams: execFn (aws child), spawnFn
// (verify tunnel child), probeSsm (verify override for tests), contextsFile.
// Throws CliError (caught by main.run). --json emits NDJSON events.
async function deploySsmVerb({ printer, flags, args, io = {} }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy ssm needs a node name (e.g. deploy ssm mybox --target i-…)');
  if (!NAME_RE.test(name)) throw new CliError(EXIT.USAGE, `bad node name "${name}" — use ${NAME_RE.source}`);
  const target = flags.target ? String(flags.target) : null;
  if (!target) throw new CliError(EXIT.USAGE, 'deploy ssm needs --target i-INSTANCE');

  const region = flags.region ? String(flags.region) : null;
  const profile = flags.profile ? String(flags.profile) : null;
  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  // repo/branch are interpolated into the SSM wrapper (embedded via heredoc), so
  // they MUST be newline-/metachar-free before they reach buildSsmScript — a
  // newline could smuggle a heredoc-terminator line into the root wrapper. Hold
  // them to a strict git-ref / URL charset (the wrapper's random-nonce delimiter
  // is the belt to this suspenders).
  const repo = flags.repo ? String(flags.repo) : DEFAULT_REPO;
  const branch = flags.branch ? String(flags.branch) : DEFAULT_BRANCH;
  if (!REF_RE.test(repo)) throw new CliError(EXIT.USAGE, `bad --repo "${repo}" — use a git URL/ref (${REF_RE.source})`);
  if (!REF_RE.test(branch)) throw new CliError(EXIT.USAGE, `bad --branch "${branch}" — use a git ref name (${REF_RE.source})`);
  // Claude auth (optional): read the token from a local file NOW (fail fast on a
  // bad path before any AWS call). It NEVER rides the SSM wrapper (CloudTrail) —
  // it's delivered post-verify over the encrypted wire. Never printed.
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const noWirescope = !!flags['no-wirescope'];
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);
  const execFn = io.execFn;   // undefined → runAws/ssm* default to execFileP
  const sleepFn = io.sleepFn;  // undefined → real setTimeout; tests inject a no-op
  const sd = { target, region, profile };

  // The typed ssm ctx entry this deploy will save/verify against (remotePort
  // only when non-default, matching the ssm kind's port convention).
  const entry = {
    ssm: { target, ...(region ? { region } : {}), ...(profile ? { profile } : {}) },
    ...(port !== DEFAULT_PORT ? { remotePort: port } : {}),
  };

  // Render one ^:: marker line from the relayed trail. Human = a live step list
  // like the ssh flavor; --json = one NDJSON object per marker (mirrors deployVerb).
  const renderMarker = (raw) => {
    const ev = parseMarker(raw);
    if (json) { emit(ev); return; }
    switch (ev.type) {
      case 'step': printer.line(`→ ${ev.name} …`); break;
      case 'ok': printer.line(`  ${ev.name} ok`); break;
      case 'fail': printer.line(`  ${ev.name} FAILED${ev.reason ? ` — ${ev.reason}` : ''}`); break;
      case 'done': break;
      default: if (ev.text) printer.line(`  ${ev.text}`); break;
    }
  };

  // --dry-run: describe the exact argv + wrapper + would-be ctx; the minted token
  // must NOT appear — print a placeholder.
  if (flags['dry-run']) {
    const script = buildSsmScript({ port, token: '<minted-token>', repo, branch, noWirescope });
    const sendArgv = ssmSendCommandArgs({ target, region, profile, script });
    if (json) { emit({ type: 'dry-run', name, target, region, profile, port, repo, branch, claudeToken: !!claudeToken, noWirescope, sendArgv, script, ctxName: flags['no-ctx'] ? null : name }); return; }
    printer.line([
      `dry-run — would deploy "${name}" to ${target} over SSM (OS flavor):`,
      `  user       clodex (host user + systemd --user service)`,
      `  port       127.0.0.1:${port} (loopback on the box)`,
      `  repo       ${repo}`,
      `  branch     ${branch}`,
      region ? `  region     ${region}` : null,
      profile ? `  profile    ${profile}` : null,
      claudeToken ? '  claude     token from --claude-token-file (delivered over the wire post-verify, NOT via SSM params, redacted)' : null,
      noWirescope ? '  wirescope  disabled (CLODEX_WIRESCOPE=off drop-in; python venv/pip deps skipped)' : null,
      `  send-command  aws ${sendArgv.slice(1).join(' ')}`,
      flags['no-ctx'] ? '  context (skipped — --no-ctx)' : `  context ${name} (ssm)`,
      '  --- wrapper ---',
      script.replace(/^/gm, '  '),
    ].filter((l) => l != null).join('\n'));
    return;
  }

  // 1. Mint a fresh wire token locally (always token-gated).
  const token = crypto.randomBytes(24).toString('hex');
  const script = buildSsmScript({ port, token, repo, branch, noWirescope });

  // 2. Preflight — instance registered + online.
  const info = await ssmPreflight(sd, { execFn });
  if (json) emit({ type: 'preflight', ok: true, target, pingStatus: info.PingStatus || null, platform: info.PlatformName || null });
  else printer.line(`instance ${target} online${info.PlatformName ? ` (${info.PlatformName})` : ''} — sending install command…`);

  // 3. send-command (bounded retry on eventually-consistent InvalidInstanceId).
  const commandId = await ssmSendCommand({ ...sd, script }, { execFn, sleepFn });
  if (json) emit({ type: 'command', commandId });
  else printer.line(`running remote install (SSM command ${commandId})…`);

  // 4. Poll to a terminal status, pseudo-streaming the marker trail as it grows.
  let streamed = 0;
  const result = await ssmPoll({ commandId, ...sd }, {
    execFn, sleepFn,
    onStatus: (s) => { if (json) emit({ type: 'status', status: s }); },
    onMarker: (raw) => { streamed++; renderMarker(raw); },
  });
  if (result.status !== 'Success') {
    // Distinct terminal statuses (all → EXIT.SERVER, distinct message).
    const why = result.status === 'TimedOut'
      ? `remote install timed out on ${target} after ${Math.round(SSM_DEPLOY_TIMEOUT_MS / 60000)}min — re-run to resume (the installer is idempotent)`
      : result.status === 'Cancelled'
        ? `remote install was cancelled on ${target} (SSM command ${commandId})`
        : `remote install failed on ${target} (SSM command ${commandId})`;
    const tail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (json) emit({ type: 'error', reason: 'command-failed', status: result.status, responseCode: result.responseCode, output: tail });
    else if (tail) printer.line(tail.replace(/^/gm, '  '));
    throw new CliError(EXIT.SERVER, why);
  }
  // Fallback: if partial output never surfaced (streamed 0), render the final
  // trail now so a marker-less pseudo-stream still shows the step list.
  if (streamed === 0) { for (const l of ssmMarkerLines(result.stdout)) renderMarker(l); }
  const helloCode = parseHelloMarker(result.stdout);
  if (!json) printer.line(`  remote install ok${helloCode ? ` (on-box hello ${helloCode})` : ''}`);

  // 5. Verify from the laptop through the REAL ssm tunnel.
  let hello;
  try {
    const probe = io.probeSsm || ssmVerifyHello;
    hello = await probe(entry, token, { spawnFn: io.spawnFn, execFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`installed, but the wire did not answer through the SSM tunnel: ${e.message}`);
    throw e instanceof CliError ? e : new CliError(EXIT.SERVER, `deploy ssm verify failed: ${e.message}`);
  }
  if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
  else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} on ${target}:${port}`);

  // 5b. Claude auth (optional): deliver the OAuth token over the ENCRYPTED WIRE
  //     (never SSM params → never CloudTrail). Post-verify, so the wire is proven.
  if (claudeToken) {
    try {
      const deliver = io.deliverToken || deliverClaudeToken;
      await deliver(entry, token, claudeToken, { spawnFn: io.spawnFn, execFn, sleepFn });
    } catch (e) {
      if (json) emit({ type: 'error', reason: 'token-delivery-failed', message: e.message });
      else printer.line(`installed and verified, but delivering the Claude token failed: ${e.message} (re-run with --claude-token-file to retry)`);
      throw e instanceof CliError ? e : new CliError(EXIT.SERVER, `claude token delivery failed: ${e.message}`);
    }
    if (json) emit({ type: 'claude-auth', ok: true });
    else printer.line('  claude token sent over the wire (unit drop-in, 0600) — verify with a claude spawn');
  }

  // 6. ctx upsert (typed ssm kind + minted token). Collision skip unless --force.
  if (flags['no-ctx']) {
    if (json) emit({ type: 'context', action: 'skipped', reason: '--no-ctx' });
    return;
  }
  const store = safeLoadContexts(io);
  const exists = Object.prototype.hasOwnProperty.call(store.contexts, name);
  if (exists && !flags.force) {
    if (json) emit({ type: 'context', action: 'skipped', name, reason: 'exists — --force to overwrite' });
    else printer.line(`context "${name}" already exists — kept it (--force to overwrite). Use: clodexctl --ctx ${name} sessions`);
    return;
  }
  // webPort (T42): the installer enables the web GUI on wire-port+1 (loopback);
  // save it so `clodexctl web <ctx>` tunnels to the right remote port.
  const webPort = port + 1;
  store.contexts[name] = { ...entry, webPort, token };
  if (!store.current) store.current = name;
  contexts.save(store, io.contextsFile);
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name, webPort });
  else {
    printer.line(`context "${name}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${name} sessions`);
    printer.line(`  see it in your browser: clodexctl web ${name}`);
  }
}

// ── helm flavor: `clodexctl deploy helm <name>` ──────────────────────────────
//
// One command births a k8s node from the PACKAGED chart (cli/deploy/helm/
// clodex): mint a wire token → `helm upgrade --install` with --set-file token
// delivery (the chart creates the Secret itself; shipped 4427bba) → save a
// kubectl-kind ctx → laptop-side hello through the real `kubectl port-forward`
// transport. Local/docker-desktop shape today; nothing here paints EKS into a
// corner (identity rides the chart's serviceAccount values, not this verb).
//
// helm/kubectl are the operator's tools — spawned argv-direct via the SAME
// injectable execFn seam the ssm flavor uses, never a shell, zero k8s SDKs.
// TOKEN DISCIPLINE (binding): the token VALUE never enters argv, markers, logs
// or errors — only FILE PATHS cross argv (`--set-file secrets.wireToken=F`).
// The tempfile is 0600 and removed in a finally.
const HELM_TIMEOUT = '5m';                    // --wait budget (chart readiness probe)
const DEFAULT_HELM_NAMESPACE = 'clodex';
// Helm release names are DNS-1123 labels capped at 53 chars (lowercase
// alphanumerics + '-', must start/end alphanumeric). Validate EARLY — helm's
// own late failure is a worse message — and note the name doubles as the ctx
// name (NAME_RE is a superset of this, so one check covers both).
const HELM_RELEASE_RE = /^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$/;
// Namespaces are DNS-1123 labels (63 chars).
const K8S_NS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Resolve the packaged chart relative to THIS module (the scriptPath pattern):
// cli/src/deploy.js → cli/deploy/helm/clodex. `deploy/` is in the published
// files list, chart included, so `npm i -g` and in-repo runs both resolve.
function helmChartPath() {
  return path.join(__dirname, '..', 'deploy', 'helm', 'clodex');
}

// The `helm upgrade --install` argv — pure, leaf-tested, the single source for
// execution AND --dry-run display. Token FILES ride --set-file (paths in argv
// are fine; values never are). --wait rides the chart's readiness probe (curl
// 200|401 in-pod), so a green exit already means the wire answered inside the
// pod; the laptop-side verify then proves port-forward + token end-to-end.
function helmArgv({ name, chart, namespace, kubeContext = null, port = DEFAULT_PORT, wireTokenFile, oauthTokenFile = null, sets = [], valuesFiles = [] } = {}) {
  return [
    'helm', 'upgrade', '--install', name, chart,
    '--namespace', namespace,
    ...(kubeContext ? ['--kube-context', kubeContext] : []),
    '--set-file', `secrets.wireToken=${wireTokenFile}`,
    ...(oauthTokenFile ? ['--set-file', `secrets.oauthToken=${oauthTokenFile}`] : []),
    ...(port !== DEFAULT_PORT ? ['--set', `wirePort=${port}`] : []),
    ...sets.flatMap((s) => ['--set', s]),
    ...valuesFiles.flatMap((f) => ['--values', f]),
    '--wait', '--timeout', HELM_TIMEOUT,
  ];
}

// `helm status` — the release-exists probe (exit 0 = installed). Pure.
function helmStatusArgs({ name, namespace, kubeContext = null } = {}) {
  return ['helm', 'status', name, '--namespace', namespace,
    ...(kubeContext ? ['--kube-context', kubeContext] : [])];
}

// kubectl argv to read a key of the chart-managed Secret (base64 via
// jsonpath) — the REUSE path: an existing release keeps its wire token so a
// redeploy/upgrade doesn't rotate it under a live ctx entry, and keeps its
// oauth token so a flagless re-run doesn't silently drop claude auth. A
// missing key renders as EMPTY stdout (exit 0), not an error. Pure.
function releaseSecretArgs({ name, namespace, kubeContext = null, key = 'wire-token' } = {}) {
  return ['kubectl', ...(kubeContext ? ['--context', kubeContext] : []),
    '-n', namespace, 'get', 'secret', `${name}-secrets`,
    '-o', `jsonpath={.data.${key}}`];
}

// Run a vendor CLI (helm/kubectl) argv through the injectable execFn — the
// runAws pattern generalized. ENOENT → the "is X installed?" hint transport.js
// uses for vendor CLIs; other failures relay the child's own stderr.
async function runVendor(execFn, argv, what, code = EXIT.CONNECT) {
  try {
    const { stdout } = await execFn(argv[0], argv.slice(1));
    return String(stdout).trim();
  } catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || ''))) {
      throw new CliError(EXIT.CONNECT, `${argv[0]}: command not found — is ${argv[0]} installed and on PATH?`);
    }
    const stderr = ((e && (e.stderr || e.message)) || '').toString().trim();
    throw new CliError(code, `${argv[0]} ${what} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

// Verify from the laptop through the REAL kubectl transport the saved ctx will
// use: openTransport on the kubectl entry (spawns `kubectl port-forward`), GET
// hello with the Bearer token, expect 200. The ssmVerifyHello shape for the
// kubectl kind. io.probeHelm overrides for unit tests.
async function helmVerifyHello(entry, token, { spawnFn, execFn } = {}) {
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, token);
    return await client.get('/api/peer/hello', 'deploy helm (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

// deploy helm <name> — orchestration. io seams: execFn (helm/kubectl children),
// spawnFn (verify tunnel child), probeHelm (verify override), contextsFile.
// Throws CliError (caught by main.run). --json emits NDJSON step markers
// shaped like parseMarker events (mirrors the other flavors).
async function deployHelmVerb({ printer, flags, args, io = {} }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy helm needs a release name (e.g. deploy helm mynode)');
  if (!HELM_RELEASE_RE.test(name)) {
    throw new CliError(EXIT.USAGE, `bad release name "${name}" — helm release names are DNS-1123: lowercase letters/digits/hyphens, start+end alphanumeric, max 53 chars (no dots or underscores; it doubles as the ctx name)`);
  }
  const namespace = flags.namespace ? String(flags.namespace) : DEFAULT_HELM_NAMESPACE;
  if (!K8S_NS_RE.test(namespace)) throw new CliError(EXIT.USAGE, `bad --namespace "${namespace}" — a DNS-1123 label (lowercase letters/digits/hyphens, max 63 chars)`);
  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  const chart = flags.chart ? String(flags.chart) : helmChartPath();
  // Only the PACKAGED default is existence-checked (it must ship with us); an
  // operator --chart passes through untouched — helm resolves repo/oci refs.
  if (!flags.chart && !fs.existsSync(path.join(chart, 'Chart.yaml'))) {
    throw new CliError(EXIT.SERVER, `packaged helm chart unreadable at ${chart} — broken install?`);
  }
  const sets = Array.isArray(flags.set) ? flags.set.map(String) : (flags.set ? [String(flags.set)] : []);
  // secrets.* via --set is a double footgun: the value would ride argv (ps-
  // visible — the discipline this verb exists to uphold) AND, last-wins, it
  // would override the minted/reused token under the ctx entry. Reject early.
  for (const s of sets) {
    if (/^secrets\./.test(s)) {
      throw new CliError(EXIT.USAGE, `--set ${s.split('=')[0]} is not allowed — secret values must never ride argv; the wire token is minted/reused automatically and claude auth rides --claude-token-file`);
    }
  }
  const valuesFiles = Array.isArray(flags.values) ? flags.values.map(String) : (flags.values ? [String(flags.values)] : []);
  // Claude auth (optional): read + validate the token NOW (fail fast before any
  // cluster call). The EXTRACTED value is re-staged into its own 0600 tempfile
  // for --set-file — the input may be an env-file whose raw bytes are NOT the
  // token. Never printed, never argv.
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);
  const execFn = io.execFn || execFileP;

  // ::step/::ok/::log vocabulary, locally emitted (there is no remote marker
  // stream to relay — helm is synchronous). --json mirrors parseMarker shapes.
  const step = (n) => { if (json) emit({ type: 'step', name: n }); else printer.line(`→ ${n} …`); };
  const okm = (n) => { if (json) emit({ type: 'ok', name: n }); else printer.line(`  ${n} ok`); };
  const log = (t) => { if (json) emit({ type: 'log', text: t }); else printer.line(`  ${t}`); };

  // --no-wirescope is the ssh/ssm/docker spelling; helm's route is the chart
  // value. Warn instead of silently ignoring (the wirescope stays ON without
  // the --set).
  if (flags['no-wirescope']) {
    log('--no-wirescope is ignored by the helm flavor — use --set wirescope.enabled=false (the chart value)');
  }

  // --dry-run: describe, run nothing. Placeholder paths — no tempfile is ever
  // written, and the claude token is noted by PRESENCE only.
  if (flags['dry-run']) {
    const argvPreview = helmArgv({ name, chart, namespace, kubeContext: flags['kube-context'] ? String(flags['kube-context']) : null, port, wireTokenFile: '<wire-token-tempfile>', oauthTokenFile: claudeToken ? '<oauth-token-tempfile>' : null, sets, valuesFiles });
    const ctxEntry = { kubectl: { target: `svc/${name}`, namespace, ...(flags['kube-context'] ? { context: String(flags['kube-context']) } : {}) }, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}), token: '<minted-or-reused>' };
    if (json) { emit({ type: 'dry-run', name, namespace, kubeContext: flags['kube-context'] || null, chart, port, claudeToken: !!claudeToken, helmArgv: argvPreview, ctxName: flags['no-ctx'] ? null : name, ctxEntry }); return; }
    printer.line([
      `dry-run — would deploy release "${name}" from the helm chart:`,
      `  chart      ${chart}`,
      `  namespace  ${namespace} (created if absent)`,
      `  kube-ctx   ${flags['kube-context'] ? String(flags['kube-context']) : "(kubectl's current context)"}`,
      `  port       ${port} (wire, in-cluster; reached via kubectl port-forward)`,
      claudeToken ? '  claude     token from --claude-token-file (rides a 0600 tempfile into --set-file, redacted)' : null,
      `  helm       ${argvPreview.join(' ')}`,
      flags['no-ctx'] ? '  context (skipped — --no-ctx)' : `  context ${name} (kubectl svc/${name} -n ${namespace}, token from the release Secret)`,
      '  (an existing release would be UPGRADED in place, reusing its wire token; its claude oauth token is carried forward unless --claude-token-file replaces it)',
    ].filter(Boolean).join('\n'));
    return;
  }

  // 1. preflight: both binaries resolve, and NAME the cluster this will hit —
  //    deploying to the wrong cluster silently is the scary failure.
  step('preflight');
  await runVendor(execFn, ['helm', 'version', '--short'], 'version');
  await runVendor(execFn, ['kubectl', 'version', '--client', '--output=yaml'], 'version --client');
  let kubeContext = flags['kube-context'] ? String(flags['kube-context']) : null;
  if (!kubeContext) {
    kubeContext = await runVendor(execFn, ['kubectl', 'config', 'current-context'], 'config current-context');
    if (!kubeContext) throw new CliError(EXIT.CONNECT, 'kubectl has no current context — pass --kube-context');
  }
  log(`cluster: kube context "${kubeContext}", namespace "${namespace}"`);
  // Namespace: get-first, create if absent. A lost create race (another
  // creator won between our get and create) surfaces as AlreadyExists —
  // that's the state we wanted, tolerate it.
  try {
    await runVendor(execFn, ['kubectl', '--context', kubeContext, 'get', 'namespace', namespace], 'get namespace');
  } catch {
    try {
      await runVendor(execFn, ['kubectl', '--context', kubeContext, 'create', 'namespace', namespace], 'create namespace', EXIT.SERVER);
      log(`namespace "${namespace}" created`);
    } catch (e) {
      if (!/AlreadyExists|already exists/i.test(e.message || '')) throw e;
    }
  }
  okm('preflight');

  // 2. token: REUSE an existing release's wire token (so redeploy/upgrade never
  //    rotates it under a live ctx entry), else mint fresh. helm status exit 0
  //    = the release exists; only a "not found" stderr means fresh install —
  //    any OTHER status failure (auth, unreachable cluster, wedged helm) must
  //    NOT fall through to a fresh mint, or we'd rotate a live release's token
  //    exactly when the operator can least see it happening.
  step('token');
  let token = null;
  let releaseExists = false;
  try {
    await runVendor(execFn, helmStatusArgs({ name, namespace, kubeContext }), 'status');
    releaseExists = true;
  } catch (e) {
    if (!/not found/i.test(e.message || '')) {
      throw new CliError(EXIT.CONNECT, `could not determine whether release "${name}" exists (helm status failed for a reason other than not-found) — check cluster access and re-run: ${e.message}`);
    }
    /* release not installed → fresh mint below */
  }
  let reusedOauth = null;   // existing release's oauth token (preserved on flagless re-run)
  if (releaseExists) {
    let b64;
    try {
      b64 = await runVendor(execFn, releaseSecretArgs({ name, namespace, kubeContext }), `get secret ${name}-secrets`, EXIT.SERVER);
    } catch (e) {
      throw new CliError(EXIT.SERVER, `release "${name}" exists but its wire token could not be read from Secret "${name}-secrets" — it was likely installed with an operator-managed Secret (secrets.existingSecret); upgrade it with helm directly, or uninstall and re-run (${e.message})`);
    }
    token = Buffer.from(b64.trim(), 'base64').toString('utf8').trim();
    if (!token || /[\s\x00-\x1f]/.test(token)) {
      throw new CliError(EXIT.SERVER, `release "${name}" exists but Secret "${name}-secrets" holds no usable wire-token — uninstall and re-run, or fix the Secret`);
    }
    log('reusing existing release token (upgrade in place, no rotation)');
    // Preserve the release's oauth token when --claude-token-file is absent:
    // the chart renders the oauth-token key only when a value is passed, and
    // an upgrade REPLACES the Secret — a flagless re-run would silently drop
    // claude auth (hidden by the pod env's optional:true until the next
    // restart). A missing key is empty stdout (exit 0) → nothing to preserve.
    if (!claudeToken) {
      let ob64 = '';
      try {
        ob64 = await runVendor(execFn, releaseSecretArgs({ name, namespace, kubeContext, key: 'oauth-token' }), `get secret ${name}-secrets (oauth)`, EXIT.SERVER);
      } catch { ob64 = ''; }   // best-effort: absent/unreadable → no oauth to carry
      if (ob64.trim()) {
        const prev = Buffer.from(ob64.trim(), 'base64').toString('utf8').trim();
        if (prev && !/[\s\x00-\x1f]/.test(prev)) {
          reusedOauth = prev;
          log('preserving existing claude oauth token (no --claude-token-file on this run)');
        }
      }
    }
  } else {
    token = crypto.randomBytes(24).toString('hex');   // same entropy as the other flavors
    log('minted a fresh wire token');
  }
  okm('token');

  // 3+4. stage token FILES (0600, cleaned in a finally) and run helm. Only
  //      paths enter argv; helm's --set-file reads the values client-side.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-'));
  try {
    const wireTokenFile = path.join(tmpDir, 'wire-token');
    fs.writeFileSync(wireTokenFile, token, { mode: 0o600 });
    let oauthTokenFile = null;
    const oauthToStage = claudeToken || reusedOauth;   // fresh flag wins; else preserve
    if (oauthToStage) {
      oauthTokenFile = path.join(tmpDir, 'oauth-token');
      fs.writeFileSync(oauthTokenFile, oauthToStage, { mode: 0o600 });
      if (claudeToken) log('claude token staged (0600 tempfile → --set-file, redacted)');
    }
    const argv = helmArgv({ name, chart, namespace, kubeContext, port, wireTokenFile, oauthTokenFile, sets, valuesFiles });
    step('helm');
    try {
      await runVendor(execFn, argv, 'upgrade --install', EXIT.SERVER);
    } catch (e) {
      // Failure honesty: a mid---wait failure leaves the release INSTALLED
      // (helm does not roll back for us, and we don't auto-rollback).
      if (json) emit({ type: 'error', reason: 'helm-failed', message: e.message });
      throw new CliError(EXIT.SERVER, `${e.message}\nrelease "${name}" likely exists in a partial state — fix the cause and re-run: the same command upgrades in place (inspect with: helm status ${name} -n ${namespace}; kubectl -n ${namespace} get pods)`);
    }
    okm('helm');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  // 5. ctx upsert — the kubectl-kind entry the verify (and the user) will use.
  //    Name-taken: kept unless --force (the flavors' shared semantics); the
  //    verify below still runs against the FRESH entry either way.
  const entry = {
    kubectl: { target: `svc/${name}`, namespace, context: kubeContext },
    ...(port !== DEFAULT_PORT ? { remotePort: port } : {}),
    token,
  };
  let ctxSaved = false;   // the verify-failure hint must not claim a save that was skipped
  if (flags['no-ctx']) {
    if (json) emit({ type: 'context', action: 'skipped', reason: '--no-ctx' });
  } else {
    const store = safeLoadContexts(io);
    const exists = Object.prototype.hasOwnProperty.call(store.contexts, name);
    if (exists && !flags.force) {
      if (json) emit({ type: 'context', action: 'skipped', name, reason: 'exists — --force to overwrite' });
      else printer.line(`context "${name}" already exists — kept it (--force to overwrite)`);
    } else {
      store.contexts[name] = entry;
      if (!store.current) store.current = name;
      contexts.save(store, io.contextsFile);
      ctxSaved = true;
      if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name });
      else printer.line(`context "${name}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${name} sessions`);
    }
  }

  // 6. verify: laptop-side hello through the REAL kubectl port-forward with the
  //    Bearer token — proves port-forward + token end-to-end, not just the
  //    pod-internal readiness --wait already rode on.
  step('verify');
  let hello;
  try {
    const probe = io.probeHelm || helmVerifyHello;
    hello = await probe(entry, token, { spawnFn: io.spawnFn, execFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`release "${name}" is live (helm --wait passed), but the wire did not answer through kubectl port-forward: ${e.message}`);
    // The hint must tell the truth about the ctx: a skipped upsert (name
    // collision, no --force) would send the operator to the OLD entry.
    const hint = flags['no-ctx'] ? ''
      : ctxSaved ? ` — the context was saved; debug with: clodexctl --ctx ${name} ctx test --verbose`
        : ` — the context was NOT saved (name "${name}" exists; re-run with --force to overwrite it)`;
    throw e instanceof CliError ? new CliError(e.exitCode, `${e.message}${hint}`) : new CliError(EXIT.SERVER, `deploy helm verify failed: ${e.message}${hint}`);
  }
  okm('verify');
  if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
  else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} (svc/${name} -n ${namespace} @ ${kubeContext})`);
}

// ── fargate flavor: `clodexctl deploy fargate <stack>` ───────────────────────
//
// One command builds a Clodex node on AWS Fargate from the PACKAGED
// CloudFormation template (cli/deploy/clodex-fargate.yaml): `aws cloudformation
// deploy` (create OR idempotent update) → optionally populate the oauth-token
// secret (file:// put-secret-value; SKIPPED on Bedrock) → read the stack's
// self-minted wire token INTO MEMORY for the ctx entry → save a typed
// {ssm:{ecs}} context → laptop-side hello through the REAL SSM/ECS tunnel.
//
// `aws` is the operator's tool, spawned argv-direct through the SAME runAws
// seam the ssm flavor uses — never a shell, no AWS SDK. TOKEN DISCIPLINE
// (binding): no secret VALUE ever enters argv/logs/errors/dry-run. The wire
// token is the STACK's (get-secret-value into memory, never printed, never
// rotated on re-run); the oauth token rides file://<path> into put-secret-value
// (only the PATH crosses argv). ClusterName defaults to the stack name so two
// stacks never collide on the template's 'clodex' default.
const FARGATE_TEMPLATE = 'clodex-fargate.yaml';
const FARGATE_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;   // Fargate cold start: image pull + boot
const FARGATE_VERIFY_POLL_MS = 5000;
// CloudFormation stack names: start with a letter, then letters/digits/hyphens,
// max 128. Stricter than NAME_RE because the name doubles as the ctx name, the
// default cluster, and the secret prefix (<stack>/wire-token, <stack>/oauth-token).
const FARGATE_STACK_RE = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
// A --param KEY=VALUE override: KEY a CloudFormation parameter name (alnum),
// VALUE anything (never a secret — those ride file:// / the stack's generator).
const FARGATE_PARAM_RE = /^[A-Za-z][A-Za-z0-9]*=.*/;

// Resolve the packaged template relative to THIS module (the helmChartPath
// pattern): cli/src/deploy.js → cli/deploy/clodex-fargate.yaml. `deploy/` is in
// the published files list, so `npm i -g` and in-repo runs both resolve.
function fargateTemplatePath() {
  return path.join(__dirname, '..', 'deploy', FARGATE_TEMPLATE);
}

// A true|false flag value → bool (the parser hands single-value flags as
// strings). Anything else is a USAGE error.
function parseBoolFlag(v, name) {
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw new CliError(EXIT.USAGE, `--${name} must be true or false, got "${v}"`);
}

// The `--parameter-overrides` tokens — pure, the single source for execution AND
// --dry-run display. ClusterName is ALWAYS emitted (defaults to the stack name,
// so two stacks don't collide on the template's 'clodex' cluster default);
// Persistent is ALWAYS emitted (the verb defaults it TRUE — a self-healing,
// verifiable node — which differs from the template's 'false'). Everything else
// only when chosen. Secret VALUES never appear here.
function fargateParamOverrides({ stackName, cluster, image, useBedrock, noWirescope, assignPublicIp, subnets, securityGroup, persistent, params = [] } = {}) {
  return [
    `ClusterName=${cluster || stackName}`,
    `Persistent=${persistent ? 'true' : 'false'}`,
    ...(image ? [`ImageUri=${image}`] : []),
    ...(useBedrock ? ['UseBedrock=true'] : []),
    ...(noWirescope ? ['DisableWirescope=true'] : []),
    ...(assignPublicIp ? [`AssignPublicIp=${assignPublicIp}`] : []),
    ...(subnets ? [`SubnetIds=${subnets}`] : []),
    ...(securityGroup ? [`SecurityGroupId=${securityGroup}`] : []),
    ...params,
  ];
}

// Full aws argv (leading 'aws') so each doubles as execution + --dry-run
// display, awsBase order matching the ssm flavor.
function fargateDeployArgs({ stackName, templateFile, region, profile, paramOverrides = [] } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'cloudformation', 'deploy',
    '--stack-name', stackName,
    '--template-file', templateFile,
    '--capabilities', 'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    ...(paramOverrides.length ? ['--parameter-overrides', ...paramOverrides] : [])];
}
function callerIdentityArgs({ region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }), 'sts', 'get-caller-identity', '--output', 'json'];
}
// put-secret-value with file://<path>: aws reads the file locally; the token
// VALUE never enters argv. Only the oauth-token secret (never the wire token —
// the stack owns that and we never rewrite it).
function fargatePutOauthArgs({ stackName, region, profile, tokenFile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'secretsmanager', 'put-secret-value',
    '--secret-id', `${stackName}/oauth-token`,
    '--secret-string', `file://${tokenFile}`];
}
// Read the stack's self-minted wire token into memory (for the ctx entry only).
function fargateGetWireTokenArgs({ stackName, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'secretsmanager', 'get-secret-value',
    '--secret-id', `${stackName}/wire-token`,
    '--query', 'SecretString', '--output', 'text'];
}
function fargateStackOutputsArgs({ stackName, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'cloudformation', 'describe-stacks',
    '--stack-name', stackName,
    '--query', 'Stacks[0].Outputs', '--output', 'json'];
}
// describe-stacks Outputs JSON → { OutputKey: OutputValue }. The output VALUES
// are literal copy-paste command templates (RunTaskCommand / PutTokenCommand
// carry a `$(aws … get-secret-value …)` SUBSTITUTION, not a token value) — safe
// to print. Best-effort: a parse failure yields {}.
function parseStackOutputs(json) {
  try {
    const list = JSON.parse(json || '[]');
    if (!Array.isArray(list)) return {};
    const out = {};
    for (const o of list) { if (o && o.OutputKey) out[o.OutputKey] = o.OutputValue; }
    return out;
  } catch { return {}; }
}

// Verify from the laptop through the REAL SSM/ECS tunnel the saved ctx will use:
// openTransport resolves the running task, GET hello with the wire token. POLLED
// to a generous deadline — Fargate cold start (image pull + boot) plus the
// window before a task is RUNNING (resolveEcsTarget 404s until then). io.probe
// Fargate overrides for unit tests.
async function fargatePollHello(entry, token, { spawnFn, execFn, timeoutMs = FARGATE_VERIFY_TIMEOUT_MS, pollMs = FARGATE_VERIFY_POLL_MS, sleepFn = defaultSleep } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    let t = null;
    try {
      t = await openTransport(entry, { spawnFn, execFn });
      const client = new WireClient(t.baseUrl, token);
      return await client.get('/api/peer/hello', 'deploy fargate (verify)');
    } catch (e) { lastErr = e; }
    finally { if (t) { try { t.close(); } catch {} } }
    if (Date.now() >= deadline) {
      throw lastErr instanceof CliError ? lastErr : new CliError(EXIT.SERVER, lastErr ? lastErr.message : 'wire did not answer');
    }
    await sleepFn(pollMs);
  }
}

// deploy fargate <stack> — orchestration. io seams: execFn (aws child), spawnFn
// (verify tunnel child), probeFargate (verify override for tests), sleepFn,
// contextsFile, env. Throws CliError (caught by main.run). --json emits NDJSON
// step/ok/log events shaped like the helm flavor.
async function deployFargateVerb({ printer, flags, args, io = {} }) {
  const stackName = args[0];
  if (!stackName) throw new CliError(EXIT.USAGE, 'deploy fargate needs a stack name (e.g. deploy fargate clodex-node)');
  if (!FARGATE_STACK_RE.test(stackName)) {
    throw new CliError(EXIT.USAGE, `bad stack name "${stackName}" — a CloudFormation stack name: start with a letter, then letters/digits/hyphens, max 128 (it doubles as the ctx name, the default cluster, and the secret prefix)`);
  }
  const region = flags.region ? String(flags.region) : null;
  const profile = flags.profile ? String(flags.profile) : null;
  const cluster = flags.cluster ? String(flags.cluster) : stackName;
  const image = flags.image ? String(flags.image) : null;
  const useBedrock = !!flags['use-bedrock'];
  const noWirescope = !!flags['no-wirescope'];
  const assignPublicIp = flags['assign-public-ip'] ? String(flags['assign-public-ip']) : null;
  if (assignPublicIp && assignPublicIp !== 'ENABLED' && assignPublicIp !== 'DISABLED') {
    throw new CliError(EXIT.USAGE, `--assign-public-ip must be ENABLED or DISABLED, got "${assignPublicIp}"`);
  }
  const subnets = flags.subnets ? String(flags.subnets) : null;
  const securityGroup = flags['security-group'] ? String(flags['security-group']) : null;
  // The verb defaults Persistent TRUE — a self-healing, VERIFIABLE node (the
  // one-command path's whole point); --persistent false is the disposable
  // infra-only run-task shape.
  const persistent = flags.persistent != null ? parseBoolFlag(flags.persistent, 'persistent') : true;
  const params = Array.isArray(flags.param) ? flags.param.map(String) : (flags.param ? [String(flags.param)] : []);
  for (const p of params) {
    if (!FARGATE_PARAM_RE.test(p)) throw new CliError(EXIT.USAGE, `bad --param "${p}" — expected KEY=VALUE (KEY a CloudFormation parameter name)`);
  }

  const env = io.env || process.env;
  // Oauth model credential (skipped ENTIRELY on Bedrock). Source: --token-file
  // or CLODEX_CLAUDE_TOKEN_FILE. The value NEVER enters argv (file:// only) and
  // is never read/printed here — we only verify the file EXISTS (fail fast).
  let oauthTokenFile = null;
  if (!useBedrock) {
    const tf = flags['token-file'] ? String(flags['token-file'])
      : (env.CLODEX_CLAUDE_TOKEN_FILE ? String(env.CLODEX_CLAUDE_TOKEN_FILE) : null);
    if (tf) {
      const abs = path.resolve(tf);
      if (!fs.existsSync(abs)) throw new CliError(EXIT.USAGE, `--token-file not found: ${tf}`);
      oauthTokenFile = abs;
    }
  }

  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);
  const execFn = io.execFn;   // undefined → runAws defaults to execFileP
  const ctxName = flags.ctx ? String(flags.ctx) : stackName;
  const templateFile = fargateTemplatePath();
  const paramOverrides = fargateParamOverrides({ stackName, cluster, image, useBedrock, noWirescope, assignPublicIp, subnets, securityGroup, persistent, params });
  const deployArgv = fargateDeployArgs({ stackName, templateFile, region, profile, paramOverrides });

  const step = (n) => { if (json) emit({ type: 'step', name: n }); else printer.line(`→ ${n} …`); };
  const okm = (n) => { if (json) emit({ type: 'ok', name: n }); else printer.line(`  ${n} ok`); };
  const log = (t) => { if (json) emit({ type: 'log', text: t }); else printer.line(`  ${t}`); };

  // --dry-run: describe the exact argv, run nothing. Secret VALUES never appear
  // — the oauth file is a file:// placeholder, the wire-token read is noted as
  // in-memory-only, no token is ever fetched.
  if (flags['dry-run']) {
    const putArgv = (!useBedrock && oauthTokenFile) ? fargatePutOauthArgs({ stackName, region, profile, tokenFile: '<oauth-token-file>' }) : null;
    const getArgv = fargateGetWireTokenArgs({ stackName, region, profile });
    if (json) { emit({ type: 'dry-run', stackName, cluster, templateFile, paramOverrides, useBedrock, persistent, deployArgv, putOauthArgv: putArgv, getWireTokenArgv: getArgv, ctxName: flags['no-ctx'] ? null : ctxName }); return; }
    printer.line([
      `dry-run — would deploy the Fargate stack "${stackName}":`,
      `  template   ${templateFile}`,
      `  cluster    ${cluster}`,
      `  persistent ${persistent} (${persistent ? 'ECS Service + verify' : 'infra only, no verify'})`,
      useBedrock ? '  model      Bedrock via the TaskRole — no oauth-token secret'
        : (oauthTokenFile ? '  model      claude oauth token from a file (file:// → put-secret-value, redacted)'
          : '  model      claude oauth (NO token file — the secret keeps its REPLACE-ME placeholder)'),
      `  deploy     aws ${deployArgv.slice(1).join(' ')}`,
      putArgv ? `  oauth      aws ${putArgv.slice(1).join(' ')}` : null,
      `  wire-token aws ${getArgv.slice(1).join(' ')} (read into the ctx entry only, never printed)`,
      flags['no-ctx'] ? '  context (skipped — --no-ctx)' : `  context ${ctxName} (ssm-ecs ${cluster}/${stackName}-node, token from the stack's wire-token secret)`,
    ].filter((l) => l != null).join('\n'));
    return;
  }

  // 1. preflight: aws resolves + NAME who we are (account+arn — identity
  //    visibility so a wrong-account deploy is caught; NEVER a secret).
  step('preflight');
  const idOut = await runAws(execFn, callerIdentityArgs({ region, profile }), 'sts get-caller-identity');
  let account = null; let arn = null;
  try { const id = JSON.parse(idOut || '{}'); account = id.Account || null; arn = id.Arn || null; } catch { /* identity is informational */ }
  log(`identity: account ${account || '?'} (${arn || '?'})`);
  okm('preflight');

  // 2. template: cloudformation deploy — create OR idempotent update
  //    (--no-fail-on-empty-changeset makes a no-change re-run green).
  step('template');
  await runAws(execFn, deployArgv, 'cloudformation deploy', EXIT.SERVER);
  okm('template');
  // Read the stack Outputs (real ARNs / joined subnets / copy-paste commands) —
  // best-effort; absence just drops the RunTaskCommand/PutTokenCommand display.
  const outputs = parseStackOutputs(await runAws(execFn, fargateStackOutputsArgs({ stackName, region, profile }), 'describe-stacks', EXIT.SERVER).catch(() => ''));

  // 3. oauth token (skip on Bedrock). put-secret-value with file:// — the value
  //    never enters argv/logs. Absent → warn LOUD + print the manual command,
  //    do NOT fail the deploy.
  if (!useBedrock) {
    if (oauthTokenFile) {
      step('oauth-token');
      await runAws(execFn, fargatePutOauthArgs({ stackName, region, profile, tokenFile: oauthTokenFile }), 'secretsmanager put-secret-value (oauth-token)', EXIT.SERVER);
      log('claude oauth token stored (file:// → put-secret-value; value never in argv). (Re)start the task to pick it up.');
      okm('oauth-token');
    } else {
      log('WARNING: no claude token (--token-file / CLODEX_CLAUDE_TOKEN_FILE unset) — the oauth-token secret keeps its REPLACE-ME placeholder; claude sessions will NOT authenticate until you populate it:');
      log(`  ${outputs.PutTokenCommand || `aws secretsmanager put-secret-value --secret-id ${stackName}/oauth-token --secret-string "$(cat TOKEN-FILE)"${region ? ` --region ${region}` : ''}`}`);
    }
  }

  // 4. wire token: the STACK minted its own (WireTokenSecret). Read it INTO
  //    MEMORY for the ctx entry only — never printed, never rewritten (no
  //    rotation on re-run — the stack owns it).
  step('wire-token');
  const token = await runAws(execFn, fargateGetWireTokenArgs({ stackName, region, profile }), 'secretsmanager get-secret-value (wire-token)', EXIT.SERVER);
  if (!token || /[\s\x00-\x1f]/.test(token)) {
    throw new CliError(EXIT.SERVER, `the stack's wire token (secret ${stackName}/wire-token) is empty or malformed — the stack may still be settling; re-run once it completes`);
  }
  okm('wire-token');

  // 5. ctx upsert BEFORE verify (the helm ctxSaved pattern). family = <stack>-node
  //    (the TaskDefinition Family / Service name). Collision kept unless --force.
  const family = `${stackName}-node`;
  const entry = {
    ssm: { ecs: `${cluster}/${family}`, ...(region ? { region } : {}), ...(profile ? { profile } : {}) },
    token,
  };
  let ctxSaved = false;
  if (flags['no-ctx']) {
    if (json) emit({ type: 'context', action: 'skipped', reason: '--no-ctx' });
  } else {
    const store = safeLoadContexts(io);
    const exists = Object.prototype.hasOwnProperty.call(store.contexts, ctxName);
    if (exists && !flags.force) {
      if (json) emit({ type: 'context', action: 'skipped', name: ctxName, reason: 'exists — --force to overwrite' });
      else printer.line(`context "${ctxName}" already exists — kept it (--force to overwrite)`);
    } else {
      store.contexts[ctxName] = entry;
      if (!store.current) store.current = ctxName;
      contexts.save(store, io.contextsFile);
      ctxSaved = true;
      if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name: ctxName });
      else printer.line(`context "${ctxName}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${ctxName} sessions`);
    }
  }

  // 6. verify — only for a persistent node (a Service keeps a task alive to
  //    poll). A non-persistent stack is infrastructure only: print the run-task
  //    command and skip verify (nothing is running yet).
  if (!persistent) {
    if (json) emit({ type: 'verify', ok: false, skipped: 'non-persistent' });
    else {
      printer.line('infrastructure deployed (Persistent=false) — start a node yourself; it stays down when it stops:');
      printer.line(`  ${outputs.RunTaskCommand || 'aws ecs run-task … (see the stack RunTaskCommand output)'}`);
    }
    return;
  }
  step('verify');
  let hello;
  try {
    const probe = io.probeFargate || fargatePollHello;
    hello = await probe(entry, token, { spawnFn: io.spawnFn, execFn, sleepFn: io.sleepFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`stack "${stackName}" deployed, but the node did not answer over the SSM tunnel within ${Math.round(FARGATE_VERIFY_TIMEOUT_MS / 60000)}min: ${e.message}`);
    // Truthful hint: a skipped ctx (collision, no --force) points at the OLD entry.
    const hint = flags['no-ctx'] ? ''
      : ctxSaved ? ` — the context was saved; debug with: clodexctl --ctx ${ctxName} ctx test --verbose`
        : ` — the context was NOT saved (name "${ctxName}" exists; re-run with --force to overwrite it)`;
    throw e instanceof CliError ? new CliError(e.exitCode, `${e.message}${hint}`) : new CliError(EXIT.SERVER, `deploy fargate verify failed: ${e.message}${hint}`);
  }
  okm('verify');
  if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
  else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} (ecs ${cluster}/${family})`);
}

module.exports = {
  DEFAULT_REPO, DEFAULT_BRANCH, DEFAULT_PORT, DEPLOY_TIMEOUT_MS, SSH_DEPLOY_ARGS, SSH_EXIT, NAME_RE, DEST_RE, REF_RE,
  shSingleQuote, scriptPath, readScript, buildPreamble, readClaudeToken, buildTokenDropinScript, parseMarker, sshDeployArgs, deriveCtxName,
  runDeploy, probeHello, deployVerb, deliverClaudeToken,
  DOCKER_IMAGE_REPO, DOCKER_DEFAULT_TAG, CONTAINER_PREFIX, CONTAINER_WIRE_PORT,
  DOCKER_VERIFY_TIMEOUT_MS, DOCKER_VERIFY_POLL_MS,
  normalizeDockerHost, dockerHostToSshDest, dockerRunArgs, runDocker, pollHello, deployDockerVerb,
  SSM_DEPLOY_TIMEOUT_MS, SSM_POLL_MS, SSM_PREPOLL_MS, SSM_SEND_RETRIES, SSM_SEND_RETRY_MS,
  buildSsmScript, awsBase, ssmDescribeArgs, ssmSendCommandArgs, ssmGetInvocationArgs,
  runAws, ssmPreflight, ssmSendCommand, ssmPoll, ssmMarkerLines, parseHelloMarker, ssmVerifyHello, deploySsmVerb,
  HELM_TIMEOUT, DEFAULT_HELM_NAMESPACE, HELM_RELEASE_RE, K8S_NS_RE,
  helmChartPath, helmArgv, helmStatusArgs, releaseSecretArgs, runVendor, helmVerifyHello, deployHelmVerb,
  FARGATE_TEMPLATE, FARGATE_STACK_RE, FARGATE_PARAM_RE, FARGATE_VERIFY_TIMEOUT_MS, FARGATE_VERIFY_POLL_MS,
  fargateTemplatePath, parseBoolFlag, fargateParamOverrides, fargateDeployArgs, callerIdentityArgs,
  fargatePutOauthArgs, fargateGetWireTokenArgs, fargateStackOutputsArgs, parseStackOutputs, fargatePollHello, deployFargateVerb,
};
