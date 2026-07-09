'use strict';

// peer-deploy: probe classification (off a fake sshRun) + deploy marker parsing
// + a bash -n syntax gate on the deploy script itself. No real ssh / no box.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  probePeer, parseDeployLine, buildProbeScript, PROBE_NOLISTEN,
  fixSessionName, buildDeployFixBriefing,
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
