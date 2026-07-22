'use strict';
// deploy.test.js — the `deploy` verb: pure helpers (marker parse, preamble,
// ctx-name derivation), the byte-equality drift pin between cli/deploy/ and
// peering/, and the full deploy flow through main.run against a FAKE ssh child
// (the transport.js spawnFn seam) that reads the script off stdin, emits a
// marker transcript, and exits 0/1/42.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const D = require('../src/deploy');
const { run } = require('../src/main');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseMarker: the documented ::grammar, garbage → log', () => {
  assert.deepStrictEqual(D.parseMarker('::step clone'), { type: 'step', name: 'clone' });
  assert.deepStrictEqual(D.parseMarker('::ok clone'), { type: 'ok', name: 'clone' });
  assert.deepStrictEqual(D.parseMarker('::fail build npm ci exploded'), { type: 'fail', name: 'build', reason: 'npm ci exploded' });
  assert.deepStrictEqual(D.parseMarker('::need-sudo apt packages'), { type: 'need-sudo', what: 'apt packages' });
  assert.deepStrictEqual(D.parseMarker('::sudo-cmd sudo apt-get install -y nodejs'), { type: 'sudo-cmd', command: 'sudo apt-get install -y nodejs' });
  assert.deepStrictEqual(D.parseMarker('::done'), { type: 'done' });
  assert.deepStrictEqual(D.parseMarker('random detail line'), { type: 'log', text: 'random detail line' });
  assert.deepStrictEqual(D.parseMarker('::unknown thing'), { type: 'log', text: '::unknown thing' });
});

test('buildPreamble: single-quote-escaped exports; CLODEX_SRC only when set', () => {
  const p = D.buildPreamble({ port: 7900, repo: 'https://h/r', branch: 'master' });
  assert.strictEqual(p, "export PORT='7900' REPO_URL='https://h/r' BRANCH='master'\n");
  const withSrc = D.buildPreamble({ port: 8000, repo: "r'x", branch: 'b', src: '~/dir' });
  assert.match(withSrc, /CLODEX_SRC='~\/dir'\n$/);
  assert.match(withSrc, /REPO_URL='r'\\''x'/);   // embedded quote escaped
});

test('buildPreamble: claudeToken (ssh flavor) adds a single-quote-escaped CLODEX_CLAUDE_TOKEN export', () => {
  const p = D.buildPreamble({ port: 7900, repo: 'https://h/r', branch: 'master', claudeToken: "tok'v" });
  assert.match(p, /CLODEX_CLAUDE_TOKEN='tok'\\''v'/);   // embedded quote escaped
  // no claudeToken → the export is absent (unchanged behavior).
  assert.doesNotMatch(D.buildPreamble({ port: 7900, repo: 'r', branch: 'm' }), /CLODEX_CLAUDE_TOKEN/);
});

test('readClaudeToken: raw token, env-file line, and rejections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const raw = path.join(dir, 'raw'); fs.writeFileSync(raw, '  sk-abc123\n');
  assert.strictEqual(D.readClaudeToken(raw), 'sk-abc123');
  const env = path.join(dir, 'env'); fs.writeFileSync(env, '# comment\nCLAUDE_CODE_OAUTH_TOKEN="sk-env-9"\nOTHER=1\n');
  assert.strictEqual(D.readClaudeToken(env), 'sk-env-9');
  const exp = path.join(dir, 'exp'); fs.writeFileSync(exp, 'export CLAUDE_CODE_OAUTH_TOKEN=sk-exp-7\n');
  assert.strictEqual(D.readClaudeToken(exp), 'sk-exp-7');
  const empty = path.join(dir, 'empty'); fs.writeFileSync(empty, '  \n');
  assert.throws(() => D.readClaudeToken(empty), /no token/);
  const spacey = path.join(dir, 'spacey'); fs.writeFileSync(spacey, 'sk abc');
  assert.throws(() => D.readClaudeToken(spacey), /whitespace\/control/);
  assert.throws(() => D.readClaudeToken(path.join(dir, 'nope')), /unreadable/);
});

test('buildTokenDropinScript: shell-var assignment (not argv), 0600 drop-in, reload+restart', () => {
  const s = D.buildTokenDropinScript("sk-x'y");
  assert.match(s, /CLODEX_CLAUDE_TOKEN='sk-x'\\''y'/);          // single-quote escaped assignment
  assert.match(s, /Environment=CLAUDE_CODE_OAUTH_TOKEN=%s/);    // printf builtin, token via "$VAR"
  assert.match(s, /printf .* "\$CLODEX_CLAUDE_TOKEN" > "\$DROPIN"/);
  assert.match(s, /chmod 600 "\$DROPIN"/);
  assert.match(s, /systemctl --user daemon-reload/);
  assert.match(s, /systemctl --user restart clodex\.service/);
  // The literal token never sits on a command line (only inside the var assign).
  assert.doesNotMatch(s, /Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-x/);
});

test('deriveCtxName: short host, sanitized; user@ and domain stripped', () => {
  assert.strictEqual(D.deriveCtxName('user@laptop2'), 'laptop2');
  assert.strictEqual(D.deriveCtxName('deploy@box.example.com'), 'box');
  assert.strictEqual(D.deriveCtxName('10.0.0.5'), '10');
  assert.strictEqual(D.deriveCtxName(''), '');
});

test('sshDeployArgs: posture options, extra ssh-opts, then host + bash -s', () => {
  const a = D.sshDeployArgs('user@box', ['-p', '2222']);
  assert.ok(a.includes('BatchMode=yes'));
  assert.ok(a.includes('-p') && a.includes('2222'));
  assert.strictEqual(a[a.length - 2], 'user@box');
  assert.strictEqual(a[a.length - 1], 'bash -s');
});

test('DRIFT PIN: cli/deploy/clodex-deploy.sh is byte-equal to peering/clodex-deploy.sh', () => {
  const copy = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'clodex-deploy.sh'));
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'peering', 'clodex-deploy.sh'));
  assert.ok(copy.equals(source), 'deploy script copy has drifted — edit peering/clodex-deploy.sh and re-copy to cli/deploy/clodex-deploy.sh');
});

test('readScript: resolves off __dirname and returns the real installer bytes', () => {
  const s = D.readScript();
  assert.match(s, /Clodex headless peer-node deploy/);
  assert.match(s, /echo "::done"/);
});

test('installer: agent-clis step installs claude+codex the native way, best-effort', () => {
  const s = D.readScript();
  assert.match(s, /step agent-clis/);
  // The SETTLED native install lines (tool-doctor.js) — curl|sh into ~/.local/bin.
  assert.match(s, /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  assert.match(s, /curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| sh/);
  // Idempotent: a present CLI is skipped.
  assert.match(s, /command -v claude >\/dev\/null 2>&1/);
  assert.match(s, /command -v codex >\/dev\/null 2>&1/);
  // Best-effort: NEVER fails the deploy, NEVER needs sudo — no `fail`/`need_sudo`
  // between the step marker and its ok.
  const seg = s.slice(s.indexOf('step agent-clis'), s.indexOf('ok agent-clis'));
  assert.doesNotMatch(seg, /\bfail agent-clis\b/);
  assert.doesNotMatch(seg, /need_sudo/);
});

test('installer: source step ::logs the deployed ref@sha (a log marker, not a new kind)', () => {
  const s = D.readScript();
  // A ::log line (parses grammar-generically → {type:'log'} in BOTH parsers) —
  // NOT an ::ok overload (the GUI keys the ✓ on the exact step name). Rides the
  // already-provided BRANCH + git's own short sha, no caller data beyond BRANCH.
  assert.match(s, /DEPLOYED_SHA="\$\(git -C "\$SRC_DIR" rev-parse --short HEAD/);
  assert.match(s, /echo "::log deployed \$BRANCH@\$DEPLOYED_SHA"/);
  // It sits in the source step, before its ok, so the trail shows what landed.
  const seg = s.slice(s.indexOf('step source'), s.indexOf('ok source'));
  assert.match(seg, /::log deployed \$BRANCH@\$DEPLOYED_SHA/);
  // parseMarker treats it as a log line (no orphan step in the GUI checklist).
  assert.deepStrictEqual(D.parseMarker('::log deployed master@abc1234'),
    { type: 'log', text: '::log deployed master@abc1234' });
});

test('service unit: PATH carries ~/.local/bin (native CLIs) ahead of ~/.npm-global/bin', () => {
  const unit = fs.readFileSync(path.join(__dirname, '..', '..', 'peering', 'clodex.service'), 'utf8');
  const m = unit.match(/^Environment=PATH=(.+)$/m);
  assert.ok(m, 'clodex.service must set Environment=PATH');
  const entries = m[1].split(':');
  assert.ok(entries.includes('%h/.local/bin'), 'PATH must include %h/.local/bin (native claude/codex)');
  assert.ok(entries.includes('%h/.npm-global/bin'), 'PATH must keep %h/.npm-global/bin');
  assert.ok(entries.indexOf('%h/.local/bin') < entries.indexOf('%h/.npm-global/bin'),
    '~/.local/bin should precede ~/.npm-global/bin (native install is the deploy default)');
});

// ── flow: fake ssh ───────────────────────────────────────────────────────────

// A fake ssh child (transport.js spawnFn shape): records argv, captures the
// script fed to stdin, and plays a caller-supplied marker script on stdout
// before exiting with `exitCode`. Never opens a socket.
function fakeSsh(rec, { lines = [], exitCode = 0, stderr = '' } = {}) {
  return (cmd, args) => {
    rec.cmd = cmd; rec.args = args; rec.stdin = '';
    const child = new EventEmitter();
    child.pid = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: (s) => { rec.stdin += s; }, end: () => {
      // Once the script is delivered, play the transcript then exit — async so
      // the caller's data/exit listeners are attached first.
      setImmediate(() => {
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        for (const l of lines) child.stdout.emit('data', Buffer.from(l + '\n'));
        child.emit('exit', exitCode, null);
      });
    } };
    child.kill = () => { rec.killed = true; };
    return child;
  };
}

const HAPPY = ['::step clone', '::ok clone', '::step build', '::ok build', '::step service', '::ok service', '::done'];

async function cli(argv, { spawnFn, probeHello, contextsFile } = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
    env: {},
    spawnFn,
    probeHello,
    contextsFile: contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
  });
  return { code, stdout, stderr };
}

function tmpCtxFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-deploy-'));
  return path.join(dir, 'contexts.json');
}

test('deploy happy path: env delivered, script on stdin, hello verified, ctx saved', async () => {
  const rec = {};
  const probeCalls = [];
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'user@box', '--port', '7900', '--repo', 'https://h/r', '--branch', 'dev'], {
    spawnFn: fakeSsh(rec, { lines: HAPPY }),
    probeHello: async (dest, port, opts) => { probeCalls.push({ dest, port }); return { app: 'clodex', host: 'box', version: '9.9.9', caps: ['transcript'] }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // ssh argv shape + script over stdin
  assert.strictEqual(rec.cmd, 'ssh');
  assert.strictEqual(rec.args[rec.args.length - 1], 'bash -s');
  assert.strictEqual(rec.args[rec.args.length - 2], 'user@box');
  // preamble exports rode stdin; the real installer bytes followed
  assert.match(rec.stdin, /^export PORT='7900' REPO_URL='https:\/\/h\/r' BRANCH='dev'\n/);
  assert.match(rec.stdin, /Clodex headless peer-node deploy/);
  // progress rendered + verified + ctx saved
  assert.match(stdout, /→ clone …/);
  assert.match(stdout, /clone ok/);
  assert.match(stdout, /verified — clodex host=box version=9\.9\.9 on user@box:7900/);
  assert.match(stdout, /context "box" saved/);
  // hello probed through the tunnel at the deploy port
  assert.deepStrictEqual(probeCalls, [{ dest: 'user@box', port: 7900 }]);
  // context persisted with no token
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.box, { ssh: 'user@box', webPort: 7901 });
  assert.strictEqual(saved.contexts.box.token, undefined);
  assert.strictEqual(saved.current, 'box');
});

test('deploy --claude-token-file: token rides ssh stdin (preamble), NEVER argv/stdout', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-secret-42\n');
  const { code, stdout } = await cli(['deploy', 'user@box', '--claude-token-file', tf], {
    spawnFn: fakeSsh(rec, { lines: HAPPY }),
    probeHello: async () => ({ app: 'clodex', host: 'box', version: '1', caps: [] }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // The token rode the stdin preamble as an env export (the ssh auth boundary).
  assert.match(rec.stdin, /CLODEX_CLAUDE_TOKEN='sk-secret-42'/);
  // REDACTION: the token is nowhere in the ssh argv nor in our stdout.
  assert.ok(!rec.args.some((a) => String(a).includes('sk-secret-42')), 'token must not appear in ssh argv');
  assert.doesNotMatch(stdout, /sk-secret-42/);
});

test('deploy --claude-token-file --dry-run: notes the token by presence only, redacted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-secret-99\n');
  const { code, stdout } = await cli(['deploy', 'user@box', '--claude-token-file', tf, '--dry-run'], {});
  assert.strictEqual(code, 0);
  assert.match(stdout, /claude  token from --claude-token-file/);
  assert.doesNotMatch(stdout, /sk-secret-99/);
});

test('deploy --port non-default: remotePort recorded in the saved context', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code } = await cli(['deploy', 'user@box', '--port', '8100'], {
    spawnFn: fakeSsh(rec, { lines: HAPPY }),
    probeHello: async () => ({ app: 'clodex', host: 'box' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(rec.stdin, /PORT='8100'/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.box, { ssh: 'user@box', remotePort: 8100, webPort: 8101 });
});

test('deploy: ::fail transcript, exit 1 → EXIT.SERVER, no verify, no ctx', async () => {
  const rec = {};
  let probed = false;
  const contextsFile = tmpCtxFile();
  const { code, stdout, stderr } = await cli(['deploy', 'user@box'], {
    spawnFn: fakeSsh(rec, { lines: ['::step clone', '::ok clone', '::step build', '::fail build npm ci exploded'], exitCode: 1 }),
    probeHello: async () => { probed = true; return {}; },
    contextsFile,
  });
  assert.strictEqual(code, 1);
  assert.match(stdout, /build FAILED — npm ci exploded/);
  assert.match(stderr, /deploy failed on user@box \(exit 1\)/);
  assert.strictEqual(probed, false);
  assert.strictEqual(fs.existsSync(contextsFile), false);   // nothing saved
});

test('deploy: exit 42 surfaces the exact sudo commands + re-run guidance', async () => {
  const rec = {};
  const { code, stdout, stderr } = await cli(['deploy', 'user@box'], {
    spawnFn: fakeSsh(rec, {
      lines: ['::step apt', '::need-sudo apt packages', '::sudo-cmd sudo apt-get update', '::sudo-cmd sudo apt-get install -y nodejs npm'],
      exitCode: 42,
    }),
    probeHello: async () => ({}),
  });
  assert.strictEqual(code, 1);   // EXIT.SERVER
  assert.match(stdout, /sudo apt-get update/);
  assert.match(stdout, /sudo apt-get install -y nodejs npm/);
  assert.match(stdout, /Run these on the box, then re-run/);
  assert.match(stderr, /2 sudo command\(s\) must be run/);
});

test('deploy --dry-run: describes, spawns nothing', async () => {
  let spawned = false;
  const { code, stdout } = await cli(['deploy', 'user@box', '--dry-run', '--port', '7901'], {
    spawnFn: () => { spawned = true; throw new Error('should not spawn'); },
    probeHello: async () => { throw new Error('should not probe'); },
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(spawned, false);
  assert.match(stdout, /dry-run — would deploy to user@box/);
  assert.match(stdout, /port    7901/);
  assert.match(stdout, /script  \d+ bytes/);
  assert.match(stdout, /context box/);
});

test('deploy --no-ctx: verifies but saves nothing', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'user@box', '--no-ctx'], {
    spawnFn: fakeSsh(rec, { lines: HAPPY }),
    probeHello: async () => ({ app: 'clodex', host: 'box' }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /verified/);
  assert.doesNotMatch(stdout, /context .* saved/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy: ctx collision kept unless --force', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { box: { ssh: 'old@box' } } }));
  // no --force → kept
  const skip = await cli(['deploy', 'user@box'], { spawnFn: fakeSsh(rec, { lines: HAPPY }), probeHello: async () => ({ app: 'clodex' }), contextsFile });
  assert.strictEqual(skip.code, 0);
  assert.match(skip.stdout, /already exists — kept it/);
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.box.ssh, 'old@box');
  // --force → overwritten
  const rec2 = {};
  const force = await cli(['deploy', 'user@box', '--force'], { spawnFn: fakeSsh(rec2, { lines: HAPPY }), probeHello: async () => ({ app: 'clodex' }), contextsFile });
  assert.strictEqual(force.code, 0);
  assert.match(force.stdout, /context "box" updated/);
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.box.ssh, 'user@box');
});

test('deploy --json: NDJSON per marker then verify + context objects', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'user@box', '--json'], {
    spawnFn: fakeSsh(rec, { lines: ['::step clone', '::ok clone', '::done'] }),
    probeHello: async () => ({ app: 'clodex', host: 'box', version: '1.0', caps: [] }),
    contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(objs[0], { type: 'step', name: 'clone' });
  assert.deepStrictEqual(objs[1], { type: 'ok', name: 'clone' });
  assert.deepStrictEqual(objs[2], { type: 'done' });
  assert.deepStrictEqual(objs[3], { type: 'verify', ok: true, host: 'box', version: '1.0', caps: [] });
  assert.deepStrictEqual(objs[4], { type: 'context', action: 'added', name: 'box', webPort: 7901 });
});

test('deploy: bad ssh destination is a usage error, no spawn', async () => {
  let spawned = false;
  const { code, stderr } = await cli(['deploy', 'host:7900'], { spawnFn: () => { spawned = true; throw new Error('x'); }, probeHello: async () => ({}) });
  assert.strictEqual(code, 2);
  assert.match(stderr, /bad ssh destination/);
  assert.strictEqual(spawned, false);
});

test('deploy: ssh connect failure (exit 255) → EXIT.CONNECT, no verify', async () => {
  const rec = {};
  let probed = false;
  const { code, stderr } = await cli(['deploy', 'user@box'], {
    spawnFn: fakeSsh(rec, { lines: [], exitCode: 255, stderr: 'ssh: could not resolve hostname box' }),
    probeHello: async () => { probed = true; return {}; },
  });
  assert.strictEqual(code, 3);
  assert.match(stderr, /ssh could not connect to user@box/);
  assert.strictEqual(probed, false);
});
