'use strict';
// deploy-ssm.test.js — the `deploy ssm <name> --target …` flavor: the OS flavor
// (dedicated clodex host user + systemd --user service, NOT docker) over AWS SSM
// RunCommand. Pure builders (wrapper + argv), the poll loop (pseudo-streaming +
// terminal statuses) against fake execFn sequences, and the full verb through
// main.run with a fully stubbed execFn (aws) + injected verify (io.probeSsm). NO
// AWS is ever touched: execFn and probeSsm are stubs, spawnFn is never reached,
// and io.sleepFn is a no-op so the 2s pre-poll / retry backoff don't slow tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/deploy');
const { EXIT } = require('../src/errors');
const { run } = require('../src/main');

const noSleep = async () => {};

// ── pure: buildSsmScript (the root wrapper) ──────────────────────────────────

test('buildSsmScript: root wrapper — prereqs+node gate, clodex user, pinned installer, token drop-in, verify', () => {
  const s = D.buildSsmScript({ port: 7900, token: 'deadbeef', repo: 'https://github.com/avirtual/clodex', branch: 'master' });
  // step 1: prereqs across families + explicit node>=20 gate (its own + the installer's).
  assert.match(s, /::step prereqs/);
  // per-package install loop (one conflicting pkg — curl-minimal on AL2023 — must
  // not sink the rest); families set $PM, the loop skips already-present commands.
  assert.match(s, /dnf install -y|yum install -y|apt-get install -y/);
  // the node-pty build toolchain rides the install list, family-named (rpm: gcc-c++
  // make python3; apt: build-essential python3) so the installer can rebuild node-pty.
  assert.match(s, /TOOLCHAIN="gcc-c\+\+ make python3"/);
  assert.match(s, /TOOLCHAIN="build-essential python3"/);
  assert.match(s, /for pkg in git curl nodejs npm \$TOOLCHAIN; do/);
  assert.match(s, /gcc-c\+\+\|build-essential\) cmd=g\+\+/);   // skip-if-present maps compiler pkg → g++
  assert.match(s, /command -v "\$cmd" >\/dev\/null 2>&1 && continue/);
  assert.match(s, /setup_20\.x/);   // NodeSource fallback when packaged node is <20
  assert.match(s, /NODE_MAJOR" -ge 20 .* \|\| \{ echo "::fail prereqs/);
  // git gate beside the node gate — prereqs must not report ok when git is absent.
  assert.match(s, /command -v git >\/dev\/null 2>&1 \|\| \{ echo "::fail prereqs git-not-found"; exit 1; \}/);
  assert.match(s, /command -v npm >\/dev\/null 2>&1 \|\| \{ echo "::fail prereqs npm-not-found"; exit 1; \}/);
  // step 2: dedicated host user + linger.
  assert.match(s, /::step user/);
  assert.match(s, /id clodex .* useradd -m clodex/);
  assert.match(s, /loginctl enable-linger clodex/);
  // step 3: the PINNED installer, byte-for-byte, run as the clodex user, log parked.
  assert.match(s, /::step install/);
  assert.match(s, /sudo -iu clodex bash -s > "\$CLODEX_LOG"/);
  assert.ok(s.includes(D.readScript()), 'embeds the drift-pinned installer bytes verbatim');
  assert.match(s, /grep -E '\^::' "\$CLODEX_LOG"/);       // filter installer markers into the trail
  assert.match(s, /echo "::log \$CLODEX_LOG"/);
  // step 4: token drop-in (approach A) — 0700 dir, 0600 conf, env, reload+restart.
  assert.match(s, /::step token/);
  assert.match(s, /chmod 700 "\$DROPIN_DIR"/);
  assert.match(s, /Environment=CLODEX_REMOTE_TOKEN=deadbeef/);
  assert.match(s, /chmod 600 "\$DROPIN"/);
  assert.match(s, /systemctl --user daemon-reload/);
  assert.match(s, /systemctl --user restart clodex\.service/);
  // step 5: on-box hello WITH the token, parseable marker — AFTER the token step.
  assert.match(s, /::step verify/);
  assert.match(s, /Authorization: Bearer deadbeef/);
  assert.match(s, /\/api\/peer\/hello/);
  assert.match(s, /echo "::verify http=\$code"/);
  // ::ok verify only on 200; a non-200 curl loop renders a non-fatal ::fail verify.
  assert.match(s, /if \[ "\$code" = "200" \]; then echo "::ok verify"; else echo "::fail verify http=\$code"; fi/);
  assert.ok(s.indexOf('::step token') < s.indexOf('::step verify'), 'verify runs after the token is live');
  assert.match(s, /::done/);
  // no docker anywhere — this is the OS flavor.
  assert.doesNotMatch(s, /docker/);
  // valid /bin/sh.
  const f = path.join(os.tmpdir(), `t39-${process.pid}.sh`);
  fs.writeFileSync(f, s);
  try { require('node:child_process').execFileSync('sh', ['-n', f]); } finally { fs.rmSync(f, { force: true }); }
});

test('buildSsmScript: step 0 portcheck fails early when the wire port is held by a non-clodex holder', () => {
  const s = D.buildSsmScript({ port: 7900, token: 'deadbeef', repo: 'https://github.com/avirtual/clodex', branch: 'master' });
  // A step-0 marker before prereqs.
  assert.match(s, /::step portcheck/);
  assert.ok(s.indexOf('::step portcheck') < s.indexOf('::step prereqs'), 'portcheck runs first');
  // ss query uses ONLY the validated numeric port — no other caller data.
  assert.match(s, /ss -tlnpH "sport = :7900"/);
  // holder identity comes from on-box ps output (never caller data).
  assert.match(s, /ps -o user= -p "\$HPID"/);
  assert.match(s, /ps -o comm= -p "\$HPID"/);
  // held by OUR clodex user → a ::log, NOT a fail (redeploy restarts it).
  assert.match(s, /\[ "\$HUSER" = "clodex" \]/);
  assert.match(s, /::log port 7900 already held by our clodex service/);
  // held by anything else → ::fail naming the holder, then exit 1.
  assert.match(s, /echo "::fail portcheck port-7900-held-by-\$\{HUSER:-unknown\}-\$\{HCMD:-proc\}-pid-\$\{HPID:-unknown\}"/);
  assert.match(s, /::ok portcheck/);
  // the ONLY port literal in the portcheck block is the validated 7900 — confirm a
  // different port flows through identically (no stray hardcode).
  const s8 = D.buildSsmScript({ port: 8100, token: 't', repo: 'https://x/y', branch: 'm' });
  assert.match(s8, /ss -tlnpH "sport = :8100"/);
  assert.match(s8, /port-8100-held-by-/);
});

test('buildSsmScript: heredoc delimiters are per-run random nonces (unguessable)', () => {
  const a = D.buildSsmScript({ port: 7900, token: 't', repo: 'https://x/y', branch: 'm' });
  const b = D.buildSsmScript({ port: 7900, token: 't', repo: 'https://x/y', branch: 'm' });
  // shape: CLODEX_EOF_<16 hex> for the install heredoc, TOKEN variant for the token one.
  const mi = a.match(/<<'(CLODEX_EOF_[0-9a-f]{16})'/);
  const mt = a.match(/<<'(CLODEX_TOKEN_EOF_[0-9a-f]{16})'/);
  assert.ok(mi && mt, 'both heredocs use a nonce delimiter');
  // each delimiter opens AND closes (balanced).
  assert.strictEqual((a.match(new RegExp(mi[1], 'g')) || []).length, 2);
  assert.strictEqual((a.match(new RegExp(mt[1], 'g')) || []).length, 2);
  // two independent renders → different nonces.
  assert.notStrictEqual(mi[1], b.match(/<<'(CLODEX_EOF_[0-9a-f]{16})'/)[1]);
  // the old fixed delimiter no longer appears.
  assert.doesNotMatch(a, /CLODEX_INSTALL_EOF/);
});

test('buildSsmScript: noWirescope rides the embedded preamble (CLODEX_NO_WIRESCOPE=1) — same mechanism as ssh, no fork', () => {
  const s = D.buildSsmScript({ port: 7900, token: 't', repo: 'https://x/y', branch: 'm', noWirescope: true });
  assert.match(s, /export PORT='7900' REPO_URL='https:\/\/x\/y' BRANCH='m' CLODEX_NO_WIRESCOPE='1'/);
  // the installer bytes themselves stay the pinned copy, verbatim.
  assert.ok(s.includes(D.readScript()), 'installer bytes unchanged');
  // no flag → no export (default behavior).
  const d = D.buildSsmScript({ port: 7900, token: 't', repo: 'https://x/y', branch: 'm' });
  assert.doesNotMatch(d, /CLODEX_NO_WIRESCOPE='1'/);
});

test('buildSsmScript: port/token/repo/branch substitution flows into the preamble + verify', () => {
  const s = D.buildSsmScript({ port: 8100, token: 'abc', repo: 'https://example.com/fork', branch: 'dev' });
  // preamble the installer inherits (buildPreamble contract).
  assert.match(s, /export PORT='8100' REPO_URL='https:\/\/example\.com\/fork' BRANCH='dev'/);
  // the on-box verify hits the chosen port with the chosen token.
  assert.match(s, /Authorization: Bearer abc/);
  assert.match(s, /127\.0\.0\.1:8100\/api\/peer\/hello/);
});

// ── pure: argv builders (unchanged from v1) ──────────────────────────────────

test('ssmSendCommandArgs: RunShellScript, instance-ids, parameters JSON, query', () => {
  const argv = D.ssmSendCommandArgs({ target: 'i-123', region: 'us-west-2', profile: 'p', script: 'echo hi' });
  assert.strictEqual(argv[0], 'aws');
  // profile before region (mirrors resolveEcsTarget base order).
  assert.ok(argv.indexOf('--profile') < argv.indexOf('--region'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('ssm'), argv.indexOf('ssm') + 6),
    ['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', 'i-123']);
  const pj = JSON.parse(argv[argv.indexOf('--parameters') + 1]);
  assert.deepStrictEqual(pj, { commands: ['echo hi'] });
  assert.deepStrictEqual(argv.slice(-4), ['--query', 'Command.CommandId', '--output', 'text']);
});

test('ssmDescribeArgs / ssmGetInvocationArgs: filters + ids, region/profile optional', () => {
  const d = D.ssmDescribeArgs({ target: 'i-9' });
  assert.ok(!d.includes('--profile') && !d.includes('--region'));
  assert.deepStrictEqual(d.slice(d.indexOf('--filters'), d.indexOf('--filters') + 2), ['--filters', 'Key=InstanceIds,Values=i-9']);
  const g = D.ssmGetInvocationArgs({ commandId: 'cmd-1', target: 'i-9', region: 'r' });
  assert.ok(g.includes('--command-id') && g[g.indexOf('--command-id') + 1] === 'cmd-1');
  assert.ok(g.includes('--instance-id') && g[g.indexOf('--instance-id') + 1] === 'i-9');
  assert.ok(g.includes('--region') && !g.includes('--profile'));
});

// ── poll loop with a scripted execFn ─────────────────────────────────────────

// execFn that returns get-command-invocation JSON from a scripted status list;
// the last entry sticks. Records nothing — this is the poll policy in isolation.
function pollExec(statuses, extra = {}) {
  let i = 0;
  return async () => {
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return { stdout: JSON.stringify({ Status: status, ResponseCode: status === 'Success' ? 0 : 1, StandardOutputContent: extra.stdout || '', StandardErrorContent: extra.stderr || '' }) };
  };
}

test('ssmPoll: reaches Success and returns the output', async () => {
  const seen = [];
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, {
    execFn: pollExec(['Pending', 'InProgress', 'Success'], { stdout: '::verify http=200\n' }),
    pollMs: 1, prePollMs: 0, sleepFn: noSleep, onStatus: (s) => seen.push(s),
  });
  assert.strictEqual(r.status, 'Success');
  assert.strictEqual(r.responseCode, 0);
  assert.match(r.stdout, /::verify http=200/);
  assert.deepStrictEqual(seen, ['Pending', 'InProgress', 'Success']);   // one emit per change
});

test('ssmPoll: Failed returns the status + output tail (caller maps to SERVER)', async () => {
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, {
    execFn: pollExec(['InProgress', 'Failed'], { stderr: 'npm-install-failed\n' }),
    pollMs: 1, prePollMs: 0, sleepFn: noSleep,
  });
  assert.strictEqual(r.status, 'Failed');
  assert.match(r.stderr, /npm-install-failed/);
});

test('ssmPoll: budget lapses → synthetic TimedOut (no infinite poll)', async () => {
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, {
    execFn: pollExec(['InProgress']),   // never terminal
    pollMs: 1, prePollMs: 0, sleepFn: noSleep, timeoutMs: 5,
  });
  assert.strictEqual(r.status, 'TimedOut');
});

test('ssmPoll: tolerates InvocationDoesNotExist right after send, then succeeds', async () => {
  let i = 0;
  const execFn = async () => {
    if (i++ === 0) { const e = new Error('An error occurred (InvocationDoesNotExist)'); e.stderr = 'InvocationDoesNotExist'; throw e; }
    return { stdout: JSON.stringify({ Status: 'Success', ResponseCode: 0, StandardOutputContent: '::verify http=200' }) };
  };
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, { execFn, pollMs: 1, prePollMs: 0, sleepFn: noSleep, timeoutMs: 2000 });
  assert.strictEqual(r.status, 'Success');
});

test('ssmPoll: pseudo-streams fresh ^:: markers once each as partial output grows', async () => {
  // Partial StandardOutputContent grows across ticks (a prefix that only extends),
  // then the final superset arrives with Success. Each marker fires exactly once.
  const frames = [
    { Status: 'InProgress', StandardOutputContent: '::step prereqs\n::ok prereqs\n' },
    { Status: 'InProgress', StandardOutputContent: '::step prereqs\n::ok prereqs\n::step user\n::ok user\n' },
    { Status: 'Success', ResponseCode: 0, StandardOutputContent: '::step prereqs\n::ok prereqs\n::step user\n::ok user\n::verify http=200\n::done\n' },
  ];
  let i = 0;
  const execFn = async () => ({ stdout: JSON.stringify(frames[Math.min(i++, frames.length - 1)]) });
  const markers = [];
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, {
    execFn, pollMs: 1, prePollMs: 0, sleepFn: noSleep, onMarker: (l) => markers.push(l),
  });
  assert.strictEqual(r.status, 'Success');
  // every marker rendered exactly once, in order, final superset adds no dup.
  assert.deepStrictEqual(markers, ['::step prereqs', '::ok prereqs', '::step user', '::ok user', '::verify http=200', '::done']);
  assert.strictEqual(r.markersStreamed, markers.length);
});

test('ssmMarkerLines: keeps only ^:: lines, and only newline-terminated ones', () => {
  assert.deepStrictEqual(D.ssmMarkerLines('noise\n::step a\nmore\n::ok a\n'), ['::step a', '::ok a']);
  assert.deepStrictEqual(D.ssmMarkerLines(''), []);
  // a partial trailing marker (no newline yet) is held back until its newline.
  assert.deepStrictEqual(D.ssmMarkerLines('::step a\n::ok pr'), ['::step a']);
  assert.deepStrictEqual(D.ssmMarkerLines('::step a\n::ok prereqs\n'), ['::step a', '::ok prereqs']);
});

test('ssmPoll: a marker caught mid-echo is not fired until its newline arrives', async () => {
  // tick 1 ends mid-line (`::ok prer`); tick 2 completes it + adds more. The
  // truncated fragment must NEVER fire, and the completed line fires exactly once.
  const frames = [
    { Status: 'InProgress', StandardOutputContent: '::step prereqs\n::ok prer' },
    { Status: 'Success', ResponseCode: 0, StandardOutputContent: '::step prereqs\n::ok prereqs\n::done\n' },
  ];
  let i = 0;
  const execFn = async () => ({ stdout: JSON.stringify(frames[Math.min(i++, frames.length - 1)]) });
  const markers = [];
  const r = await D.ssmPoll({ commandId: 'c', target: 'i-1' }, {
    execFn, pollMs: 1, prePollMs: 0, sleepFn: noSleep, onMarker: (l) => markers.push(l),
  });
  assert.strictEqual(r.status, 'Success');
  assert.deepStrictEqual(markers, ['::step prereqs', '::ok prereqs', '::done']);
  assert.ok(!markers.includes('::ok prer'), 'the truncated fragment never fired');
});

// ── send-side retry (registration race) ──────────────────────────────────────

test('ssmSendCommand: retries on eventually-consistent InvalidInstanceId, then succeeds', async () => {
  let i = 0;
  const execFn = async (cmd, argv) => {
    if (argv.join(' ').includes('send-command')) {
      if (i++ < 2) { const e = new Error('boom'); e.stderr = 'An error occurred (InvalidInstanceId) when calling the SendCommand operation'; throw e; }
      return { stdout: 'cmd-final\n' };
    }
    throw new Error('unexpected');
  };
  const id = await D.ssmSendCommand({ target: 'i-1', script: 'x' }, { execFn, retryMs: 1, sleepFn: noSleep });
  assert.strictEqual(id, 'cmd-final');
  assert.strictEqual(i, 3);   // two failures + one success
});

test('ssmSendCommand: a non-transient error is not retried', async () => {
  let i = 0;
  const execFn = async () => { i++; const e = new Error('nope'); e.stderr = 'AccessDeniedException'; throw e; };
  await assert.rejects(() => D.ssmSendCommand({ target: 'i-1', script: 'x' }, { execFn, retryMs: 1, sleepFn: noSleep }),
    (e) => e.exitCode === EXIT.SERVER && /AccessDeniedException/.test(e.message));
  assert.strictEqual(i, 1);   // no retry
});

// ── preflight ────────────────────────────────────────────────────────────────

test('ssmPreflight: online instance resolves; offline + not-registered → CONNECT + hint', async () => {
  const online = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'Online', PlatformName: 'Amazon Linux' }] }) });
  const info = await D.ssmPreflight({ target: 'i-1' }, { execFn: online });
  assert.strictEqual(info.PingStatus, 'Online');

  const empty = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [] }) });
  await assert.rejects(() => D.ssmPreflight({ target: 'i-1' }, { execFn: empty }),
    (e) => e.exitCode === EXIT.CONNECT && /not registered with SSM/.test(e.message) && /AmazonSSMManagedInstanceCore/.test(e.message));

  const offline = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'ConnectionLost' }] }) });
  await assert.rejects(() => D.ssmPreflight({ target: 'i-1' }, { execFn: offline }),
    (e) => e.exitCode === EXIT.CONNECT && /ConnectionLost/.test(e.message));
});

test('runAws: aws ENOENT → CONNECT with the install hint', async () => {
  const enoent = async () => { const e = new Error('spawn aws ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(() => D.ssmPreflight({ target: 'i-1' }, { execFn: enoent }),
    (e) => e.exitCode === EXIT.CONNECT && /aws CLI not found/.test(e.message));
});

// ── full verb through main.run ───────────────────────────────────────────────

// A scripted aws execFn: dispatches by subcommand. describe → online; send →
// a command id; get-command-invocation → Success with the wrapper's marker trail.
const SSM_TRAIL = '::step prereqs\n::ok prereqs\n::step user\n::ok user\n::step install\n::ok install\n::step token\n::ok token\n::step verify\n::verify http=200\n::ok verify\n::done\n';
function fakeAws(rec = {}) {
  return async (cmd, argv) => {
    rec.calls = rec.calls || [];
    rec.calls.push(argv);
    const j = argv.join(' ');
    if (j.includes('describe-instance-information')) {
      return { stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'Online', PlatformName: 'Amazon Linux' }] }) };
    }
    if (j.includes('send-command')) {
      rec.sentScript = JSON.parse(argv[argv.indexOf('--parameters') + 1]).commands[0];
      return { stdout: 'cmd-abc123\n' };
    }
    if (j.includes('get-command-invocation')) {
      return { stdout: JSON.stringify({ Status: 'Success', ResponseCode: 0, StandardOutputContent: SSM_TRAIL, StandardErrorContent: '' }) };
    }
    throw new Error('unexpected aws call: ' + j);
  };
}

async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {},
    sleepFn: noSleep,   // no-op the 2s pre-poll + retry backoff in tests
    contextsFile: io.contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}
function tmpCtxFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-ssm-')), 'contexts.json'); }

test('deploy ssm --no-wirescope: the sent wrapper embeds CLODEX_NO_WIRESCOPE=1; absent without the flag', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'ssm', 'mybox', '--target', 'i-1', '--no-wirescope', '--no-ctx'], {
    execFn: fakeAws(rec),
    probeSsm: async () => ({ app: 'clodex', host: 'mybox' }),
  });
  assert.strictEqual(code, 0);
  assert.match(rec.sentScript, /CLODEX_NO_WIRESCOPE='1'/);
  const rec2 = {};
  await cli(['deploy', 'ssm', 'mybox', '--target', 'i-1', '--no-ctx'], {
    execFn: fakeAws(rec2),
    probeSsm: async () => ({ app: 'clodex', host: 'mybox' }),
  });
  assert.doesNotMatch(rec2.sentScript, /CLODEX_NO_WIRESCOPE='1'/);
});

test('deploy ssm happy path: preflight→send→poll→verify→ctx (ssm kind + token) saved', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  let verifiedWith = null;
  const { code, stdout } = await cli(['deploy', 'ssm', 'mybox', '--target', 'i-1', '--region', 'us-west-2', '--profile', 'p'], {
    execFn: fakeAws(rec),
    probeSsm: async (entry, token) => { verifiedWith = { entry, token }; return { app: 'clodex', host: 'mybox', version: '9.9.9', caps: [] }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /instance i-1 online/);
  assert.match(stdout, /SSM command cmd-abc123/);
  // the relayed marker trail renders as a step list (pseudo-streamed).
  assert.match(stdout, /→ prereqs …/);
  assert.match(stdout, /install ok/);
  assert.match(stdout, /verified — clodex host=mybox version=9\.9\.9/);
  assert.match(stdout, /context "mybox" saved/);
  // The verify used the typed ssm entry + the minted token.
  assert.deepStrictEqual(verifiedWith.entry.ssm, { target: 'i-1', region: 'us-west-2', profile: 'p' });
  assert.match(verifiedWith.token, /^[0-9a-f]{48}$/);
  // The token that was sent to the box (in the drop-in) matches the one saved + verified.
  assert.ok(rec.sentScript.includes(`Environment=CLODEX_REMOTE_TOKEN=${verifiedWith.token}`));
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.mybox, { ssm: { target: 'i-1', region: 'us-west-2', profile: 'p' }, webPort: 7901, token: verifiedWith.token });
  assert.strictEqual(saved.current, 'mybox');
});

test('deploy ssm --claude-token-file: OAuth token delivered over the WIRE, NEVER in the SSM send-command params', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-oauth-secret\n');
  let delivered = null;
  const { code, stdout } = await cli(['deploy', 'ssm', 'mybox', '--target', 'i-1', '--claude-token-file', tf], {
    execFn: fakeAws(rec),
    probeSsm: async () => ({ app: 'clodex', host: 'mybox', version: '9', caps: [] }),
    deliverToken: async (entry, wireToken, oauth) => { delivered = { entry, wireToken, oauth }; return { ok: true }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // Delivery happened over the wire with the typed ssm entry + minted WIRE token.
  assert.strictEqual(delivered.oauth, 'sk-oauth-secret');
  assert.deepStrictEqual(delivered.entry.ssm, { target: 'i-1' });
  assert.match(delivered.wireToken, /^[0-9a-f]{48}$/);
  // CRITICAL: the OAuth token VALUE is NOWHERE in the SSM send-command wrapper
  // (CloudTrail). (The embedded ssh-flavor installer references the CLODEX_CLAUDE_TOKEN
  // env VAR by name for its own drop-in guard — that's a name, never the secret; the
  // ssm flavor leaves it unset so that branch is inert, and the value never rides SSM.)
  assert.ok(!rec.sentScript.includes('sk-oauth-secret'), 'OAuth token must never ride SSM params');
  // Nor in stdout / the deploy trail.
  assert.doesNotMatch(stdout, /sk-oauth-secret/);
  assert.match(stdout, /claude token sent over the wire .*verify with a claude spawn/);
});

test('deploy ssm --claude-token-file --dry-run: token noted by presence only, absent from wrapper', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, 'sk-drysecret\n');
  const { code, stdout } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--claude-token-file', tf, '--dry-run'], {
    execFn: async () => ({ stdout: '{}' }), probeSsm: async () => ({}),
    deliverToken: async () => { throw new Error('should not deliver on dry-run'); },
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /claude.*delivered over the wire post-verify, NOT via SSM params/);
  assert.doesNotMatch(stdout, /sk-drysecret/);
});

test('deploy ssm --claude-token-file: a bad token file fails fast BEFORE any aws call', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-tok-'));
  const tf = path.join(dir, 'empty'); fs.writeFileSync(tf, '\n');
  let awsCalled = false;
  const { code, stderr } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--claude-token-file', tf], {
    execFn: async () => { awsCalled = true; return { stdout: '{}' }; },
    probeSsm: async () => ({}), deliverToken: async () => ({ ok: true }),
  });
  assert.strictEqual(code, 2);   // EXIT.USAGE
  assert.match(stderr, /no token/);
  assert.strictEqual(awsCalled, false);
});

test('deliverClaudeToken: wire dance — bash session, control acquire, drop-in typed, engine polled back', async () => {
  // A fake wire: a WireClient hits transport.js → we stub openTransport by
  // pointing at a local http server that records the calls.
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null, auth: req.headers['authorization'] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'POST' && /\/api\/control\//.test(req.url)) return res.end(JSON.stringify({ ok: true, token: 'ctrl-1' }));
      if (req.url === '/api/peer/hello') return res.end(JSON.stringify({ ok: true, app: 'clodex' }));
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const entry = { url: `http://127.0.0.1:${port}` };
  const r = await D.deliverClaudeToken(entry, 'wire-tok', 'sk-oauth-9', { pollMs: 1, sleepFn: async () => {} });
  assert.strictEqual(r.ok, true);
  server.close();
  // The wire carried: create bash session, acquire control, input the drop-in, then hello.
  const create = seen.find((s) => s.method === 'POST' && s.url === '/api/sessions');
  assert.strictEqual(create.body.type, 'bash');
  assert.match(create.body.name, /^clodex-token-/);
  assert.strictEqual(create.auth, 'Bearer wire-tok');
  const input = seen.find((s) => s.method === 'POST' && /\/api\/input\//.test(s.url));
  assert.strictEqual(input.body.token, 'ctrl-1');
  assert.match(input.body.data, /systemctl --user restart clodex\.service/);
  // The OAuth token rides a shell-var assignment in the typed script (not argv).
  assert.match(input.body.data, /CLODEX_CLAUDE_TOKEN='sk-oauth-9'/);
  assert.ok(seen.some((s) => s.url === '/api/peer/hello'), 'engine polled back after restart');
});

test('deploy ssm --port non-default: remotePort saved on the ssm entry + wrapper', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  let entrySeen = null;
  const { code } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--port', '8100'], {
    execFn: fakeAws(rec), probeSsm: async (e) => { entrySeen = e; return { app: 'clodex' }; }, contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(entrySeen.remotePort, 8100);
  assert.match(rec.sentScript, /export PORT='8100'/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.strictEqual(saved.contexts.n.remotePort, 8100);
  assert.strictEqual(saved.contexts.n.ssm.target, 'i-1');
});

test('deploy ssm --branch/--repo: flow into the installer preamble', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--branch', 'dev', '--repo', 'https://example.com/fork', '--no-ctx'], {
    execFn: fakeAws(rec), probeSsm: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.match(rec.sentScript, /BRANCH='dev'/);
  assert.match(rec.sentScript, /REPO_URL='https:\/\/example\.com\/fork'/);
});

test('deploy ssm --no-ctx: verifies but saves nothing', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--no-ctx'], {
    execFn: fakeAws({}), probeSsm: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /verified/);
  assert.doesNotMatch(stdout, /context .* saved/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy ssm: a Failed command relays the output tail → EXIT.SERVER, no verify/ctx', async () => {
  const contextsFile = tmpCtxFile();
  let verified = false;
  const execFn = async (cmd, argv) => {
    const j = argv.join(' ');
    if (j.includes('describe-instance-information')) return { stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'Online' }] }) };
    if (j.includes('send-command')) return { stdout: 'cmd-x\n' };
    if (j.includes('get-command-invocation')) return { stdout: JSON.stringify({ Status: 'Failed', ResponseCode: 1, StandardOutputContent: '::step install\n::fail install installer-rc=1\n', StandardErrorContent: 'npm-install-failed' }) };
    throw new Error('x');
  };
  const { code, stdout, stderr } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1'], {
    execFn, probeSsm: async () => { verified = true; return {}; }, contextsFile,
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stdout + stderr, /npm-install-failed/);
  assert.match(stderr, /remote install failed on i-1/);
  assert.strictEqual(verified, false);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy ssm: a Cancelled command → EXIT.SERVER with the distinct message', async () => {
  const execFn = async (cmd, argv) => {
    const j = argv.join(' ');
    if (j.includes('describe-instance-information')) return { stdout: JSON.stringify({ InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'Online' }] }) };
    if (j.includes('send-command')) return { stdout: 'cmd-c\n' };
    if (j.includes('get-command-invocation')) return { stdout: JSON.stringify({ Status: 'Cancelled', ResponseCode: null, StandardOutputContent: '', StandardErrorContent: '' }) };
    throw new Error('x');
  };
  const { code, stderr } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--no-ctx'], {
    execFn, probeSsm: async () => { throw new Error('should not verify'); },
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stderr, /cancelled on i-1/);
});

test('deploy ssm: preflight offline → EXIT.CONNECT, nothing sent', async () => {
  const rec = { calls: [] };
  const execFn = async (cmd, argv) => {
    rec.calls.push(argv.join(' '));
    return { stdout: JSON.stringify({ InstanceInformationList: [] }) };   // not registered
  };
  const { code, stderr } = await cli(['deploy', 'ssm', 'n', '--target', 'i-ghost'], {
    execFn, probeSsm: async () => { throw new Error('should not verify'); },
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /not registered with SSM/);
  assert.ok(!rec.calls.some((c) => c.includes('send-command')), 'never sent a command');
});

test('deploy ssm: --target required', async () => {
  const { code, stderr } = await cli(['deploy', 'ssm', 'n'], { execFn: async () => ({ stdout: '{}' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /needs --target/);
});

test('deploy ssm: bad node name → usage error, no aws call', async () => {
  let ran = false;
  const { code, stderr } = await cli(['deploy', 'ssm', 'bad name!', '--target', 'i-1'], {
    execFn: async () => { ran = true; return { stdout: '{}' }; },
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /bad node name/);
  assert.strictEqual(ran, false);
});

test('deploy ssm: --branch/--repo with a heredoc-delimiter newline is rejected (EXIT.USAGE, no send)', async () => {
  // The worked exploit: a newline + a line equal to the heredoc terminator would
  // end the install heredoc early and run the trailing payload as ROOT. Validation
  // must reject it before anything is sent.
  const evil = 'x\nCLODEX_EOF_0000000000000000\nid > /tmp/pwned\n:';
  for (const flag of ['--branch', '--repo']) {
    let ran = false;
    const { code, stderr } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', flag, evil], {
      execFn: async () => { ran = true; return { stdout: '{}' }; },
      probeSsm: async () => { throw new Error('should not verify'); },
    });
    assert.strictEqual(code, EXIT.USAGE, `${flag} newline → USAGE`);
    assert.match(stderr, new RegExp(`bad \\${flag}`));
    assert.strictEqual(ran, false, 'no aws call for a rejected value');
  }
});

test('deploy ssm --dry-run: a newline-injected --branch never renders an executable payload', async () => {
  // Even if validation were bypassed, --dry-run must not print a wrapper whose
  // injected payload is a live line. Validation rejects it first (USAGE), so the
  // payload string never reaches stdout at all.
  const { code, stdout } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--branch', 'x\nid > /tmp/pwned', '--dry-run'], {
    execFn: async () => ({ stdout: '{}' }), probeSsm: async () => ({}),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.doesNotMatch(stdout, /id > \/tmp\/pwned/);
});

test('deploy ssm --dry-run: composes argv + wrapper, runs nothing, token is a placeholder', async () => {
  let ran = false;
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--region', 'us-west-2', '--dry-run'], {
    execFn: async () => { ran = true; return { stdout: '{}' }; },
    probeSsm: async () => { throw new Error('should not verify'); },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(ran, false);
  assert.match(stdout, /dry-run — would deploy "n" to i-1 over SSM \(OS flavor\)/);
  assert.match(stdout, /sudo -iu clodex/);
  assert.match(stdout, /useradd -m clodex/);
  assert.match(stdout, /<minted-token>/);
  // The real (hex) token must NOT appear — only the placeholder.
  assert.doesNotMatch(stdout, /CLODEX_REMOTE_TOKEN=[0-9a-f]{48}/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy ssm --json: NDJSON preflight/command/marker/verify/context, no token leak', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--json'], {
    execFn: fakeAws({}), probeSsm: async () => ({ app: 'clodex', host: 'n', version: '1.0', caps: [] }), contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(objs.some((o) => o.type === 'preflight' && o.ok));
  assert.ok(objs.some((o) => o.type === 'command' && o.commandId === 'cmd-abc123'));
  // marker trail surfaces as parsed events (one per ^:: line).
  assert.ok(objs.some((o) => o.type === 'step' && o.name === 'prereqs'));
  assert.ok(objs.some((o) => o.type === 'verify' && o.ok && o.host === 'n'));
  assert.deepStrictEqual(objs[objs.length - 1], { type: 'context', action: 'added', name: 'n', webPort: 7901 });
  // No object carries the minted token.
  assert.doesNotMatch(stdout, /[0-9a-f]{48}/);
});

test('deploy ssm: ctx collision kept unless --force', async () => {
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { n: { url: 'http://old' } } }));
  const skip = await cli(['deploy', 'ssm', 'n', '--target', 'i-1'], { execFn: fakeAws({}), probeSsm: async () => ({ app: 'clodex' }), contextsFile });
  assert.strictEqual(skip.code, 0);
  assert.match(skip.stdout, /already exists — kept it/);
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n.url, 'http://old');
  const force = await cli(['deploy', 'ssm', 'n', '--target', 'i-1', '--force'], { execFn: fakeAws({}), probeSsm: async () => ({ app: 'clodex' }), contextsFile });
  assert.strictEqual(force.code, 0);
  assert.match(force.stdout, /context "n" updated/);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.n;
  assert.deepStrictEqual(saved.ssm, { target: 'i-1' });
  assert.match(saved.token, /^[0-9a-f]{48}$/);
});

// ── dispatch: `deploy ssm` routes; `deploy ssh ssm` stays the ssh flavor ──────

test('deploy ssm routes to the ssm flavor', async () => {
  // Missing --target reaches the ssm verb's validator (proves routing).
  const { code, stderr } = await cli(['deploy', 'ssm', 'n'], { execFn: async () => ({ stdout: '{}' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /deploy ssm needs --target/);
});

test('deploy ssh ssm still routes to the ssh flavor (host literally named ssm)', async () => {
  // 'ssm' is the ssh dest here; the ssh verb accepts it and tries to deploy —
  // stub spawnFn so no real ssh runs; a spawn error surfaces as CONNECT, proving
  // it reached the ssh flavor (not the ssm verb, which would need --target).
  const { code } = await cli(['deploy', 'ssh', 'ssm'], {
    spawnFn: () => { const e = new Error('spawn ssh ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.strictEqual(code, EXIT.CONNECT);   // ssh flavor's "could not start ssh"
});
