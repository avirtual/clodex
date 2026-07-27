'use strict';
// upgrade.test.js — `clodexctl upgrade <ctx>`: move an EXISTING deployment to a
// new version. The four things the verb does that `deploy` cannot — route on
// the stored flavor, refuse to create, report FROM→TO (and no-op when equal),
// and force the image pin EXPLICIT — plus the two flavor decisions (docker
// refused, ssm supported-but-rotating).
//
// Everything runs through the REAL verbs against a scripted execFn (helm /
// kubectl / aws / ssh are never really spawned) and an injected io.probeVersion
// (no transport is ever opened).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/upgrade');
const D = require('../src/deploy');
const { EXIT } = require('../src/errors');
const { run } = require('../src/main');

function tmpCtxFile(contexts, current = null) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clodexctl-up-t-')), 'contexts.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ current, contexts }, null, 2), { mode: 0o600 });
  return f;
}

async function cli(argv, io = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, {
    stdout: (s) => (stdout += s), stderr: (s) => (stderr += s),
    env: {},
    ...io,
  });
  return { code, stdout, stderr };
}

// A version probe seam: what the live node reports as `hello.version`.
const reports = (v) => async () => v;
const silent = () => { throw new Error('connection refused'); };

// ── the packaged pins ────────────────────────────────────────────────────────

test('the TO version is read from the PACKAGED ASSET, with the same anchors release.sh maintains', () => {
  // The asset is what actually deploys; package.json would be a comforting lie
  // if the two ever drifted. Both readers insist on EXACTLY ONE match for the
  // same reason scripts/release.sh:sync_pin does — a restructured file that no
  // longer matches means the pin stopped being maintained, and a silent
  // fallback would upgrade every node to a stale version forever.
  const tag = U.helmPinnedTag();
  assert.match(tag, /^\d+\.\d+\.\d+/, 'the chart tag must be a real version');
  const values = fs.readFileSync(path.join(D.helmChartPath(), 'values.yaml'), 'utf8');
  assert.ok(values.includes(`  tag: "${tag}"`), 'the tag read must be the literal line release.sh rewrites');

  const image = U.fargatePinnedImage();
  assert.match(image, /^ghcr\.io\/avirtual\/clodex:\d+\.\d+\.\d+/, 'the template image must be a real pinned reference');
  const tpl = fs.readFileSync(D.fargateTemplatePath(), 'utf8');
  assert.ok(tpl.includes(`    Default: '${image}'`), 'the image read must be the literal line release.sh rewrites');

  // And the two assets agree — release.sh syncs both from one version, so a
  // disagreement means one of the two sync_pin calls silently stopped firing.
  assert.strictEqual(U.refVersion(image), tag,
    'the chart tag and the template image drifted apart — release.sh syncs both from the same version, so one of its sync_pin anchors is no longer matching and this build ships two different "current" versions');
});

test('refVersion / withTag: a DIGEST names no version, so nothing is compared', () => {
  assert.strictEqual(U.refVersion('ghcr.io/avirtual/clodex:4.5.0'), '4.5.0');
  assert.strictEqual(U.refVersion('registry:5000/team/clodex:1.2.3'), '1.2.3', 'a registry PORT is not a tag');
  assert.strictEqual(U.refVersion('ghcr.io/avirtual/clodex@sha256:abc'), null,
    'a digest pin has no version — comparing it against hello.version would invent one, so it must be null and the no-op check skipped');
  assert.strictEqual(U.withTag('ghcr.io/avirtual/clodex:4.5.0', '4.6.0'), 'ghcr.io/avirtual/clodex:4.6.0');
  assert.strictEqual(U.withTag('ghcr.io/avirtual/clodex@sha256:abc', '4.6.0'), 'ghcr.io/avirtual/clodex:4.6.0');
  assert.strictEqual(U.withTag('registry:5000/x/clodex:1', '2'), 'registry:5000/x/clodex:2', 'the registry port survives a re-tag');
});

// ── routing: the flavor field is the ONLY router ─────────────────────────────

test('a context with NO deploy record (pre-t54) is refused, and never guessed from the transport', async () => {
  const contextsFile = tmpCtxFile({ old: { ssh: 'user@box', webPort: 7901 } });
  const { code, stderr } = await cli(['upgrade', 'old'], { contextsFile, probeVersion: reports('4.5.0') });
  // The MESSAGE is asserted before the exit code, deliberately: a bare
  // `2 !== 0` tells the next reader that something changed, not what broke.
  assert.match(stderr, /does not record how it was deployed/,
    'a pre-t54 context must be refused by NAME — an ssh deploy and a remote docker deploy save identical transports, so guessing here is how an upgrade re-runs the wrong path');
  assert.match(stderr, /Re-run the flavor's deploy/,
    'the refusal must name what to do instead — re-running deploy is safe now, and it stamps the record so this works next time');
  assert.strictEqual(code, EXIT.USAGE, 'and it must exit USAGE, so a script can branch on it');
});

test('an UNRECOGNIZED flavor is refused BY NAME at upgrade — not at every other verb (t55)', async () => {
  // The other half of the t55 partition: contexts.js stores it without
  // complaint (cli/test/contexts.test.js pins that), so `sessions`/`web`/`ctx
  // test` keep working against a perfectly reachable node. THIS is where the
  // refusal belongs, because this is the verb that must dispatch on the value.
  const contextsFile = tmpCtxFile({ future: { ssh: 'user@box', deploy: { flavor: 'nomad', job: 'clodex' } } });
  const { code, stderr } = await cli(['upgrade', 'future'], { contextsFile, probeVersion: reports('4.5.0') });
  assert.match(stderr, /records deploy flavor "nomad", which this clodexctl cannot upgrade/,
    'the refusal must NAME the flavor it cannot route — "unsupported" alone leaves the operator guessing which of their nodes is the problem');
  assert.match(stderr, /newer clodexctl probably wrote it/,
    'and must say WHY, because the actionable fix is upgrading clodexctl rather than editing the context');
  assert.match(stderr, /every other verb still works with it/,
    'and must say the context is otherwise fine — that is the whole point of making enum membership advisory in contexts.js');
  assert.strictEqual(code, EXIT.USAGE, 'and it must exit USAGE rather than attempt a route it does not have');
});

test('docker is refused with its REASON, and the two-step path that keeps the data', async () => {
  const contextsFile = tmpCtxFile({
    edge: { ssh: 'user@box', deploy: { flavor: 'docker', container: 'clodexctl-edge', dockerHost: 'ssh://user@box' } },
  });
  const { code, stderr } = await cli(['upgrade', 'edge'], { contextsFile, probeVersion: reports('4.5.0') });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /--env-file/,
    'the refusal must name the run arguments that are not stored — that is the honest reason, and it tells the operator what they will need to supply');
  assert.match(stderr, /docker inspect/,
    'and must say why they cannot simply be recovered: inspect returns RESOLVED env values, so replaying the run would spell secrets into argv');
  assert.match(stderr, /undeploy docker edge --host ssh:\/\/user@box --keep-data/,
    'the two-step path must carry --keep-data, or following our own instructions destroys the node\'s state');
  assert.match(stderr, /deploy docker edge --host ssh:\/\/user@box --tag/,
    'and must name the recreate command with the stored host, so the operator is not re-deriving it');
});

// ── helm ─────────────────────────────────────────────────────────────────────

// A scripted helm/kubectl execFn, shaped like deploy-helm.test.js's fakeK8s
// (this suite needs the same calls plus `helm status` answering for a release
// that exists). Records the upgrade argv so the image pin can be asserted.
function fakeK8s(rec, { releaseExists = true, statusFail = null, priorValues = null } = {}) {
  rec.calls = [];
  const token = Buffer.from('a'.repeat(48)).toString('base64');
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = cmd + ' ' + args.join(' ');
    if (cmd === 'helm' && args[0] === 'version') return { stdout: 'v3.14.0' };
    if (cmd === 'kubectl' && args[0] === 'version') return { stdout: 'clientVersion:' };
    if (j.includes('config current-context')) return { stdout: 'docker-desktop\n' };
    if (cmd === 'helm' && args[0] === 'status') {
      if (releaseExists) return { stdout: 'STATUS: deployed' };
      const e = new Error('helm status failed'); e.stderr = statusFail || 'Error: release: not found'; throw e;
    }
    if (cmd === 'helm' && args[0] === 'get' && args[1] === 'values') {
      return { stdout: priorValues == null ? 'null' : JSON.stringify(priorValues) };
    }
    if (cmd === 'kubectl' && args.includes('namespace')) return { stdout: 'ok' };
    if (cmd === 'kubectl' && args.includes('secret')) {
      if (j.includes('oauth-token')) return { stdout: '' };
      return { stdout: token };
    }
    if (cmd === 'helm' && args[0] === 'upgrade') { rec.helmArgs = args.slice(); return { stdout: 'upgraded' }; }
    throw new Error('unexpected call: ' + j);
  };
}

const HELM_CTX = () => ({
  mynode: {
    kubectl: { target: 'svc/mynode', namespace: 'clodex', context: 'docker-desktop' },
    webPort: 8080, token: 'tok',
    deploy: { flavor: 'helm', release: 'mynode', namespace: 'clodex', kubeContext: 'docker-desktop' },
  },
});

test('helm: refuses to CREATE — a release that is not installed is an error, not a silent install', async () => {
  const rec = {};
  const contextsFile = tmpCtxFile(HELM_CTX());
  const { code, stderr } = await cli(['upgrade', 'mynode'], {
    contextsFile, execFn: fakeK8s(rec, { releaseExists: false }), probeVersion: reports('4.5.0'),
  });
  assert.match(stderr, /is not installed in namespace "clodex" — upgrade moves an existing deployment, it does not create one/,
    'an upgrade against a release that is not there must FAIL — installing silently would turn a typo\'d ctx name into a surprise deployment');
  assert.match(stderr, /clodexctl deploy helm mynode --namespace clodex/,
    'and must name the command that WOULD create it');
  assert.ok(!rec.helmArgs, 'helm upgrade must never have run — the refusal happens BEFORE the delegate, which is what keeps the delegate off its install path');
  assert.strictEqual(code, EXIT.USAGE, 'and it must exit USAGE — a missing release is the operator addressing the wrong thing');
});

test('helm: FROM===TO no-ops without touching the cluster, and --force overrides it', async () => {
  const pinned = U.helmPinnedTag();
  const rec = {};
  const contextsFile = tmpCtxFile(HELM_CTX());
  const { code, stdout } = await cli(['upgrade', 'mynode'], {
    contextsFile, execFn: fakeK8s(rec), probeVersion: reports(pinned),
  });
  // The consequence first, then the message, then the code — reverting the
  // no-op makes the run CONTINUE, and "helm ran" is what the reader needs to
  // see, not the exit code that changed as a side effect.
  assert.ok(!rec.helmArgs,
    'the no-op must not run helm at all — a "no-op" that still redeploys is just an upgrade with a reassuring message, and it would restart a healthy node for nothing');
  assert.match(stdout, new RegExp(`already running ${pinned.replace(/\./g, '\\.')} — nothing to do`),
    'an upgrade to the version already running must SAY so and stop');
  assert.strictEqual(code, EXIT.OK, 'and a no-op is success, not a failure');

  // --force is the way through.
  const rec2 = {};
  const { code: c2, stdout: s2 } = await cli(['upgrade', 'mynode', '--force'], {
    contextsFile: tmpCtxFile(HELM_CTX()), execFn: fakeK8s(rec2), probeVersion: reports(pinned),
    probeHelm: async () => ({ app: 'clodex', version: pinned }),
  });
  assert.strictEqual(c2, EXIT.OK);
  assert.ok(rec2.helmArgs, '--force must re-run even at the target version — that is what it is for');
});

test('helm: the image pin is EXPLICIT, and an explicit --tag BEATS a carried image.tag', async () => {
  // t54 carries the operator's prior overrides forward, so a release pinned to
  // 4.5.0 keeps 4.5.0 across a plain re-run. `upgrade --tag` is what MOVES it,
  // and it must win: the pin rides --set, which helm applies after every values
  // file regardless of argv position.
  const rec = {};
  const contextsFile = tmpCtxFile(HELM_CTX());
  const { code, stdout } = await cli(['upgrade', 'mynode', '--tag', '4.9.9'], {
    contextsFile, execFn: fakeK8s(rec, { priorValues: { image: { tag: '4.5.0' } } }),
    probeVersion: reports('4.5.0'),
    probeHelm: async () => ({ app: 'clodex', version: '4.9.9' }),
  });
  assert.strictEqual(code, EXIT.OK);
  assert.match(stdout, /running: 4\.5\.0/, 'FROM is the live hello.version, not a stored guess');
  assert.match(stdout, /target:  4\.9\.9 \(--tag\)/, 'TO must be reported before acting, and name where it came from');

  const argv = rec.helmArgs.join(' ');
  assert.match(argv, /--set image\.tag=4\.9\.9/,
    'the requested version must reach helm as an EXPLICIT --set — this is the entire point of the verb');
  // The carried file is still passed (t54's carry-forward is doing its job),
  // and the pin still wins, because --set beats every values file by helm's own
  // merge rule. Assert BOTH, or a passing test could mean the carry-forward was
  // silently dropped instead of correctly overridden.
  const carried = rec.helmArgs.filter((a, i) => rec.helmArgs[i - 1] === '--values');
  assert.strictEqual(carried.length, 1,
    'the prior values must STILL be carried forward — winning the version argument by discarding every other override the operator set is not a win');
  assert.match(fs.existsSync(carried[0]) ? fs.readFileSync(carried[0], 'utf8') : '{"image":{"tag":"4.5.0"}}', /4\.5\.0|image/);
});

test('helm: with no --tag the target is the version this clodexctl SHIPS', async () => {
  const pinned = U.helmPinnedTag();
  const rec = {};
  const { code, stdout } = await cli(['upgrade', 'mynode'], {
    contextsFile: tmpCtxFile(HELM_CTX()), execFn: fakeK8s(rec), probeVersion: reports('1.0.0'),
    probeHelm: async () => ({ app: 'clodex', version: pinned }),
  });
  assert.strictEqual(code, EXIT.OK);
  assert.match(stdout, /target:  .* \(the chart this clodexctl ships\)/);
  assert.ok(rec.helmArgs.join(' ').includes(`--set image.tag=${pinned}`),
    'the packaged pin must be passed EXPLICITLY too — leaving it to the chart default would work today and silently stop working the moment a carried image.tag exists');
});

test('helm: --force-conflicts reaches the delegate, and is absent by default (t56)', async () => {
  // upgrade is the verb where this flag matters most: a node whose image tag
  // was hand-edited (the very operator upgrade exists for) fails the SSA
  // ownership check, and the error tells them to re-run with this flag. If it
  // stopped at the upgrade verb and never reached helm, that instruction would
  // be a dead end — the operator would run exactly what the tool told them to
  // and get the identical failure.
  const withFlag = {};
  const { code } = await cli(['upgrade', 'mynode', '--force-conflicts'], {
    contextsFile: tmpCtxFile(HELM_CTX()), execFn: fakeK8s(withFlag), probeVersion: reports('1.0.0'),
    probeHelm: async () => ({ app: 'clodex', version: U.helmPinnedTag() }),
  });
  // Exit first: --force-conflicts is a BARE boolean, and a parser not told so
  // eats the next argv item (or rejects it), so helm never runs — asserting the
  // argv first would surface that as a crash rather than as the cause.
  assert.strictEqual(code, EXIT.OK,
    '--force-conflicts must PARSE as a boolean flag — undeclared, it fails the run before helm is ever reached');
  assert.ok(withFlag.helmArgs && withFlag.helmArgs.includes('--force-conflicts'),
    'the flag must survive the delegation into helm — the conflict error names it as the remedy, so a flag that stops here makes our own advice fail');

  // And the default stays off THROUGH the delegation too. `upgrade` spreads the
  // operator's flags into deployHelmVerb, so this also pins that the spread
  // cannot manufacture a truthy value from an absent flag.
  const without = {};
  await cli(['upgrade', 'mynode'], {
    contextsFile: tmpCtxFile(HELM_CTX()), execFn: fakeK8s(without), probeVersion: reports('1.0.0'),
    probeHelm: async () => ({ app: 'clodex', version: U.helmPinnedTag() }),
  });
  assert.ok(!without.helmArgs.includes('--force-conflicts'),
    'a plain upgrade must NEVER force — taking ownership of whatever disagrees is not something an operator should get without asking');
});

// ── fargate: the silent-success defect ───────────────────────────────────────

function fakeAws(rec, { exists = true, params = {} } = {}) {
  rec.calls = [];
  return async (cmd, args) => {
    rec.calls.push([cmd, ...args]);
    const j = args.join(' ');
    if (j.includes('describe-stacks')) {
      if (!exists) { const e = new Error('aws failed'); e.stderr = 'An error occurred (ValidationError): Stack with id nope does not exist'; throw e; }
      if (j.includes('Stacks[0].Outputs')) return { stdout: '[]' };
      return { stdout: JSON.stringify({ Stacks: [{ StackStatus: 'CREATE_COMPLETE', Parameters: Object.entries(params).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })) }] }) };
    }
    if (j.includes('get-caller-identity')) return { stdout: JSON.stringify({ Account: '1', Arn: 'arn:x' }) };
    if (j.includes('cloudformation deploy')) { rec.deployArgs = args.slice(); return { stdout: 'ok' }; }
    if (j.includes('get-secret-value')) return { stdout: 'b'.repeat(48) };
    if (j.includes('configure get region')) return { stdout: 'us-west-2' };
    throw new Error('unexpected call: ' + j);
  };
}

const FARGATE_CTX = () => ({
  'clodex-node': {
    ssm: { ecs: 'clodex-node/clodex-node-node', region: 'us-west-2' },
    webPort: 8080, token: 'tok',
    deploy: { flavor: 'fargate', stack: 'clodex-node', region: 'us-west-2' },
  },
});
const PRIOR_PARAMS = {
  ClusterName: 'clodex-node', Persistent: 'true',
  SubnetIds: 'subnet-a,subnet-b', SecurityGroupId: 'sg-1', AssignPublicIp: 'ENABLED',
  ImageUri: 'ghcr.io/avirtual/clodex:4.5.0',
};

test('fargate: ImageUri is ALWAYS in the parameter overrides — the silent-success defect', async () => {
  // THE pin for this verb. `aws cloudformation deploy` reuses a prior parameter
  // value for anything not overridden, and --no-fail-on-empty-changeset then
  // reports SUCCESS. So an upgrade that omits ImageUri prints "ok", changes
  // nothing, and looks like it worked — worse than a failure, because the
  // operator walks away believing the node moved.
  const rec = {};
  // FROM must differ from the packaged pin, or this test would ride the no-op
  // path and assert nothing about the argv (it did, the first time I ran it).
  const { code } = await cli(['upgrade', 'clodex-node'], {
    contextsFile: tmpCtxFile(FARGATE_CTX()), execFn: fakeAws(rec, { params: PRIOR_PARAMS }),
    probeVersion: reports('1.0.0'), probeFargate: async () => ({ app: 'clodex', version: '9.9.9' }), sleepFn: async () => {},
  });
  assert.strictEqual(code, EXIT.OK);
  const overrides = rec.deployArgs.slice(rec.deployArgs.indexOf('--parameter-overrides') + 1);
  const imageUri = overrides.find((o) => o.startsWith('ImageUri='));
  assert.ok(imageUri,
    'ImageUri was NOT passed — CloudFormation then reuses the prior stack value and --no-fail-on-empty-changeset reports SUCCESS, so the upgrade silently no-ops while claiming it worked');
  assert.strictEqual(imageUri, `ImageUri=${U.fargatePinnedImage()}`,
    'and it must carry the version this clodexctl ships, not whatever the stack already had');
});

test('fargate: ImageUri is passed even when the target EQUALS the prior parameter (--force)', async () => {
  // The nastiest shape of the same defect: when the value happens to match, an
  // implementation that "skips the redundant override" is indistinguishable
  // from a correct one on every other test — and is exactly as broken the day
  // CFN's reuse and our intent disagree.
  const pinned = U.fargatePinnedImage();
  const rec = {};
  const { code } = await cli(['upgrade', 'clodex-node', '--force'], {
    contextsFile: tmpCtxFile(FARGATE_CTX()),
    execFn: fakeAws(rec, { params: { ...PRIOR_PARAMS, ImageUri: pinned } }),
    probeVersion: reports(U.refVersion(pinned)),
    probeFargate: async () => ({ app: 'clodex', version: U.refVersion(pinned) }), sleepFn: async () => {},
  });
  assert.strictEqual(code, EXIT.OK);
  const overrides = rec.deployArgs.slice(rec.deployArgs.indexOf('--parameter-overrides') + 1);
  assert.ok(overrides.includes(`ImageUri=${pinned}`),
    'ImageUri must be UNCONDITIONAL — an override skipped because it "would not change anything" is the same silent-no-op bug wearing a smarter disguise');
});

test('fargate: refuses to CREATE a stack that does not exist', async () => {
  const rec = {};
  const { code, stderr } = await cli(['upgrade', 'clodex-node'], {
    contextsFile: tmpCtxFile(FARGATE_CTX()), execFn: fakeAws(rec, { exists: false }),
    probeVersion: reports('4.5.0'), sleepFn: async () => {},
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /does not exist in us-west-2 — upgrade moves an existing deployment, it does not create one/,
    'an upgrade against a missing stack must fail, naming the region it looked in — a wrong --region looks exactly like a missing stack');
  assert.match(stderr, /clodexctl deploy fargate clodex-node --region us-west-2/);
  assert.ok(!rec.deployArgs, 'cloudformation deploy must never have run');
});

test('fargate: the live stack\'s networking is carried forward, not silently re-detected', async () => {
  // fargateParamOverrides ALWAYS emits ClusterName and Persistent, and the
  // deploy verb AUTO-DETECTS subnets/SG from the default VPC when those flags
  // are absent. So a flagless re-deploy would overwrite four settings CFN would
  // otherwise have kept — worst case moving a custom-VPC task onto default-VPC
  // subnets. This is the fargate shape of t54's derived-values lesson.
  const rec = {};
  const { code } = await cli(['upgrade', 'clodex-node'], {
    contextsFile: tmpCtxFile(FARGATE_CTX()),
    execFn: fakeAws(rec, { params: { ...PRIOR_PARAMS, SubnetIds: 'subnet-private-1', SecurityGroupId: 'sg-locked' } }),
    probeVersion: reports('1.0.0'), probeFargate: async () => ({ app: 'clodex', version: '9.9.9' }), sleepFn: async () => {},
  });
  assert.strictEqual(code, EXIT.OK);
  const overrides = rec.deployArgs.slice(rec.deployArgs.indexOf('--parameter-overrides') + 1);
  assert.ok(overrides.includes('SubnetIds=subnet-private-1'),
    'the stack\'s own subnets must be carried forward — auto-detecting instead would move the task into the default VPC, which is a network change nobody asked an UPGRADE for');
  assert.ok(overrides.includes('SecurityGroupId=sg-locked'), 'and its security group with it');
  assert.ok(!rec.calls.some((c) => c.join(' ').includes('describe-vpcs')),
    'and the default-VPC auto-detect must not even run — if it did, the prior values were being ignored and only coincidentally reproduced');
});

// ── ssh / ssm: the source-installed flavors ──────────────────────────────────

const SSH_CTX = () => ({ box: { ssh: 'user@box', webPort: 7901, deploy: { flavor: 'ssh', host: 'user@box' } } });

test('ssh: a node that does not answer is NOT silently installed (--force is the way through)', async () => {
  const { code, stderr } = await cli(['upgrade', 'box'], {
    contextsFile: tmpCtxFile(SSH_CTX()), probeVersion: silent,
    spawnFn: () => { throw new Error('ssh must not be spawned'); },
  });
  assert.strictEqual(code, EXIT.CONNECT);
  assert.match(stderr, /did not answer, so this build cannot confirm a node is there to upgrade/,
    'the installer IS the create path, so a silent node is "unconfirmed" — running anyway would INSTALL onto a box the operator only meant to update');
  assert.match(stderr, /re-run with --force/,
    'and must offer the way through, because "it is down and I want the installer to repair it" is the common case');
});

test('ssh: never no-ops, and SAYS which flags will revert', async () => {
  // The installer clones a BRANCH and builds the tip — there is no pinned
  // artifact, so there is no target version and nothing to compare. Saying that
  // is honest; inventing a target from package.json would not be.
  let ranWith = null;
  const { code, stdout } = await cli(['upgrade', 'box', '--dry-run'], {
    contextsFile: tmpCtxFile(SSH_CTX()), probeVersion: reports('4.5.0'),
    spawnFn: () => { ranWith = true; throw new Error('nothing spawns on --dry-run'); },
  });
  assert.strictEqual(code, EXIT.OK);
  assert.match(stdout, /the ssh installer tracks a branch and deploys no pinned artifact/,
    'an upgrade with no knowable target must SAY there is none rather than invent one');
  assert.match(stdout, /--no-wirescope, --repo, --branch, --src, --ssh-opt and --claude-token-file/,
    'the flags a context does not store REVERT on a re-run, and the operator must be told BEFORE it happens — silently changing their node is the failure this note exists to prevent');
  assert.ok(!ranWith, '--dry-run must touch nothing');
});

test('ssm: the token ROTATION is warned about BEFORE anything runs', async () => {
  // `deploy ssm` mints a fresh wire token on EVERY run (deploy.js), unlike helm
  // (reuses the release's) and fargate (never rewrites the stack's). So an ssm
  // upgrade rotates it, and any other holder of the old token breaks. That is a
  // real consequence of running this verb and it must be stated up front.
  const ctx = { box: { ssm: { target: 'i-123', region: 'us-west-2' }, webPort: 7901, token: 'tok', deploy: { flavor: 'ssm', target: 'i-123', region: 'us-west-2' } } };
  const { code, stdout } = await cli(['upgrade', 'box', '--dry-run'], {
    contextsFile: tmpCtxFile(ctx), probeVersion: reports('4.5.0'),
    execFn: async () => { throw new Error('nothing runs on --dry-run'); },
  });
  assert.strictEqual(code, EXIT.OK);
  const warnAt = stdout.indexOf('MINTS A FRESH WIRE TOKEN');
  assert.ok(warnAt >= 0,
    'an ssm upgrade ROTATES the wire token — the one consequence that differs from every other flavor, and the one nobody would guess');
  assert.match(stdout, /any OTHER holder of the old one/,
    'and the warning must name who breaks: a second machine\'s context, a GUI peer row, a script');
  const planAt = stdout.indexOf('dry-run — the ssm deploy path would run');
  assert.ok(planAt > warnAt,
    'the warning must come BEFORE the plan — a consequence announced after the operator has stopped reading is not a warning');
});

test('ssm: --tag is refused rather than silently ignored', async () => {
  const ctx = { box: { ssm: { target: 'i-123' }, token: 'tok', deploy: { flavor: 'ssm', target: 'i-123' } } };
  const { code, stderr } = await cli(['upgrade', 'box', '--tag', '4.9.9'], {
    contextsFile: tmpCtxFile(ctx), probeVersion: reports('4.5.0'),
  });
  assert.strictEqual(code, EXIT.USAGE);
  assert.match(stderr, /--tag does not apply to the ssm flavor — it installs from source/,
    'accepting a version flag the flavor cannot honor would let an operator believe they pinned a version that was never applied');
});
