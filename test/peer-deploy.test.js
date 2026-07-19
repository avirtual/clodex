'use strict';

// peer-deploy: probe classification (off a fake sshRun) + deploy marker parsing
// + a bash -n syntax gate on the deploy script itself. No real ssh / no box.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  probePeer, parseDeployLine, buildProbeScript, PROBE_NOLISTEN, PROBE_BODY, PROBE_CODE,
  fixSessionName, buildDeployFixBriefing, classifyDeployFolder, classifyPeerDest,
  homeRelativize, resolveDeployFolder,
} = require('../peer-deploy');

// A session name must satisfy the same regex sessions/agents use elsewhere.
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

const fakeRun = (result) => async () => result;

test('probePeer → hello-ok surfaces version, caps, host, platform', async () => {
  const body = JSON.stringify({
    ok: true, app: 'clodex', host: 'box', version: '2.10.1',
    caps: ['transcript', 'send', 'create'], platform: 'linux',
  });
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout: `CLODEX_PROBE_BODY ${body}\n`, stderr: '', timedOut: false }) });
  assert.equal(res.kind, 'hello-ok');
  assert.equal(res.version, '2.10.1');
  assert.deepStrictEqual(res.caps, ['transcript', 'send', 'create']);
  assert.equal(res.host, 'box');
  assert.equal(res.platform, 'linux');
});

test('probePeer → no-listener when the box emits the NOLISTEN sentinel', async () => {
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout: `${PROBE_NOLISTEN}\n`, stderr: '', timedOut: false }) });
  assert.equal(res.kind, 'no-listener');
});

test('probePeer → not-clodex for junk or non-clodex JSON', async () => {
  const junk = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout: 'CLODEX_PROBE_BODY <html>nginx</html>\n', stderr: '', timedOut: false }) });
  assert.equal(junk.kind, 'not-clodex');
  const other = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout: 'CLODEX_PROBE_BODY {"app":"grafana"}\n', stderr: '', timedOut: false }) });
  assert.equal(other.kind, 'not-clodex');
});

test('probePeer → ssh-fail on exit 255 carries the stderr tail', async () => {
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: 255, stdout: '', stderr: 'ssh: connect to host h port 22: Connection refused\n', timedOut: false }) });
  assert.equal(res.kind, 'ssh-fail');
  assert.match(res.stderr, /Connection refused/);
});

test('probePeer → ssh-fail on timeout', async () => {
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: null, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(res.kind, 'ssh-fail');
});

test('probePeer → ssh-fail when ssh ran but produced neither sentinel', async () => {
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout: 'weird\n', stderr: 'shell init noise', timedOut: false }) });
  assert.equal(res.kind, 'ssh-fail');
});

test('probePeer treats a spawn reject (no ssh binary) as ssh-fail', async () => {
  const res = await probePeer('h', 7900, { sshRun: async () => { throw new Error('spawn ssh ENOENT'); } });
  assert.equal(res.kind, 'ssh-fail');
  assert.match(res.stderr, /ENOENT/);
});

test('buildProbeScript curls loopback + the given port at the hello endpoint', () => {
  const s = buildProbeScript(1234);
  assert.match(s, /127\.0\.0\.1:1234\/api\/peer\/hello/);
  // A non-numeric port must not reach the wire — falls back to the default.
  assert.match(buildProbeScript('nope'), /127\.0\.0\.1:7900\//);
});

// --- auth-gate probe: a token-protected Clodex must not read as an empty box --
const curlLineOf = (s) => s.split('\n').find((l) => l.includes('curl')) || '';

test('probePeer → auth-required (no token tried) on a 401 with nothing sent', async () => {
  const stdout = `${PROBE_BODY}unauthorized\n${PROBE_CODE}401\n`;
  const res = await probePeer('h', 7900, { sshRun: fakeRun({ code: 0, stdout, stderr: '', timedOut: false }) });
  assert.equal(res.kind, 'auth-required');
  assert.equal(res.tokenSent, false);
  assert.equal(res.status, 401);
});

test('probePeer → auth-required (tokenSent) when the token we sent is rejected', async () => {
  const stdout = `${PROBE_BODY}unauthorized\n${PROBE_CODE}403\n`;
  const res = await probePeer('h', 7900, { token: 'wrong', sshRun: fakeRun({ code: 0, stdout, stderr: '', timedOut: false }) });
  assert.equal(res.kind, 'auth-required');
  assert.equal(res.tokenSent, true);
  assert.equal(res.status, 403);
});

test('probePeer → hello-ok when a correct token yields a 200 hello (token validated end-to-end)', async () => {
  const body = JSON.stringify({ ok: true, app: 'clodex', version: '3.0.0', caps: [], host: 'box', platform: 'linux' });
  const stdout = `${PROBE_BODY}${body}\n${PROBE_CODE}200\n`;
  const res = await probePeer('h', 7900, { token: 'right', sshRun: fakeRun({ code: 0, stdout, stderr: '', timedOut: false }) });
  assert.equal(res.kind, 'hello-ok');
  assert.equal(res.version, '3.0.0');
});

test('buildProbeScript drops -f (a 401 must not look like connect-refused) and recovers the status via -w', () => {
  const curl = curlLineOf(buildProbeScript(7900));
  assert.doesNotMatch(curl, /\s-f(\s|$)/);   // no -f flag
  assert.doesNotMatch(curl, /--fail/);
  assert.match(curl, /-w /);                  // status recovered via write-out
  assert.match(buildProbeScript(7900), /CLODEX_PROBE_CODE %\{http_code\}/);
});

test('buildProbeScript with a token keeps it OUT of every argv-reaching position', () => {
  const s = buildProbeScript(7900, 's3cr!t');
  // Never on the curl command line — delivered via a header FILE (-H @file).
  assert.doesNotMatch(curlLineOf(s), /s3cr!t/);
  assert.match(curlLineOf(s), /-H @"\$__ch"/);
  // Written with printf (a bash builtin → no argv) into a umask-077 temp file,
  // then removed. The token is single-quoted in the printf arg.
  assert.match(s, /umask 077/);
  assert.ok(s.includes("printf 'Authorization: Bearer %s\\n' 's3cr!t'"), 'printf writes the header');
  assert.match(s, /rm -f "\$__ch"/);
});

test('buildProbeScript single-quote-escapes a token that contains a quote', () => {
  const s = buildProbeScript(7900, "a'b");
  // shSingleQuote("a'b") === "'a'\\''b'" — closes, escaped quote, reopens.
  assert.ok(s.includes("printf 'Authorization: Bearer %s\\n' 'a'\\''b'"), 'quote is escaped');
  assert.doesNotMatch(curlLineOf(s), /a'b/);
});

test('buildProbeScript without a token probes bare — no header file at all', () => {
  const s = buildProbeScript(7900);
  assert.doesNotMatch(s, /umask 077/);
  assert.doesNotMatch(s, /__ch/);
  assert.doesNotMatch(s, /Authorization/);
  assert.match(s, /127\.0\.0\.1:7900\/api\/peer\/hello/);
});

test('parseDeployLine parses every marker + falls back to log', () => {
  assert.deepStrictEqual(parseDeployLine('::step apt-deps'), { type: 'step', name: 'apt-deps' });
  assert.deepStrictEqual(parseDeployLine('::ok apt-deps'), { type: 'ok', name: 'apt-deps' });
  assert.deepStrictEqual(parseDeployLine('::fail source git-clone-failed'), { type: 'fail', name: 'source', reason: 'git-clone-failed' });
  assert.deepStrictEqual(parseDeployLine('::fail source'), { type: 'fail', name: 'source', reason: '' });
  assert.deepStrictEqual(parseDeployLine('::need-sudo install packages'), { type: 'need-sudo', what: 'install packages' });
  assert.deepStrictEqual(parseDeployLine('::sudo-cmd sudo apt-get update'), { type: 'sudo-cmd', command: 'sudo apt-get update' });
  assert.deepStrictEqual(parseDeployLine('::done'), { type: 'done' });
  assert.deepStrictEqual(parseDeployLine('cloning into ...'), { type: 'log', text: 'cloning into ...' });
  assert.deepStrictEqual(parseDeployLine(''), { type: 'log', text: '' });
});

test('fixSessionName sanitizes the label and always yields a NAME_RE-valid stem', () => {
  const n = fixSessionName('user@laptop2');
  assert.equal(n, 'fix-user-laptop2');
  assert.match(n, NAME_RE);
  // Spaces / punctuation collapse to hyphens; leading/trailing separators trimmed.
  assert.equal(fixSessionName('  My Box!! '), 'fix-my-box');
  // Empty / all-junk label falls back to a generic stem, still valid.
  assert.equal(fixSessionName(''), 'fix-peer');
  assert.match(fixSessionName('@@@'), NAME_RE);
  assert.equal(fixSessionName('@@@'), 'fix-peer');
});

test('fixSessionName suffixes on collision (Set or array), staying under 64 chars', () => {
  const taken = new Set(['fix-box', 'fix-box-2']);
  assert.equal(fixSessionName('box', taken), 'fix-box-3');
  // Array form of `taken` works too.
  assert.equal(fixSessionName('box', ['fix-box']), 'fix-box-2');
  // A maximal label plus a suffix never exceeds the 64-char ceiling.
  const long = 'x'.repeat(200);
  const takenLong = new Set([`fix-${'x'.repeat(60)}`]);
  const got = fixSessionName(long, takenLong);
  assert.ok(got.length <= 64, `got ${got.length} chars`);
  assert.match(got, NAME_RE);
});

test('fixSessionName auto-suffixes past an ARCHIVED/persisted name in the taken set (Task 15)', () => {
  // The deploy-fix caller now unions LIVE + PERSISTED names into `taken` so a
  // generated fix-name dodges an archived record the mint guard would reject —
  // fixSessionName just has to bump past whatever set it's handed.
  const taken = new Set(['fix-box']); // e.g. an archived `fix-box` still on record
  assert.equal(fixSessionName('box', taken), 'fix-box-2');
});

test('buildDeployFixBriefing names the box, the hello check, the log, and the playbook', () => {
  const b = buildDeployFixBriefing({
    sshHost: 'user@box', port: 7911, label: 'box',
    logText: '::fail service enable-now-failed',
  });
  assert.match(b, /user@box/);
  assert.match(b, /127\.0\.0\.1:7911\/api\/peer\/hello/);
  assert.match(b, /"app":"clodex"/);
  assert.match(b, /::fail service enable-now-failed/);
  assert.match(b, /peering\/README\.md/);
  assert.match(b, /peering\/clodex-deploy\.sh/);
  // The GitHub repo is ALWAYS named as the backstop (packaged app.asar isn't
  // readable by an external CLI, so absolute on-disk paths can be dead).
  assert.match(b, /github\.com\/avirtual\/clodex/);
  // Missing log + port degrade gracefully (default port, placeholder log).
  const d = buildDeployFixBriefing({ sshHost: 'h' });
  assert.match(d, /127\.0\.0\.1:7900\//);
  assert.match(d, /no log captured/);
});

test('buildDeployFixBriefing renders ABSOLUTE playbook paths when docsDir is given', () => {
  const b = buildDeployFixBriefing({
    sshHost: 'h', docsDir: '/opt/clodex/peering',
  });
  assert.match(b, /\/opt\/clodex\/peering\/README\.md/);
  assert.match(b, /\/opt\/clodex\/peering\/clodex-deploy\.sh/);
  // A trailing slash on docsDir doesn't double up.
  const t = buildDeployFixBriefing({ sshHost: 'h', docsDir: '/opt/clodex/peering/' });
  assert.match(t, /\/opt\/clodex\/peering\/README\.md/);
  assert.doesNotMatch(t, /peering\/\/README/);
  // Repo backstop still present alongside the absolute paths.
  assert.match(b, /github\.com\/avirtual\/clodex/);
});

test('clodex-deploy.sh passes a bash -n syntax check', () => {
  const script = path.join(__dirname, '..', 'peering', 'clodex-deploy.sh');
  // Throws (failing the test) on any shell syntax error.
  execFileSync('bash', ['-n', script]);
});

// --- classifyDeployFolder: the CLODEX_SRC preamble token ---------------------
test('classifyDeployFolder: blank ⇒ no override (script default stands)', () => {
  assert.deepStrictEqual(classifyDeployFolder(''), { ok: true, srcExport: '' });
  assert.deepStrictEqual(classifyDeployFolder('   '), { ok: true, srcExport: '' });
  assert.deepStrictEqual(classifyDeployFolder(null), { ok: true, srcExport: '' });
  assert.deepStrictEqual(classifyDeployFolder(undefined), { ok: true, srcExport: '' });
});

test('classifyDeployFolder: ~/… expands $HOME on the REMOTE (unquoted $HOME)', () => {
  // $HOME must stay OUTSIDE the single quotes so the box's shell expands it; the
  // remainder is a single-quoted literal. A quoted "~" would be a literal dir.
  assert.deepStrictEqual(classifyDeployFolder('~/clodex'),
    { ok: true, srcExport: `CLODEX_SRC="$HOME/"'clodex'` });
  assert.deepStrictEqual(classifyDeployFolder('~/projects/clodex'),
    { ok: true, srcExport: `CLODEX_SRC="$HOME/"'projects/clodex'` });
  // The default pre-fill round-trips to the script's own default location.
  assert.deepStrictEqual(classifyDeployFolder('~/wb-wrap-ui'),
    { ok: true, srcExport: `CLODEX_SRC="$HOME/"'wb-wrap-ui'` });
  // Extra slashes after ~/ are normalized away.
  assert.deepStrictEqual(classifyDeployFolder('~//clodex'),
    { ok: true, srcExport: `CLODEX_SRC="$HOME/"'clodex'` });
});

test('classifyDeployFolder: absolute path is single-quoted whole', () => {
  assert.deepStrictEqual(classifyDeployFolder('/opt/clodex'),
    { ok: true, srcExport: `CLODEX_SRC='/opt/clodex'` });
  // A path with a quote is safely escaped (never breaks out of the literal).
  assert.deepStrictEqual(classifyDeployFolder(`/opt/cl'odex`),
    { ok: true, srcExport: `CLODEX_SRC='/opt/cl'\\''odex'` });
});

test('classifyDeployFolder: a relative-without-~ path is rejected', () => {
  const r = classifyDeployFolder('projects/clodex');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /absolute|home/i);
  assert.strictEqual(classifyDeployFolder('clodex').ok, false);
  assert.strictEqual(classifyDeployFolder('./x').ok, false);
});

test('classifyDeployFolder: a bare ~ (no path under home) is rejected', () => {
  assert.strictEqual(classifyDeployFolder('~').ok, false);
  assert.strictEqual(classifyDeployFolder('~/').ok, false);
});

// --- classifyPeerDest: the single smart destination field --------------------
test('classifyPeerDest: ssh forms — user@host, bare IP, and ssh-config alias', () => {
  assert.deepStrictEqual(classifyPeerDest('user@laptop2'), { kind: 'ssh', sshHost: 'user@laptop2' });
  assert.deepStrictEqual(classifyPeerDest('192.168.1.5'), { kind: 'ssh', sshHost: '192.168.1.5' });
  assert.deepStrictEqual(classifyPeerDest('laptop2'), { kind: 'ssh', sshHost: 'laptop2' });
  // Surrounding whitespace is trimmed before classifying.
  assert.deepStrictEqual(classifyPeerDest('  box  '), { kind: 'ssh', sshHost: 'box' });
});

test('classifyPeerDest: http(s):// URLs pass through as url', () => {
  assert.deepStrictEqual(classifyPeerDest('http://host:7900'), { kind: 'url', url: 'http://host:7900' });
  assert.deepStrictEqual(classifyPeerDest('https://box.example.com:8080/x'),
    { kind: 'url', url: 'https://box.example.com:8080/x' });
  // Scheme match is case-insensitive.
  assert.deepStrictEqual(classifyPeerDest('HTTPS://host'), { kind: 'url', url: 'HTTPS://host' });
});

test('classifyPeerDest: empty / whitespace-only ⇒ empty', () => {
  assert.deepStrictEqual(classifyPeerDest(''), { kind: 'empty' });
  assert.deepStrictEqual(classifyPeerDest('   '), { kind: 'empty' });
  assert.deepStrictEqual(classifyPeerDest(null), { kind: 'empty' });
  assert.deepStrictEqual(classifyPeerDest(undefined), { kind: 'empty' });
});

test('classifyPeerDest: a scheme-less host:port is a targeted error', () => {
  const r = classifyPeerDest('host:7900');
  assert.strictEqual(r.kind, 'error');
  assert.match(r.error, /http:\/\/|ssh config|\.ssh\/config/i);
});

test('classifyPeerDest: an ssh command (space / ssh prefix) is rejected', () => {
  const r = classifyPeerDest('ssh user@host');
  assert.strictEqual(r.kind, 'error');
  assert.match(r.error, /just the destination|not an ssh command/i);
  // A bare internal space also trips the ssh-command guard.
  assert.strictEqual(classifyPeerDest('user @host').kind, 'error');
});

test('classifyPeerDest: a non-http scheme (ftp://) is rejected', () => {
  const r = classifyPeerDest('ftp://host/file');
  assert.strictEqual(r.kind, 'error');
  assert.match(r.error, /http/i);
});

test('classifyPeerDest: a malformed http URL is rejected', () => {
  assert.strictEqual(classifyPeerDest('http://').kind, 'error');
});

test('classifyPeerDest: an over-long destination (>128 chars) is rejected', () => {
  const long = 'a'.repeat(129);
  assert.strictEqual(classifyPeerDest(long).kind, 'error');
  // Exactly 128 is still a valid ssh alias.
  assert.deepStrictEqual(classifyPeerDest('a'.repeat(128)), { kind: 'ssh', sshHost: 'a'.repeat(128) });
});

// --- homeRelativize: absolute path → ~/… for the self-report ------------------
test('homeRelativize: inside home becomes ~/rest, exactly home becomes ~', () => {
  assert.strictEqual(homeRelativize('/Users/bob/projects/clodex', '/Users/bob'), '~/projects/clodex');
  assert.strictEqual(homeRelativize('/Users/bob/wb-wrap-ui', '/Users/bob'), '~/wb-wrap-ui');
  assert.strictEqual(homeRelativize('/Users/bob', '/Users/bob'), '~');
});

test('homeRelativize: outside home is unchanged; trailing separators tolerated', () => {
  assert.strictEqual(homeRelativize('/opt/clodex', '/Users/bob'), '/opt/clodex');
  // A trailing slash on home (or path) still matches and normalizes.
  assert.strictEqual(homeRelativize('/Users/bob/proj', '/Users/bob/'), '~/proj');
  assert.strictEqual(homeRelativize('/Users/bob/proj/', '/Users/bob'), '~/proj');
  // A prefix that isn't a path-boundary must NOT match (/Users/bobby ≠ ~).
  assert.strictEqual(homeRelativize('/Users/bobby/x', '/Users/bob'), '/Users/bobby/x');
});

test('homeRelativize: empty inputs degrade to the raw path', () => {
  assert.strictEqual(homeRelativize('', '/Users/bob'), '');
  assert.strictEqual(homeRelativize('/opt/x', ''), '/opt/x');
  assert.strictEqual(homeRelativize(null, null), '');
});

// --- resolveDeployFolder: reported > persisted > default ----------------------
test('resolveDeployFolder: a live reported dir wins over a persisted guess', () => {
  // The wrong-guess bug: settings carry ~/wb-wrap-ui but the box reports the real
  // dir — reported must win so Update pulls the right checkout.
  assert.strictEqual(resolveDeployFolder('~/projects/clodex', '~/wb-wrap-ui'), '~/projects/clodex');
});

test('resolveDeployFolder: falls through reported → persisted → ""', () => {
  assert.strictEqual(resolveDeployFolder('', '~/wb-wrap-ui'), '~/wb-wrap-ui');
  assert.strictEqual(resolveDeployFolder(null, '~/custom'), '~/custom');
  assert.strictEqual(resolveDeployFolder(null, null), '');
  assert.strictEqual(resolveDeployFolder('', ''), '');
  // Whitespace-only on either side counts as absent.
  assert.strictEqual(resolveDeployFolder('   ', '~/persisted'), '~/persisted');
  assert.strictEqual(resolveDeployFolder('  ~/reported  ', '~/persisted'), '~/reported');
});
