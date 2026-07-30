// STANDALONE by construction: node:* + this CLI's own sibling modules only,
// never an app require() — the published package ships without the app.
// NO TOKEN on the ssh deploy path: loopback bind + ssh tunnel is the auth
// boundary; do not add one.
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
const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
// A strict git-ref / repo-URL charset for values interpolated into the SSM
// wrapper. Covers https + git@ URLs and normal branch/tag names; REJECTS
// whitespace, newlines and shell/heredoc metachars — the single-quote escaping
// in buildPreamble does NOT neutralize a newline, and a newline can smuggle a
// heredoc-terminator line into the outer root wrapper (validate before interp).
const REF_RE = /^[A-Za-z0-9._:/@+~-]{1,256}$/;

const DOCKER_IMAGE_REPO = 'ghcr.io/avirtual/clodex';
const DOCKER_DEFAULT_TAG = 'latest';
const CONTAINER_PREFIX = 'clodexctl-';
const CONTAINER_WIRE_PORT = 7900;           // the wire's in-container port (baked)
const CONTAINER_WEB_PORT = 8080;            // the image's web GUI port (Dockerfile CLODEX_WEB_PORT; a FIXED port, NOT the ssh installer's wire+1)
const DOCKER_VERIFY_TIMEOUT_MS = 60 * 1000; // pull already happened in `run`; boot is seconds
const DOCKER_VERIFY_POLL_MS = 1000;

const SSH_DEPLOY_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
];
const SSH_EXIT = 255;  // ssh's own connect/auth failure code

function shSingleQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, `'\\''`)}'`;
}

function scriptPath() {
  return path.join(__dirname, '..', 'deploy', 'clodex-deploy.sh');
}
function readScript() {
  try { return fs.readFileSync(scriptPath(), 'utf8'); }
  catch (e) { throw new CliError(EXIT.SERVER, `deploy script unreadable at ${scriptPath()}: ${e.message}`); }
}

// claudeToken is ssh-flavor ONLY: it rides the same ssh stdin as the script,
// which is the auth boundary and is not logged. The SSM flavor MUST NOT pass
// it — that wrapper text lands in CloudTrail; deliver it post-verify over the
// encrypted wire instead. CLODEX_SRC is omitted when unset so the script's own
// default stays the single source of truth.
function buildPreamble({ port = DEFAULT_PORT, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, src = null, claudeToken = null, noWirescope = false } = {}) {
  let line = `export PORT=${shSingleQuote(port)} REPO_URL=${shSingleQuote(repo)} BRANCH=${shSingleQuote(branch)}`;
  if (src) line += ` CLODEX_SRC=${shSingleQuote(src)}`;
  if (claudeToken) line += ` CLODEX_CLAUDE_TOKEN=${shSingleQuote(claudeToken)}`;
  if (noWirescope) line += ` CLODEX_NO_WIRESCOPE='1'`;
  return line + '\n';
}

// Token from a FILE, never argv (argv leaks via ps). Whitespace/control chars
// are rejected: a newline would smuggle a second env-export line into the ssh
// preamble.
function readClaudeToken(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new CliError(EXIT.USAGE, `--claude-token-file unreadable at ${file}: ${e.message}`); }
  let tok = null;
  for (const ln of raw.split('\n')) {
    const m = ln.match(/^\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.*)$/);
    if (m) { tok = m[1].trim().replace(/^["']|["']$/g, ''); break; }
  }
  if (tok == null) tok = raw.trim();   // raw-token file
  if (!tok) throw new CliError(EXIT.USAGE, `--claude-token-file ${file} has no token (empty, or no CLAUDE_CODE_OAUTH_TOKEN=… line)`);
  if (/[\s\x00-\x1f]/.test(tok)) throw new CliError(EXIT.USAGE, `--claude-token-file ${file}: token has whitespace/control chars — expected a single opaque token or a CLAUDE_CODE_OAUTH_TOKEN=… line`);
  return tok;
}

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

function sshDeployArgs(host, sshOpts = []) {
  return [...SSH_DEPLOY_ARGS, ...sshOpts, host, 'bash -s'];
}

function deriveCtxName(dest) {
  const host = String(dest || '').split('@').pop() || '';
  const short = host.split(':')[0].split('.')[0];
  const stem = short.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return NAME_RE.test(stem) ? stem : '';
}

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

async function probeHello(dest, port, { spawnFn } = {}) {
  const t = await openTransport({ ssh: dest, remotePort: port }, { spawnFn });
  try {
    const client = new WireClient(t.baseUrl, null);   // no token — tunnel is the boundary
    return await client.get('/api/peer/hello', 'deploy (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

const DEST_RE = /^[a-zA-Z0-9._@-]{1,128}$/;

function parsePortOr(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) throw new CliError(EXIT.USAGE, '--port must be a port number (1-65535)');
  return n;
}

async function deployVerb({ printer, flags, args, io = {} }) {
  const dest = args[0];
  if (!dest) throw new CliError(EXIT.USAGE, 'deploy needs an ssh destination (e.g. user@host)');
  if (!DEST_RE.test(dest)) throw new CliError(EXIT.USAGE, `bad ssh destination "${dest}" — use user@host / host / IP (set a port in ~/.ssh/config, not host:port)`);

  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  const repo = flags.repo ? String(flags.repo) : DEFAULT_REPO;
  const branch = flags.branch ? String(flags.branch) : DEFAULT_BRANCH;
  const src = flags.src ? String(flags.src) : null;
  const sshOpts = Array.isArray(flags['ssh-opt']) ? flags['ssh-opt'] : (flags['ssh-opt'] ? [String(flags['ssh-opt'])] : []);
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const noWirescope = !!flags['no-wirescope'];
  const script = readScript();
  const preamble = buildPreamble({ port, repo, branch, src, claudeToken, noWirescope });
  const stdin = preamble + script;
  const ctxName = flags.name ? String(flags.name) : deriveCtxName(dest);
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);

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
  // `deploy` (t54): which flavor made this node. NOT inferable from the
  // transport — a remote `deploy docker` saves the same `{ssh: user@host}`
  // shape this line does, so without the field an `upgrade <ctx>` would have to
  // guess between re-running an installer and pulling a new container image.
  store.contexts[ctxName] = { ssh: dest, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}), webPort, deploy: { flavor: 'ssh', host: dest } };
  if (!store.current) store.current = ctxName;
  contexts.save(store, io.contextsFile);
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name: ctxName, webPort });
  else {
    printer.line(`context "${ctxName}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${ctxName} sessions`);
    printer.line(`  see it in your browser: clodexctl web ${ctxName}`);
  }
}

function safeLoadContexts(io) {
  try { return contexts.load(io.contextsFile, { warn: () => {} }); }
  catch { return { current: null, contexts: {} }; }
}


function normalizeDockerHost(h) {
  const s = String(h == null ? '' : h).trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `ssh://${s}`;
}

function dockerHostToSshDest(dockerHost) {
  const s = String(dockerHost || '');
  const m = s.match(/^ssh:\/\/([^/]+)/i);
  if (!m) return '';
  return m[1].replace(/:\d+$/, '');   // strip a trailing :port — belongs in ~/.ssh/config
}

// --hostname becomes the engine's SELF_LABEL on the peer wire: it must be
// unique per node or DM routing collides.
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

  const childEnv = dockerHost ? { ...(io.env || process.env), DOCKER_HOST: dockerHost } : null;
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  let res;
  try {
    res = await runDocker({ args: runArgs, env: childEnv, spawnFn: io.spawnFn, onStderr: (s) => { if (!json) writeErr(s); } });
  } catch (e) {
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
  const dep = { flavor: 'docker', container: CONTAINER_PREFIX + name, ...(dockerHost ? { dockerHost } : {}) };
  const entry = sshDest
    ? { ssh: sshDest, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}), deploy: dep }
    : { url: `http://127.0.0.1:${port}`, deploy: dep };
  store.contexts[name] = entry;
  if (!store.current) store.current = name;
  contexts.save(store, io.contextsFile);
  const hint = probe.tokenGated ? ' (token-gated — add your token: clodexctl ctx add …)' : '';
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name, tokenGated: !!probe.tokenGated });
  else printer.line(`context "${name}" ${exists ? 'updated' : 'saved'}${hint} — you can now: clodexctl --ctx ${name} sessions`);
}

// ── ssm flavor ──
// RunCommand runs as ROOT and has no stdin/stdout pipe (async send, polled
// output, 24KB cap) — hence the root wrapper that mints a clodex user and then
// runs the PINNED installer as that user. The installer bytes must stay
// byte-identical (a drift test gates them), so the wire token is injected
// AFTER it runs via a systemd --user drop-in rather than by forking it.
// That token rides send-command parameters → visible in SSM history/CloudTrail;
// acceptable only because the port never leaves loopback.
const SSM_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;  // a cold clone+install+rebuild is minutes
const SSM_POLL_MS = 5000;                       // get-command-invocation cadence
const SSM_PREPOLL_MS = 2000;                    // let SSM register the invocation before the first poll
const SSM_SEND_RETRY_MS = 2000;                 // backoff between send-command retries
const SSM_SEND_RETRIES = 3;                     // InvalidInstanceId is eventually-consistent post-registration

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// No `set -e` here on purpose: load-bearing steps gate with
// `|| { echo "::fail …"; exit 1; }` and best-effort steps use `|| true`.
// repo/branch are REF_RE-validated by the caller before interpolation, and the
// heredoc delimiters carry a per-run random nonce, so no field can smuggle a
// terminator line.
function buildSsmScript({ port = DEFAULT_PORT, token, repo = DEFAULT_REPO, branch = DEFAULT_BRANCH, noWirescope = false } = {}) {
  const embedded = buildPreamble({ port, repo, branch, noWirescope }) + readScript();
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

function awsBase({ region, profile } = {}) {
  return [
    ...(profile ? ['--profile', profile] : []),
    ...(region ? ['--region', region] : []),
  ];
}

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

// Only NEWLINE-TERMINATED lines count: a poll can catch output mid-echo, and a
// truncated marker fired now would be swallowed by the cursor when the real
// line arrives. Partial output is a growing prefix, so the cursor never
// re-fires a rendered line.
function ssmMarkerLines(stdout) {
  const s = String(stdout || '');
  const nl = s.lastIndexOf('\n');
  if (nl < 0) return [];
  return s.slice(0, nl).split('\n').filter((l) => /^::/.test(l));
}

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

function parseHelloMarker(stdout) {
  const m = String(stdout || '').match(/::verify\s+http=(\d{3})/);
  return m ? m[1] : null;
}

async function ssmVerifyHello(entry, token, { spawnFn, execFn } = {}) {
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, token);
    return await client.get('/api/peer/hello', 'deploy ssm (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

// The typed script's `systemctl restart` drops the engine, which tears this
// wire down — a post-input CONNECT error is the EXPECTED end, not a failure.
// Epistemics: success here proves input-accepted + engine-reachable-after, NOT
// that the drop-in was written; the first `spawn --type claude` is the real
// proof. The secret rides the encrypted wire, never SSM params/CloudTrail.
const TOKEN_SESSION_PREFIX = 'clodex-token-';
async function deliverClaudeToken(entry, wireToken, oauthToken, { spawnFn, execFn, timeoutMs = 60000, pollMs = 1000, sleepFn = defaultSleep } = {}) {
  const sessName = TOKEN_SESSION_PREFIX + crypto.randomBytes(4).toString('hex');
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, wireToken);
    // 1. throwaway bash session (as the clodex user the engine runs as). The
    //    engine REJECTS a create without cwd; /tmp exists on any box we deploy.
    await client.post('/api/sessions', 'deploy ssm (token session)', { name: sessName, type: 'bash', cwd: '/tmp' });
    const acq = await client.post(`/api/control/${encodeURIComponent(sessName)}`, 'deploy ssm (token control)', { action: 'acquire', client: 'clodexctl' });
    const ctrlToken = acq && acq.token;
    if (!ctrlToken) throw new CliError(EXIT.SERVER, 'token delivery: could not acquire session control');
    const dropin = buildTokenDropinScript(oauthToken) + '\n';
    try {
      await client.post(`/api/input/${encodeURIComponent(sessName)}`, 'deploy ssm (token write)', { token: ctrlToken, data: dropin });
    } catch (e) {
      if (!(e instanceof CliError && e.exitCode === EXIT.CONNECT)) throw e;
    }
  } finally {
    try { t.close(); } catch {}
  }
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

async function deploySsmVerb({ printer, flags, args, io = {} }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy ssm needs a node name (e.g. deploy ssm mybox --target i-…)');
  if (!NAME_RE.test(name)) throw new CliError(EXIT.USAGE, `bad node name "${name}" — use ${NAME_RE.source}`);
  const target = flags.target ? String(flags.target) : null;
  if (!target) throw new CliError(EXIT.USAGE, 'deploy ssm needs --target i-INSTANCE');

  const region = flags.region ? String(flags.region) : null;
  const profile = flags.profile ? String(flags.profile) : null;
  const port = flags.port != null ? parsePortOr(flags.port) : DEFAULT_PORT;
  const repo = flags.repo ? String(flags.repo) : DEFAULT_REPO;
  const branch = flags.branch ? String(flags.branch) : DEFAULT_BRANCH;
  if (!REF_RE.test(repo)) throw new CliError(EXIT.USAGE, `bad --repo "${repo}" — use a git URL/ref (${REF_RE.source})`);
  if (!REF_RE.test(branch)) throw new CliError(EXIT.USAGE, `bad --branch "${branch}" — use a git ref name (${REF_RE.source})`);
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const noWirescope = !!flags['no-wirescope'];
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);
  const execFn = io.execFn;   // undefined → runAws/ssm* default to execFileP
  const sleepFn = io.sleepFn;  // undefined → real setTimeout; tests inject a no-op
  const sd = { target, region, profile };

  const entry = {
    ssm: { target, ...(region ? { region } : {}), ...(profile ? { profile } : {}) },
    ...(port !== DEFAULT_PORT ? { remotePort: port } : {}),
  };

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

  const token = crypto.randomBytes(24).toString('hex');
  const script = buildSsmScript({ port, token, repo, branch, noWirescope });

  const info = await ssmPreflight(sd, { execFn });
  if (json) emit({ type: 'preflight', ok: true, target, pingStatus: info.PingStatus || null, platform: info.PlatformName || null });
  else printer.line(`instance ${target} online${info.PlatformName ? ` (${info.PlatformName})` : ''} — sending install command…`);

  const commandId = await ssmSendCommand({ ...sd, script }, { execFn, sleepFn });
  if (json) emit({ type: 'command', commandId });
  else printer.line(`running remote install (SSM command ${commandId})…`);

  let streamed = 0;
  const result = await ssmPoll({ commandId, ...sd }, {
    execFn, sleepFn,
    onStatus: (s) => { if (json) emit({ type: 'status', status: s }); },
    onMarker: (raw) => { streamed++; renderMarker(raw); },
  });
  if (result.status !== 'Success') {
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
  if (streamed === 0) { for (const l of ssmMarkerLines(result.stdout)) renderMarker(l); }
  const helloCode = parseHelloMarker(result.stdout);
  if (!json) printer.line(`  remote install ok${helloCode ? ` (on-box hello ${helloCode})` : ''}`);

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
  const webPort = port + 1;
  store.contexts[name] = { ...entry, webPort, token, deploy: { flavor: 'ssm', target, ...(region ? { region } : {}), ...(profile ? { profile } : {}) } };
  if (!store.current) store.current = name;
  contexts.save(store, io.contextsFile);
  if (json) emit({ type: 'context', action: exists ? 'overwritten' : 'added', name, webPort });
  else {
    printer.line(`context "${name}" ${exists ? 'updated' : 'saved'} — you can now: clodexctl --ctx ${name} sessions`);
    printer.line(`  see it in your browser: clodexctl web ${name}`);
  }
}

// ── helm flavor ──
// TOKEN DISCIPLINE: the token VALUE never enters argv, markers, logs or errors
// — only FILE PATHS cross argv (--set-file). Tempfiles are 0600 and removed in
// a finally.
const HELM_TIMEOUT = '5m';                    // --wait budget (chart readiness probe)
const DEFAULT_HELM_NAMESPACE = 'clodex';
// Helm release names are DNS-1123 labels capped at 53 chars (lowercase
// alphanumerics + '-', must start/end alphanumeric). Validate EARLY — helm's
// own late failure is a worse message — and note the name doubles as the ctx
// name (NAME_RE is a superset of this, so one check covers both).
const HELM_RELEASE_RE = /^[a-z0-9]([a-z0-9-]{0,51}[a-z0-9])?$/;
const K8S_NS_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function helmChartPath() {
  return path.join(__dirname, '..', 'deploy', 'helm', 'clodex');
}

// carriedValuesFile MUST be the FIRST --values: helm merges values files
// left-to-right, later wins, so a carried value placed after the operator's own
// -f would beat a file passed on THIS run. --set is applied after all files
// regardless of argv position, so this-run --set needs no ordering care.
// (Both verified against helm v4.1.0 with `helm template`.)
// forceConflicts stays OFF by default: forcing takes ownership of every
// conflicting field, including ones a controller legitimately owns.
function helmArgv({ name, chart, namespace, kubeContext = null, port = DEFAULT_PORT, wireTokenFile, oauthTokenFile = null, sets = [], valuesFiles = [], carriedValuesFile = null, forceConflicts = false } = {}) {
  return [
    'helm', 'upgrade', '--install', name, chart,
    '--namespace', namespace,
    ...(kubeContext ? ['--kube-context', kubeContext] : []),
    '--set-file', `secrets.wireToken=${wireTokenFile}`,
    ...(oauthTokenFile ? ['--set-file', `secrets.oauthToken=${oauthTokenFile}`] : []),
    ...(port !== DEFAULT_PORT ? ['--set', `wirePort=${port}`] : []),
    ...sets.flatMap((s) => ['--set', s]),
    ...(carriedValuesFile ? ['--values', carriedValuesFile] : []),
    ...valuesFiles.flatMap((f) => ['--values', f]),
    ...(forceConflicts ? ['--force-conflicts'] : []),
    '--wait', '--timeout', HELM_TIMEOUT,
  ];
}

const SSA_CONFLICT_RE = /Apply failed with \d+ conflicts?:/;
function ssaConflictHint(stderr, { name, namespace } = {}) {
  const text = String(stderr || '');
  if (!SSA_CONFLICT_RE.test(text)) return null;

// The quotes must be UNESCAPED: helm prints this text twice, once JSON-escaped
// inside a `level=WARN msg="upgrade failed" error="…\"kubectl-edit\"…"` line.
// A pattern tolerating `\"` matches that copy and captures escaped garbage.
  const who = /conflicts? with "([^"]+)" using (\S+?):/.exec(text);
  const manager = who ? who[1] : null;

  // The conflicting field(s): inline after the colon (singular), else the `- x`
  // list on the lines that follow (plural).
  const fields = [];
  if (who) {
    const rest = text.slice(who.index + who[0].length);
    const firstLine = rest.split('\n')[0].trim();
    if (firstLine) fields.push(firstLine);
    else {
      for (const line of rest.split('\n').slice(1)) {
        const m = /^\s*-\s+(\S.*)$/.exec(line);
        if (!m) break;
        fields.push(m[1].trim());
      }
    }
  }

  // The object: `object <ns>/<name> <group>/<version>, Kind=<Kind>:` — the group
  // is empty for core types (which is why that half may be blank), and the Kind
  // is followed by the `: Apply failed …` that the detection regex matched, so
  // it must stop at the colon rather than take \S+.
  const obj = /while applying object (\S+) (\S*), Kind=([^\s:,]+)/.exec(text);
  const objectDesc = obj ? `${obj[3]} ${obj[1]}` : 'an object in the release';

  const ns = namespace || (obj && obj[1].includes('/') ? obj[1].split('/')[0] : null);
  const kind = obj ? obj[3].toLowerCase() : 'sts';
  const objName = obj && obj[1].includes('/') ? obj[1].split('/')[1] : (name || '<name>');
  const inspect = ns
    ? `kubectl -n ${ns} get ${kind} ${objName} -o jsonpath='{range .metadata.managedFields[*]}{.manager}{" "}{.operation}{"\\n"}{end}'`
    : null;

  const owner = manager ? `"${manager}"` : 'another field manager';
  const what = fields.length
    ? `${fields.length === 1 ? 'the field' : 'the fields'} ${fields.join(', ')} on ${objectDesc} ${fields.length === 1 ? 'is' : 'are'} owned by ${owner}`
    : `a field on ${objectDesc} is owned by ${owner}`;

  return [
    `${what}, and this release applies SERVER-SIDE, where a manager may not change a field it does not own.`,
    'Re-running the same command will fail the same way — this is not a partial or transient state. Something outside helm (typically `kubectl edit`/`patch`/`apply`) changed that field, which permanently claimed it.',
    inspect ? `See every owner:\n  ${inspect}` : null,
    `Then either hand the field back (revert the out-of-band change), or re-run with --force-conflicts to take ownership of it. --force-conflicts overrides ${owner} on ${fields.length === 1 ? 'that field' : 'those fields'} — check first that it is not a controller that legitimately owns ${fields.length === 1 ? 'it' : 'them'} (an HPA on replicas, a sidecar injector), because forcing takes the field away from it too.`,
    name && namespace ? `(this release's apply method: helm get metadata ${name} -n ${namespace})` : null,
  ].filter(Boolean).join('\n');
}

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

// NO `-a`: --all dumps the COMPUTED value set, so re-applying it would freeze
// every chart default (including image.tag, the version pin) at the day the
// release was last touched. Plain `get values` = user-supplied overrides only.
function helmGetValuesArgs({ name, namespace, kubeContext = null } = {}) {
  return ['helm', 'get', 'values', name, '--namespace', namespace,
    ...(kubeContext ? ['--kube-context', kubeContext] : []), '-o', 'json'];
}

// --set-file makes the tokens part of the release's user-supplied values, so
// `helm get values` hands the token VALUE back. Never carry secrets.*: the
// Secret read-back above is the single authoritative source.
const HELM_NEVER_CARRY = ['secrets'];

function parseCarriedValues(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === 'null') return { values: {}, carried: [], dropped: [] };
  let obj;
  try { obj = JSON.parse(s); }
  catch (e) { throw new CliError(EXIT.SERVER, `could not parse the release's prior values as JSON (${e.message}) — refusing to re-run, because deploying without them would silently revert your overrides`); }
  if (obj === null) return { values: {}, carried: [], dropped: [] };
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw new CliError(EXIT.SERVER, `the release's prior values are not a JSON object (got ${Array.isArray(obj) ? 'an array' : typeof obj}) — refusing to re-run rather than silently revert your overrides`);
  }
  const values = {}; const carried = []; const dropped = [];
  for (const k of Object.keys(obj)) {
    if (HELM_NEVER_CARRY.includes(k)) { dropped.push(k); continue; }
    values[k] = obj[k]; carried.push(k);
  }
  return { values, carried, dropped };
}

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

async function helmVerifyHello(entry, token, { spawnFn, execFn } = {}) {
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, token);
    return await client.get('/api/peer/hello', 'deploy helm (verify)');
  } finally {
    try { t.close(); } catch {}
  }
}

async function deployHelmVerb({ printer, flags, args, io = {} }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy helm needs a release name (e.g. deploy helm mynode)');
  if (!HELM_RELEASE_RE.test(name)) {
    throw new CliError(EXIT.USAGE, `bad release name "${name}" — helm release names are DNS-1123: lowercase letters/digits/hyphens, start+end alphanumeric, max 53 chars (no dots or underscores; it doubles as the ctx name)`);
  }
  const namespace = flags.namespace ? String(flags.namespace) : DEFAULT_HELM_NAMESPACE;
  if (!K8S_NS_RE.test(namespace)) throw new CliError(EXIT.USAGE, `bad --namespace "${namespace}" — a DNS-1123 label (lowercase letters/digits/hyphens, max 63 chars)`);
  const portFlagged = flags.port != null;
  let port = portFlagged ? parsePortOr(flags.port) : DEFAULT_PORT;
  const chart = flags.chart ? String(flags.chart) : helmChartPath();
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
  let webEnabledFlag = null;
  for (const s of sets) {
    const m = /^web\.enabled=(.*)$/.exec(s);
    if (m) webEnabledFlag = !/^(false|0|no)$/i.test(m[1].trim());
  }
  let webEnabled = webEnabledFlag == null ? true : webEnabledFlag;
  const valuesFiles = Array.isArray(flags.values) ? flags.values.map(String) : (flags.values ? [String(flags.values)] : []);
  // Claude auth (optional): read + validate the token NOW (fail fast before any
  // cluster call). The EXTRACTED value is re-staged into its own 0600 tempfile
  // for --set-file — the input may be an env-file whose raw bytes are NOT the
  // token. Never printed, never argv.
  const claudeToken = flags['claude-token-file'] ? readClaudeToken(String(flags['claude-token-file'])) : null;
  const json = !!flags.json;
  const emit = (obj) => printer.json(obj);
  const execFn = io.execFn || execFileP;

  const step = (n) => { if (json) emit({ type: 'step', name: n }); else printer.line(`→ ${n} …`); };
  const okm = (n) => { if (json) emit({ type: 'ok', name: n }); else printer.line(`  ${n} ok`); };
  const log = (t) => { if (json) emit({ type: 'log', text: t }); else printer.line(`  ${t}`); };

  if (flags['no-wirescope']) {
    log('--no-wirescope is ignored by the helm flavor — use --set wirescope.enabled=false (the chart value)');
  }

  if (flags['dry-run']) {
    const argvPreview = helmArgv({ name, chart, namespace, kubeContext: flags['kube-context'] ? String(flags['kube-context']) : null, port, wireTokenFile: '<wire-token-tempfile>', oauthTokenFile: claudeToken ? '<oauth-token-tempfile>' : null, sets, valuesFiles, forceConflicts: !!flags['force-conflicts'] });
    const ctxEntry = { kubectl: { target: `svc/${name}`, namespace, ...(flags['kube-context'] ? { context: String(flags['kube-context']) } : {}) }, ...(port !== DEFAULT_PORT ? { remotePort: port } : {}), token: '<minted-or-reused>', deploy: { flavor: 'helm', release: name, namespace, kubeContext: flags['kube-context'] ? String(flags['kube-context']) : null } };
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
      '  (its prior --set/--values overrides are also carried forward and re-applied — a flag on this run beats a carried value; the cluster is not touched on --dry-run, so they cannot be listed here)',
    ].filter(Boolean).join('\n'));
    return;
  }

  step('preflight');
  await runVendor(execFn, ['helm', 'version', '--short'], 'version');
  await runVendor(execFn, ['kubectl', 'version', '--client', '--output=yaml'], 'version --client');
  let kubeContext = flags['kube-context'] ? String(flags['kube-context']) : null;
  if (!kubeContext) {
    kubeContext = await runVendor(execFn, ['kubectl', 'config', 'current-context'], 'config current-context');
    if (!kubeContext) throw new CliError(EXIT.CONNECT, 'kubectl has no current context — pass --kube-context');
  }
  log(`cluster: kube context "${kubeContext}", namespace "${namespace}"`);
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

// Carry the operator's prior user-supplied overrides forward explicitly.
// NOT `--reuse-values`: it also ignores new chart defaults, which would freeze
// image.tag (the authoritative version pin) at the release's last touch — the
// same silent revert by the other door. `--reset-then-reuse-values` needs helm
// 3.14+, which we do not control.
// Precedence: chart defaults < carried prior values < this run's flags, so an
// explicit --set image.tag survives a re-run.
  let carriedValues = null;
  if (releaseExists) {
    let rawValues;
    try {
      rawValues = await runVendor(execFn, helmGetValuesArgs({ name, namespace, kubeContext }), 'get values', EXIT.SERVER);
    } catch (e) {
      throw new CliError(EXIT.SERVER, `release "${name}" exists but its prior values could not be read (${e.message}) — refusing to continue, because upgrading without them would silently revert every override you set`);
    }
    const parsed = parseCarriedValues(rawValues);
    carriedValues = parsed.values;
    if (parsed.carried.length) log(`carrying forward your prior values: ${parsed.carried.join(', ')} (re-applied under this run's flags)`);
    else log('no prior values to carry forward (the release has no operator overrides)');
    if (parsed.dropped.length) log(`not carried (owned by the release Secret, never re-applied from values): ${parsed.dropped.join(', ')}`);

    if (!portFlagged && Number.isInteger(carriedValues.wirePort)) port = carriedValues.wirePort;
    if (webEnabledFlag == null && carriedValues.web && typeof carriedValues.web === 'object'
        && typeof carriedValues.web.enabled === 'boolean') {
      webEnabled = carriedValues.web.enabled;
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-helm-'));
  try {
    const wireTokenFile = path.join(tmpDir, 'wire-token');
    fs.writeFileSync(wireTokenFile, token, { mode: 0o600 });
    let carriedValuesFile = null;
    if (carriedValues && Object.keys(carriedValues).length) {
      carriedValuesFile = path.join(tmpDir, 'carried-values.json');
      fs.writeFileSync(carriedValuesFile, JSON.stringify(carriedValues, null, 2), { mode: 0o600 });
    }
    let oauthTokenFile = null;
    const oauthToStage = claudeToken || reusedOauth;   // fresh flag wins; else preserve
    if (oauthToStage) {
      oauthTokenFile = path.join(tmpDir, 'oauth-token');
      fs.writeFileSync(oauthTokenFile, oauthToStage, { mode: 0o600 });
      if (claudeToken) log('claude token staged (0600 tempfile → --set-file, redacted)');
    }
    const argv = helmArgv({ name, chart, namespace, kubeContext, port, wireTokenFile, oauthTokenFile, sets, valuesFiles, carriedValuesFile, forceConflicts: !!flags['force-conflicts'] });
    step('helm');
    try {
      await runVendor(execFn, argv, 'upgrade --install', EXIT.SERVER);
    } catch (e) {
      const ssa = ssaConflictHint(e.message, { name, namespace });
      if (json) emit({ type: 'error', reason: ssa ? 'helm-conflict' : 'helm-failed', message: e.message });
      if (ssa) throw new CliError(EXIT.SERVER, `${e.message}\n${ssa}`);
      throw new CliError(EXIT.SERVER, `${e.message}\nrelease "${name}" likely exists in a partial state — fix the cause and re-run: the same command upgrades in place (inspect with: helm status ${name} -n ${namespace}; kubectl -n ${namespace} get pods)`);
    }
    okm('helm');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  const entry = {
    kubectl: { target: `svc/${name}`, namespace, context: kubeContext },
    ...(port !== DEFAULT_PORT ? { remotePort: port } : {}),
    // webPort: the image's FIXED web GUI port (CONTAINER_WEB_PORT=8080), the
    // same one the chart's Service now publishes as its `web` port. Without
    // this `clodexctl web <ctx>` fell back to wire+1 (7901), which the Service
    // never exposes → "does not have a service port 7901". Skipped when the
    // chart's web is disabled (--set web.enabled=false): no port to reach.
    ...(webEnabled ? { webPort: CONTAINER_WEB_PORT } : {}),
    token,
    deploy: { flavor: 'helm', release: name, namespace, kubeContext },
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

  step('verify');
  let hello;
  try {
    const probe = io.probeHelm || helmVerifyHello;
    hello = await probe(entry, token, { spawnFn: io.spawnFn, execFn });
  } catch (e) {
    if (json) emit({ type: 'error', reason: 'verify-failed', message: e.message });
    else printer.line(`release "${name}" is live (helm --wait passed), but the wire did not answer through kubectl port-forward: ${e.message}`);
    const hint = flags['no-ctx'] ? ''
      : ctxSaved ? ` — the context was saved; debug with: clodexctl --ctx ${name} ctx test --verbose`
        : ` — the context was NOT saved (name "${name}" exists; re-run with --force to overwrite it)`;
    throw e instanceof CliError ? new CliError(e.exitCode, `${e.message}${hint}`) : new CliError(EXIT.SERVER, `deploy helm verify failed: ${e.message}${hint}`);
  }
  okm('verify');
  if (json) emit({ type: 'verify', ok: true, host: hello.host || null, version: hello.version || null, caps: hello.caps || [] });
  else printer.line(`verified — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} (svc/${name} -n ${namespace} @ ${kubeContext})`);
}

const FARGATE_TEMPLATE = 'clodex-fargate.yaml';
const FARGATE_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;   // Fargate cold start: image pull + boot
const FARGATE_VERIFY_POLL_MS = 5000;
// CloudFormation stack names: start with a letter, then letters/digits/hyphens,
// max 128. Stricter than NAME_RE because the name doubles as the ctx name, the
// default cluster, and the secret prefix (<stack>/wire-token, <stack>/oauth-token).
const FARGATE_STACK_RE = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const FARGATE_PARAM_RE = /^[A-Za-z][A-Za-z0-9]*=.*/;

function fargateTemplatePath() {
  return path.join(__dirname, '..', 'deploy', FARGATE_TEMPLATE);
}

function parseBoolFlag(v, name) {
  const s = String(v).toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  throw new CliError(EXIT.USAGE, `--${name} must be true or false, got "${v}"`);
}

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
// `aws configure get region` — the honest read of what the CLI itself resolved
// for the profile when no --region flag was given. Profile-aware; NEVER carries
// --region (that would defeat the point). An unset key exits non-zero → runAws
// throws → the caller leaves the region unresolved and WARNs.
function fargateConfigureGetRegionArgs({ profile } = {}) {
  return ['aws', ...(profile ? ['--profile', profile] : []), 'configure', 'get', 'region'];
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
function parseStackOutputs(json) {
  try {
    const list = JSON.parse(json || '[]');
    if (!Array.isArray(list)) return {};
    const out = {};
    for (const o of list) { if (o && o.OutputKey) out[o.OutputKey] = o.OutputValue; }
    return out;
  } catch { return {}; }
}

function fargateDescribeVpcsArgs({ region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ec2', 'describe-vpcs',
    '--filters', 'Name=is-default,Values=true',
    '--query', 'Vpcs[].VpcId', '--output', 'text'];
}
function fargateDescribeSubnetsArgs({ vpcId, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ec2', 'describe-subnets',
    '--filters', `Name=vpc-id,Values=${vpcId}`, 'Name=default-for-az,Values=true',
    '--query', 'Subnets[].SubnetId', '--output', 'text'];
}
function fargateDescribeSgArgs({ vpcId, region, profile } = {}) {
  return ['aws', ...awsBase({ region, profile }),
    'ec2', 'describe-security-groups',
    '--filters', `Name=vpc-id,Values=${vpcId}`, 'Name=group-name,Values=default',
    '--output', 'json'];
}

function fargateSgInboundWarning(sgId, ipPermissions = []) {
  const items = [];
  for (const p of ipPermissions || []) {
    const proto = (p.IpProtocol === '-1' || p.IpProtocol == null) ? 'all' : String(p.IpProtocol);
    const port = p.FromPort == null ? ''
      : (p.FromPort === p.ToPort ? ` ${p.FromPort}` : ` ${p.FromPort}-${p.ToPort}`);
    const sources = [
      ...(p.IpRanges || []).map((r) => r.CidrIp),
      ...(p.Ipv6Ranges || []).map((r) => r.CidrIpv6),
      ...(p.PrefixListIds || []).map((r) => r.PrefixListId),
      // self-referencing pairs are factory; only a FOREIGN group id offends.
      ...(p.UserIdGroupPairs || []).filter((u) => u.GroupId && u.GroupId !== sgId).map((u) => u.GroupId),
    ].filter(Boolean);
    for (const s of sources) items.push(`${proto}${port} from ${s}`);
  }
  if (!items.length) return null;
  return `detected default SG ${sgId} has inbound rules: ${items.join(', ')} — the node needs NO inbound; consider a closed SG`;
}

async function fargateDetectNetwork({ region, profile, needSubnets, needSg, execFn } = {}) {
  const passBoth = 'pass --subnets and --security-group explicitly';
  const vpcOut = await runAws(execFn, fargateDescribeVpcsArgs({ region, profile }), 'ec2 describe-vpcs');
  const vpcId = vpcOut.split(/\s+/).filter(Boolean)[0] || null;
  if (!vpcId) throw new CliError(EXIT.USAGE, `no default VPC in this account/region — ${passBoth}`);

  let subnets = null;
  if (needSubnets) {
    const subOut = await runAws(execFn, fargateDescribeSubnetsArgs({ vpcId, region, profile }), 'ec2 describe-subnets');
    const ids = subOut.split(/\s+/).filter(Boolean).sort();   // stable order
    if (!ids.length) throw new CliError(EXIT.USAGE, `no default-for-az subnets in the default VPC ${vpcId} — ${passBoth}`);
    subnets = ids.join(',');
  }

  let securityGroup = null;
  let sgInboundWarning = null;
  if (needSg) {
    const sgOut = await runAws(execFn, fargateDescribeSgArgs({ vpcId, region, profile }), 'ec2 describe-security-groups');
    let groups = [];
    try { groups = (JSON.parse(sgOut || '{}').SecurityGroups) || []; } catch { groups = []; }
    const g = groups[0] || null;
    securityGroup = (g && g.GroupId) || null;
    if (!securityGroup) throw new CliError(EXIT.USAGE, `no default security group in the default VPC ${vpcId} — ${passBoth}`);
    sgInboundWarning = fargateSgInboundWarning(securityGroup, g.IpPermissions || []);
  }
  return { vpcId, subnets, securityGroup, sgInboundWarning };
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
  let assignPublicIp = flags['assign-public-ip'] ? String(flags['assign-public-ip']) : null;
  if (assignPublicIp && assignPublicIp !== 'ENABLED' && assignPublicIp !== 'DISABLED') {
    throw new CliError(EXIT.USAGE, `--assign-public-ip must be ENABLED or DISABLED, got "${assignPublicIp}"`);
  }
  const assignPublicIpGiven = assignPublicIp != null;   // an explicit flag always wins
  let subnets = flags.subnets ? String(flags.subnets) : null;
  let securityGroup = flags['security-group'] ? String(flags['security-group']) : null;
  const persistent = flags.persistent != null ? parseBoolFlag(flags.persistent, 'persistent') : true;
  const params = Array.isArray(flags.param) ? flags.param.map(String) : (flags.param ? [String(flags.param)] : []);
  for (const p of params) {
    if (!FARGATE_PARAM_RE.test(p)) throw new CliError(EXIT.USAGE, `bad --param "${p}" — expected KEY=VALUE (KEY a CloudFormation parameter name)`);
  }

  const env = io.env || process.env;
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

  const needSubnets = !subnets;
  const needSg = !securityGroup;
  const autoDetected = { subnets: needSubnets, securityGroup: needSg };
  const networkLines = [];
  let netVpcId = null;
  let sgInboundWarning = null;
  if (needSubnets || needSg) {
    const net = await fargateDetectNetwork({ region, profile, needSubnets, needSg, execFn });
    netVpcId = net.vpcId;
    if (needSubnets) subnets = net.subnets;
    if (needSg) { securityGroup = net.securityGroup; sgInboundWarning = net.sgInboundWarning; }
    // assign-public-ip: default-VPC subnets are PUBLIC — DISABLED there means no
    // egress → image pull hangs → verify times out with no clue. When subnets were
    // auto-detected and no flag was given, imply ENABLED (an explicit flag wins).
    const impliedPublicIp = needSubnets && !assignPublicIpGiven;
    if (impliedPublicIp) assignPublicIp = 'ENABLED';
    networkLines.push(`network: default VPC ${netVpcId} [auto-detected]`);
    if (needSubnets) networkLines.push(`network: subnets ${subnets} [auto-detected]`);
    if (needSg) networkLines.push(`network: security-group ${securityGroup} [auto-detected]`);
    if (impliedPublicIp) networkLines.push('network: assign-public-ip ENABLED [implied by default-VPC subnets]');
    if (sgInboundWarning) networkLines.push(`WARNING: ${sgInboundWarning}`);
  }

// Region is OBSERVED for the RECORD only — it never steers the deploy. When
// --region is unset, mirror the AWS CLI's own precedence: AWS_REGION/
// AWS_DEFAULT_REGION beat profile config, so asking `aws configure get region`
// while env is set would record a region the deploy never used.
  let effectiveRegion = region;
  let regionResolvedFrom = null; // 'env' | 'profile' | null (flag = already effective)
  if (!effectiveRegion) {
    const env = io.env || process.env;
    const envRegion = String(env.AWS_REGION || env.AWS_DEFAULT_REGION || '').trim();
    if (envRegion) { effectiveRegion = envRegion; regionResolvedFrom = 'env'; }
  }
  if (!effectiveRegion) {
    try {
      const r = await runAws(execFn, fargateConfigureGetRegionArgs({ profile }), 'configure get region');
      if (r) { effectiveRegion = r; regionResolvedFrom = 'profile'; }
    } catch { /* unset key OR aws itself missing — leave null, warned below; a
                 missing aws binary re-surfaces hard at the preflight step */ }
  }
  const regionResolvedFromProfile = regionResolvedFrom === 'profile';
  const regionLine = effectiveRegion
    ? (regionResolvedFrom
      ? `region: ${effectiveRegion} [resolved from ${regionResolvedFrom === 'env' ? 'AWS_REGION/AWS_DEFAULT_REGION env' : 'profile'} — pin with --region]`
      : `region: ${effectiveRegion}`)
    : 'WARNING: no region resolved — the stack goes wherever AWS defaults; pass --region';

  const paramOverrides = fargateParamOverrides({ stackName, cluster, image, useBedrock, noWirescope, assignPublicIp, subnets, securityGroup, persistent, params });
  const deployArgv = fargateDeployArgs({ stackName, templateFile, region, profile, paramOverrides });

  const step = (n) => { if (json) emit({ type: 'step', name: n }); else printer.line(`→ ${n} …`); };
  const okm = (n) => { if (json) emit({ type: 'ok', name: n }); else printer.line(`  ${n} ok`); };
  const log = (t) => { if (json) emit({ type: 'log', text: t }); else printer.line(`  ${t}`); };

  if (flags['dry-run']) {
    const putArgv = (!useBedrock && oauthTokenFile) ? fargatePutOauthArgs({ stackName, region, profile, tokenFile: '<oauth-token-file>' }) : null;
    const getArgv = fargateGetWireTokenArgs({ stackName, region, profile });
    const networkPlan = {
      vpcId: netVpcId, subnets: subnets ? subnets.split(',') : [],
      securityGroup: securityGroup || null, assignPublicIp: assignPublicIp || null, autoDetected,
    };
    if (json) { emit({ type: 'dry-run', stackName, cluster, templateFile, paramOverrides, useBedrock, persistent, deployArgv, putOauthArgv: putArgv, getWireTokenArgv: getArgv, ctxName: flags['no-ctx'] ? null : ctxName, network: networkPlan, region: effectiveRegion || null, regionResolvedFrom, regionResolvedFromProfile }); return; }
    printer.line([
      `dry-run — would deploy the Fargate stack "${stackName}":`,
      `  template   ${templateFile}`,
      `  cluster    ${cluster}`,
      `  ${regionLine}`,
      ...networkLines.map((l) => `  ${l}`),
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

  step('preflight');
  const idOut = await runAws(execFn, callerIdentityArgs({ region, profile }), 'sts get-caller-identity');
  let account = null; let arn = null;
  try { const id = JSON.parse(idOut || '{}'); account = id.Account || null; arn = id.Arn || null; } catch { /* identity is informational */ }
  log(`identity: account ${account || '?'} (${arn || '?'}) region ${effectiveRegion || '?'}`);
  okm('preflight');

  log(regionLine);
  for (const l of networkLines) log(l);

  step('template');
  await runAws(execFn, deployArgv, 'cloudformation deploy', EXIT.SERVER);
  okm('template');
  const outputs = parseStackOutputs(await runAws(execFn, fargateStackOutputsArgs({ stackName, region, profile }), 'describe-stacks', EXIT.SERVER).catch(() => ''));

  if (!useBedrock) {
    if (oauthTokenFile) {
      step('oauth-token');
      await runAws(execFn, fargatePutOauthArgs({ stackName, region, profile, tokenFile: oauthTokenFile }), 'secretsmanager put-secret-value (oauth-token)', EXIT.SERVER);
      log('claude oauth token stored (file:// → put-secret-value; value never in argv). (Re)start the task to pick it up.');
      okm('oauth-token');
    } else {
      log('WARNING: no claude token (--token-file / CLODEX_CLAUDE_TOKEN_FILE unset) — the oauth-token secret keeps its REPLACE-ME placeholder; claude sessions will NOT authenticate until you populate it:');
      log(`  ${outputs.PutTokenCommand || `aws secretsmanager put-secret-value --secret-id ${stackName}/oauth-token --secret-string "$(cat TOKEN-FILE)"${effectiveRegion ? ` --region ${effectiveRegion}` : ''}`}`);
    }
  }

  step('wire-token');
  const token = await runAws(execFn, fargateGetWireTokenArgs({ stackName, region, profile }), 'secretsmanager get-secret-value (wire-token)', EXIT.SERVER);
  if (!token || /[\s\x00-\x1f]/.test(token)) {
    throw new CliError(EXIT.SERVER, `the stack's wire token (secret ${stackName}/wire-token) is empty or malformed — the stack may still be settling; re-run once it completes`);
  }
  okm('wire-token');

  const family = `${stackName}-node`;
  const entry = {
    ssm: { ecs: `${cluster}/${family}`, ...(effectiveRegion ? { region: effectiveRegion } : {}), ...(profile ? { profile } : {}) },
    webPort: CONTAINER_WEB_PORT,
    token,
    deploy: { flavor: 'fargate', stack: stackName, ...(effectiveRegion ? { region: effectiveRegion } : {}), ...(profile ? { profile } : {}) },
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
  DOCKER_IMAGE_REPO, DOCKER_DEFAULT_TAG, CONTAINER_PREFIX, CONTAINER_WIRE_PORT, CONTAINER_WEB_PORT,
  DOCKER_VERIFY_TIMEOUT_MS, DOCKER_VERIFY_POLL_MS,
  normalizeDockerHost, dockerHostToSshDest, dockerRunArgs, runDocker, pollHello, deployDockerVerb,
  SSM_DEPLOY_TIMEOUT_MS, SSM_POLL_MS, SSM_PREPOLL_MS, SSM_SEND_RETRIES, SSM_SEND_RETRY_MS,
  buildSsmScript, awsBase, ssmDescribeArgs, ssmSendCommandArgs, ssmGetInvocationArgs,
  runAws, ssmPreflight, ssmSendCommand, ssmPoll, ssmMarkerLines, parseHelloMarker, ssmVerifyHello, deploySsmVerb,
  HELM_TIMEOUT, DEFAULT_HELM_NAMESPACE, HELM_RELEASE_RE, K8S_NS_RE,
  helmChartPath, helmArgv, helmStatusArgs, releaseSecretArgs, runVendor, helmVerifyHello, deployHelmVerb,
  ssaConflictHint,
  helmGetValuesArgs, parseCarriedValues, HELM_NEVER_CARRY,
  FARGATE_TEMPLATE, FARGATE_STACK_RE, FARGATE_PARAM_RE, FARGATE_VERIFY_TIMEOUT_MS, FARGATE_VERIFY_POLL_MS,
  fargateTemplatePath, parseBoolFlag, fargateParamOverrides, fargateDeployArgs, callerIdentityArgs, fargateConfigureGetRegionArgs,
  fargatePutOauthArgs, fargateGetWireTokenArgs, fargateStackOutputsArgs, parseStackOutputs, fargatePollHello, deployFargateVerb,
  fargateDescribeVpcsArgs, fargateDescribeSubnetsArgs, fargateDescribeSgArgs, fargateSgInboundWarning, fargateDetectNetwork,
};
