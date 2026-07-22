// undeploy.js — `clodexctl undeploy <fargate <stack>|helm <name>|docker <name>>`:
// the destructive inverse of `deploy`. Teardown is one command with the same
// reviewable-argv discipline deploy upholds — --dry-run prints every command and
// runs nothing destructive (read-only lookups are fine), and the real run gates
// on a type-the-name confirmation before anything is deleted.
//
// Every AWS/helm/kubectl/docker call rides the SAME exec seams deploy uses
// (deploy.js's runAws / runVendor / runDocker — never a shell), so no secret
// value ever crosses argv (the flow never reads a secret to begin with).
//
// ssh/ssm are deliberately unsupported: their teardown needs an uninstall mode
// in the shipped, byte-pinned installer catalog (a separate task) — they get an
// honest USAGE error pointing at the manual path.
'use strict';

const { promisify } = require('util');
const { execFile } = require('child_process');
const { CliError, EXIT } = require('./errors');
const contexts = require('./contexts');
const D = require('./deploy');

const execFileP = promisify(execFile);

// StatefulSet PVCs carry the chart's selectorLabels (verified from
// cli/deploy/helm/clodex/templates/_helpers.tpl `clodex.selectorLabels`): the
// controller merges spec.selector.matchLabels onto each created PVC.
const HELM_PVC_SELECTOR = (name) => `app.kubernetes.io/instance=${name},app.kubernetes.io/name=clodex`;
// The StatefulSet's volumeClaimTemplate is `name: state` → PVC `state-<release>-0`.
const HELM_PVC_NAME = (name) => `state-${name}-0`;

// ── shared: confirm gate ─────────────────────────────────────────────────────
// The destructive gate. --force skips it (scripts); --json is scripted use → it
// too requires --force (never destroy silently in a pipe, the `kill` rule); a
// non-TTY without --force is refused for the same reason. Otherwise prompt on
// stdin and require an exact name echo. Throws CliError(USAGE) on any refusal.
async function confirmTeardown({ name, noun, flags, io }) {
  if (flags.force) return;
  if (flags.json) throw new CliError(EXIT.USAGE, `undeploy needs --force in --json/non-interactive mode (teardown is a destructive, unrecoverable delete)`);
  const isTTY = io.isTTY != null ? io.isTTY : !!(process.stdin && process.stdin.isTTY);
  if (!isTTY) throw new CliError(EXIT.USAGE, `undeploy needs --force in non-interactive mode (no TTY to confirm this destructive delete)`);
  const prompt = io.prompt || defaultPrompt;
  const ans = await prompt(`type the ${noun} name "${name}" to confirm teardown (this is a HARD DELETE): `);
  if (String(ans).trim() !== name) throw new CliError(EXIT.USAGE, 'aborted — confirmation did not match');
}

function defaultPrompt(question) {
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

// ── shared: ctx cleanup ──────────────────────────────────────────────────────
// One helper for all flavors (unit-tested once). Removes every stored context
// the matchFn selects; clears store.current when it named a removed one.
// --keep-ctx opts out. A missing/unreadable store is tolerated (nothing to do).
function ctxCleanup({ flags, printer, io, matchFn }) {
  const json = !!flags.json;
  const emit = (o) => printer.json(o);
  if (flags['keep-ctx']) {
    if (json) emit({ type: 'context', action: 'kept', reason: '--keep-ctx' });
    else printer.line('context kept (--keep-ctx)');
    return;
  }
  const store = safeLoadContexts(io);
  const removed = [];
  for (const [name, entry] of Object.entries(store.contexts)) {
    if (matchFn(name, entry)) removed.push(name);
  }
  if (!removed.length) {
    if (json) emit({ type: 'context', action: 'none' });
    else printer.line('no matching context to remove');
    return;
  }
  let clearedCurrent = false;
  for (const name of removed) {
    delete store.contexts[name];
    if (store.current === name) { store.current = null; clearedCurrent = true; }
  }
  contexts.save(store, io.contextsFile);
  if (json) emit({ type: 'context', action: 'removed', names: removed, clearedCurrent });
  else printer.line(`removed context ${removed.map((n) => `"${n}"`).join(', ')}${clearedCurrent ? ' (was current — cleared)' : ''}`);
}

function safeLoadContexts(io) {
  try { return contexts.load(io.contextsFile, { warn: () => {} }); }
  catch { return { current: null, contexts: {} }; }
}

// ── argv builders (pure; leading tool token doubles as exec + dry-run display) ─
// awsBase order (profile before region) matches the deploy flavors.
function describeStacksArgs({ stackName, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'cloudformation', 'describe-stacks', '--stack-name', stackName, '--output', 'json'];
}
function describeStackResourcesArgs({ stackName, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'cloudformation', 'describe-stack-resources', '--stack-name', stackName, '--output', 'json'];
}
function ecsListTasksArgs({ cluster, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'ecs', 'list-tasks', '--cluster', cluster, '--output', 'json'];
}
function ecsDescribeTasksArgs({ cluster, tasks = [], region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'ecs', 'describe-tasks', '--cluster', cluster, '--tasks', ...tasks, '--output', 'json'];
}
function ecsStopTaskArgs({ cluster, task, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'ecs', 'stop-task', '--cluster', cluster, '--task', task];
}
function deleteStackArgs({ stackName, region, profile } = {}) {
  return ['aws', ...D.awsBase({ region, profile }), 'cloudformation', 'delete-stack', '--stack-name', stackName];
}
function helmGetManifestArgs({ name, namespace, kubeContext = null } = {}) {
  return ['helm', 'get', 'manifest', name, '--namespace', namespace, ...(kubeContext ? ['--kube-context', kubeContext] : [])];
}
function helmUninstallArgs({ name, namespace, kubeContext = null } = {}) {
  return ['helm', 'uninstall', name, '--namespace', namespace, ...(kubeContext ? ['--kube-context', kubeContext] : [])];
}
function kubectlDeletePvcArgs({ name, namespace, kubeContext = null } = {}) {
  return ['kubectl', ...(kubeContext ? ['--context', kubeContext] : []), '-n', namespace, 'delete', 'pvc', '-l', HELM_PVC_SELECTOR(name)];
}
// docker argv WITHOUT the leading 'docker' (runDocker prepends the binary).
function dockerInspectArgs({ name } = {}) { return ['inspect', D.CONTAINER_PREFIX + name]; }
function dockerRmArgs({ name } = {}) { return ['rm', '-f', D.CONTAINER_PREFIX + name]; }
function dockerVolumeRmArgs({ volume } = {}) { return ['volume', 'rm', volume]; }

// ── parse helpers ────────────────────────────────────────────────────────────
function parseStacks(json) {
  try { const o = JSON.parse(json || '{}'); return Array.isArray(o.Stacks) ? o.Stacks : []; }
  catch { return []; }
}
function stackParam(stack, key) {
  const p = (stack && stack.Parameters) || [];
  const hit = p.find((x) => x && x.ParameterKey === key);
  return hit ? hit.ParameterValue : null;
}
function parseStackResources(json) {
  try { const o = JSON.parse(json || '{}'); return Array.isArray(o.StackResources) ? o.StackResources : []; }
  catch { return []; }
}
function parseTaskArns(json) {
  try { const o = JSON.parse(json || '{}'); return Array.isArray(o.taskArns) ? o.taskArns : []; }
  catch { return []; }
}
function parseTasks(json) {
  try { const o = JSON.parse(json || '{}'); return Array.isArray(o.tasks) ? o.tasks : []; }
  catch { return []; }
}
// A service-owned task carries group "service:<name>" (verified: ECS stamps the
// service name there); it dies with the stack, so never double-stop it. A
// standalone run-task defaults to group "family:<taskdef>" — those block cluster
// teardown and must be stopped first.
function isServiceTask(task) { return typeof task.group === 'string' && task.group.startsWith('service:'); }

// ── dispatcher ───────────────────────────────────────────────────────────────
async function undeployVerb({ printer, flags, args, io = {} }) {
  const flavor = args[0];
  if (flavor === 'fargate') return undeployFargate({ printer, flags, args: args.slice(1), io });
  if (flavor === 'helm') return undeployHelm({ printer, flags, args: args.slice(1), io });
  if (flavor === 'docker') return undeployDocker({ printer, flags, args: args.slice(1), io });
  if (flavor === 'ssh' || flavor === 'ssm') {
    throw new CliError(EXIT.USAGE, `undeploy ${flavor} needs an uninstall mode in the installer script — not yet supported; remove by hand on the node: systemctl --user disable --now clodex.service`);
  }
  throw new CliError(EXIT.USAGE, `undeploy needs a flavor: fargate <stack> | helm <name> | docker <name> (got "${flavor || '(none)'}")`);
}

// ── fargate ──────────────────────────────────────────────────────────────────
async function undeployFargate({ printer, flags, args, io }) {
  const stackName = args[0];
  if (!stackName) throw new CliError(EXIT.USAGE, 'undeploy fargate needs a stack name (e.g. undeploy fargate clodex-node)');
  if (!D.FARGATE_STACK_RE.test(stackName)) throw new CliError(EXIT.USAGE, `bad stack name "${stackName}" — ${D.FARGATE_STACK_RE.source}`);

  const json = !!flags.json;
  const emit = (o) => printer.json(o);
  const log = (s) => { if (!json) printer.line(s); };
  const execFn = io.execFn || execFileP;

  // Region/profile: flag > the stack's own ctx entry (T55 pins ssm.region/profile
  // into fargate ctxs) > aws default. Say which source won.
  const ctxStore = safeLoadContexts(io);
  const ctxEntry = ctxStore.contexts[stackName];
  const ctxSsm = ctxEntry && ctxEntry.ssm && typeof ctxEntry.ssm === 'object' ? ctxEntry.ssm : null;
  let region = flags.region ? String(flags.region) : null;
  let regionSource = region ? '--region flag' : null;
  if (!region && ctxSsm && ctxSsm.region) { region = String(ctxSsm.region); regionSource = `ctx "${stackName}"`; }
  if (!region) regionSource = 'aws default';
  let profile = flags.profile ? String(flags.profile) : null;
  let profileSource = profile ? '--profile flag' : null;
  if (!profile && ctxSsm && ctxSsm.profile) { profile = String(ctxSsm.profile); profileSource = `ctx "${stackName}"`; }
  if (!profile) profileSource = 'aws default';

  // 1. Stack lookup (read-only — runs on dry-run too). SERVER as the base code:
  //    only a genuine not-found remaps to USAGE; a throttle/expired-creds failure
  //    must not masquerade as an operator mistake.
  let stack;
  try {
    const out = await D.runAws(execFn, describeStacksArgs({ stackName, region, profile }), 'cloudformation describe-stacks', EXIT.SERVER);
    stack = parseStacks(out)[0] || null;
  } catch (e) {
    if (e instanceof CliError && /does not exist|ValidationError/i.test(e.message)) {
      throw new CliError(EXIT.USAGE, `stack "${stackName}" not found in ${region || 'the default region'} — is the region right? (deploy pins the region into the ctx; try --region)`);
    }
    throw e;
  }
  if (!stack) throw new CliError(EXIT.USAGE, `stack "${stackName}" not found in ${region || 'the default region'} — is the region right? (try --region)`);
  log(`region: ${region || '(aws default)'} [${regionSource}] · profile: ${profile || '(aws default)'} [${profileSource}]`);

  // ClusterName the stack was deployed with (falls back to the ctx cluster-half,
  // then the stack name — the deploy's own default).
  const cluster = stackParam(stack, 'ClusterName')
    || (ctxSsm && ctxSsm.ecs && String(ctxSsm.ecs).includes('/') ? String(ctxSsm.ecs).split('/')[0] : null)
    || stackName;

  // 2. Preview: stack resources + any running tasks in the cluster.
  const resources = parseStackResources(await D.runAws(execFn, describeStackResourcesArgs({ stackName, region, profile }), 'cloudformation describe-stack-resources', EXIT.SERVER));
  const taskArns = parseTaskArns(await D.runAws(execFn, ecsListTasksArgs({ cluster, region, profile }), 'ecs list-tasks', EXIT.SERVER));
  let tasks = [];
  if (taskArns.length) {
    tasks = parseTasks(await D.runAws(execFn, ecsDescribeTasksArgs({ cluster, tasks: taskArns, region, profile }), 'ecs describe-tasks', EXIT.SERVER));
  }
  const strays = tasks.filter((t) => !isServiceTask(t));

  // Orphan-cluster note: the stack owns the cluster only if it created an
  // AWS::ECS::Cluster resource. A passed-in pre-existing cluster is NOT deleted.
  const ownsCluster = resources.some((r) => r.ResourceType === 'AWS::ECS::Cluster');
  // Stray-stopping exists ONLY to unblock deleting a cluster the stack owns
  // (active standalone tasks block delete-stack on its AWS::ECS::Cluster). On a
  // pre-existing/shared cluster the cluster survives, so strays block nothing —
  // and stopping them would kill CO-TENANT workloads (list-tasks sees the whole
  // cluster, not just ours). Never reach past what the stack owns.
  const stopTargets = ownsCluster ? strays : [];

  if (json) {
    emit({ type: 'preview', stack: stackName, cluster, status: stack.StackStatus || null, region: region || null, regionSource,
      resources: resources.map((r) => ({ logicalId: r.LogicalResourceId, type: r.ResourceType })),
      runningTasks: tasks.length, strayTasks: strays.length, ownsCluster, stopTasks: stopTargets.map((t) => t.taskArn) });
  } else {
    log(`teardown preview for stack "${stackName}" (cluster ${cluster}, status ${stack.StackStatus || '?'}):`);
    log('  resources that die with the stack:');
    for (const r of resources) log(`    ${r.LogicalResourceId} (${r.ResourceType})`);
    if (tasks.length) {
      log(`  running tasks in the cluster: ${tasks.length}${ownsCluster ? ` (${strays.length} stray — will be stopped first)` : ''}`);
      for (const t of tasks) log(`    ${t.taskArn ? String(t.taskArn).split('/').pop() : '?'} group=${t.group || '?'}${t.startedAt ? ` started ${t.startedAt}` : ''}${isServiceTask(t) ? ' [service — dies with the stack]' : (ownsCluster ? ' [stray — stopped first]' : ' [not ours — left alone]')}`);
    } else {
      log('  running tasks in the cluster: none');
    }
    if (!ownsCluster) log(`  NOTE: cluster "${cluster}" is not an AWS::ECS::Cluster resource of this stack — it is pre-existing and will NOT be deleted; its tasks are left alone (they block nothing).`);
  }

  // --dry-run: print every destructive argv, execute nothing destructive.
  if (flags['dry-run']) {
    const lines = [];
    for (const t of stopTargets) lines.push(`  aws ${ecsStopTaskArgs({ cluster, task: t.taskArn, region, profile }).slice(1).join(' ')}`);
    lines.push(`  aws ${deleteStackArgs({ stackName, region, profile }).slice(1).join(' ')}`);
    if (json) emit({ type: 'dry-run', stopTasks: stopTargets.map((t) => t.taskArn), deleteStack: stackName, keepCtx: !!flags['keep-ctx'] });
    else { printer.line('dry-run — would run (nothing destructive executed):'); for (const l of lines) printer.line(l); }
    return EXIT.OK;
  }

  // 3. Destructive gate.
  await confirmTeardown({ name: stackName, noun: 'stack', flags, io });

  // 4. Stop stray tasks — only in a cluster the stack OWNS (see stopTargets).
  //    Service tasks die with the stack — never double-stopped.
  for (const t of stopTargets) {
    await D.runAws(execFn, ecsStopTaskArgs({ cluster, task: t.taskArn, region, profile }), 'ecs stop-task', EXIT.SERVER);
    if (json) emit({ type: 'stop-task', task: t.taskArn }); else log(`stopped stray task ${String(t.taskArn).split('/').pop()}`);
  }

  // 5. Delete the stack.
  await D.runAws(execFn, deleteStackArgs({ stackName, region, profile }), 'cloudformation delete-stack', EXIT.SERVER);
  if (json) emit({ type: 'delete-stack', stack: stackName }); else log(`delete-stack requested for "${stackName}"`);

  // 6. --wait: poll to DELETE_COMPLETE (stack gone) / DELETE_FAILED. Default: no wait.
  if (flags.wait) {
    await waitForStackDeletion({ stackName, region, profile, execFn, io });
    if (json) emit({ type: 'wait', ok: true }); else log('stack deleted (DELETE_COMPLETE)');
  } else if (!json) {
    log(`deletion started — check: aws cloudformation describe-stacks --stack-name ${stackName}${region ? ` --region ${region}` : ''}`);
  }

  // 7. ctx cleanup: name match OR ssm.ecs cluster-half === this cluster. The
  //    cluster-half match also requires the entry's pinned region to agree (or
  //    be absent) — a same-named cluster in ANOTHER region is a different
  //    deployment; don't drop its ctx.
  ctxCleanup({ flags, printer, io, matchFn: (name, entry) => {
    if (name === stackName) return true;
    const ecs = entry && entry.ssm && entry.ssm.ecs;
    if (!(typeof ecs === 'string' && ecs.includes('/') && ecs.split('/')[0] === cluster)) return false;
    const entryRegion = entry.ssm.region;
    return entryRegion == null || !region || String(entryRegion) === region;
  } });

  // Secrets expectation-setting (the template schedules Secrets Manager deletion).
  log('note: the stack\'s secrets enter Secrets Manager\'s recovery window (gone for real in 7–30 days).');
  return EXIT.OK;
}

const STACK_DELETE_TIMEOUT_MS = 15 * 60 * 1000;
const STACK_DELETE_POLL_MS = 10 * 1000;
async function waitForStackDeletion({ stackName, region, profile, execFn, io }) {
  const sleepFn = io.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (io.stackDeleteTimeoutMs || STACK_DELETE_TIMEOUT_MS);
  for (;;) {
    let stack = null;
    try {
      const out = await D.runAws(execFn, describeStacksArgs({ stackName, region, profile }), 'cloudformation describe-stacks (wait)', EXIT.SERVER);
      stack = parseStacks(out)[0] || null;
    } catch (e) {
      // The stack is gone once describe-stacks can no longer find it → success.
      if (e instanceof CliError && /does not exist|ValidationError/i.test(e.message)) return;
      throw e;
    }
    if (!stack || stack.StackStatus === 'DELETE_COMPLETE') return;
    if (stack.StackStatus === 'DELETE_FAILED') {
      throw new CliError(EXIT.SERVER, `stack "${stackName}" delete FAILED: ${stack.StackStatusReason || '(no reason given)'} — resources may remain; inspect in the console`);
    }
    if (Date.now() >= deadline) throw new CliError(EXIT.SERVER, `stack "${stackName}" still deleting after ${Math.round((io.stackDeleteTimeoutMs || STACK_DELETE_TIMEOUT_MS) / 60000)}min (status ${stack.StackStatus}) — check later with describe-stacks`);
    await sleepFn(STACK_DELETE_POLL_MS);
  }
}

// ── helm ─────────────────────────────────────────────────────────────────────
async function undeployHelm({ printer, flags, args, io }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'undeploy helm needs a release name (e.g. undeploy helm mynode)');
  if (!D.HELM_RELEASE_RE.test(name)) throw new CliError(EXIT.USAGE, `bad release name "${name}" — ${D.HELM_RELEASE_RE.source}`);
  const namespace = flags.namespace ? String(flags.namespace) : D.DEFAULT_HELM_NAMESPACE;
  if (!D.K8S_NS_RE.test(namespace)) throw new CliError(EXIT.USAGE, `bad --namespace "${namespace}" — a DNS-1123 label`);
  const kubeContext = flags['kube-context'] ? String(flags['kube-context']) : null;

  const json = !!flags.json;
  const emit = (o) => printer.json(o);
  const log = (s) => { if (!json) printer.line(s); };
  const execFn = io.execFn || execFileP;

  // 1. Lookup: helm status (exit 0 = installed).
  try {
    await D.runVendor(execFn, D.helmStatusArgs({ name, namespace, kubeContext }), 'status', EXIT.USAGE);
  } catch (e) {
    if (e instanceof CliError) throw new CliError(EXIT.USAGE, `release "${name}" not found in namespace "${namespace}" — is the namespace right? (--namespace) [${e.message}]`);
    throw e;
  }

  // 2. Preview: helm get manifest → Kind/name resource lines.
  const manifest = await D.runVendor(execFn, helmGetManifestArgs({ name, namespace, kubeContext }), 'get manifest', EXIT.SERVER);
  const kinds = parseManifestKinds(manifest);
  const pvc = HELM_PVC_NAME(name);
  if (json) {
    emit({ type: 'preview', release: name, namespace, resources: kinds, pvc, keepData: !!flags['keep-data'] });
  } else {
    log(`teardown preview for release "${name}" (namespace ${namespace}):`);
    for (const k of kinds) log(`  ${k.kind}/${k.name}`);
    log(`  PVC "${pvc}" (StatefulSet data) — ${flags['keep-data'] ? 'KEPT (--keep-data)' : 'will be DELETED (default full teardown; --keep-data to keep)'}`);
  }

  // --dry-run: print every destructive argv, execute nothing destructive.
  if (flags['dry-run']) {
    const lines = [`  ${helmUninstallArgs({ name, namespace, kubeContext }).join(' ')}`];
    if (!flags['keep-data']) lines.push(`  ${kubectlDeletePvcArgs({ name, namespace, kubeContext }).join(' ')}`);
    if (json) emit({ type: 'dry-run', uninstall: name, deletePvc: flags['keep-data'] ? null : HELM_PVC_SELECTOR(name), keepCtx: !!flags['keep-ctx'] });
    else { printer.line('dry-run — would run (nothing destructive executed):'); for (const l of lines) printer.line(l); }
    return EXIT.OK;
  }

  // 3. Destructive gate.
  await confirmTeardown({ name, noun: 'release', flags, io });

  // 4. Uninstall.
  await D.runVendor(execFn, helmUninstallArgs({ name, namespace, kubeContext }), 'uninstall', EXIT.SERVER);
  if (json) emit({ type: 'uninstall', release: name }); else log(`uninstalled release "${name}"`);

  // 5. DATA: the StatefulSet PVC survives helm uninstall by design. Default: delete
  //    it too (full teardown parity); --keep-data keeps it and names it.
  if (flags['keep-data']) {
    if (json) emit({ type: 'data', action: 'kept', pvc });
    else log(`kept PVC "${pvc}" (--keep-data) — reattaches on the next deploy of "${name}"`);
  } else {
    await D.runVendor(execFn, kubectlDeletePvcArgs({ name, namespace, kubeContext }), 'delete pvc', EXIT.SERVER);
    if (json) emit({ type: 'data', action: 'deleted', selector: HELM_PVC_SELECTOR(name) });
    else log(`deleted PVC(s) matching ${HELM_PVC_SELECTOR(name)}`);
  }

  // 6. ctx cleanup (kubectl-kind ctx — name match).
  ctxCleanup({ flags, printer, io, matchFn: (n) => n === name });
  return EXIT.OK;
}

// helm get manifest → a stream of `---`-separated YAML docs. Pull Kind + name
// without a YAML parser (the manifest is well-formed helm output).
function parseManifestKinds(manifest) {
  const out = [];
  for (const doc of String(manifest || '').split(/^---\s*$/m)) {
    const kind = (doc.match(/^kind:\s*(\S+)/m) || [])[1];
    if (!kind) continue;
    const meta = doc.split(/^metadata:\s*$/m)[1] || doc;
    const name = (meta.match(/^\s+name:\s*(\S+)/m) || [])[1] || '?';
    out.push({ kind, name });
  }
  return out;
}

// ── docker ───────────────────────────────────────────────────────────────────
async function undeployDocker({ printer, flags, args, io }) {
  const name = args[0];
  if (!name) throw new CliError(EXIT.USAGE, 'undeploy docker needs a node name (e.g. undeploy docker mybox)');
  if (!D.NAME_RE.test(name)) throw new CliError(EXIT.USAGE, `bad node name "${name}" — ${D.NAME_RE.source}`);
  const container = D.CONTAINER_PREFIX + name;
  const dockerHost = flags.host ? D.normalizeDockerHost(flags.host) : '';
  const childEnv = dockerHost ? { ...(io.env || process.env), DOCKER_HOST: dockerHost } : null;

  const json = !!flags.json;
  const emit = (o) => printer.json(o);
  const log = (s) => { if (!json) printer.line(s); };
  const runDocker = io.runDocker || D.runDocker;
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  const run = async (a) => runDocker({ args: a, env: childEnv, spawnFn: io.spawnFn, onStderr: (s) => { if (!json) writeErr(s); } });

  // 1. Lookup: docker inspect (read-only).
  let res;
  try { res = await run(dockerInspectArgs({ name })); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || /ENOENT|not found/i.test(e.message || ''))) throw new CliError(EXIT.SERVER, `could not run docker: ${e.message} — is docker installed and on PATH?`);
    throw new CliError(EXIT.SERVER, `could not run docker: ${e.message}`);
  }
  if (res.code !== 0) throw new CliError(EXIT.USAGE, `container "${container}" not found${dockerHost ? ` on ${dockerHost}` : ''} — nothing to undeploy`);
  const inspected = parseInspect(res.stdout);
  const volumes = dockerVolumes(inspected);

  // 2. Preview.
  if (json) {
    emit({ type: 'preview', container, image: inspected.image, state: inspected.state, volumes, keepData: !!flags['keep-data'] });
  } else {
    log(`teardown preview for container "${container}":`);
    log(`  image ${inspected.image || '?'}, state ${inspected.state || '?'}`);
    if (volumes.length) log(`  named volumes: ${volumes.join(', ')} — ${flags['keep-data'] ? 'KEPT (--keep-data)' : 'will be DELETED (docker rm does NOT remove them; --keep-data to keep)'}`);
    else log('  named volumes: none');
  }

  // --dry-run: print every destructive argv, execute nothing destructive.
  if (flags['dry-run']) {
    const lines = [`  docker ${dockerRmArgs({ name }).join(' ')}`];
    if (!flags['keep-data']) for (const v of volumes) lines.push(`  docker ${dockerVolumeRmArgs({ volume: v }).join(' ')}`);
    if (json) emit({ type: 'dry-run', rm: container, removeVolumes: flags['keep-data'] ? [] : volumes, keepCtx: !!flags['keep-ctx'] });
    else { printer.line('dry-run — would run (nothing destructive executed):'); for (const l of lines) printer.line(l); }
    return EXIT.OK;
  }

  // 3. Destructive gate.
  await confirmTeardown({ name, noun: 'container', flags, io });

  // 4. Remove the container.
  const rm = await run(dockerRmArgs({ name }));
  if (rm.code !== 0) throw new CliError(EXIT.SERVER, `docker rm -f failed (exit ${rm.code == null ? '?' : rm.code}) — see docker's output`);
  if (json) emit({ type: 'rm', container }); else log(`removed container "${container}"`);

  // 5. DATA: docker rm -f does NOT remove named volumes — delete them explicitly.
  if (flags['keep-data']) {
    if (json) emit({ type: 'data', action: 'kept', volumes });
    else if (volumes.length) log(`kept named volume(s): ${volumes.join(', ')} (--keep-data)`);
  } else {
    for (const v of volumes) {
      const vr = await run(dockerVolumeRmArgs({ volume: v }));
      if (vr.code !== 0) throw new CliError(EXIT.SERVER, `docker volume rm ${v} failed (exit ${vr.code == null ? '?' : vr.code})`);
      if (json) emit({ type: 'data', action: 'deleted', volume: v }); else log(`deleted volume "${v}"`);
    }
  }

  // 6. ctx cleanup (name match).
  ctxCleanup({ flags, printer, io, matchFn: (n) => n === name });
  return EXIT.OK;
}

function parseInspect(stdout) {
  try {
    const arr = JSON.parse(stdout || '[]');
    const o = Array.isArray(arr) ? arr[0] : arr;
    if (!o) return { image: null, state: null, mounts: [] };
    return { image: (o.Config && o.Config.Image) || null, state: (o.State && o.State.Status) || null, mounts: Array.isArray(o.Mounts) ? o.Mounts : [] };
  } catch { return { image: null, state: null, mounts: [] }; }
}
// Named volumes only (Type === 'volume' with a Name); anonymous/bind mounts skipped.
function dockerVolumes(inspected) {
  return (inspected.mounts || []).filter((m) => m && m.Type === 'volume' && m.Name).map((m) => m.Name);
}

module.exports = {
  undeployVerb, confirmTeardown, ctxCleanup,
  describeStacksArgs, describeStackResourcesArgs, ecsListTasksArgs, ecsDescribeTasksArgs, ecsStopTaskArgs, deleteStackArgs,
  helmGetManifestArgs, helmUninstallArgs, kubectlDeletePvcArgs,
  dockerInspectArgs, dockerRmArgs, dockerVolumeRmArgs,
  isServiceTask, parseManifestKinds, parseInspect, dockerVolumes,
  HELM_PVC_SELECTOR, HELM_PVC_NAME,
};
