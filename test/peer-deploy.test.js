'use strict';

// peer-deploy: probe classification (off a fake sshRun) + deploy marker parsing
// + a bash -n syntax gate on the deploy script itself. No real ssh / no box.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  probePeer, parseDeployLine, buildProbeScript, PROBE_NOLISTEN,
} = require('../peer-deploy');

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

test('clodex-deploy.sh passes a bash -n syntax check', () => {
  const script = path.join(__dirname, '..', 'peering', 'clodex-deploy.sh');
  // Throws (failing the test) on any shell syntax error.
  execFileSync('bash', ['-n', script]);
});
