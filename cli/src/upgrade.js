// upgrade.js — `clodexctl upgrade <ctx>`: move an EXISTING deployment to a new
// version. Not a deploy, not a create.
//
// The verb is deliberately THIN. Everything an upgrade needs to do to a node —
// reuse the release's wire token, preserve its claude auth, carry its prior
// helm values forward (t54), stage secrets into 0600 tempfiles, verify
// laptop-side, upsert the ctx — already exists in deploy.js and is already
// correct for an upgrade. Re-implementing it here would fork the most
// security-sensitive code in the CLI into a second copy that drifts from the
// day it lands. So `upgrade` does the four things `deploy` cannot do, then
// DELEGATES to the flavor's deploy verb:
//
//   1. ROUTE on entry.deploy.flavor (t54's field) — never on the transport.
//      The ssh flavor and a remote `deploy docker` save byte-identical
//      `{ssh: user@host}` entries, so sniffing the transport is a guess.
//   2. REFUSE TO CREATE. An upgrade against something that isn't there is an
//      error, not a silent install — so existence is probed BEFORE the
//      delegate runs, and the delegate can therefore never reach its install
//      path.
//   3. REPORT the version it is moving FROM and TO, and no-op when equal.
//   4. FORCE the image pin EXPLICIT, which is the entire point of the verb.
//      (For fargate that is load-bearing: see FARGATE below.)
//
// STANDALONE, like the rest of cli/: node:* + sibling CLI modules only, never
// an app require(). No secret VALUE ever enters argv, logs or errors — the
// delegates uphold that and this module never reads a secret at all (the ctx
// token it uses for the version probe is already in memory, and only rides an
// Authorization header).
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

// The flavors this build can ROUTE. Deliberately not contexts.js's validator:
// t55 made enum membership advisory there (an unknown flavor is stored and
// carried without complaint, so a newer clodexctl's context stays usable for
// every verb that doesn't care), and put the refusal HERE — at the one verb
// that must actually dispatch on the value.
const UPGRADABLE = ['ssh', 'ssm', 'helm', 'fargate'];
// Known, but refused with a reason rather than a "newer clodexctl" message.
const KNOWN_UNSUPPORTED = ['docker'];

// ── the packaged version pins ────────────────────────────────────────────────
//
// The TARGET version comes from the PACKAGED ASSET, not from package.json. The
// asset is what actually deploys; if the two ever drifted, the asset is the
// truth and package.json would be a comforting lie. Both readers use the SAME
// anchors scripts/release.sh:sync_pin edits, and both insist on EXACTLY ONE
// match for the same reason sync_pin does: a restructured file that no longer
// matches means the pin is no longer being maintained, and a silent fallback
// would upgrade nodes to a stale version forever.
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

// The VERSION half of a full image reference — what a `hello.version` can be
// compared against. `repo:tag` → tag; `repo@sha256:…` → null (a digest names no
// version, so the no-op comparison is skipped rather than faked).
function refVersion(ref) {
  const s = String(ref || '');
  if (s.includes('@')) return null;
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  return colon > slash ? s.slice(colon + 1) : null;
}

// Replace the tag of a full image reference, keeping its repository. Used to
// turn `--tag T` into a fargate ImageUri without hardcoding the registry — the
// repository comes from the packaged pin, which is the one we ship.
function withTag(ref, tag) {
  const s = String(ref || '');
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  const slash = base.lastIndexOf('/');
  const colon = base.lastIndexOf(':');
  const repo = colon > slash ? base.slice(0, colon) : base;
  return `${repo}:${tag}`;
}

// ── argv builders (pure) ─────────────────────────────────────────────────────
// Local rather than reused from undeploy.js: upgrade must not depend on the
// TEARDOWN module for a read-only lookup — the dependency would read as though
// an upgrade were part of a delete flow, and the two calls answer different
// questions (undeploy's is a preview of what dies).
function stackDescribeArgs({ stackName, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'cloudformation', 'describe-stacks',
    '--stack-name', stackName, '--output', 'json'];
}

// describe-stacks JSON → the first stack's { ParameterKey: ParameterValue }.
// Best-effort on shape; a stack with no Parameters yields {}.
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

// ── the running version ──────────────────────────────────────────────────────
// `hello.version` over the ctx's REAL transport — the honest "what is actually
// running". Never persisted, so never stale; better than any stored guess.
// Returns null on any failure: see the call site for why that is not fatal.
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

// ── the verb ─────────────────────────────────────────────────────────────────
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

  // 2. EXISTENCE + 3. FROM/TO, per flavor. Each arm returns the plan.
  const plan = await buildPlan({ flavor, ctxName, entry, dep, flags, io, printer, execFn, log });

  // 3b. Report FROM → TO, and no-op when they are equal.
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

  // 4. DELEGATE. The delegate's own --dry-run prints its plan and touches
  //    nothing, so --dry-run rides straight through on the same footing as
  //    `deploy`'s — this module's own probes above are read-only.
  if (!json) log(dryRun ? `dry-run — the ${flavor} deploy path would run:` : `upgrading via the ${flavor} deploy path…`);
  await plan.run();
  if (json) emit({ type: 'upgrade', ok: true, ctx: ctxName, flavor, from: from || null, to: to || null, dryRun });
  return EXIT.OK;
}

// The docker refusal, stated as a reason rather than a shrug.
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

// ── per-flavor planning ──────────────────────────────────────────────────────
async function buildPlan({ flavor, ctxName, entry, dep, flags, io, printer, execFn, log }) {
  if (flavor === 'helm') return planHelm({ ctxName, entry, dep, flags, io, printer, execFn, log });
  if (flavor === 'fargate') return planFargate({ ctxName, entry, dep, flags, io, printer, execFn, log });
  return planInstaller({ flavor, ctxName, entry, dep, flags, io, printer, log });
}

// ── helm ─────────────────────────────────────────────────────────────────────
// The main event. `helm upgrade` with t54's carried values plus an EXPLICIT
// image pin. The pin rides --set, which helm applies after every values file
// regardless of argv position — so it beats a carried `image.tag` by helm's own
// merge rule, which is precisely the precedence t54 established and tested.
async function planHelm({ ctxName, entry, dep, flags, io, printer, execFn, log }) {
  const release = String(dep.release || ctxName);
  const namespace = String(dep.namespace || flags.namespace || D.DEFAULT_HELM_NAMESPACE);
  const kubeContext = dep.kubeContext ? String(dep.kubeContext) : (flags['kube-context'] ? String(flags['kube-context']) : null);

  // REFUSE TO CREATE: the same `helm status` probe deployHelmVerb uses.
  try {
    await D.runVendor(execFn, D.helmStatusArgs({ name: release, namespace, kubeContext }), 'status', EXIT.USAGE);
  } catch (e) {
    if (/not found/i.test(e.message || '')) {
      throw new CliError(EXIT.USAGE, `release "${release}" is not installed in namespace "${namespace}" — upgrade moves an existing deployment, it does not create one. Install it with: clodexctl deploy helm ${release} --namespace ${namespace}${kubeContext ? ` --kube-context ${kubeContext}` : ''}`);
    }
    throw new CliError(EXIT.CONNECT, `could not determine whether release "${release}" exists (helm status failed for a reason other than not-found) — check cluster access and re-run: ${e.message}`);
  }

  // TO: an explicit --tag/--image, else an image pin the operator already set
  // by hand, else the packaged chart's own tag.
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
  // The pin goes LAST among --set: helm applies sets in argv order, last wins,
  // so an operator --set on THIS run that we did not detect still loses to the
  // pin only when the pin is the thing they asked for. When they DID say
  // image.tag themselves, `pin` is null and their value simply stands.
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

// The last `k=v` for key k in a --set list (helm's own last-wins), or null.
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

  // REFUSE TO CREATE: describe-stacks. Its Parameters are also what keeps the
  // re-deploy from silently moving the node (below), so this one call does
  // double duty.
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

  // TO: --image is the full URI; --tag re-tags the packaged pin's repository
  // (so the registry comes from the asset we ship, never a hardcoded literal).
  const pinned = fargatePinnedImage();
  let toRef; let targetLine;
  if (flags.image) { toRef = String(flags.image); targetLine = `${toRef} (--image)`; }
  else if (flags.tag) { toRef = withTag(pinned, String(flags.tag)); targetLine = `${toRef} (--tag)`; }
  else { toRef = pinned; targetLine = `${toRef} (the template this clodexctl ships)`; }
  const toVersion = refVersion(toRef);

  const warnings = [];
  const from = await probeFrom({ entry, io, log, warnings });

  // Carry the ALWAYS-EMITTED parameters forward from the live stack.
  //
  // `aws cloudformation deploy` reuses a prior parameter value for anything not
  // overridden — which is exactly why the missing ImageUri no-ops silently. But
  // fargateParamOverrides ALWAYS emits ClusterName and Persistent (computed
  // from this run's flags), and auto-detects SubnetIds/SecurityGroupId when
  // those flags are absent. So a flagless re-deploy would overwrite four
  // settings that CFN would otherwise have kept — worst case moving the task
  // onto default-VPC subnets. Feeding the prior values back as flags both
  // preserves them and skips the auto-detect's AWS calls entirely.
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

// The ECS cluster a fargate ctx reaches through (`{ssm:{ecs:'CLUSTER/FAMILY'}}`).
// The stack's own ClusterName is preferred; this is the fallback for a stack
// whose parameter list we could not read.
function clusterFromEcs(entry) {
  const ecs = entry && entry.ssm && entry.ssm.ecs;
  return (typeof ecs === 'string' && ecs.includes('/')) ? ecs.split('/')[0] : null;
}

// ── ssh / ssm: the re-runnable installer flavors ─────────────────────────────
// Both drive the same idempotent installer, so an upgrade is close to a thin
// alias — but "close to" is where the honesty lives:
//
//   * Neither flavor deploys a PINNED artifact. The installer clones
//     <repo>@<branch> and builds the tip, so there is no target version to
//     read and no equality to no-op on. Saying that is honest; inventing a
//     target from package.json would not be.
//   * Flags that are not stored REVERT on a re-run (--no-wirescope, --repo,
//     --branch, --src, --ssh-opt, --claude-token-file). They are named, every
//     time, before anything runs.
//   * `deploy ssm` MINTS A FRESH WIRE TOKEN on every run, so an ssm upgrade
//     ROTATES the token. Ours is rewritten with it; any other holder breaks.
async function planInstaller({ flavor, ctxName, entry, dep, flags, io, printer, log }) {
  const port = entry.remotePort ? Number(entry.remotePort) : null;
  if (flags.tag || flags.image) {
    throw new CliError(EXIT.USAGE, `--${flags.tag ? 'tag' : 'image'} does not apply to the ${flavor} flavor — it installs from source, not from a container image. The version knob is --branch (default ${D.DEFAULT_BRANCH}).`);
  }

  // REFUSE TO CREATE, as far as this flavor can be asked. There is no cheap
  // probe that separates "installed but down" from "never installed" — the
  // installer IS the create path — so a node that answers proves existence, and
  // a node that does not is refused rather than silently installed. --force is
  // the way through, because "it is down and I want the installer to repair it"
  // is a real and common case.
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

// The FROM probe, shared. A failure is NEVER fatal here: refusing to upgrade a
// node that cannot be reached would block the very upgrade that repairs it, and
// re-running a deploy at the version already installed is idempotent. So the
// probe warns and the caller decides (the installer flavors treat a silent node
// as "cannot confirm it exists" and gate on --force; helm and fargate already
// proved existence against the cluster/stack itself).
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
