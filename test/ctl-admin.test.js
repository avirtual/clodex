'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const { mkTmpRoot } = require('./lib/tmp-roots');
const A = require('../scripts/clodex-ctl-admin.js');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'clodex-ctl-admin.js');
const HEX48 = 'ab12'.repeat(12);
const SSH_REC = { ssh: 'u@h' };

const refusalOf = (fn) => {
  try { fn(); } catch (e) {
    assert.ok(e instanceof A.Refusal, `expected a Refusal, got ${e && e.stack}`);
    return e.message;
  }
  return null;
};
const build = (verb, args, rec = SSH_REC, ctx = 'ios') => A.buildArgv(verb, ctx, rec, A.tokenize(args));
const refusalFor = (verb, args, rec = SSH_REC, ctx = 'ios') => refusalOf(() => build(verb, args, rec, ctx));

test('A1: every record flag is refused by name on deploy, in both groups and both spellings', () => {
  const L = (f) => `refused: --${f} comes from the context record and cannot be set here`;
  const C = (f) => `refused: --${f} is operator-only on this tier (a credential, a local path, or a replication source)`;
  const rows = [
    ['--ssh x', L('ssh')], ['--ssm x', L('ssm')], ['--host x', L('host')], ['--url x', L('url')],
    ['--ctx x', L('ctx')], ['--remote-port x', L('remote-port')], ['--remotePort x', L('remotePort')],
    ['--tunnel x', L('tunnel')], ['--region x', L('region')], ['--profile x', L('profile')], ['--target x', L('target')],
    ['--token x', C('token')], ['--src x', C('src')], ['--repo x', C('repo')],
    ['--claude-token-file x', C('claude-token-file')], ['--env-file x', C('env-file')], ['--ssh-opt x', C('ssh-opt')],
    ['--import x', C('import')], ['--token-file x', C('token-file')],
    ['--ssh=x', L('ssh')], ['--token=x', C('token')], ['--remote-port=x', L('remote-port')],
  ];
  assert.strictEqual(rows.length, 22);
  for (const [args, want] of rows) {
    assert.strictEqual(refusalFor('deploy', args), want, args);
    assert.ok(want.length <= 200, args);
  }
  assert.strictEqual(refusalFor('upgrade', '--url x'), L('url'));
});

test('A2: the per-verb allowlist builds the exact argv and refuses the rest', () => {
  const rec = { ssh: 'u@h', remotePort: 7901 };
  const accepted = [
    ['--branch dev --dry-run', ['deploy', 'node', 'ios', '--ssh', 'u@h', '--port', '7901', '--branch', 'dev', '--dry-run', '--force', '-o', 'json']],
    ['--set a=1 --set b=2', ['deploy', 'node', 'ios', '--ssh', 'u@h', '--port', '7901', '--set', 'a=1', '--set', 'b=2', '--force', '-o', 'json']],
    ['--tag=v1 --image "img:with space"', ['deploy', 'node', 'ios', '--ssh', 'u@h', '--port', '7901', '--tag', 'v1', '--image', 'img:with space', '--force', '-o', 'json']],
  ];
  for (const [args, want] of accepted) assert.deepStrictEqual(build('deploy', args, rec), want, args);
  const DEPLOY_LIST = 'branch tag image set param subnets security-group assign-public-ip persistent use-bedrock no-wirescope force-conflicts dry-run';
  const refused = [
    ['--volume x', `refused: --volume is not accepted by deploy here (allowed: ${DEPLOY_LIST})`],
    ['--port 1', `refused: --port is not accepted by deploy here (allowed: ${DEPLOY_LIST})`],
    ['--help', `refused: --help is not accepted by deploy here (allowed: ${DEPLOY_LIST})`],
    ['--docker', `refused: --docker is not accepted by deploy here (allowed: ${DEPLOY_LIST})`],
    ['-o json', 'refused: "-o" — short flags and bare -- are not accepted; spell the long form'],
    ['--', 'refused: "--" — short flags and bare -- are not accepted; spell the long form'],
    ['--branch', 'refused: --branch needs a value, got ""'],
    ['--branch --ssh', 'refused: --branch needs a value, got "--ssh"'],
    ['--dry-run=1', 'refused: --dry-run takes no value'],
    ['--tag a --tag b', 'refused: --tag given twice'],
    ['node ios', 'refused: deploy takes flags only — the node name and its locator come from the context record "ios"'],
    ['--branch "dev', 'refused: args: unbalanced double quote'],
  ];
  for (const [args, want] of refused) assert.strictEqual(refusalOf(() => build('deploy', args, rec)), want, args);
  assert.deepStrictEqual(build('upgrade', '--tag v2 --force'), ['upgrade', 'node', 'ios', '--tag', 'v2', '--force', '-o', 'json']);
  assert.strictEqual(refusalFor('upgrade', '--param a'),
    'refused: --param is not accepted by upgrade here (allowed: tag image branch set subnets security-group assign-public-ip persistent force dry-run force-conflicts)');
});

test('A3: the deploy locator comes from the record, one row per shape', () => {
  const rows = [
    [{ ssh: 'u@h' }, ['deploy', 'node', 'ios', '--ssh', 'u@h', '--force', '-o', 'json']],
    [{ ssh: 'u@h', remotePort: '7902' }, ['deploy', 'node', 'ios', '--ssh', 'u@h', '--port', '7902', '--force', '-o', 'json']],
    [{ ssh: 'old@h', deploy: { flavor: 'ssh', host: 'd@h' } }, ['deploy', 'node', 'ios', '--ssh', 'd@h', '--force', '-o', 'json']],
    [{ ssm: { target: 'i-1', region: 'eu-west-1', profile: 'p' } },
      ['deploy', 'node', 'ios', '--ssm', 'i-1', '--region', 'eu-west-1', '--profile', 'p', '--force', '-o', 'json']],
    [{ ssm: { target: 'i-2' } }, ['deploy', 'node', 'ios', '--ssm', 'i-2', '--force', '-o', 'json']],
    [{ ssh: 'u@h', deploy: { flavor: 'docker' } }, ['deploy', 'node', 'ios', '--docker', '--force', '-o', 'json']],
    [{ ssh: 'u@h', remotePort: 7903, deploy: { flavor: 'docker', dockerHost: 'ssh://u@h' } },
      ['deploy', 'node', 'ios', '--docker', '--host', 'ssh://u@h', '--port', '7903', '--force', '-o', 'json']],
    [{ kubectl: { target: 'svc/ios', namespace: 'ns1', context: 'kc1' }, remotePort: 7901 },
      ['deploy', 'node', 'ios', '--helm', '--namespace', 'ns1', '--kube-context', 'kc1', '--force', '-o', 'json']],
    [{ kubectl: { target: 'svc/ios' } }, ['deploy', 'node', 'ios', '--helm', '--namespace', 'clodex', '--force', '-o', 'json']],
    [{ ssm: { ecs: 'clu/fam', region: 'us-east-1' }, deploy: { flavor: 'fargate', stack: 'stk' } },
      ['deploy', 'node', 'stk', '--fargate', '--ctx', 'ios', '--region', 'us-east-1', '--cluster', 'clu', '--force', '-o', 'json']],
    [{ ssm: { ecs: 'clu/fam' }, deploy: { flavor: 'fargate' } },
      ['deploy', 'node', 'ios', '--fargate', '--cluster', 'clu', '--force', '-o', 'json']],
  ];
  for (const [rec, want] of rows) assert.deepStrictEqual(build('deploy', '', rec), want, JSON.stringify(rec));
  const refusals = [
    [{ url: 'https://x' }, 'refused: context "ios" records no deploy flavor and its url transport names no installer — the operator runs the first deploy'],
    [{ tunnel: ['a'] }, 'refused: context "ios" records no deploy flavor and its tunnel transport names no installer — the operator runs the first deploy'],
    [{ ssm: { ecs: 'c/f' } }, 'refused: context "ios" records no deploy flavor and its ssm-ecs transport names no installer — the operator runs the first deploy'],
    [{ deploy: { flavor: 'ssh' } }, 'refused: context "ios" records deploy flavor ssh but no host — the operator re-stamps it with a deploy from a terminal'],
    [{ deploy: { flavor: 'ssm' } }, 'refused: context "ios" records deploy flavor ssm but no target — the operator re-stamps it with a deploy from a terminal'],
    [{ ssh: 'u@h', deploy: { flavor: 'gcloud' } }, 'refused: context "ios" records deploy flavor "gcloud", which this tier does not deploy — the operator runs it from a terminal'],
    [{ kubectl: { target: 'svc/other' } }, 'refused: helm context "ios" records release "other" — deploy would save a context under the release name; use upgrade'],
  ];
  for (const [rec, want] of refusals) assert.strictEqual(refusalFor('deploy', '', rec), want, JSON.stringify(rec));
});

test('A4: restart is restart node, forced', () => {
  assert.deepStrictEqual(build('restart', ''), ['--ctx', 'ios', 'restart', 'node', '--force', '-o', 'json']);
  assert.deepStrictEqual(build('restart', 'node'), ['--ctx', 'ios', 'restart', 'node', '--force', '-o', 'json']);
  assert.strictEqual(refusalFor('restart', 'session x'),
    'refused: restart here is `restart node` (args empty or "node"); restart session is in clodex-ctl-seats');
  assert.strictEqual(refusalFor('restart', '--fresh'), 'refused: --fresh is not accepted by restart here (allowed: no flags)');
});

test('A5: delete is delete session <name>, forced', () => {
  assert.deepStrictEqual(build('delete', 'session w'), ['--ctx', 'ios', 'delete', 'session', 'w', '--force', '-o', 'json']);
  assert.deepStrictEqual(build('delete', 'session/w'), ['--ctx', 'ios', 'delete', 'session', 'w', '--force', '-o', 'json']);
  assert.strictEqual(refusalFor('delete', 'node ios'), 'refused: delete here is `delete session <name>`; delete node is operator-only');
  const R17 = 'refused: delete session needs a plain session name ([A-Za-z0-9._-]{1,64})';
  assert.strictEqual(refusalFor('delete', 'session'), R17);
  assert.strictEqual(refusalFor('delete', 'session ../x'), R17);
  assert.strictEqual(refusalFor('delete', 'session ..'), R17);
});

test('A6: undeploy keeps the context and refuses flavor and record overrides', () => {
  assert.deepStrictEqual(build('undeploy', ''), ['undeploy', 'node', 'ios', '--force', '--keep-ctx', '-o', 'json']);
  assert.deepStrictEqual(build('undeploy', '--keep-data --wait'), ['undeploy', 'node', 'ios', '--keep-data', '--wait', '--force', '--keep-ctx', '-o', 'json']);
  assert.strictEqual(refusalFor('undeploy', '--keep-ctx'), 'refused: --keep-ctx is not accepted by undeploy here (allowed: keep-data dry-run wait)');
  assert.strictEqual(refusalFor('undeploy', '--helm'), 'refused: --helm is not accepted by undeploy here (allowed: keep-data dry-run wait)');
  assert.strictEqual(refusalFor('undeploy', '--host x'), 'refused: --host comes from the context record and cannot be set here');
});

test('A7: verbs outside the table are refused as interactive', () => {
  for (const verb of ['attach', 'logs', 'exec', 'input', 'create', 'use', 'port-forward', 'web', 'get']) {
    assert.strictEqual(refusalOf(() => A.buildArgv(verb, 'ios', SSH_REC, [])),
      `refused: ${verb} has no non-interactive spelling on this tier (verbs: help deploy upgrade restart; undeploy, delete by operator enum edit)`, verb);
  }
});

test('A9: redact hides tokens and token-shaped values, leaves short tokens alone', () => {
  const rows = [
    ['pre secrettoken123 post', ['secrettoken123'], 'pre *** post'],
    [`minted ${HEX48} now`, [], 'minted *** now'],
    ['{"token":"abcdefgh12345678"}', [], '{"token":"***"}'],
    ['Environment=CLODEX_REMOTE_TOKEN=zzzzzzzzzzzz', [], 'Environment=CLODEX_REMOTE_TOKEN=***'],
    ['Authorization: Bearer qwertyuiop', [], 'Authorization: Bearer ***'],
    ['short abcdefg kept', ['abcdefg'], 'short abcdefg kept'],
    ['xx secrettoken123secrettoken123 yy', ['secrettoken123secrettoken123', 'secrettoken123'], 'xx *** yy'],
  ];
  for (const [input, tokens, want] of rows) assert.strictEqual(A.redact(input, tokens), want, input);
  assert.ok(rows[5][0].includes('abcdefg'), 'ENTER: the 7-char token is still in the input');
});

test('resultBody: a failed run with a reason carries it in the head', () => {
  const rec = { seq: 9, verb: 'deploy', ctx: 'ios', outcome: 'failed', exitCode: null, signal: null,
    reason: 'clodexctl spawn failed: x', startedAt: '2026-01-02T03:04:05.000Z', endedAt: '2026-01-02T03:04:07.000Z' };
  assert.strictEqual(A.resultBody(rec, '/r', ['tail one']),
    '[run 9 deploy ios] exit null (failed: clodexctl spawn failed: x) after 2s — log /r/9.log\ntail one');
});

test('A14: every prompt site in the CLI throws EXIT.USAGE under -o json before it prompts', () => {
  let sites = 0;
  for (const rel of ['cli/src/verbs.js', 'cli/src/undeploy.js']) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\bprompt\(/.test(line) || /function defaultPrompt/.test(line)) return;
      const before = lines.slice(Math.max(0, i - 8), i).join('\n');
      assert.match(before, /flags\.json/, `${rel}:${i + 1}`);
      assert.match(before, /EXIT\.USAGE/, `${rel}:${i + 1}`);
      sites++;
    });
  }
  assert.ok(sites >= 3, `ENTER: at least three prompt sites (got ${sites})`);
});

function fixture(contexts = { ios: { ssh: 'u@h', token: 'tok-ios-0123456789' } }) {
  const tmp = mkTmpRoot('clodex-mon-');
  const home = path.join(tmp, '.clodex');
  fs.mkdirSync(path.join(home, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(home, 'run', 'a'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cli', 'contexts.json'), JSON.stringify({ current: null, contexts }));
  const sock = path.join(mkTmpRoot('clodex-mon-'), 's.sock');
  fs.writeFileSync(path.join(home, 'run', 'a', 'agent.json'), JSON.stringify({ socket: sock }));
  const fake = path.join(tmp, 'fake-clodexctl.js');
  fs.writeFileSync(fake, [
    "'use strict';",
    'const a = process.argv.slice(2);',
    "if (a[0] === 'help') { process.stdout.write('HELP ' + JSON.stringify(a) + '\\n'); process.exit(0); }",
    'const go = () => {',
    "const out = [JSON.stringify(a), JSON.stringify({ erun: process.env.ELECTRON_RUN_AS_NODE, hasUrl: 'CLODEX_URL' in process.env })];",
    "for (const l of JSON.parse(process.env.FAKE_LINES || '[]')) out.push(l);",
    "process.stdout.write(out.join('\\n') + '\\n');",
    "process.exitCode = Number(process.env.FAKE_EXIT || 0);",
    '};',
    "const rel = process.env.FAKE_RELEASE;",
    "if (rel) { const t = setInterval(() => { if (require('fs').existsSync(rel)) { clearInterval(t); go(); } }, 20); } else go();",
  ].join('\n'));
  const dms = [];
  const waiters = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => {
      dms.push(JSON.parse(buf));
      for (const w of waiters.splice(0)) w();
    });
  });
  const env = {
    ...process.env, HOME: tmp, CLODEX_HOME: home, CLODEX_SEAT: 'a', CLODEX_NODE: process.execPath,
    CLODEX_CTL: fake, CLODEX_URL: 'http://decoy', TZ: 'UTC',
  };
  const waitDm = (pred, label) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`no dm matching ${label} within 10s: ${JSON.stringify(dms)}`)), 10000);
    const check = () => {
      const hit = dms.find(pred);
      if (hit) { clearTimeout(deadline); resolve(hit); } else waiters.push(check);
    };
    check();
  });
  const runs = path.join(home, 'ctl-runs');
  return {
    tmp, home, runs, env, dms, waitDm, server,
    listen: () => new Promise((r) => server.listen(sock, r)),
    close: () => new Promise((r) => server.close(r)),
  };
}

const launch = (env, payload) => new Promise((resolve) => {
  const ch = cp.spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ch.stderr.on('data', (d) => { err += d; });
  ch.on('exit', (code) => resolve({ code, err: err.trim() }));
  ch.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
});

const until = async (pred, label) => {
  const end = Date.now() + 10000;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const readRec = (runs, seq) => { try { return JSON.parse(fs.readFileSync(path.join(runs, `${seq}.json`), 'utf8')); } catch { return null; } };

test('A10: a deploy runs detached, streams redacted milestones, and reports a waking result', async () => {
  const f = fixture();
  await f.listen();
  try {
    const env = {
      ...f.env, FAKE_EXIT: '3',
      FAKE_LINES: JSON.stringify([
        '{"type":"step","name":"a"}', '{"type":"ok","name":"a"}',
        JSON.stringify({ type: 'log', text: `"token":"${HEX48}"` }),
      ]),
    };
    const r = await launch(env, { ctx: 'ios', verb: 'deploy', args: '' });
    assert.strictEqual(r.code, 0, r.err);
    const [l1, l2] = r.err.split('\n');
    assert.match(l1, /^run 1 started: deploy on ios — progress and the result arrive as dms from ctl-admin; log \/.*\/ctl-runs\/1\.log$/);
    assert.strictEqual(l2, 'argv: clodexctl deploy node ios --ssh u@h --force -o json');
    const final = await f.waitDm((m) => !m.delivery, 'the result');
    await until(() => (readRec(f.runs, 1) || {}).notified === true, 'notified:true');
    const passive = f.dms.filter((m) => m.delivery === 'passive');
    assert.ok(passive.length >= 1, 'ENTER: at least one progress dm');
    assert.match(passive[0].body, /^\[run 1 deploy ios\]\n→ a …/);
    const progress = passive.map((m) => m.body).join('\n');
    assert.match(progress, /\na ok(\n|$)/);
    assert.ok(!/"type":"log"|token/.test(progress), progress);
    assert.ok(f.dms.every((m) => m.from === 'ctl-admin' && m.type === 'dm'));
    const [head, ...tail] = final.body.split('\n');
    assert.match(head, /^\[run 1 deploy ios\] exit 3 \(failed\) after \d+s — log \/.*\/ctl-runs\/1\.log$/);
    assert.ok(tail.join('\n').includes('***'));
    assert.ok(!final.body.includes(HEX48));
    const logFile = path.join(f.runs, '1.log');
    assert.strictEqual(fs.statSync(logFile).mode & 0o777, 0o600);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.ok(!log.includes(HEX48));
    assert.ok(log.includes('out {"erun":"1","hasUrl":false}'), log);
    assert.ok(log.includes('out ["deploy","node","ios","--ssh","u@h","--force","-o","json"]'), log);
    const rec = readRec(f.runs, 1);
    assert.deepStrictEqual({ outcome: rec.outcome, exitCode: rec.exitCode, notified: rec.notified, seat: rec.seat },
      { outcome: 'failed', exitCode: 3, notified: true, seat: 'a' });
    assert.ok(!fs.existsSync(path.join(f.runs, 'ios.lock')));
  } finally {
    await f.close();
  }
});

test('A8: a live lock refuses naming the run; a dead one is swept to unknown and the run proceeds', async () => {
  const f = fixture();
  await f.listen();
  try {
    fs.mkdirSync(f.runs, { recursive: true });
    const lockFile = path.join(f.runs, 'ios.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ seq: 4, pid: process.pid, seat: 'b', verb: 'upgrade', startedAt: '2026-01-02T03:04:05.000Z' }));
    const live = await launch(f.env, { ctx: 'ios', verb: 'deploy' });
    assert.strictEqual(live.code, 1);
    assert.ok(live.err.startsWith('refused: run 4 is in flight on ios (upgrade, started 03:04:05, seat b) — wait for its result dm; log '), live.err);
    assert.ok(live.err.endsWith('ctl-runs/4.log') && live.err.length <= 200, live.err);

    const dead = cp.spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(lockFile, JSON.stringify({ seq: 7, pid: dead, seat: 'a', verb: 'deploy', startedAt: '2026-01-02T03:04:05.000Z' }));
    fs.writeFileSync(path.join(f.runs, '7.json'), JSON.stringify({ seq: 7, ctx: 'ios', seat: 'a', verb: 'deploy', startedAt: '2026-01-02T03:04:05.000Z', outcome: 'running', notified: false }));
    const r = await launch(f.env, { ctx: 'ios', verb: 'deploy' });
    assert.strictEqual(r.code, 0, r.err);
    assert.match(r.err, /^run 1 started: deploy on ios/);
    const unknown = await f.waitDm((m) => /outcome UNKNOWN/.test(m.body), 'the sweep dm');
    assert.strictEqual(unknown.delivery, undefined);
    assert.match(unknown.body, new RegExp(`^\\[run 7 deploy ios\\] outcome UNKNOWN — the worker \\(pid ${dead}\\) is gone and left no result; nothing was re-run\\. log /.*/ctl-runs/7\\.log$`));
    const swept = readRec(f.runs, 7);
    assert.deepStrictEqual({ outcome: swept.outcome, reason: swept.reason, notified: swept.notified },
      { outcome: 'unknown', reason: `worker pid ${dead} gone without a result`, notified: true });
    await f.waitDm((m) => /^\[run 1 deploy ios\] exit 0 \(ok\)/.test(m.body), 'the new run result');
    await until(() => (readRec(f.runs, 1) || {}).notified === true, 'run 1 notified');
    assert.ok(!fs.existsSync(lockFile));
  } finally {
    await f.close();
  }
});

test('A10b: a silent run gets a passive heartbeat before its result', async () => {
  const f = fixture();
  await f.listen();
  try {
    const release = path.join(f.tmp, 'release');
    const env = { ...f.env, CTLA_HEARTBEAT_MS: '50', FAKE_RELEASE: release };
    const r = await launch(env, { ctx: 'ios', verb: 'restart', args: '' });
    assert.strictEqual(r.code, 0, r.err);
    const beat = await f.waitDm((m) => /still running/.test(m.body), 'the heartbeat');
    assert.strictEqual(beat.delivery, 'passive');
    assert.match(beat.body, /^\[run 1 restart ios\] still running — \d+s; last: $/);
    assert.ok(!f.dms.some((m) => !m.delivery), 'no result before the child exits');
    fs.writeFileSync(release, '');
    await f.waitDm((m) => /^\[run 1 restart ios\] exit 0 \(ok\)/.test(m.body), 'the result');
    await until(() => (readRec(f.runs, 1) || {}).notified === true, 'notified:true');
  } finally {
    await f.close();
  }
});

test('A11: help relays clodexctl help locally, takes no lock and writes no record', async () => {
  const f = fixture();
  const r = await launch(f.env, { ctx: 'ios', verb: 'help', args: 'deploy' });
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.err.includes('HELP ["help","deploy"]'), r.err);
  assert.ok(r.err.endsWith('[clodex-ctl-admin] on this tier deploy takes: --branch --tag --image --set --param --subnets --security-group --assign-public-ip --persistent --use-bedrock --no-wirescope --force-conflicts --dry-run; the node and its locator come from the context record'), r.err);
  assert.ok(!fs.existsSync(f.runs));
  const bad = await launch(f.env, { ctx: 'ios', verb: 'help', args: '--ssh' });
  assert.deepStrictEqual(bad, { code: 1, err: 'refused: help takes up to three verb words ([a-z-]+), e.g. args "deploy"' });
});

test('A12 + launcher refusals: env guard, payload, ctx, verb, record', async () => {
  const f = fixture();
  const noSeat = { ...f.env };
  delete noSeat.CLODEX_SEAT;
  const rows = [
    [noSeat, { ctx: 'ios', verb: 'deploy' }, 'refused: this host does not pass CLODEX_SEAT/CLODEX_NODE/CLODEX_CTL to exec commands — restart Clodex on a build with the admin tier'],
    [f.env, 'not json', 'refused: payload is not valid JSON'],
    [f.env, { ctx: '../x', verb: 'deploy' }, 'refused: ctx must be a plain context name ([A-Za-z0-9._-]{1,64})'],
    [f.env, { ctx: 'ios', verb: 'attach' }, 'refused: attach has no non-interactive spelling on this tier (verbs: help deploy upgrade restart; undeploy, delete by operator enum edit)'],
    [f.env, { ctx: 'ios', verb: 'deploy', args: 'a\u0007' }, 'refused: args may not contain control characters'],
    [f.env, { ctx: 'nope', verb: 'deploy' }, 'refused: context "nope" is not in ~/.clodex/cli/contexts.json — the enum names it, the operator creates it'],
    [f.env, { ctx: 'ios', verb: 'deploy', args: '--ssh evil' }, 'refused: --ssh comes from the context record and cannot be set here'],
  ];
  for (const [env, payload, want] of rows) {
    assert.deepStrictEqual(await launch(env, payload), { code: 1, err: want }, JSON.stringify(payload));
  }
  assert.ok(!fs.existsSync(path.join(f.runs, '1.json')), 'no refused call allocated a run');
});

async function execEnvProbe(deps = {}) {
  const { mk: mkBase } = require('./lib/session-fixtures');
  const { isFilenameToken, parseAndValidate, clampReplyBody } = require('../exec-schema');
  const REGISTRY_DIR = mkTmpRoot('clx-ctl-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'probe.json'), JSON.stringify({
    argv: ['/usr/bin/env', 'node', '${CLODEX_BIN}/probe.js'], description: 'probe', timeoutMs: 5000,
    schema: { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } },
  }));
  const spawned = [];
  const QUIET = { info() {}, warn() {}, error() {}, debug() {} };
  const m = mkBase({
    log: QUIET, isFilenameToken, fs, path, os, REGISTRY_DIR, clampReplyBody, parseAndValidate,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: () => ({ name: 'a', execCommands: ['probe'] }) }),
    childProcess: { spawn: (cmd, args, opts) => { spawned.push(opts); throw new Error('stop'); } },
    ...deps,
  });
  m._injectText = () => {};
  m._broadcast = () => {};
  await m._handleExecIntent({ name: 'a', agentType: 'claude', workspaceId: 'ws1', cwd: '/tmp' }, 'probe', '{"x":"y"}');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(spawned.length, 1, 'ENTER: the dispatcher reached spawn');
  return { env: spawned[0].env, REGISTRY_DIR };
}

function hostEnv(REGISTRY_DIR, team) {
  return {
    ...process.env,
    CLODEX_HOME: REGISTRY_DIR,
    CLODEX_SEAT: 'a',
    CLODEX_NODE: process.execPath,
    CLODEX_CTL: path.join(__dirname, '..', 'cli', 'bin', 'clodexctl.js'),
    CLODEX_TEAM: team ? team.name : '',
    CLODEX_TEAM_ROOT: team ? team.root : '',
  };
}

test('A13: the exec dispatcher passes seat, interpreter and CLI script to the child', async () => {
  const { env, REGISTRY_DIR } = await execEnvProbe();
  assert.strictEqual(env.CLODEX_SEAT, 'a');
  assert.strictEqual(env.CLODEX_NODE, process.execPath);
  assert.ok(path.isAbsolute(env.CLODEX_CTL) && env.CLODEX_CTL.endsWith(path.join('cli', 'bin', 'clodexctl.js')), env.CLODEX_CTL);
  assert.strictEqual(env.CLODEX_HOME, REGISTRY_DIR);
});

test('A13: a seat on a team gets its team name and root in CLODEX_TEAM / CLODEX_TEAM_ROOT', async () => {
  const team = { name: 'tm', root: '/srv/tm-root' };
  const { env, REGISTRY_DIR } = await execEnvProbe({ teamOf: ({ name }) => (name === 'a' ? team : null) });
  assert.deepStrictEqual(env, hostEnv(REGISTRY_DIR, team));
});

test('A13: a seat on no team gets CLODEX_TEAM / CLODEX_TEAM_ROOT as empty strings, never the app env', async () => {
  const saved = { t: process.env.CLODEX_TEAM, r: process.env.CLODEX_TEAM_ROOT };
  process.env.CLODEX_TEAM = 'decoy';
  process.env.CLODEX_TEAM_ROOT = '/decoy';
  try {
    const { env, REGISTRY_DIR } = await execEnvProbe({ teamOf: () => null });
    assert.deepStrictEqual(env, hostEnv(REGISTRY_DIR, null));
    assert.strictEqual(env.CLODEX_TEAM, '');
    assert.strictEqual(env.CLODEX_TEAM_ROOT, '');
  } finally {
    if (saved.t === undefined) delete process.env.CLODEX_TEAM; else process.env.CLODEX_TEAM = saved.t;
    if (saved.r === undefined) delete process.env.CLODEX_TEAM_ROOT; else process.env.CLODEX_TEAM_ROOT = saved.r;
  }
});
