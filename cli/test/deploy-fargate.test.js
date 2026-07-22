'use strict';
// deploy-fargate.test.js — the `deploy fargate <stack>` flavor: one command
// from the packaged CloudFormation template to a verified Fargate node. Pure
// argv builders (secret VALUES never in argv), stack-name validation, the
// ClusterName-defaults-to-stack rule, the Bedrock skip-oauth branch, the
// wire-token-into-memory read, ctx-entry shape, dry-run byte pins, the
// re-run/no-fail-on-empty-changeset idempotence, and the verify-failure exit —
// all against a scripted execFn (aws is never really spawned) and an injected
// io.probeFargate (no SSM tunnel is ever opened). No live AWS, no real account
// identifiers (an all-zeros placeholder stands in).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/deploy');
const { EXIT } = require('../src/errors');
const { run } = require('../src/main');

const ACCT = '000000000000';   // placeholder account — never a real identifier
const WIRE = 'W'.repeat(48);   // the stack's minted wire token (get-secret-value)

// ── pure builders ────────────────────────────────────────────────────────────

test('fargateTemplatePath: resolves to the packaged template (file exists)', () => {
  assert.ok(fs.existsSync(D.fargateTemplatePath()));
  assert.match(D.fargateTemplatePath(), /cli[/\\]deploy[/\\]clodex-fargate\.yaml$/);
});

test('fargateParamOverrides: ClusterName+Persistent always; the rest only when given', () => {
  // minimal: cluster defaults to the stack name, Persistent defaults false here
  // (the caller passes the resolved bool), nothing else.
  assert.deepStrictEqual(
    D.fargateParamOverrides({ stackName: 'clodex-node', persistent: false }),
    ['ClusterName=clodex-node', 'Persistent=false']);
  // full: explicit cluster wins; every optional appears once, params trail.
  assert.deepStrictEqual(
    D.fargateParamOverrides({
      stackName: 's', cluster: 'my-cluster', image: 'repo@sha256:abc', useBedrock: true,
      noWirescope: true, assignPublicIp: 'DISABLED', subnets: 'subnet-a,subnet-b',
      securityGroup: 'sg-1', persistent: true, params: ['Cpu=2048', 'Memory=8192'],
    }),
    ['ClusterName=my-cluster', 'Persistent=true', 'ImageUri=repo@sha256:abc',
     'UseBedrock=true', 'DisableWirescope=true', 'AssignPublicIp=DISABLED',
     'SubnetIds=subnet-a,subnet-b', 'SecurityGroupId=sg-1', 'Cpu=2048', 'Memory=8192']);
  // no useBedrock/noWirescope → those flags absent (not '=false').
  const j = D.fargateParamOverrides({ stackName: 's', persistent: true }).join(' ');
  assert.doesNotMatch(j, /UseBedrock/);
  assert.doesNotMatch(j, /DisableWirescope/);
});

test('fargateDeployArgs: exact argv — capabilities, no-fail-on-empty-changeset, param overrides last', () => {
  const a = D.fargateDeployArgs({
    stackName: 's', templateFile: '/pkg/clodex-fargate.yaml', region: 'us-west-2',
    paramOverrides: ['ClusterName=s', 'Persistent=true'],
  });
  assert.deepStrictEqual(a, [
    'aws', '--region', 'us-west-2',
    'cloudformation', 'deploy',
    '--stack-name', 's',
    '--template-file', '/pkg/clodex-fargate.yaml',
    '--capabilities', 'CAPABILITY_IAM',
    '--no-fail-on-empty-changeset',
    '--parameter-overrides', 'ClusterName=s', 'Persistent=true',
  ]);
  // no overrides → no --parameter-overrides flag at all.
  const b = D.fargateDeployArgs({ stackName: 's', templateFile: '/t', paramOverrides: [] });
  assert.doesNotMatch(b.join(' '), /--parameter-overrides/);
  // profile before region (awsBase order).
  const c = D.fargateDeployArgs({ stackName: 's', templateFile: '/t', region: 'r', profile: 'p' });
  assert.ok(c.indexOf('--profile') < c.indexOf('--region'));
});

test('fargate secret argv: file:// for oauth (path only), get for the wire token', () => {
  assert.deepStrictEqual(
    D.fargatePutOauthArgs({ stackName: 's', tokenFile: '/tmp/tok' }),
    ['aws', 'secretsmanager', 'put-secret-value', '--secret-id', 's/oauth-token',
     '--secret-string', 'file:///tmp/tok']);
  assert.deepStrictEqual(
    D.fargateGetWireTokenArgs({ stackName: 's', region: 'r' }),
    ['aws', '--region', 'r', 'secretsmanager', 'get-secret-value',
     '--secret-id', 's/wire-token', '--query', 'SecretString', '--output', 'text']);
});

test('parseStackOutputs: Outputs array → map; junk → {}', () => {
  const j = JSON.stringify([
    { OutputKey: 'CtxAddCommand', OutputValue: 'clodexctl ctx add …' },
    { OutputKey: 'RunTaskCommand', OutputValue: 'aws ecs run-task …' },
  ]);
  assert.deepStrictEqual(D.parseStackOutputs(j), { CtxAddCommand: 'clodexctl ctx add …', RunTaskCommand: 'aws ecs run-task …' });
  assert.deepStrictEqual(D.parseStackOutputs('not json'), {});
  assert.deepStrictEqual(D.parseStackOutputs('{}'), {});
});

test('parseBoolFlag: true/false/1/0; anything else → USAGE', () => {
  assert.strictEqual(D.parseBoolFlag('true', 'persistent'), true);
  assert.strictEqual(D.parseBoolFlag('1', 'persistent'), true);
  assert.strictEqual(D.parseBoolFlag('false', 'persistent'), false);
  assert.strictEqual(D.parseBoolFlag('0', 'persistent'), false);
  assert.throws(() => D.parseBoolFlag('yes', 'persistent'), /must be true or false/);
});

test('FARGATE_STACK_RE: CFN stack names — letter start, hyphens ok, no dots/underscores', () => {
  for (const ok of ['a', 'clodex', 'clodex-node', 'Node-1']) assert.ok(D.FARGATE_STACK_RE.test(ok), ok);
  for (const bad of ['1node', '-node', 'a_b', 'my.node', '', 'a'.repeat(129)]) {
    assert.ok(!D.FARGATE_STACK_RE.test(bad), `should reject "${bad}"`);
  }
  assert.ok(D.FARGATE_STACK_RE.test('a'.repeat(128)));
});

// ── flow: scripted execFn (aws) ──────────────────────────────────────────────

// A scripted aws execFn. Records every call; answers the four aws invocations
// the verb makes (sts get-caller-identity, cloudformation deploy, describe-
// stacks, secretsmanager get/put). `wire` is what get-secret-value returns;
// override individual steps to fail via the *Fail hooks.
function fakeAws(rec, {
  wire = WIRE, outputs = null, deployFail = null, getWireFail = null, putFail = null, idFail = null,
  // default-VPC networking (T53): what the ec2 describe-* calls answer. Defaults
  // are a clean default VPC (two default-for-az subnets, a factory-empty SG) so
  // pre-existing flow tests that omit --subnets/--security-group keep passing.
  vpc = 'vpc-default', subnets = ['subnet-b', 'subnet-a'], sg = 'sg-default', sgInbound = [],
  vpcFail = null, subnetsFail = null, sgFail = null,
} = {}) {
  rec.calls = [];
  const outs = outputs || [
    { OutputKey: 'RunTaskCommand', OutputValue: 'aws ecs run-task --cluster CL …' },
    { OutputKey: 'PutTokenCommand', OutputValue: 'aws secretsmanager put-secret-value --secret-id S/oauth-token …' },
  ];
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = cmd + ' ' + args.join(' ');
    if (j.includes('ec2 describe-vpcs')) {
      if (vpcFail) { const e = new Error('vpc failed'); e.stderr = vpcFail; throw e; }
      return { stdout: (vpc || '') + '\n' };   // --output text: id or empty when none
    }
    if (j.includes('ec2 describe-subnets')) {
      if (subnetsFail) { const e = new Error('subnets failed'); e.stderr = subnetsFail; throw e; }
      return { stdout: (subnets || []).join('\t') + '\n' };   // --output text: tab-separated
    }
    if (j.includes('ec2 describe-security-groups')) {
      if (sgFail) { const e = new Error('sg failed'); e.stderr = sgFail; throw e; }
      return { stdout: JSON.stringify({ SecurityGroups: sg ? [{ GroupId: sg, IpPermissions: sgInbound }] : [] }) };
    }
    if (j.includes('sts get-caller-identity')) {
      if (idFail) { const e = new Error('id failed'); e.stderr = idFail; throw e; }
      return { stdout: JSON.stringify({ Account: ACCT, Arn: `arn:aws:iam::${ACCT}:user/op`, UserId: 'AIDA' }) };
    }
    if (j.includes('cloudformation deploy')) {
      if (deployFail) { const e = new Error('deploy failed'); e.stderr = deployFail; throw e; }
      return { stdout: 'Successfully created/updated stack' };
    }
    if (j.includes('cloudformation describe-stacks')) {
      return { stdout: JSON.stringify(outs) };
    }
    if (j.includes('secretsmanager get-secret-value')) {
      if (getWireFail) { const e = new Error('get failed'); e.stderr = getWireFail; throw e; }
      return { stdout: wire + '\n' };   // real get-secret-value --output text has a trailing newline
    }
    if (j.includes('secretsmanager put-secret-value')) {
      if (putFail) { const e = new Error('put failed'); e.stderr = putFail; throw e; }
      return { stdout: JSON.stringify({ VersionId: 'v1' }) };
    }
    throw new Error('unexpected aws call: ' + j);
  };
}

async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: io.env || {},
    contextsFile: io.contextsFile || path.join(os.tmpdir(), 'nonexistent-clodexctl', 'contexts.json'),
    ...io,
  });
  return { code, stdout, stderr };
}
function tmpCtxFile() { return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-fargate-t-')), 'contexts.json'); }
function tokenFile(body = 'sk-oauth-secret\n') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-fargate-tok-'));
  const tf = path.join(dir, 'tok'); fs.writeFileSync(tf, body); return tf;
}

test('deploy fargate happy path: preflight→deploy→oauth→wire-token→ctx→verify', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const tf = tokenFile();
  let verifiedWith = null;
  const { code, stdout } = await cli(['deploy', 'fargate', 'clodex-node', '--region', 'us-west-2', '--token-file', tf], {
    execFn: fakeAws(rec),
    probeFargate: async (entry, token) => { verifiedWith = { entry, token }; return { app: 'clodex', host: 'node', version: '9.9.9', caps: [] }; },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  // preflight echoed identity (account+arn), never a secret.
  assert.match(stdout, new RegExp(`identity: account ${ACCT}`));
  assert.match(stdout, /context "clodex-node" saved/);
  assert.match(stdout, /verified — clodex host=node version=9\.9\.9/);
  // the deploy argv: packaged template, ClusterName defaults to the stack, and
  // the wire token VALUE appears NOWHERE in any argv.
  const deployCall = rec.calls.find((c) => c.join(' ').includes('cloudformation deploy'));
  assert.ok(deployCall.includes(D.fargateTemplatePath()), 'packaged template path');
  assert.ok(deployCall.includes('ClusterName=clodex-node'), 'ClusterName defaults to stack');
  assert.ok(deployCall.includes('Persistent=true'), 'default persistent');
  assert.ok(!rec.calls.some((c) => c.some((a) => String(a).includes(WIRE))), 'wire token value never in argv');
  assert.ok(!stdout.includes(WIRE), 'wire token value never in output');
  // oauth put used file:// (only the PATH crosses argv), never the secret value.
  const putCall = rec.calls.find((c) => c.join(' ').includes('put-secret-value'));
  assert.ok(putCall.includes(`file://${path.resolve(tf)}`), 'oauth rides file://');
  assert.ok(!putCall.some((a) => String(a).includes('sk-oauth-secret')), 'oauth value never in argv');
  // verify used the ssm-ecs entry + the stack's (trimmed) wire token.
  assert.deepStrictEqual(verifiedWith.entry.ssm, { ecs: 'clodex-node/clodex-node-node', region: 'us-west-2' });
  assert.strictEqual(verifiedWith.token, WIRE);
  // saved ctx: ssm-ecs kind, token, no stray fields.
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts['clodex-node'], {
    ssm: { ecs: 'clodex-node/clodex-node-node', region: 'us-west-2' },
    token: WIRE,
  });
  assert.strictEqual(saved.current, 'clodex-node');
  // only aws was ever exec'd.
  assert.ok(!rec.calls.some(([c]) => c !== 'aws'), 'only aws called');
});

test('deploy fargate: --cluster overrides the default; --profile flows through', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  const { code } = await cli(['deploy', 'fargate', 's', '--cluster', 'shared', '--profile', 'prod', '--use-bedrock'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(code, 0);
  const deployCall = rec.calls.find((c) => c.join(' ').includes('cloudformation deploy'));
  assert.ok(deployCall.includes('ClusterName=shared'));
  assert.ok(deployCall.includes('--profile') && deployCall.includes('prod'));
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.deepStrictEqual(saved.contexts.s.ssm, { ecs: 'shared/s-node', profile: 'prod' });
});

test('deploy fargate --use-bedrock: NO oauth secret is touched (put-secret-value never runs)', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.ok(deployHasParam(rec, 'UseBedrock=true'));
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('put-secret-value')), 'no oauth put on Bedrock');
  // no "no claude token" warning either — Bedrock has no oauth secret.
  assert.doesNotMatch(stdout, /no claude token/i);
});

test('deploy fargate: no token file (non-Bedrock) → LOUD warn + manual PutTokenCommand, deploy still succeeds', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--no-ctx'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /WARNING: no claude token/);
  assert.match(stdout, /put-secret-value --secret-id S\/oauth-token/);   // the stack's PutTokenCommand
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('put-secret-value')), 'nothing put when no file');
  assert.match(stdout, /verified/);
});

test('deploy fargate: CLODEX_CLAUDE_TOKEN_FILE env supplies the token file', async () => {
  const rec = {};
  const tf = tokenFile();
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--no-ctx'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
    env: { CLODEX_CLAUDE_TOKEN_FILE: tf },
  });
  assert.strictEqual(code, 0);
  const putCall = rec.calls.find((c) => c.join(' ').includes('put-secret-value'));
  assert.ok(putCall.includes(`file://${path.resolve(tf)}`));
  assert.doesNotMatch(stdout, /WARNING: no claude token/);
});

test('deploy fargate: a missing --token-file fails fast (USAGE) before any AWS call', async () => {
  let ran = false;
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--token-file', '/no/such/token'], {
    execFn: async () => { ran = true; return { stdout: '' }; },
    probeFargate: async () => ({}),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /--token-file not found/);
  assert.strictEqual(ran, false);
});

test('deploy fargate --persistent false: infra only — prints RunTaskCommand, SKIPS verify', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  let probed = false;
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--persistent', 'false', '--use-bedrock'], {
    execFn: fakeAws(rec), probeFargate: async () => { probed = true; return {}; }, contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(probed, false, 'verify skipped for a non-persistent stack');
  assert.ok(deployHasParam(rec, 'Persistent=false'));
  assert.match(stdout, /infrastructure deployed \(Persistent=false\)/);
  assert.match(stdout, /aws ecs run-task/);
  // ctx still saved BEFORE the (skipped) verify.
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.ok(saved.contexts.s.ssm);
});

test('deploy fargate: re-run is an idempotent update — --no-fail-on-empty-changeset, wire token NEVER re-put', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: 's', contexts: { s: { ssm: { ecs: 's/s-node' }, token: WIRE } } }));
  const { code } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--force'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(code, 0);
  const deployCall = rec.calls.find((c) => c.join(' ').includes('cloudformation deploy'));
  assert.ok(deployCall.includes('--no-fail-on-empty-changeset'), 'no-change re-run is green');
  // the wire token is READ (get) but NEVER written — the stack owns it, no rotation.
  assert.ok(rec.calls.some((c) => c.join(' ').includes('get-secret-value') && c.join(' ').includes('wire-token')));
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('put-secret-value') && c.join(' ').includes('wire-token')), 'wire token never rotated');
});

test('deploy fargate --dry-run: plan only — deploy/put/get argv with a file:// placeholder, nothing runs', async () => {
  let ran = false;
  const contextsFile = tmpCtxFile();
  const tf = tokenFile();
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--region', 'eu-west-1', '--token-file', tf,
    '--subnets', 'subnet-x', '--security-group', 'sg-x', '--dry-run'], {
    execFn: async () => { ran = true; return { stdout: '' }; },
    probeFargate: async () => { throw new Error('should not verify'); },
    contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.strictEqual(ran, false);
  assert.match(stdout, /dry-run — would deploy the Fargate stack "s"/);
  assert.match(stdout, new RegExp(D.fargateTemplatePath().replace(/[/\\.]/g, '.')));
  assert.match(stdout, /ClusterName=s Persistent=true/);
  assert.match(stdout, /put-secret-value --secret-id s\/oauth-token --secret-string file:\/\/<oauth-token-file>/);
  assert.match(stdout, /get-secret-value --secret-id s\/wire-token/);
  assert.match(stdout, /context s \(ssm-ecs s\/s-node/);
  // the real token file path is NOT leaked into the dry-run (placeholder only).
  assert.doesNotMatch(stdout, new RegExp(path.resolve(tf).replace(/[/\\.]/g, '.')));
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy fargate: the wire token value never rides the dry-run (no fetch happens at all)', async () => {
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--subnets', 'subnet-x', '--security-group', 'sg-x', '--dry-run'], {
    execFn: async () => { throw new Error('nothing runs on --dry-run'); },
    probeFargate: async () => ({}),
  });
  assert.strictEqual(code, 0);
  assert.doesNotMatch(stdout, /[A-Z]{48}/);   // the placeholder WIRE shape never appears
});

test('deploy fargate: verify failure → nonzero exit; ctx already saved, message points at ctx test', async () => {
  const { CliError } = require('../src/errors');
  const contextsFile = tmpCtxFile();
  const { code, stdout, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock'], {
    execFn: fakeAws({}),
    probeFargate: async () => { throw new CliError(EXIT.CONNECT, 'no running task for family s-node'); },
    contextsFile,
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stdout, /did not answer over the SSM tunnel/);
  assert.match(stderr, /context was saved.*ctx test --verbose/);
  assert.doesNotMatch(stderr, /[A-Z]{48}/);   // token never rides the error
  // ctx upsert happened BEFORE verify — the stack is live, keep the handle.
  const saved = JSON.parse(fs.readFileSync(contextsFile, 'utf8'));
  assert.ok(saved.contexts.s.ssm);
});

test('deploy fargate: verify failure with a SKIPPED ctx (collision, no --force) says NOT saved', async () => {
  const { CliError } = require('../src/errors');
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { s: { url: 'http://old' } } }));
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock'], {
    execFn: fakeAws({}),
    probeFargate: async () => { throw new CliError(EXIT.CONNECT, 'no running task'); },
    contextsFile,
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /context was NOT saved/);
  assert.match(stderr, /--force/);
  assert.doesNotMatch(stderr, /context was saved/);
  // the old entry is untouched.
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.s.url, 'http://old');
});

test('deploy fargate --no-ctx: verifies but saves nothing', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws({}), probeFargate: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout, /verified/);
  assert.doesNotMatch(stdout, /context .* saved/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy fargate: ctx collision kept unless --force (verify still runs on the fresh entry)', async () => {
  const contextsFile = tmpCtxFile();
  fs.mkdirSync(path.dirname(contextsFile), { recursive: true });
  fs.writeFileSync(contextsFile, JSON.stringify({ current: null, contexts: { s: { url: 'http://old' } } }));
  let probed = 0;
  const skip = await cli(['deploy', 'fargate', 's', '--use-bedrock'], {
    execFn: fakeAws({}), probeFargate: async () => { probed++; return { app: 'clodex' }; }, contextsFile,
  });
  assert.strictEqual(skip.code, 0);
  assert.match(skip.stdout, /already exists — kept it/);
  assert.strictEqual(probed, 1);   // verify ran against the fresh entry regardless
  assert.strictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.s.url, 'http://old');
  const force = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--force'], {
    execFn: fakeAws({}), probeFargate: async () => ({ app: 'clodex' }), contextsFile,
  });
  assert.strictEqual(force.code, 0);
  assert.match(force.stdout, /context "s" updated/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(contextsFile, 'utf8')).contexts.s.ssm, { ecs: 's/s-node' });
});

test('deploy fargate --json: NDJSON step/ok + context + verify, no token leak', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--json'], {
    execFn: fakeAws({}), probeFargate: async () => ({ app: 'clodex', host: 's', version: '1.0', caps: [] }), contextsFile,
  });
  assert.strictEqual(code, 0);
  const objs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  for (const n of ['preflight', 'template', 'wire-token', 'verify']) {
    assert.ok(objs.some((o) => o.type === 'step' && o.name === n), `step ${n}`);
    assert.ok(objs.some((o) => o.type === 'ok' && o.name === n), `ok ${n}`);
  }
  assert.ok(objs.some((o) => o.type === 'context' && o.action === 'added' && o.name === 's'));
  assert.deepStrictEqual(objs[objs.length - 1], { type: 'verify', ok: true, host: 's', version: '1.0', caps: [] });
  assert.doesNotMatch(stdout, /[A-Z]{48}/);
});

test('deploy fargate: the stack wire token being empty/malformed → SERVER, no ctx/verify', async () => {
  const contextsFile = tmpCtxFile();
  let probed = false;
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock'], {
    execFn: fakeAws({}, { wire: '   ' }),   // whitespace-only → malformed
    probeFargate: async () => { probed = true; return {}; }, contextsFile,
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stderr, /wire token.*empty or malformed/);
  assert.strictEqual(probed, false);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy fargate: cloudformation deploy failure → SERVER with aws stderr, nothing downstream', async () => {
  const contextsFile = tmpCtxFile();
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock'], {
    execFn: fakeAws({}, { deployFail: 'ROLLBACK_COMPLETE: resource X failed' }),
    probeFargate: async () => { throw new Error('should not verify'); }, contextsFile,
  });
  assert.strictEqual(code, EXIT.SERVER);
  assert.match(stderr, /cloudformation deploy failed/);
  assert.match(stderr, /ROLLBACK_COMPLETE/);
  assert.strictEqual(fs.existsSync(contextsFile), false);
});

test('deploy fargate: --param validates KEY=VALUE; a bad token → USAGE before any AWS call', async () => {
  let ran = false;
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--param', 'not-a-pair'], {
    execFn: async () => { ran = true; return { stdout: '' }; }, probeFargate: async () => ({}),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /bad --param/);
  assert.strictEqual(ran, false);
});

test('deploy fargate: --assign-public-ip rejects a non-ENABLED/DISABLED value', async () => {
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--assign-public-ip', 'yes'], {
    execFn: async () => ({ stdout: '' }), probeFargate: async () => ({}),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /--assign-public-ip must be ENABLED or DISABLED/);
});

// ── default-VPC networking auto-detect (T53) ─────────────────────────────────

// pure builders + posture gate
test('fargateDescribe*Args: exact ec2 argv — default-VPC filters, query/output shape', () => {
  assert.deepStrictEqual(D.fargateDescribeVpcsArgs({ region: 'us-west-2' }), [
    'aws', '--region', 'us-west-2', 'ec2', 'describe-vpcs',
    '--filters', 'Name=is-default,Values=true', '--query', 'Vpcs[].VpcId', '--output', 'text']);
  assert.deepStrictEqual(D.fargateDescribeSubnetsArgs({ vpcId: 'vpc-1', profile: 'p' }), [
    'aws', '--profile', 'p', 'ec2', 'describe-subnets',
    '--filters', 'Name=vpc-id,Values=vpc-1', 'Name=default-for-az,Values=true',
    '--query', 'Subnets[].SubnetId', '--output', 'text']);
  assert.deepStrictEqual(D.fargateDescribeSgArgs({ vpcId: 'vpc-1' }), [
    'aws', 'ec2', 'describe-security-groups',
    '--filters', 'Name=vpc-id,Values=vpc-1', 'Name=group-name,Values=default', '--output', 'json']);
});

test('fargateSgInboundWarning: factory-benign → null; a real inbound rule → offender line', () => {
  // empty → benign
  assert.strictEqual(D.fargateSgInboundWarning('sg-1', []), null);
  // only self-referencing pair → benign (the default SG's factory all-self rule)
  assert.strictEqual(D.fargateSgInboundWarning('sg-1', [{ IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-1' }] }]), null);
  // a CIDR grant → warned, with proto/port/source
  const w = D.fargateSgInboundWarning('sg-1', [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }]);
  assert.match(w, /sg-1 has inbound rules: tcp 22 from 0\.0\.0\.0\/0/);
  assert.match(w, /needs NO inbound/);
  // a FOREIGN group reference is not factory → warned
  assert.match(D.fargateSgInboundWarning('sg-1', [{ IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-other' }] }]), /all from sg-other/);
  // a port RANGE renders as from-to
  assert.match(D.fargateSgInboundWarning('sg-1', [{ IpProtocol: 'tcp', FromPort: 8000, ToPort: 8100, IpRanges: [{ CidrIp: '10.0.0.0/8' }] }]), /tcp 8000-8100 from 10\.0\.0\.0\/8/);
});

test('deploy fargate: both --subnets and --security-group given → ZERO ec2 calls, explicit ids used', async () => {
  const rec = {};
  const { code } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx',
    '--subnets', 'subnet-A,subnet-B', '--security-group', 'sg-X'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('ec2 describe')), 'no detection when both flags given');
  assert.ok(deployHasParam(rec, 'SubnetIds=subnet-A,subnet-B'), 'explicit subnets used');
  assert.ok(deployHasParam(rec, 'SecurityGroupId=sg-X'), 'explicit sg used');
  // no auto AssignPublicIp when subnets were explicit and the flag was omitted.
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('AssignPublicIp')), 'no implied public ip on explicit subnets');
});

test('deploy fargate: BOTH flags missing → full detect, resolved ids in overrides, ENABLED implied, loud lines', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  // all three describes ran (vpc, subnets, sg).
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-vpcs')));
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-subnets')));
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-security-groups')));
  // resolved ids fed the SAME template params; subnets are SORTED (stable order).
  assert.ok(deployHasParam(rec, 'SubnetIds=subnet-a,subnet-b'), 'subnets resolved + sorted');
  assert.ok(deployHasParam(rec, 'SecurityGroupId=sg-default'));
  assert.ok(deployHasParam(rec, 'AssignPublicIp=ENABLED'), 'public ip implied by auto subnets');
  // loud, one line per resolved item.
  assert.match(stdout, /network: default VPC vpc-default \[auto-detected\]/);
  assert.match(stdout, /network: subnets subnet-a,subnet-b \[auto-detected\]/);
  assert.match(stdout, /network: security-group sg-default \[auto-detected\]/);
  assert.match(stdout, /network: assign-public-ip ENABLED \[implied by default-VPC subnets\]/);
});

test('deploy fargate: only --security-group given → detect SUBNETS only (one describe path skipped)', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx', '--security-group', 'sg-mine'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-vpcs')));
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-subnets')));
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('ec2 describe-security-groups')), 'no SG describe when sg explicit');
  assert.ok(deployHasParam(rec, 'SubnetIds=subnet-a,subnet-b'));
  assert.ok(deployHasParam(rec, 'SecurityGroupId=sg-mine'), 'explicit sg wins');
  assert.ok(deployHasParam(rec, 'AssignPublicIp=ENABLED'), 'implied by the auto-detected subnets');
  assert.doesNotMatch(stdout, /network: security-group/);   // sg wasn't auto-detected
});

test('deploy fargate: only --subnets given → detect SG only, NO implied public ip (subnets were explicit)', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx', '--subnets', 'subnet-mine'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('ec2 describe-subnets')), 'no subnet describe when subnets explicit');
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-security-groups')));
  assert.ok(deployHasParam(rec, 'SubnetIds=subnet-mine'));
  assert.ok(deployHasParam(rec, 'SecurityGroupId=sg-default'));
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('AssignPublicIp')), 'public ip NOT implied — subnets were explicit');
  assert.doesNotMatch(stdout, /assign-public-ip ENABLED \[implied/);
});

test('deploy fargate: explicit --assign-public-ip DISABLED SURVIVES auto-detected subnets (explicit wins the trap)', async () => {
  // break-verify of the implied-ENABLED rule: a user who deliberately passes
  // DISABLED (private subnets they detect for) must NOT be overridden.
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx', '--assign-public-ip', 'DISABLED'], {
    execFn: fakeAws(rec), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.ok(deployHasParam(rec, 'AssignPublicIp=DISABLED'), 'explicit DISABLED survives detection');
  assert.ok(!deployHasParam(rec, 'AssignPublicIp=ENABLED'), 'never flipped to ENABLED');
  assert.doesNotMatch(stdout, /implied by default-VPC subnets/);
});

test('deploy fargate: no default VPC → USAGE naming BOTH flags, nothing deployed', async () => {
  const rec = {};
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws(rec, { vpc: '' }), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /no default VPC/);
  assert.match(stderr, /--subnets and --security-group/);
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('cloudformation deploy')), 'aborts before deploy');
});

test('deploy fargate: default VPC with no default-for-az subnets → USAGE naming both flags', async () => {
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws({}, { subnets: [] }), probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /no default-for-az subnets/);
  assert.match(stderr, /--subnets and --security-group/);
});

test('deploy fargate: an auto-detected SG with a real inbound rule → loud WARNING, deploy PROCEEDS', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws(rec, { sgInbound: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '0.0.0.0/0' }] }] }),
    probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);   // warn-don't-block
  assert.match(stdout, /WARNING: detected default SG sg-default has inbound rules: tcp 22 from 0\.0\.0\.0\/0/);
  assert.ok(rec.calls.some((c) => c.join(' ').includes('cloudformation deploy')), 'proceeds past the warning');
  assert.match(stdout, /verified|verify/);
});

test('deploy fargate: a factory default SG (all-self rule) → NO warning', async () => {
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws({}, { sgInbound: [{ IpProtocol: '-1', UserIdGroupPairs: [{ GroupId: 'sg-default' }] }] }),
    probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, 0);
  assert.doesNotMatch(stdout, /WARNING: detected default SG/);
});

test('deploy fargate --dry-run: detection RUNS (read-only) and the plan carries the resolved ids', async () => {
  const rec = {};
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--dry-run'], {
    execFn: fakeAws(rec), probeFargate: async () => { throw new Error('no verify on dry-run'); },
  });
  assert.strictEqual(code, 0);
  // the read-only describes ran; the mutating deploy did NOT.
  assert.ok(rec.calls.some((c) => c.join(' ').includes('ec2 describe-vpcs')), 'detection runs on dry-run (read-only)');
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('cloudformation deploy')), 'no mutating deploy on dry-run');
  // the plan shows the REAL resolved ids + the auto-detected network lines.
  assert.match(stdout, /network: default VPC vpc-default \[auto-detected\]/);
  assert.match(stdout, /SubnetIds=subnet-a,subnet-b/);
  assert.match(stdout, /AssignPublicIp=ENABLED/);
});

test('deploy fargate --json --dry-run: the dry-run event carries network{vpcId,subnets,securityGroup,assignPublicIp,autoDetected}', async () => {
  const { code, stdout } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--dry-run', '--json'], {
    execFn: fakeAws({}), probeFargate: async () => { throw new Error('no verify'); },
  });
  assert.strictEqual(code, 0);
  const obj = stdout.trim().split('\n').map((l) => JSON.parse(l)).find((o) => o.type === 'dry-run');
  assert.deepStrictEqual(obj.network, {
    vpcId: 'vpc-default', subnets: ['subnet-a', 'subnet-b'], securityGroup: 'sg-default',
    assignPublicIp: 'ENABLED', autoDetected: { subnets: true, securityGroup: true },
  });
});

test('deploy fargate: an ec2 describe failure rides the runAws CliError shape', async () => {
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: fakeAws({}, { vpcFail: 'AccessDenied: not authorized to DescribeVpcs' }),
    probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /aws ec2 describe-vpcs failed/);
  assert.match(stderr, /AccessDenied/);
});

// T53 review nit 1: the SG describe JSON parse is try/catch-guarded (→ []); a
// garbage stdout must fail SAFE (no default SG found → USAGE, deploy blocked)
// rather than throwing an unhandled parse error or silently deploying SG-less.
test('deploy fargate: malformed SG describe output (unparseable JSON) → USAGE, deploy blocked', async () => {
  const rec = {};
  const gibberish = async (cmd, args) => {
    const j = cmd + ' ' + args.join(' ');
    if (j.includes('ec2 describe-security-groups')) return { stdout: 'not-json <<<garbage>>>' };
    return fakeAws(rec)(cmd, args);   // everything else answers normally
  };
  const { code, stderr } = await cli(['deploy', 'fargate', 's', '--use-bedrock', '--no-ctx'], {
    execFn: gibberish, probeFargate: async () => ({ app: 'clodex' }),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /no default security group/);
  assert.match(stderr, /--subnets and --security-group/);
});

// T53 review nit 2: a MIXED permission entry (self-ref pair the factory allows
// AND a real CIDR) must still warn, and name the CIDR — the self-ref filter
// must not swallow the whole entry.
test('fargateSgInboundWarning: a mixed self-ref + CIDR permission → warns, names the CIDR', () => {
  const w = D.fargateSgInboundWarning('sg-1', [{
    IpProtocol: 'tcp', FromPort: 443, ToPort: 443,
    UserIdGroupPairs: [{ GroupId: 'sg-1' }],        // factory self-ref — benign alone
    IpRanges: [{ CidrIp: '203.0.113.0/24' }],       // but a real CIDR rides the same entry
  }]);
  assert.match(w, /tcp 443 from 203\.0\.113\.0\/24/, 'the CIDR is named despite the benign self-ref pair');
  assert.doesNotMatch(w, /from sg-1/, 'the self-referencing pair is NOT reported as an offender');
});

test('deploy fargate: bad stack name (dots/underscore/leading digit) → USAGE, nothing runs', async () => {
  for (const bad of ['my.stack', 'a_b', '1node']) {
    let ran = false;
    const { code, stderr } = await cli(['deploy', 'fargate', bad], {
      execFn: async () => { ran = true; return { stdout: '' }; }, probeFargate: async () => ({}),
    });
    assert.strictEqual(code, EXIT.USAGE, bad);
    assert.match(stderr, /bad stack name/);
    assert.strictEqual(ran, false);
  }
});

test('deploy fargate: no stack name → USAGE', async () => {
  const { code, stderr } = await cli(['deploy', 'fargate'], { execFn: async () => ({ stdout: '' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /deploy fargate needs a stack name/);
});

test('deploy fargate: missing aws binary (ENOENT) → CONNECT with the aws hint', async () => {
  const { code, stderr } = await cli(['deploy', 'fargate', 's'], {
    execFn: async () => { const e = new Error('spawn aws ENOENT'); e.code = 'ENOENT'; throw e; },
    probeFargate: async () => ({}),
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /aws CLI not found/);
});

// ── dispatch: `deploy fargate` routes; `deploy ssh fargate` stays ssh ─────────

test('deploy fargate routes to the fargate flavor', async () => {
  // "My.Stack" is a valid ssh dest but an invalid fargate stack name — the "bad
  // stack name" USAGE error proves dispatch routed to the fargate validator.
  const { code, stderr } = await cli(['deploy', 'fargate', 'My.Stack'], { execFn: async () => ({ stdout: '' }) });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /bad stack name/);
});

test('deploy ssh fargate still routes to the ssh flavor (host literally named fargate)', async () => {
  const { code } = await cli(['deploy', 'ssh', 'fargate'], {
    spawnFn: () => { const e = new Error('spawn ssh ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.strictEqual(code, EXIT.CONNECT);   // ssh flavor's "could not start ssh"
});

// helper: did the cloudformation deploy call carry this parameter override?
function deployHasParam(rec, param) {
  const c = rec.calls.find((x) => x.join(' ').includes('cloudformation deploy'));
  return !!c && c.includes(param);
}

// ── fargatePollHello: the retry/deadline loop (T50 followup) ──────────────────
// The flow tests above inject io.probeFargate, so the poll loop itself
// (deploy.js:1667) went uncovered. Exercise it DIRECTLY. openTransport is a hard
// module require (not an injectable seam) and the loop doesn't thread the
// forwarded local port, so the only ctx that can reach a live hello is a `{ url }`
// entry pointed at a REAL throwaway HTTP server — the spawn/ssm paths pick their
// own free port and would time out. The clock is faked (Date only, so the http
// server's real timers still fire) and sleepFn is injected — NO real waiting.
const http = require('node:http');
const { CliError } = require('../src/errors');

// A local server whose /api/peer/hello replies come from a scripted status
// sequence (last entry sticks). Returns { url, hits, close }. hits counts hello
// requests so a test can prove how many retries happened.
async function helloServer(statuses) {
  let i = 0;
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    // 2xx → a hello body; non-2xx → a coded error body (server's honest reason).
    res.end(status >= 200 && status < 300
      ? JSON.stringify({ app: 'clodex', host: 'node', version: '9.9.9', caps: [] })
      : JSON.stringify({ error: `boom ${status}` }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => srv.close(r)) };
}

test('fargatePollHello: retries past transient failures and RETURNS the hello (through the finally-close); sleeps are injected, not real', async () => {
  // Two 503s then a 200 — the loop must survive the catch/finally twice and return
  // the success body on the third open. A large timeout keeps the deadline out of
  // play; the injected sleepFn resolves instantly so no wall-clock time passes.
  const srv = await helloServer([503, 503, 200]);
  const slept = [];
  try {
    const hello = await D.fargatePollHello(
      { url: srv.url }, WIRE,
      { timeoutMs: 60_000, pollMs: 250, sleepFn: async (ms) => { slept.push(ms); } },
    );
    assert.deepStrictEqual(hello, { app: 'clodex', host: 'node', version: '9.9.9', caps: [] },
      'the success body is returned even though two prior opens threw (return passes through the finally)');
    assert.strictEqual(srv.hits.length, 3, 'polled three times: two failures + the success');
    assert.deepStrictEqual(slept, [250, 250], 'slept once per failure (injected sleepFn, real pollMs), never before the success');
  } finally {
    await srv.close();
  }
});

test('fargatePollHello: deadline exhaustion throws the HONEST last error (CliError passthrough), driven by the injected clock', async (t) => {
  // A server that never recovers (always 500). The clock is faked and advanced
  // only inside sleepFn, so the deadline is crossed deterministically after a
  // known number of polls — no real time elapses.
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(1_000_000);
  const srv = await helloServer([500]);
  let sleeps = 0;
  try {
    await assert.rejects(
      D.fargatePollHello(
        { url: srv.url }, WIRE,
        { timeoutMs: 100, pollMs: 40, sleepFn: async (ms) => { sleeps += 1; t.mock.timers.tick(ms); } },
      ),
      (e) => {
        // The last WireClient error is a CliError (500 → EXIT.SERVER); the loop
        // rethrows it UNCHANGED (instanceof passthrough), so the operator sees the
        // server's own reason, not a generic "wire did not answer".
        assert.ok(e instanceof CliError, 'throws a coded CliError');
        assert.strictEqual(e.exitCode, EXIT.SERVER, '500 maps to EXIT.SERVER');
        assert.match(e.message, /boom 500/, 'carries the honest last-error detail (passthrough), not a generic message');
        return true;
      },
    );
    // deadline = t0+100, pollMs 40: fail(t0)→tick→fail(40)→tick→fail(80)→tick→
    // fail(120 ≥ 100)→throw. Three sleeps, four polls.
    assert.strictEqual(sleeps, 3, 'slept exactly until the deadline was crossed (injected clock, no real waiting)');
    assert.strictEqual(srv.hits.length, 4, 'polled until the deadline, then gave up');
  } finally {
    await srv.close();
  }
});

// ── runAws default seam ──────────────────────────────────────────────────────
// The live path calls runAws(undefined, …) (io.execFn unset outside tests);
// the default must be a real exec, not a crash. Regression: "execFn is not a
// function" on the first real `deploy fargate` run — every earlier test
// injected execFn, so the default seam was never exercised.
test('runAws with NO execFn injected execs the argv via the real child-process seam', async () => {
  const out = await D.runAws(undefined, ['node', '-e', 'console.log("live-seam-ok")'], 'seam probe');
  assert.strictEqual(out, 'live-seam-ok');
});
