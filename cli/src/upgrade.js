// Standalone, like the rest of cli/: node:* + sibling CLI modules only, never an
// app require(). Routing is on entry.deploy.flavor and never on the transport —
// an ssh deploy and a remote docker deploy store byte-identical ssh entries.
'use strict';

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { CliError, EXIT } = require('./errors');
const { openTransport } = require('./transport');
const { WireClient } = require('./client');
const contexts = require('./contexts');
const D = require('./deploy');

const execFileP = promisify(execFile);

// Deliberately not contexts.js's validator: unknown flavors are stored there
// without complaint, so the refusal lives at the one verb that dispatches.
const UPGRADABLE = ['ssh', 'ssm', 'helm', 'fargate'];
const KNOWN_UNSUPPORTED = ['docker'];

// The target version comes from the PACKAGED ASSET, not package.json, and both
// regexes match the anchors scripts/release.sh:sync_pin edits.
const HELM_TAG_RE = /^ {2}tag: "([^"]+)"$/m;
const FARGATE_IMAGE_RE = /^ {4}Default: '(ghcr\.io\/avirtual\/clodex:[^']+)'$/m;

function readPinned(file, re, what) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (e) { throw new CliError(EXIT.SERVER, `packaged ${what} unreadable at ${file} (${e.message}) — broken install?`); }
  const all = raw.match(new RegExp(re.source, 'gm')) || [];
  if (all.length !== 1) {
    throw new CliError(EXIT.SERVER, `packaged ${what} (${file}): the version pin matched ${all.length} times, expected exactly 1 — the file was restructured, so this build cannot tell what version it ships; upgrade clodexctl`);
  }
  return re.exec(raw)[1];
}

function helmPinnedTag() { return readPinned(path.join(D.helmChartPath(), 'values.yaml'), HELM_TAG_RE, 'helm chart'); }
function fargatePinnedImage() { return readPinned(D.fargateTemplatePath(), FARGATE_IMAGE_RE, 'fargate template'); }

function refVersion(ref) {
  const s = String(ref || '');
  if (s.includes('@')) return null;
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  return colon > slash ? s.slice(colon + 1) : null;
}

function withTag(ref, tag) {
  const s = String(ref || '');
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  const repo = colon > slash ? base.slice(0, colon) : base;
  return `${repo}:${tag}`;
}

function stackDescribeArgs({ stackName, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'cloudformation', 'describe-stacks',
    '--stack-name', stackName, '--output', 'json'];
}

function stackParams(json) {
  let stack;
  try { const o = JSON.parse(json || '{}'); stack = (Array.isArray(o.Stacks) ? o.Stacks : [])[0]; }
  catch { return {}; }
  const out = {};
  for (const p of (stack && stack.Parameters) || []) {
    if (p && p.ParameterKey != null) out[p.ParameterKey] = p.ParameterValue;
  }
  return out;
}

async function probeRunningVersion(entry, { spawnFn, execFn } = {}) {
  const t = await openTransport(entry, { spawnFn, execFn });
  try {
    const client = new WireClient(t.baseUrl, entry.token || null);
    const hello = await client.get('/api/peer/hello', 'upgrade (version probe)');
    return (hello && hello.version) ? String(hello.version) : null;
  } finally {
    try { t.close(); } catch {}
  }
}

async function upgradeVerb({ printer, flags, args, io = {} }) {
  const json = !!flags.json;
  const emit = (o) => printer.json(o);
  const log = (s) => { if (!json) printer.line(s); };
  const dryRun = !!flags['dry-run'];

  // Context selection mirrors `web [ctx]`: a positional, else --ctx, else the
  // current one. Resolved against the FILE only — env/flag overrides describe a
  // transport, and an upgrade needs the stored deploy record, which they cannot
  // carry.
  const store = contexts.load(io.contextsFile, { warn: () => {} });
  const ctxName = args[0] ? String(args[0]) : (flags.ctx ? String(flags.ctx) : store.current);
  if (!ctxName) {
    throw new CliError(EXIT.USAGE, 'upgrade needs a context — `clodexctl upgrade <ctx>` (or set one with `clodexctl ctx use …`)');
  }
  const entry = store.contexts[ctxName];
  if (!entry) throw new CliError(EXIT.USAGE, `no such context: ${ctxName}`);

  // 1. ROUTE — on the stored flavor, never on the transport.
  const dep = entry.deploy;
  if (!dep || typeof dep !== 'object' || !dep.flavor) {
    throw new CliError(EXIT.USAGE,
      `context "${ctxName}" does not record how it was deployed, so upgrade cannot tell which path to take — it was created before clodexctl stored that (or by hand). Re-run the flavor's deploy instead: it upgrades in place and stamps the record, so this works next time. Which flavor it is is the one thing this build cannot determine, and guessing it from the transport is exactly the ambiguity the record exists to remove (an ssh deploy and a remote docker deploy save identical transports).`);
  }
  const flavor = String(dep.flavor);
  if (KNOWN_UNSUPPORTED.includes(flavor)) {
    throw new CliError(EXIT.USAGE, refusalFor(flavor, ctxName, dep));
  }
  if (!UPGRADABLE.includes(flavor)) {
    throw new CliError(EXIT.USAGE,
      `context "${ctxName}" records deploy flavor "${flavor}", which this clodexctl cannot upgrade — a newer clodexctl probably wrote it. Upgrade clodexctl, or re-run that flavor's own deploy command. (The context itself is fine and every other verb still works with it.)`);
  }

  const execFn = io.execFn || execFileP;
  const ctxLine = `context "${ctxName}" — deploy flavor ${flavor}`;
  if (!json) log(ctxLine);

  const plan = await buildPlan({ flavor, ctxName, entry, dep, flags, io, printer, execFn, log });

  const from = plan.from;
  const to = plan.toVersion;
  if (json) emit({ type: 'version', from: from || null, to: to || null, target: plan.toRef || null, comparable: !!(from && to) });
  else {
    log(`running: ${from || '(unknown — the node did not answer)'}`);
    log(`target:  ${plan.targetLine}`);
  }
  if (from && to && from === to && !flags.force) {
    if (json) emit({ type: 'no-op', reason: 'already at target', version: from });
    else printer.line(`already running ${from} — nothing to do (--force re-runs anyway)`);
    return EXIT.OK;
  }
  for (const w of plan.warnings) {
    if (json) emit({ type: 'warning', text: w }); else printer.line(`  WARNING: ${w}`);
  }
  for (const r of plan.reverts) {
    if (json) emit({ type: 'reverts', text: r }); else printer.line(`  note: ${r}`);
  }

  if (!json) log(dryRun ? `dry-run — the ${flavor} deploy path would run:` : `upgrading via the ${flavor} deploy path…`);
  await plan.run();
  if (json) emit({ type: 'upgrade', ok: true, ctx: ctxName, flavor, from: from || null, to: to || null, dryRun });
  return EXIT.OK;
}

function refusalFor(flavor, ctxName, dep) {
  const container = dep.container || `clodexctl-${ctxName}`;
  const host = dep.dockerHost ? ` --host ${dep.dockerHost}` : '';
  return [
    `context "${ctxName}" is a docker node, and upgrade deliberately does NOT handle that flavor — not because it is hard, but because it cannot be done honestly from what is stored.`,
    `A container cannot be upgraded in place: it is remove-and-recreate. The recreate needs the run arguments you gave the original deploy — --env-file, extra --volume mounts, --port, --no-wirescope — and NONE of them are stored, because a context records identifying names, not a command line to replay.`,
    `They are not recoverable either: the env-file exists precisely so secrets never cross argv (docker reads it, clodexctl never opens it), and reconstructing the run from \`docker inspect\` would mean spelling every resolved secret into a -e KEY=VALUE. That is the one line this subsystem does not cross.`,
    `So do it in two steps, with the flags only you have:`,
    `  clodexctl undeploy docker ${ctxName}${host} --keep-data`,
    `  clodexctl deploy docker ${ctxName}${host} --tag <version> [--env-file … --volume … ]`,
    `(--keep-data keeps the ${container}-data volume, so the node's state survives the recreate.)`,
  ].join('\n');
}

async function buildPlan({ flavor, ctxName, entry, dep, flags, io, printer, execFn, log }) {
  if (flavor === 'helm') return planHelm({ ctxName, entry, dep, flags, io, printer, execFn, log });
  if (flavor === 'fargate') return planFargate({ ctxName, entry, dep, flags, io, printer, execFn, log });
  return planInstaller({ flavor, ctxName, entry, dep, flags, io, printer, log });
}

// helm applies every --set after every -f values file regardless of argv order,
// and among --set the last wins — hence the pin is appended last.
async function planHelm({ ctxName, entry, dep, flags, io, printer, execFn, log }) {
  const release = String(dep.release || ctxName);
  const namespace = String(dep.namespace || flags.namespace || D.DEFAULT_HELM_NAMESPACE);
  const kubeContext = dep.kubeContext ? String(dep.kubeContext) : (flags['kube-context'] ? String(flags['kube-context']) : null);

  try {
    await D.runVendor(execFn, D.helmStatusArgs({ name: release, namespace, kubeContext }), 'status', EXIT.USAGE);
  } catch (e) {
    if (/not found/i.test(e.message || '')) {
      throw new CliError(EXIT.USAGE, `release "${release}" is not installed in namespace "${namespace}" — upgrade moves an existing deployment, it does not create one. Install it with: clodexctl deploy helm ${release} --namespace ${namespace}${kubeContext ? ` --kube-context ${kubeContext}` : ''}`);
    }
    throw new CliError(EXIT.CONNECT, `could not determine whether release "${release}" exists (helm status failed for a reason other than not-found) — check cluster access and re-run: ${e.message}`);
  }

  const userSets = Array.isArray(flags.set) ? flags.set.map(String) : (flags.set ? [String(flags.set)] : []);
  const setTag = lastSetValue(userSets, 'image.tag');
  const setDigest = lastSetValue(userSets, 'image.digest');
  let pin = null;            // the --set we ADD (null when the operator already said it)
  let toRef; let toVersion; let targetLine;
  if (flags.image) {
    const ref = String(flags.image);
    const at = ref.indexOf('@');
    pin = at >= 0
      ? [`image.repository=${ref.slice(0, at)}`, `image.digest=${ref.slice(at + 1)}`, 'image.tag=']
      : [`image.repository=${withTag(ref, '').replace(/:$/, '')}`, `image.tag=${refVersion(ref) || ''}`];
    toRef = ref; toVersion = refVersion(ref); targetLine = `${ref} (--image)`;
  } else if (flags.tag) {
    toVersion = String(flags.tag); toRef = toVersion;
    pin = [`image.tag=${toVersion}`];
    targetLine = `${toVersion} (--tag)`;
  } else if (setDigest) {
    toRef = setDigest; toVersion = null;
    targetLine = `${setDigest} (your --set image.digest — a digest names no version, so nothing is compared)`;
  } else if (setTag) {
    toVersion = setTag; toRef = setTag;
    targetLine = `${setTag} (your --set image.tag on this run)`;
  } else {
    toVersion = helmPinnedTag(); toRef = toVersion;
    pin = [`image.tag=${toVersion}`];
    targetLine = `${toVersion} (the chart this clodexctl ships)`;
  }

  const from = await probeFrom({ entry, io, log, warnings: [] });
  const sets = pin ? [...userSets, ...pin] : userSets;

  return {
    from: from.version, toVersion, toRef, targetLine,
    warnings: from.warnings,
    // Nothing reverts: t54's carry-forward re-applies every prior override, and
    // the wire token / claude auth are reused by deployHelmVerb itself. The
    // port is deliberately NOT passed as a flag — the carried wirePort restores
    // it, and passing a flag would make this run's silence look like a choice.
    reverts: [],
    run: () => D.deployHelmVerb({
      printer, flags: { ...flags, force: true, set: sets, namespace, 'kube-context': kubeContext },
      args: [release], io,
    }),
  };
}

function lastSetValue(sets, key) {
  let out = null;
  for (const s of sets) {
    const m = new RegExp(`^${key.replace(/\./g, '\\.')}=(.*)$`).exec(s);
    if (m) out = m[1].trim();
  }
  return out || null;
}

// ── fargate ──────────────────────────────────────────────────────────────────
// ImageUri must be passed EXPLICITLY and UNCONDITIONALLY. Omitting it makes
// CloudFormation reuse the prior stack value, and --no-fail-on-empty-changeset
// then reports SUCCESS — a silent no-op upgrade, which is worse than a failure
// because it looks like it worked.
async function planFargate({ ctxName, entry, dep, flags, io, printer, execFn, log }) {
  const stackName = String(dep.stack || ctxName);
  const region = flags.region ? String(flags.region) : (dep.region ? String(dep.region) : null);
  const profile = flags.profile ? String(flags.profile) : (dep.profile ? String(dep.profile) : null);

  let raw;
  try {
    raw = await D.runAws(execFn, stackDescribeArgs({ stackName, region, profile }), 'cloudformation describe-stacks', EXIT.SERVER);
  } catch (e) {
    if (e instanceof CliError && /does not exist|ValidationError/i.test(e.message)) {
      throw new CliError(EXIT.USAGE, `stack "${stackName}" does not exist in ${region || 'the default region'} — upgrade moves an existing deployment, it does not create one. Create it with: clodexctl deploy fargate ${stackName}${region ? ` --region ${region}` : ''}`);
    }
    throw e;
  }
  const prior = stackParams(raw);

  const pinned = fargatePinnedImage();
  let toRef; let targetLine;
  if (flags.image) { toRef = String(flags.image); targetLine = `${toRef} (--image)`; }
  else if (flags.tag) { toRef = withTag(pinned, String(flags.tag)); targetLine = `${toRef} (--tag)`; }
  else { toRef = pinned; targetLine = `${toRef} (the template this clodexctl ships)`; }
  const toVersion = refVersion(toRef);

  const warnings = [];
  const from = await probeFrom({ entry, io, log, warnings });

  // CloudFormation reuses a prior parameter value for anything not overridden, but
  // the fargate param builder ALWAYS emits ClusterName and Persistent and
  // auto-detects SubnetIds/SecurityGroupId, so a flagless re-deploy would overwrite
  // all four — worst case moving the task onto default-VPC subnets.
  const cluster = flags.cluster ? String(flags.cluster)
    : (prior.ClusterName || clusterFromEcs(entry) || stackName);
  const persistent = flags.persistent != null ? flags.persistent
    : (prior.Persistent != null ? String(prior.Persistent) : 'true');
  const subnets = flags.subnets ? String(flags.subnets) : (prior.SubnetIds || null);
  const securityGroup = flags['security-group'] ? String(flags['security-group']) : (prior.SecurityGroupId || null);
  const assignPublicIp = flags['assign-public-ip'] ? String(flags['assign-public-ip']) : (prior.AssignPublicIp || null);
  if (!subnets || !securityGroup) {
    warnings.push(`the live stack does not report SubnetIds/SecurityGroupId, so this re-deploy will auto-detect them from the default VPC — if the node runs in a custom VPC, pass --subnets and --security-group explicitly to keep it there`);
  }

  return {
    from: from.version, toVersion, toRef, targetLine, warnings,
    reverts: [`carrying the live stack's networking and Persistent settings forward (cluster ${cluster}${subnets ? `, subnets ${subnets}` : ''}${securityGroup ? `, sg ${securityGroup}` : ''}) — everything else CloudFormation keeps by itself`],
    run: () => D.deployFargateVerb({
      printer,
      flags: {
        ...flags, force: true, image: toRef, cluster, persistent,
        ...(subnets ? { subnets } : {}), ...(securityGroup ? { 'security-group': securityGroup } : {}),
        ...(assignPublicIp ? { 'assign-public-ip': assignPublicIp } : {}),
        ...(region ? { region } : {}), ...(profile ? { profile } : {}),
        ctx: ctxName,
      },
      args: [stackName], io,
    }),
  };
}

function clusterFromEcs(entry) {
  const ecs = entry && entry.ssm && entry.ssm.ecs;
  return (typeof ecs === 'string' && ecs.includes('/')) ? ecs.split('/')[0] : null;
}

async function planInstaller({ flavor, ctxName, entry, dep, flags, io, printer, log }) {
  const port = entry.remotePort ? Number(entry.remotePort) : null;
  if (flags.tag || flags.image) {
    throw new CliError(EXIT.USAGE, `--${flags.tag ? 'tag' : 'image'} does not apply to the ${flavor} flavor — it installs from source, not from a container image. The version knob is --branch (default ${D.DEFAULT_BRANCH}).`);
  }

  const warnings = [];
  const from = await probeFrom({ entry, io, log, warnings });
  if (!from.version && !flags.force) {
    throw new CliError(EXIT.CONNECT, `context "${ctxName}" did not answer, so this build cannot confirm a node is there to upgrade (${from.error || 'no response'}) — and upgrade refuses to silently INSTALL one. If the node is merely down and you want the installer to repair it, re-run with --force; if it was never deployed, use: clodexctl deploy ${flavor === 'ssm' ? `ssm ${ctxName} --target <i-…>` : String(dep.host || entry.ssh || ctxName)}`);
  }

  const reverts = [
    `flags that are not stored in a context REVERT on a re-run — --no-wirescope, --repo, --branch${flavor === 'ssh' ? ', --src, --ssh-opt' : ''} and --claude-token-file. If you set any of them at deploy time, pass them again here; otherwise the node returns to the defaults.`,
  ];
  if (flavor === 'ssm') {
    warnings.push('`deploy ssm` MINTS A FRESH WIRE TOKEN on every run, so this upgrade will ROTATE it. This context is rewritten with the new token, but any OTHER holder of the old one — a second machine\'s context, a GUI peer row, a script — stops being able to reach the node until you re-share it.');
  }

  const targetLine = `whatever ${flags.branch ? `branch "${String(flags.branch)}"` : `branch "${D.DEFAULT_BRANCH}"`} currently builds — the ${flavor} installer tracks a branch and deploys no pinned artifact, so there is no version to compare and this never no-ops`;

  if (flavor === 'ssm') {
    const target = dep.target ? String(dep.target) : (flags.target ? String(flags.target) : null);
    if (!target) throw new CliError(EXIT.USAGE, `context "${ctxName}" records an ssm deploy but no --target instance — pass --target i-… (the record predates it, or was hand-edited)`);
    return {
      from: from.version, toVersion: null, toRef: null, targetLine, warnings, reverts,
      run: () => D.deploySsmVerb({
        printer,
        flags: { ...flags, force: true, target,
          ...(dep.region && !flags.region ? { region: String(dep.region) } : {}),
          ...(dep.profile && !flags.profile ? { profile: String(dep.profile) } : {}),
          ...(port && flags.port == null ? { port } : {}) },
        args: [ctxName], io,
      }),
    };
  }

  const host = dep.host ? String(dep.host) : (entry.ssh ? String(entry.ssh) : null);
  if (!host) throw new CliError(EXIT.USAGE, `context "${ctxName}" records an ssh deploy but no host to reach — re-run \`clodexctl deploy <user@host>\` to restamp it`);
  return {
    from: from.version, toVersion: null, toRef: null, targetLine, warnings, reverts,
    run: () => D.deployVerb({
      printer,
      // --name pins the ctx this updates. Without it deployVerb re-derives a
      // name from the host, which need not equal the context we were asked to
      // upgrade — and would then write a SECOND entry beside it.
      flags: { ...flags, force: true, name: ctxName, ...(port && flags.port == null ? { port } : {}) },
      args: [host], io,
    }),
  };
}

// A probe failure must never be fatal here: refusing to upgrade an unreachable
// node would block the very upgrade that repairs it. The caller decides.
async function probeFrom({ entry, io, log, warnings }) {
  try {
    const probe = io.probeVersion || probeRunningVersion;
    const version = await probe(entry, { spawnFn: io.spawnFn, execFn: io.execFn });
    return { version, warnings, error: null };
  } catch (e) {
    warnings.push(`could not read the running version (${e.message}) — proceeding without a FROM/TO comparison`);
    return { version: null, warnings, error: e.message };
  }
}

module.exports = {
  upgradeVerb, UPGRADABLE, KNOWN_UNSUPPORTED,
  helmPinnedTag, fargatePinnedImage, refVersion, withTag,
  stackDescribeArgs, stackParams, clusterFromEcs, lastSetValue, probeRunningVersion,
};
