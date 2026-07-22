'use strict';
// cloud-transports.test.js — the four typed cloud transport kinds (ssm, kubectl,
// gcloud, az): pure argv builders (exact snapshots), the ECS derive-at-open
// resolver (fake execFn), openTransport routing (fake spawnFn), validateEntry
// per-kind rules, and ctx add flag→stored-shape round-trips. No real vendor CLI
// is ever invoked — every spawn/exec is injected.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const T = require('../src/transport');
const C = require('../src/contexts');
const { run } = require('../src/main');

// ── argv builders ────────────────────────────────────────────────────────────

test('ssmArgv: target, optional profile/region, JSON parameters valid + shaped', () => {
  const a = T.ssmArgv({ target: 'i-0abc', region: 'us-east-1', profile: 'eng' }, 7900);
  assert.deepStrictEqual(a.slice(0, 8), [
    'aws', '--profile', 'eng', '--region', 'us-east-1', 'ssm', 'start-session', '--target',
  ]);
  assert.strictEqual(a[8], 'i-0abc');
  assert.strictEqual(a[9], '--document-name');
  assert.strictEqual(a[10], 'AWS-StartPortForwardingSession');
  assert.strictEqual(a[11], '--parameters');
  const params = JSON.parse(a[12]);
  assert.deepStrictEqual(params, { portNumber: ['7900'], localPortNumber: ['{port}'] });
});

test('ssmArgv: no profile/region omits those flags; remotePort flows into JSON', () => {
  const a = T.ssmArgv({ target: 'i-x' }, 9000);
  assert.strictEqual(a[0], 'aws');
  assert.ok(!a.includes('--profile') && !a.includes('--region'));
  assert.deepStrictEqual(JSON.parse(a[a.length - 1]), { portNumber: ['9000'], localPortNumber: ['{port}'] });
});

test('kubectlArgv: optional context/namespace, {port}:remote mapping last', () => {
  assert.deepStrictEqual(
    T.kubectlArgv({ target: 'pod/clodex-node-0', namespace: 'cust', context: 'engagement' }, 7900),
    ['kubectl', '--context', 'engagement', '-n', 'cust', 'port-forward', 'pod/clodex-node-0', '{port}:7900'],
  );
  assert.deepStrictEqual(
    T.kubectlArgv({ target: 'svc/x' }, 8080),
    ['kubectl', 'port-forward', 'svc/x', '{port}:8080'],
  );
});

test('gcloudArgv: remote port positional, {port} in --local-host-port', () => {
  assert.deepStrictEqual(
    T.gcloudArgv({ instance: 'clodex-node', zone: 'us-central1-a', project: 'cust-eng' }, 7900),
    ['gcloud', 'compute', 'start-iap-tunnel', 'clodex-node', '7900', '--local-host-port=localhost:{port}', '--zone', 'us-central1-a', '--project', 'cust-eng'],
  );
  assert.deepStrictEqual(
    T.gcloudArgv({ instance: 'n' }, 7900),
    ['gcloud', 'compute', 'start-iap-tunnel', 'n', '7900', '--local-host-port=localhost:{port}'],
  );
});

test('azArgv: all three fields, resource-port remote, --port {port}', () => {
  assert.deepStrictEqual(
    T.azArgv({ bastion: 'cust-bastion', resourceGroup: 'cust-rg', target: '/subscriptions/…/vm1' }, 7900),
    ['az', 'network', 'bastion', 'tunnel', '--name', 'cust-bastion', '--resource-group', 'cust-rg', '--target-resource-id', '/subscriptions/…/vm1', '--resource-port', '7900', '--port', '{port}'],
  );
});

// ── ECS derive-at-open ───────────────────────────────────────────────────────

test('resolveEcsTarget: two aws reads, exact argv, composed ecs: target', async () => {
  const calls = [];
  const execFn = async (cmd, args) => {
    calls.push([cmd, args]);
    if (args.includes('list-tasks')) return { stdout: 'arn:aws:ecs:us-east-1:1:task/CLUSTER/abcdef123\n' };
    if (args.includes('describe-tasks')) return { stdout: 'abcdef123-runtime\n' };
    throw new Error('unexpected');
  };
  const target = await T.resolveEcsTarget('CLUSTER/clodex-node', { region: 'us-east-1', profile: 'eng', execFn });
  assert.strictEqual(target, 'ecs:CLUSTER_abcdef123_abcdef123-runtime');
  // both invocations went through aws with profile+region and the right verbs
  assert.strictEqual(calls[0][0], 'aws');
  assert.deepStrictEqual(calls[0][1].slice(0, 4), ['--profile', 'eng', '--region', 'us-east-1']);
  assert.ok(calls[0][1].includes('list-tasks') && calls[0][1].includes('--family') && calls[0][1].includes('clodex-node'));
  assert.ok(calls[1][1].includes('describe-tasks') && calls[1][1].includes('--tasks') && calls[1][1].includes('abcdef123'));
});

test('resolveEcsTarget: no running task → EXIT.CONNECT with a clear message', async () => {
  const execFn = async () => ({ stdout: 'None\n' });
  await assert.rejects(
    () => T.resolveEcsTarget('C/F', { execFn }),
    (e) => e.exitCode === 3 && /no running task for family F in cluster C/.test(e.message),
  );
});

test('resolveEcsTarget: aws nonzero relays stderr verbatim, EXIT.CONNECT', async () => {
  const execFn = async () => { const e = new Error('exit 255'); e.stderr = 'An error occurred (AccessDenied)'; throw e; };
  await assert.rejects(
    () => T.resolveEcsTarget('C/F', { execFn }),
    (e) => e.exitCode === 3 && /AccessDenied/.test(e.message),
  );
});

test('resolveEcsTarget: missing aws binary → EXIT.CONNECT install hint', async () => {
  const execFn = async () => { const e = new Error('spawn aws ENOENT'); e.code = 'ENOENT'; throw e; };
  await assert.rejects(
    () => T.resolveEcsTarget('C/F', { execFn }),
    (e) => e.exitCode === 3 && /aws CLI not found/.test(e.message),
  );
});

test('parseEcsSpec: exactly one slash, both halves non-empty', () => {
  assert.deepStrictEqual(T.parseEcsSpec('CLUSTER/family'), { cluster: 'CLUSTER', family: 'family' });
  assert.throws(() => T.parseEcsSpec('noslash'), /CLUSTER\/FAMILY/);
  assert.throws(() => T.parseEcsSpec('/family'), /CLUSTER\/FAMILY/);
  assert.throws(() => T.parseEcsSpec('cluster/'), /CLUSTER\/FAMILY/);
  assert.throws(() => T.parseEcsSpec('a/b/c'), /CLUSTER\/FAMILY/);
});

// ── openTransport routing ────────────────────────────────────────────────────

// Fake spawn: records argv, never listens, no pid (teardown no-ops). Port never
// accepts → drive with a tiny deadline and expect the CONNECT timeout, then read
// the recorded argv.
function inspectSpawn(rec) {
  return (cmd, args, opts) => {
    rec.cmd = cmd; rec.args = args; rec.detached = opts && opts.detached;
    const child = new EventEmitter();
    child.pid = null;
    child.stderr = new EventEmitter();
    child.kill = () => { rec.killed = true; };
    return child;
  };
}

async function assertRoutes(ctx, expectCmd, portRe, extra = {}) {
  const rec = {};
  await assert.rejects(
    T.openTransport(ctx, { spawnFn: inspectSpawn(rec), deadlineMs: 200, ...extra }),
    (e) => { assert.strictEqual(e.exitCode, 3); return true; },
  );
  assert.strictEqual(rec.cmd, expectCmd);
  assert.strictEqual(rec.detached, true);
  assert.ok(rec.args.some((a) => portRe.test(a)), `expected a substituted port arg matching ${portRe}, got ${JSON.stringify(rec.args)}`);
  return rec;
}

test('openTransport(ssm target): routes to aws, {port} substituted in parameters', async () => {
  // execFn injected: the ssm failure path now runs the instance post-mortem,
  // which must never reach a real aws CLI from a test.
  const execFn = async () => ({ stdout: '{"InstanceInformationList":[]}' });
  const rec = await assertRoutes({ ssm: { target: 'i-0abc' } }, 'aws', /"localPortNumber":\["\d+"\]/, { execFn });
  assert.ok(rec.args.includes('start-session'));
});

// ── the SSM instance post-mortem (diagnoseSsmInstance) ───────────────────────

test('diagnoseSsmInstance: unregistered instance → gone verdict with redeploy hint', async () => {
  const execFn = async (cmd, args) => {
    assert.strictEqual(cmd, 'aws');
    assert.ok(args.includes('describe-instance-information'));
    return { stdout: '{"InstanceInformationList":[]}' };
  };
  const v = await T.diagnoseSsmInstance({ target: 'i-0dead', execFn });
  assert.match(v, /terminated, stopped, or never had the agent/);
  assert.match(v, /--target i-NEW/);
});

test('diagnoseSsmInstance: Online yet tunnel failed → suspect-the-box verdict', async () => {
  const execFn = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'Online' }] }) });
  const v = await T.diagnoseSsmInstance({ target: 'i-0abc', execFn });
  assert.match(v, /Online, yet the tunnel failed/);
  assert.match(v, /wedged agent|reboot/i);
});

test('diagnoseSsmInstance: ConnectionLost → agent-dead verdict with ping age', async () => {
  const lastPing = Date.now() / 1000 - 45 * 60; // 45 minutes ago
  const execFn = async () => ({ stdout: JSON.stringify({ InstanceInformationList: [{ PingStatus: 'ConnectionLost', LastPingDateTime: lastPing }] }) });
  const v = await T.diagnoseSsmInstance({ target: 'i-0abc', execFn });
  assert.match(v, /ConnectionLost \(last ping 4[45]m ago\)/);
  assert.match(v, /Reboot it, or redeploy/);
});

test('diagnoseSsmInstance: best-effort — aws failure or a non-instance target → null', async () => {
  const boom = async () => { throw new Error('no credentials'); };
  assert.strictEqual(await T.diagnoseSsmInstance({ target: 'i-0abc', execFn: boom }), null);
  assert.strictEqual(await T.diagnoseSsmInstance({ target: 'ecs:c_t_r', execFn: async () => ({ stdout: '{}' }) }), null);
  assert.strictEqual(await T.diagnoseSsmInstance({ target: '', execFn: async () => ({ stdout: '{}' }) }), null);
});

test('openTransport(ssm): a failed open appends the post-mortem verdict to the error', async () => {
  const rec = {};
  const execFn = async () => ({ stdout: '{"InstanceInformationList":[]}' });
  await assert.rejects(
    T.openTransport({ ssm: { target: 'i-0dead' } }, { spawnFn: inspectSpawn(rec), execFn, deadlineMs: 200 }),
    (e) => e.exitCode === 3 && /did not open a local port/.test(e.message) && /terminated, stopped/.test(e.message),
  );
});

test('openTransport(kubectl): routes to kubectl, {port}:7900 substituted', async () => {
  await assertRoutes({ kubectl: { target: 'pod/x' } }, 'kubectl', /^\d+:7900$/);
});

test('openTransport(gcloud): routes to gcloud, {port} in local-host-port', async () => {
  await assertRoutes({ gcloud: { instance: 'n' } }, 'gcloud', /^--local-host-port=localhost:\d+$/);
});

test('openTransport(az): routes to az, --port <substituted>', async () => {
  const rec = await assertRoutes({ az: { bastion: 'b', resourceGroup: 'g', target: 't' } }, 'az', /^\d+$/);
  assert.ok(rec.args.includes('--port'));
});

test('openTransport(ssm ecs): resolves the target first, then spawns aws with it', async () => {
  const rec = {};
  const execFn = async (cmd, args) => {
    if (args.includes('list-tasks')) return { stdout: 'arn/CLUSTER/tid9\n' };
    return { stdout: 'rt9\n' };
  };
  await assert.rejects(
    T.openTransport({ ssm: { ecs: 'CLUSTER/fam' } }, { spawnFn: inspectSpawn(rec), execFn, deadlineMs: 200 }),
    (e) => { assert.strictEqual(e.exitCode, 3); return true; },
  );
  assert.strictEqual(rec.cmd, 'aws');
  const ti = rec.args.indexOf('--target');
  assert.strictEqual(rec.args[ti + 1], 'ecs:CLUSTER_tid9_rt9');
});

test('openTransport(ssm ecs): a resolve failure propagates (no spawn)', async () => {
  let spawned = false;
  const execFn = async () => ({ stdout: 'None' });
  await assert.rejects(
    T.openTransport({ ssm: { ecs: 'C/F' } }, { spawnFn: () => { spawned = true; throw new Error('x'); }, execFn, deadlineMs: 200 }),
    (e) => e.exitCode === 3 && /no running task/.test(e.message),
  );
  assert.strictEqual(spawned, false);
});

test('openTransport: remotePort sibling flows into the built argv', async () => {
  await assertRoutes({ kubectl: { target: 'pod/x' }, remotePort: 8100 }, 'kubectl', /^\d+:8100$/);
});

// ── validateEntry ────────────────────────────────────────────────────────────

test('validateEntry: each cloud kind accepted', () => {
  C.validateEntry({ ssm: { target: 'i-x' } });
  C.validateEntry({ ssm: { ecs: 'C/F' } });
  C.validateEntry({ kubectl: { target: 'pod/x' } });
  C.validateEntry({ gcloud: { instance: 'n' } });
  C.validateEntry({ az: { bastion: 'b', resourceGroup: 'g', target: 't' } });
});

test('validateEntry: conflicting transports rejected with the kinds listed', () => {
  assert.throws(() => C.validateEntry({ ssh: 'x', kubectl: { target: 'p' } }), /conflicting transports \(ssh, kubectl\)/);
  assert.throws(() => C.validateEntry({ url: 'http://h', ssm: { target: 'i' } }), /conflicting transports \(url, ssm\)/);
});

test('validateEntry: ssm needs exactly one of target|ecs', () => {
  assert.throws(() => C.validateEntry({ ssm: {} }), /one of --ssm TARGET or --ssm-ecs/);
  assert.throws(() => C.validateEntry({ ssm: { target: 'i', ecs: 'C/F' } }), /exactly one of --ssm \/ --ssm-ecs/);
});

test('validateEntry: ssm ecs spec parse enforced at add time', () => {
  assert.throws(() => C.validateEntry({ ssm: { ecs: 'noslash' } }), /CLUSTER\/FAMILY/);
});

test('validateEntry: az names each missing field', () => {
  assert.throws(() => C.validateEntry({ az: { bastion: 'b' } }), /--az-resource-group, --az-target/);
  assert.throws(() => C.validateEntry({ az: { bastion: 'b', target: 't' } }), /--az-resource-group/);
});

test('validateEntry: kubectl/gcloud require their core field', () => {
  assert.throws(() => C.validateEntry({ kubectl: {} }), /--kubectl/);
  assert.throws(() => C.validateEntry({ gcloud: {} }), /--gcloud-iap/);
});

test('validateEntry: unknown sibling fields inside a kind are ignored (forward compat)', () => {
  C.validateEntry({ kubectl: { target: 'pod/x', futureField: 'ok' } });
  C.validateEntry({ ssm: { target: 'i', somethingNew: 1 } });
});

// ── ctx add flag → stored shape ──────────────────────────────────────────────

function tmpCtxFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-cloud-'));
  return path.join(dir, 'contexts.json');
}
async function cli(argv, contextsFile) {
  let stdout = '', stderr = '';
  const code = await run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env: {}, contextsFile });
  return { code, stdout, stderr };
}

test('ctx add --ssm: stored shape round-trip', async () => {
  const f = tmpCtxFile();
  const { code } = await cli(['ctx', 'add', 'ec2ssm', '--ssm', 'i-0abc', '--region', 'us-east-1', '--profile', 'eng', '--token', 'sek'], f);
  assert.strictEqual(code, 0);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.ec2ssm, { ssm: { target: 'i-0abc', region: 'us-east-1', profile: 'eng' }, token: 'sek' });
});

test('ctx add --ssm-ecs: stored shape, ecs spec kept for connect-time resolve', async () => {
  const f = tmpCtxFile();
  const { code } = await cli(['ctx', 'add', 'fargate', '--ssm-ecs', 'CLUSTER/clodex-node', '--region', 'us-west-2'], f);
  assert.strictEqual(code, 0);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.fargate, { ssm: { ecs: 'CLUSTER/clodex-node', region: 'us-west-2' } });
});

test('ctx add --ssm + --ssm-ecs: mutually exclusive', async () => {
  const f = tmpCtxFile();
  const { code, stderr } = await cli(['ctx', 'add', 'x', '--ssm', 'i', '--ssm-ecs', 'C/F'], f);
  assert.strictEqual(code, 2);
  assert.match(stderr, /mutually exclusive/);
});

test('ctx add --kubectl: stored shape with namespace + kube-context', async () => {
  const f = tmpCtxFile();
  await cli(['ctx', 'add', 'k8s', '--kubectl', 'pod/clodex-node-0', '--namespace', 'cust', '--kube-context', 'engagement'], f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.k8s, { kubectl: { target: 'pod/clodex-node-0', namespace: 'cust', context: 'engagement' } });
});

test('ctx add --gcloud-iap: stored shape', async () => {
  const f = tmpCtxFile();
  await cli(['ctx', 'add', 'gcp', '--gcloud-iap', 'clodex-node', '--zone', 'us-central1-a', '--project', 'cust-eng'], f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.gcp, { gcloud: { instance: 'clodex-node', zone: 'us-central1-a', project: 'cust-eng' } });
});

test('ctx add --az-bastion: stored shape, all three fields', async () => {
  const f = tmpCtxFile();
  await cli(['ctx', 'add', 'azvm', '--az-bastion', 'cust-bastion', '--az-resource-group', 'cust-rg', '--az-target', '/subscriptions/s/vm1'], f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(saved.contexts.azvm, { az: { bastion: 'cust-bastion', resourceGroup: 'cust-rg', target: '/subscriptions/s/vm1' } });
});

test('ctx add --az-bastion missing a field: usage error names it', async () => {
  const f = tmpCtxFile();
  const { code, stderr } = await cli(['ctx', 'add', 'azvm', '--az-bastion', 'b', '--az-target', 't'], f);
  assert.strictEqual(code, 2);
  assert.match(stderr, /--az-resource-group/);
});

// ── ctx list / show honest rendering ─────────────────────────────────────────

test('ctx list / show: honest per-kind target rendering', async () => {
  const f = tmpCtxFile();
  await cli(['ctx', 'add', 'ec2ssm', '--ssm', 'i-0abc123', '--region', 'us-east-1'], f);
  await cli(['ctx', 'add', 'fargate', '--ssm-ecs', 'CLUSTER/clodex-node'], f);
  await cli(['ctx', 'add', 'k8s', '--kubectl', 'pod/clodex-node-0', '--namespace', 'cust'], f);
  await cli(['ctx', 'add', 'gcp', '--gcloud-iap', 'clodex-node', '--zone', 'us-central1-a'], f);
  await cli(['ctx', 'add', 'azvm', '--az-bastion', 'cust-bastion', '--az-resource-group', 'g', '--az-target', '/subscriptions/s/virtualMachines/vm1'], f);
  const list = await cli(['ctx', 'list'], f);
  assert.match(list.stdout, /ec2ssm\s+ssm\s+i-0abc123 \(us-east-1\)/);
  assert.match(list.stdout, /fargate\s+ssm\s+ecs CLUSTER\/clodex-node \(resolved at connect\)/);
  assert.match(list.stdout, /k8s\s+kubectl\s+pod\/clodex-node-0 -n cust/);
  assert.match(list.stdout, /gcp\s+gcloud\s+clodex-node \(us-central1-a\)/);
  assert.match(list.stdout, /azvm\s+az\s+cust-bastion → vm1/);
  const show = await cli(['ctx', 'show', 'fargate'], f);
  assert.match(show.stdout, /kind        ssm/);
  assert.match(show.stdout, /target      ecs CLUSTER\/clodex-node \(resolved at connect\)/);
});
