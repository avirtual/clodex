'use strict';
// undeploy.test.js — `clodexctl undeploy <fargate|helm|docker>`: the destructive
// inverse of deploy. Pure argv builders (no secret ever crosses argv — the flow
// reads none), the shared confirm gate + ctx-cleanup helper, and each flavor's
// full flow through main.run against scripted exec seams (aws/helm/kubectl via
// execFn, docker via runDocker). No live cloud, no real account identifiers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/undeploy');
const { EXIT } = require('../src/errors');
const { run } = require('../src/main');

const ACCT = '000000000000';   // placeholder account — never a real identifier

// ── helpers ──────────────────────────────────────────────────────────────────
async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: io.env || {},
    contextsFile: io.contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl-undeploy', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}
function tmpCtxFile(seed = null) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-undeploy-t-')), 'contexts.json');
  if (seed) fs.writeFileSync(f, JSON.stringify(seed, null, 2));
  return f;
}
// stdin confirm seam: canned answer.
function answering(ans) { return async () => ans; }

// ── pure argv builders ───────────────────────────────────────────────────────

test('fargate argv builders: awsBase order (profile before region), --output json on reads', () => {
  assert.deepStrictEqual(
    U.describeStacksArgs({ stackName: 's', region: 'us-west-2', profile: 'p' }),
    ['aws', '--profile', 'p', '--region', 'us-west-2', 'cloudformation', 'describe-stacks', '--stack-name', 's', '--output', 'json']);
  assert.deepStrictEqual(
    U.describeStackResourcesArgs({ stackName: 's', region: 'us-west-2' }),
    ['aws', '--region', 'us-west-2', 'cloudformation', 'describe-stack-resources', '--stack-name', 's', '--output', 'json']);
  assert.deepStrictEqual(
    U.ecsListTasksArgs({ cluster: 'c', region: 'r' }),
    ['aws', '--region', 'r', 'ecs', 'list-tasks', '--cluster', 'c', '--output', 'json']);
  assert.deepStrictEqual(
    U.ecsDescribeTasksArgs({ cluster: 'c', tasks: ['a', 'b'], region: 'r' }),
    ['aws', '--region', 'r', 'ecs', 'describe-tasks', '--cluster', 'c', '--tasks', 'a', 'b', '--output', 'json']);
  assert.deepStrictEqual(
    U.ecsStopTaskArgs({ cluster: 'c', task: 't', region: 'r' }),
    ['aws', '--region', 'r', 'ecs', 'stop-task', '--cluster', 'c', '--task', 't']);
  assert.deepStrictEqual(
    U.deleteStackArgs({ stackName: 's', region: 'r' }),
    ['aws', '--region', 'r', 'cloudformation', 'delete-stack', '--stack-name', 's']);
  // region/profile omitted → no flags (aws resolves the call itself, deploy parity).
  assert.deepStrictEqual(U.deleteStackArgs({ stackName: 's' }), ['aws', 'cloudformation', 'delete-stack', '--stack-name', 's']);
});

test('helm/kubectl argv builders: verified PVC selector + name', () => {
  assert.deepStrictEqual(
    U.helmGetManifestArgs({ name: 'n', namespace: 'ns', kubeContext: 'c' }),
    ['helm', 'get', 'manifest', 'n', '--namespace', 'ns', '--kube-context', 'c']);
  assert.deepStrictEqual(
    U.helmUninstallArgs({ name: 'n', namespace: 'ns' }),
    ['helm', 'uninstall', 'n', '--namespace', 'ns']);
  assert.deepStrictEqual(
    U.kubectlDeletePvcArgs({ name: 'n', namespace: 'ns', kubeContext: 'c' }),
    ['kubectl', '--context', 'c', '-n', 'ns', 'delete', 'pvc', '-l', 'app.kubernetes.io/instance=n,app.kubernetes.io/name=clodex']);
  assert.strictEqual(U.HELM_PVC_SELECTOR('mynode'), 'app.kubernetes.io/instance=mynode,app.kubernetes.io/name=clodex');
  assert.strictEqual(U.HELM_PVC_NAME('mynode'), 'state-mynode-0');
});

test('docker argv builders: no leading `docker` token (runDocker prepends it)', () => {
  assert.deepStrictEqual(U.dockerInspectArgs({ name: 'mybox' }), ['inspect', 'clodexctl-mybox']);
  assert.deepStrictEqual(U.dockerRmArgs({ name: 'mybox' }), ['rm', '-f', 'clodexctl-mybox']);
  assert.deepStrictEqual(U.dockerVolumeRmArgs({ volume: 'clodexctl-mybox-data' }), ['volume', 'rm', 'clodexctl-mybox-data']);
});

test('isServiceTask: only group "service:*" is service-owned (dies with the stack)', () => {
  assert.ok(U.isServiceTask({ group: 'service:clodex-node-node' }));
  assert.ok(!U.isServiceTask({ group: 'family:clodex-node-node' }));
  assert.ok(!U.isServiceTask({ group: undefined }));
  assert.ok(!U.isServiceTask({}));
});

test('dockerVolumes: named volumes only (Type volume + Name); binds/anon skipped', () => {
  assert.deepStrictEqual(
    U.dockerVolumes({ mounts: [
      { Type: 'volume', Name: 'clodexctl-n-data' },
      { Type: 'bind', Source: '/host' },
      { Type: 'volume' },   // anonymous — no Name
    ] }),
    ['clodexctl-n-data']);
  assert.deepStrictEqual(U.dockerVolumes({ mounts: [] }), []);
});

test('parseManifestKinds: Kind/name from `---`-split helm manifest', () => {
  const m = [
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: mynode\nspec: {}',
    'apiVersion: apps/v1\nkind: StatefulSet\nmetadata:\n  name: mynode\nspec: {}',
  ].join('\n---\n');
  assert.deepStrictEqual(U.parseManifestKinds(m), [
    { kind: 'Service', name: 'mynode' },
    { kind: 'StatefulSet', name: 'mynode' },
  ]);
});

// ── shared: ctxCleanup helper (unit-tested once) ─────────────────────────────

test('ctxCleanup: removes matched contexts, clears current, --keep-ctx skips', () => {
  const lines = [];
  const printer = { line: (s) => lines.push(s), json: () => {} };
  // remove the matched one; current pointed at it → cleared.
  const f = tmpCtxFile({ current: 'a', contexts: { a: { url: 'http://x' }, b: { url: 'http://y' } } });
  U.ctxCleanup({ flags: {}, printer, io: { contextsFile: f }, matchFn: (n) => n === 'a' });
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(Object.keys(after.contexts), ['b']);
  assert.strictEqual(after.current, null);
  assert.match(lines.join('\n'), /removed context "a".*was current — cleared/);

  // --keep-ctx: nothing touched.
  const lines2 = [];
  const printer2 = { line: (s) => lines2.push(s), json: () => {} };
  const f2 = tmpCtxFile({ current: 'a', contexts: { a: { url: 'http://x' } } });
  U.ctxCleanup({ flags: { 'keep-ctx': true }, printer: printer2, io: { contextsFile: f2 }, matchFn: () => true });
  const after2 = JSON.parse(fs.readFileSync(f2, 'utf8'));
  assert.deepStrictEqual(Object.keys(after2.contexts), ['a']);
  assert.match(lines2.join('\n'), /context kept/);
});

// ── dispatcher: ssh/ssm honest USAGE, unknown flavor ─────────────────────────

test('undeploy ssh/ssm → honest USAGE (installer surgery is a separate task)', async () => {
  for (const flavor of ['ssh', 'ssm']) {
    const r = await cli(['undeploy', flavor, 'whatever']);
    assert.strictEqual(r.code, EXIT.USAGE, flavor);
    assert.match(r.stderr, /not yet supported/);
    assert.match(r.stderr, /systemctl --user disable --now clodex\.service/);
  }
});

test('undeploy with no/unknown flavor → USAGE', async () => {
  const r = await cli(['undeploy', 'bogus']);
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.stderr, /needs a flavor/);
});

// ── fargate flow ─────────────────────────────────────────────────────────────

// A scripted aws execFn for undeploy. Records calls; answers describe-stacks,
// describe-stack-resources, list-tasks, describe-tasks, stop-task, delete-stack.
function fakeAws(rec, {
  status = 'CREATE_COMPLETE', clusterParam = 'clodex-node', notFound = false,
  resources = [{ LogicalResourceId: 'Service', ResourceType: 'AWS::ECS::Service' }, { LogicalResourceId: 'Cluster', ResourceType: 'AWS::ECS::Cluster' }],
  taskArns = [], tasks = [],
  // --wait: a queue of statuses to return in sequence for successive describe-stacks
  // (after delete-stack). 'GONE' models the stack having disappeared (aws throws).
  waitStatuses = null,
} = {}) {
  rec.calls = [];
  let deleteRequested = false;
  let waitIdx = 0;
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = cmd + ' ' + args.join(' ');
    if (j.includes('cloudformation describe-stacks')) {
      if (deleteRequested && waitStatuses) {
        const s = waitStatuses[Math.min(waitIdx++, waitStatuses.length - 1)];
        if (s === 'GONE') { const e = new Error('Stack with id does not exist'); e.stderr = 'ValidationError: Stack with id s does not exist'; throw e; }
        return { stdout: JSON.stringify({ Stacks: [{ StackName: 's', StackStatus: s, StackStatusReason: s === 'DELETE_FAILED' ? 'a resource is stuck' : undefined }] }) };
      }
      if (notFound) { const e = new Error('does not exist'); e.stderr = 'ValidationError: Stack with id s does not exist'; throw e; }
      return { stdout: JSON.stringify({ Stacks: [{ StackName: 's', StackStatus: status,
        Parameters: clusterParam ? [{ ParameterKey: 'ClusterName', ParameterValue: clusterParam }] : [] }] }) };
    }
    if (j.includes('describe-stack-resources')) return { stdout: JSON.stringify({ StackResources: resources }) };
    if (j.includes('ecs list-tasks')) return { stdout: JSON.stringify({ taskArns }) };
    if (j.includes('ecs describe-tasks')) return { stdout: JSON.stringify({ tasks }) };
    if (j.includes('ecs stop-task')) return { stdout: JSON.stringify({ task: { taskArn: 't' } }) };
    if (j.includes('cloudformation delete-stack')) { deleteRequested = true; return { stdout: '' }; }
    throw new Error('unexpected aws call: ' + j);
  };
}

test('undeploy fargate: not found → USAGE with region hint', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--region', 'us-west-2', '--force'], { execFn: fakeAws(rec, { notFound: true }) });
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.stderr, /stack "clodex-node" not found in us-west-2/);
  assert.match(r.stderr, /region/);
});

test('undeploy fargate --dry-run: previews + prints every argv, nothing destructive runs', async () => {
  const rec = {};
  const taskArns = ['arn/svc-1', 'arn/stray-1'];
  const tasks = [{ taskArn: 'arn/svc-1', group: 'service:clodex-node-node' }, { taskArn: 'arn/stray-1', group: 'family:x' }];
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--region', 'us-west-2', '--dry-run'], { execFn: fakeAws(rec, { taskArns, tasks }) });
  assert.strictEqual(r.code, 0);
  // preview lists resources + tasks, marks stray vs service.
  assert.match(r.stdout, /teardown preview for stack "clodex-node"/);
  assert.match(r.stdout, /stray — stopped first/);
  assert.match(r.stdout, /service — dies with the stack/);
  // dry-run prints stop-task (only the stray) + delete-stack argv.
  assert.match(r.stdout, /aws --region us-west-2 ecs stop-task --cluster clodex-node --task arn\/stray-1/);
  assert.match(r.stdout, /aws --region us-west-2 cloudformation delete-stack --stack-name clodex-node/);
  assert.doesNotMatch(r.stdout, /stop-task --cluster clodex-node --task arn\/svc-1/);
  // nothing destructive executed.
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('delete-stack')), 'delete-stack not run on dry-run');
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('stop-task')), 'stop-task not run on dry-run');
});

test('undeploy fargate: confirm mismatch → abort USAGE, nothing destructive fired', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--region', 'us-west-2'], {
    execFn: fakeAws(rec), prompt: answering('wrong-name'), isTTY: true,
  });
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.stderr, /confirmation did not match/);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('delete-stack')), 'no delete after aborted confirm');
});

test('undeploy fargate: --json without --force in non-TTY → USAGE (never destroy in a pipe)', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--json'], { execFn: fakeAws(rec) });
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('delete-stack')));
});

test('undeploy fargate --force: stops strays (NOT service tasks), delete-stack, ctx removed', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile({ current: 'clodex-node', contexts: {
    'clodex-node': { ssm: { ecs: 'clodex-node/clodex-node-node', region: 'us-west-2' }, webPort: 8080, token: 'W' },
  } });
  const tasks = [{ taskArn: 'arn/svc-1', group: 'service:clodex-node-node' }, { taskArn: 'arn/stray-1', group: 'family:x' }];
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--force'], {
    execFn: fakeAws(rec, { taskArns: ['arn/svc-1', 'arn/stray-1'], tasks }), contextsFile,
  });
  assert.strictEqual(r.code, 0);
  // region came from the ctx (no flag).
  assert.match(r.stdout, /region: us-west-2 \[ctx "clodex-node"\]/);
  // stray stopped, service NOT.
  const stops = rec.calls.filter((c) => c.join(' ').includes('stop-task'));
  assert.strictEqual(stops.length, 1);
  assert.ok(stops[0].join(' ').includes('arn/stray-1'));
  // delete-stack ran.
  assert.ok(rec.calls.some((c) => c.join(' ').includes('delete-stack --stack-name clodex-node')));
  // no --wait → prints the check hint, does NOT poll after delete.
  assert.match(r.stdout, /deletion started — check:/);
  // ctx removed + current cleared.
  const after = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(after.contexts, {});
  assert.strictEqual(after.current, null);
  // secrets note.
  assert.match(r.stdout, /recovery window/);
});

test('undeploy fargate --keep-ctx: ctx survives', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile({ current: 'clodex-node', contexts: { 'clodex-node': { ssm: { ecs: 'clodex-node/clodex-node-node' }, token: 'W' } } });
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--force', '--keep-ctx', '--region', 'r'], { execFn: fakeAws(rec), contextsFile });
  assert.strictEqual(r.code, 0);
  const after = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.ok(after.contexts['clodex-node'], 'ctx kept');
  assert.match(r.stdout, /context kept/);
});

test('undeploy fargate --wait: polls to DELETE_COMPLETE', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r', '--wait'], {
    execFn: fakeAws(rec, { clusterParam: 's', waitStatuses: ['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'] }),
    sleepFn: async () => {},
  });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /stack deleted \(DELETE_COMPLETE\)/);
});

test('undeploy fargate --wait: gone (describe throws) counts as success', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r', '--wait'], {
    execFn: fakeAws(rec, { clusterParam: 's', waitStatuses: ['GONE'] }), sleepFn: async () => {},
  });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /stack deleted/);
});

test('undeploy fargate --wait: DELETE_FAILED → EXIT.SERVER with the reason', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r', '--wait'], {
    execFn: fakeAws(rec, { clusterParam: 's', waitStatuses: ['DELETE_FAILED'] }), sleepFn: async () => {},
  });
  assert.strictEqual(r.code, EXIT.SERVER);
  assert.match(r.stderr, /delete FAILED: a resource is stuck/);
});

test('undeploy fargate: pre-existing cluster (no ECS::Cluster resource) → not-deleted note', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r', '--keep-ctx'], {
    execFn: fakeAws(rec, { clusterParam: 'shared', resources: [{ LogicalResourceId: 'Service', ResourceType: 'AWS::ECS::Service' }] }),
  });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /cluster "shared" is not an AWS::ECS::Cluster resource of this stack.*will NOT be deleted/s);
});

// MUST-FIX pin (cold review): on a cluster the stack does NOT own, non-service
// tasks are CO-TENANT workloads, not "strays" — the cluster survives the stack
// delete, so they block nothing and must never be stopped.
test('undeploy fargate: unowned cluster → co-tenant tasks NOT stopped (no collateral)', async () => {
  const rec = {};
  const tasks = [{ taskArn: 'arn/tenant-1', group: 'family:someone-elses' }, { taskArn: 'arn/svc-1', group: 'service:s-node' }];
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r', '--keep-ctx'], {
    execFn: fakeAws(rec, {
      clusterParam: 'shared', taskArns: ['arn/tenant-1', 'arn/svc-1'], tasks,
      resources: [{ LogicalResourceId: 'Service', ResourceType: 'AWS::ECS::Service' }],
    }),
  });
  assert.strictEqual(r.code, 0);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('stop-task')), 'no stop-task fires in an unowned cluster');
  assert.ok(rec.calls.some((c) => c.join(' ').includes('delete-stack')), 'the stack itself still goes');
  assert.match(r.stdout, /\[not ours — left alone\]/);
  assert.match(r.stdout, /its tasks are left alone/);
  assert.doesNotMatch(r.stdout, /stray — stopped first/);
});

test('undeploy fargate --dry-run on unowned cluster: no stop-task argv in the plan', async () => {
  const rec = {};
  const tasks = [{ taskArn: 'arn/tenant-1', group: 'family:x' }];
  const r = await cli(['undeploy', 'fargate', 's', '--dry-run', '--region', 'r'], {
    execFn: fakeAws(rec, {
      clusterParam: 'shared', taskArns: ['arn/tenant-1'], tasks,
      resources: [{ LogicalResourceId: 'Service', ResourceType: 'AWS::ECS::Service' }],
    }),
  });
  assert.strictEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, /stop-task/);
  assert.match(r.stdout, /delete-stack/);
});

// NIT pin: cluster-half ctx match must respect a differing pinned region — a
// same-named cluster in another region is a different deployment.
test('undeploy fargate ctx cleanup: same-named cluster in ANOTHER region keeps its ctx', async () => {
  const contextsFile = tmpCtxFile();
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: {
    other: { ssm: { ecs: 'clodex-node/clodex-node-node', region: 'eu-west-1' }, token: 'T' },
    sameRegion: { ssm: { ecs: 'clodex-node/other-family', region: 'us-west-2' }, token: 'T' },
  } }));
  const r = await cli(['undeploy', 'fargate', 'clodex-node', '--force', '--region', 'us-west-2'], {
    execFn: fakeAws({}), contextsFile,
  });
  assert.strictEqual(r.code, 0);
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.ok(saved.contexts.other, 'differing pinned region → ctx kept');
  assert.ok(!saved.contexts.sameRegion, 'matching region cluster-half → removed');
});

// NIT pin: a describe-stacks failure that is NOT a not-found (throttle, expired
// creds) must surface as SERVER, not masquerade as an operator USAGE mistake.
test('undeploy fargate: non-not-found describe-stacks failure → SERVER, not USAGE', async () => {
  const execFn = async () => { const e = new Error('throttled'); e.stderr = 'ThrottlingException: Rate exceeded'; throw e; };
  const r = await cli(['undeploy', 'fargate', 's', '--force', '--region', 'r'], { execFn });
  assert.strictEqual(r.code, EXIT.SERVER);
  assert.doesNotMatch(r.stderr, /not found/);
});

// ── helm flow ────────────────────────────────────────────────────────────────

// A scripted helm/kubectl execFn (execFileP shape: returns {stdout}, throws on fail).
function fakeHelm(rec, { installed = true, manifest = null } = {}) {
  rec.calls = [];
  const m = manifest || 'kind: Service\nmetadata:\n  name: mynode\n---\nkind: StatefulSet\nmetadata:\n  name: mynode';
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = cmd + ' ' + args.join(' ');
    if (j.includes('helm status')) {
      if (!installed) { const e = new Error('not found'); e.stderr = 'Error: release: not found'; throw e; }
      return { stdout: 'STATUS: deployed' };
    }
    if (j.includes('helm get manifest')) return { stdout: m };
    if (j.includes('helm uninstall')) return { stdout: 'release "mynode" uninstalled' };
    if (j.includes('kubectl') && j.includes('delete pvc')) return { stdout: 'persistentvolumeclaim "state-mynode-0" deleted' };
    throw new Error('unexpected helm/kubectl call: ' + j);
  };
}

test('undeploy helm: not found → USAGE with namespace hint', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'helm', 'mynode', '--force'], { execFn: fakeHelm(rec, { installed: false }) });
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.stderr, /release "mynode" not found in namespace "clodex"/);
});

test('undeploy helm --dry-run: previews Kind/name + PVC question, prints argv, nothing destructive', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'helm', 'mynode', '--dry-run'], { execFn: fakeHelm(rec) });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /Service\/mynode/);
  assert.match(r.stdout, /StatefulSet\/mynode/);
  assert.match(r.stdout, /PVC "state-mynode-0".*will be DELETED/);
  assert.match(r.stdout, /helm uninstall mynode --namespace clodex/);
  assert.match(r.stdout, /kubectl -n clodex delete pvc -l app\.kubernetes\.io\/instance=mynode/);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('uninstall')), 'no uninstall on dry-run');
});

test('undeploy helm --force: uninstall + delete PVC with the verified selector, ctx removed', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile({ current: 'mynode', contexts: { mynode: { kubectl: { target: 'svc/mynode', namespace: 'clodex', context: null }, token: 'W' } } });
  const r = await cli(['undeploy', 'helm', 'mynode', '--force'], { execFn: fakeHelm(rec), contextsFile });
  assert.strictEqual(r.code, 0);
  assert.ok(rec.calls.some((c) => c.join(' ').includes('helm uninstall mynode --namespace clodex')));
  const pvcCall = rec.calls.find((c) => c.join(' ').includes('delete pvc'));
  assert.ok(pvcCall.join(' ').includes('-l app.kubernetes.io/instance=mynode,app.kubernetes.io/name=clodex'));
  const after = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(after.contexts, {});
  assert.strictEqual(after.current, null);
});

test('undeploy helm --keep-data: skips the PVC delete, names the kept PVC', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'helm', 'mynode', '--force', '--keep-data', '--keep-ctx'], { execFn: fakeHelm(rec) });
  assert.strictEqual(r.code, 0);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('delete pvc')), 'PVC delete skipped');
  assert.match(r.stdout, /kept PVC "state-mynode-0"/);
});

// ── docker flow ──────────────────────────────────────────────────────────────

// A fake runDocker seam: records argv/env, answers inspect/rm/volume-rm.
function fakeRunDocker(rec, { exists = true, volumes = ['clodexctl-mybox-data'], rmCode = 0, volRmCode = 0 } = {}) {
  rec.calls = [];
  return async ({ args, env }) => {
    rec.calls.push({ args, env });
    const j = args.join(' ');
    if (j.startsWith('inspect')) {
      if (!exists) return { code: 1, stdout: '' };
      return { code: 0, stdout: JSON.stringify([{ Config: { Image: 'ghcr.io/avirtual/clodex:latest' }, State: { Status: 'running' },
        Mounts: volumes.map((v) => ({ Type: 'volume', Name: v })) }]) };
    }
    if (j.startsWith('rm -f')) return { code: rmCode, stdout: 'clodexctl-mybox' };
    if (j.startsWith('volume rm')) return { code: volRmCode, stdout: args[2] };
    throw new Error('unexpected docker call: ' + j);
  };
}

test('undeploy docker: not found → USAGE', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'docker', 'mybox', '--force'], { runDocker: fakeRunDocker(rec, { exists: false }) });
  assert.strictEqual(r.code, EXIT.USAGE);
  assert.match(r.stderr, /container "clodexctl-mybox" not found/);
});

test('undeploy docker --dry-run: previews volumes, prints rm + volume rm argv, nothing destructive', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'docker', 'mybox', '--dry-run'], { runDocker: fakeRunDocker(rec) });
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /named volumes: clodexctl-mybox-data.*will be DELETED/);
  assert.match(r.stdout, /docker rm -f clodexctl-mybox/);
  assert.match(r.stdout, /docker volume rm clodexctl-mybox-data/);
  assert.ok(!rec.calls.some((c) => c.args.join(' ').startsWith('rm -f')), 'no rm on dry-run');
});

test('undeploy docker --force: rm -f + delete named volume, --host sets DOCKER_HOST, ctx removed', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile({ current: 'mybox', contexts: { mybox: { url: 'http://127.0.0.1:7900' } } });
  const r = await cli(['undeploy', 'docker', 'mybox', '--force', '--host', 'ssh://user@box'], { runDocker: fakeRunDocker(rec), contextsFile });
  assert.strictEqual(r.code, 0);
  assert.ok(rec.calls.some((c) => c.args.join(' ') === 'rm -f clodexctl-mybox'));
  assert.ok(rec.calls.some((c) => c.args.join(' ') === 'volume rm clodexctl-mybox-data'));
  // DOCKER_HOST rode the child env.
  assert.ok(rec.calls.every((c) => c.env && c.env.DOCKER_HOST === 'ssh://user@box'), 'DOCKER_HOST set on every call');
  const after = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(after.contexts, {});
});

test('undeploy docker --keep-data: keeps the named volume', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'docker', 'mybox', '--force', '--keep-data', '--keep-ctx'], { runDocker: fakeRunDocker(rec) });
  assert.strictEqual(r.code, 0);
  assert.ok(!rec.calls.some((c) => c.args.join(' ').startsWith('volume rm')), 'volume kept');
  assert.match(r.stdout, /kept named volume\(s\): clodexctl-mybox-data/);
});

// ── TOKEN DISCIPLINE ─────────────────────────────────────────────────────────

test('TOKEN DISCIPLINE: a ctx token never surfaces in argv or output during teardown', async () => {
  const SECRET = 'S'.repeat(48);
  // fargate: the ctx entry carries a token; teardown must never read/print it.
  const recA = {};
  const cfA = tmpCtxFile({ current: 'clodex-node', contexts: { 'clodex-node': { ssm: { ecs: 'clodex-node/clodex-node-node', region: 'us-west-2' }, token: SECRET } } });
  const rA = await cli(['undeploy', 'fargate', 'clodex-node', '--force'], { execFn: fakeAws(recA), contextsFile: cfA });
  assert.strictEqual(rA.code, 0);
  assert.ok(!rA.stdout.includes(SECRET) && !rA.stderr.includes(SECRET), 'token not in fargate output');
  assert.ok(!recA.calls.some((c) => c.some((a) => String(a).includes(SECRET))), 'token not in any aws argv');
  // helm: same guarantee.
  const recH = {};
  const cfH = tmpCtxFile({ current: 'mynode', contexts: { mynode: { kubectl: { target: 'svc/mynode', namespace: 'clodex', context: null }, token: SECRET } } });
  const rH = await cli(['undeploy', 'helm', 'mynode', '--force'], { execFn: fakeHelm(recH), contextsFile: cfH });
  assert.strictEqual(rH.code, 0);
  assert.ok(!rH.stdout.includes(SECRET) && !rH.stderr.includes(SECRET), 'token not in helm output');
  assert.ok(!recH.calls.some((c) => c.some((a) => String(a).includes(SECRET))), 'token not in any helm/kubectl argv');
});

test('undeploy docker: no named volumes → rm only, no volume rm', async () => {
  const rec = {};
  const r = await cli(['undeploy', 'docker', 'mybox', '--force', '--keep-ctx'], { runDocker: fakeRunDocker(rec, { volumes: [] }) });
  assert.strictEqual(r.code, 0);
  assert.ok(rec.calls.some((c) => c.args.join(' ') === 'rm -f clodexctl-mybox'));
  assert.ok(!rec.calls.some((c) => c.args.join(' ').startsWith('volume rm')));
});
