// transport.js — how bytes reach the wire. Three context kinds, one mechanism.
//
//   direct  — a `url`; speak fetch straight at it, nothing to open/close.
//   tunnel  — an argv array with a `{port}` placeholder; substitute a free
//             local port, spawn the child DIRECTLY (never a shell), wait for
//             the port to accept, hand back http://127.0.0.1:<port>, and on
//             close kill the child's PROCESS GROUP (detached spawn + kill(-pid)
//             — cloud CLIs fork helpers a plain child-kill would orphan).
//   ssh     — sugar over `tunnel`: a built-in argv template around the system
//             `ssh` binary. One code path, two entry shapes (spec §Contexts).
//
// Standalone by construction: node:* only, never require()s an app file.
// peer-tunnel.js is the pattern reference, not a dependency.
'use strict';

const net = require('net');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { CliError, EXIT } = require('./errors');

const execFileP = promisify(execFile);

const DEFAULT_REMOTE_PORT = 7900;
const WAIT_PORT_MS = 10000;     // bounded wait for the tunnel's local port
const WAIT_POLL_MS = 150;

// ssh argv template — mirrors peer-tunnel.js's key-auth, fail-loud posture.
// {port} is the placeholder the tunnel machinery substitutes; BatchMode keeps
// us from ever blocking on an interactive prompt (the CLI can't answer one).
function sshArgv(host, remotePort) {
  return [
    'ssh', '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-L', `{port}:127.0.0.1:${remotePort}`,
    host,
  ];
}

// ── cloud transport templates ────────────────────────────────────────────────
//
// Each is a PURE {port}-tunnel argv over the SAME mechanism as sshArgv — we
// shell out to the operator's own vendor CLI (aws/kubectl/gcloud/az), never a
// vendor SDK, never a shell. `{port}` is the local end the tunnel machinery
// substitutes; the remote end is the wire port baked into each template. Data,
// not code (the whole point of typed kinds): safe to import/share.

// AWS SSM port-forward. The --parameters payload is real JSON built with
// JSON.stringify (never string-pasted) so a value can't break the quoting; the
// local end stays the literal `{port}` token for the tunnel machinery.
function ssmArgv({ target, region, profile } = {}, remotePort) {
  const params = JSON.stringify({ portNumber: [String(remotePort)], localPortNumber: ['{port}'] });
  return [
    'aws',
    ...(profile ? ['--profile', profile] : []),
    ...(region ? ['--region', region] : []),
    'ssm', 'start-session',
    '--target', target,
    '--document-name', 'AWS-StartPortForwardingSession',
    '--parameters', params,
  ];
}

// kubectl port-forward to a pod/svc. --context avoids relying on the operator's
// current-context; -n scopes the namespace. `{port}:<remote>` is the mapping.
function kubectlArgv({ target, namespace, context } = {}, remotePort) {
  return [
    'kubectl',
    ...(context ? ['--context', context] : []),
    ...(namespace ? ['-n', namespace] : []),
    'port-forward', target, `{port}:${remotePort}`,
  ];
}

// GCP IAP tunnel to a Compute instance. start-iap-tunnel takes the remote port
// as a positional; --local-host-port carries the {port} local end.
function gcloudArgv({ instance, zone, project } = {}, remotePort) {
  return [
    'gcloud', 'compute', 'start-iap-tunnel', instance, String(remotePort),
    '--local-host-port=localhost:{port}',
    ...(zone ? ['--zone', zone] : []),
    ...(project ? ['--project', project] : []),
  ];
}

// Azure Bastion tunnel to a VM by resource id. --port is the {port} local end.
function azArgv({ bastion, resourceGroup, target } = {}, remotePort) {
  return [
    'az', 'network', 'bastion', 'tunnel',
    '--name', bastion,
    '--resource-group', resourceGroup,
    '--target-resource-id', target,
    '--resource-port', String(remotePort),
    '--port', '{port}',
  ];
}

// Parse `CLUSTER/FAMILY` → { cluster, family }. Exactly one '/', both halves
// non-empty. Used at ctx-add time (validation) and at open time (resolve).
function parseEcsSpec(ecsSpec) {
  const s = String(ecsSpec == null ? '' : ecsSpec);
  const slash = s.indexOf('/');
  if (slash < 0 || slash !== s.lastIndexOf('/') || slash === 0 || slash === s.length - 1) {
    throw new CliError(EXIT.USAGE, `--ssm-ecs must be CLUSTER/FAMILY (one slash, both halves non-empty), got "${s}"`);
  }
  return { cluster: s.slice(0, slash), family: s.slice(slash + 1) };
}

// Resolve a Fargate `ecs:CLUSTER/FAMILY` spec to a concrete SSM target at OPEN
// time — task ids are ephemeral, so a stored id would go stale every redeploy.
// Two aws reads (list-tasks → the running task's arn; describe-tasks → the
// container's runtimeId), then compose `ecs:<cluster>_<taskId>_<runtimeId>`.
// execFn is injectable (default promisified execFile) — NEVER a shell. Any aws
// failure surfaces as EXIT.CONNECT with aws's own stderr; no running task is a
// clear CONNECT message.
async function resolveEcsTarget(ecsSpec, { region, profile, execFn = execFileP } = {}) {
  const { cluster, family } = parseEcsSpec(ecsSpec);
  const base = [
    ...(profile ? ['--profile', profile] : []),
    ...(region ? ['--region', region] : []),
  ];
  const runAws = async (args, what) => {
    try {
      const { stdout } = await execFn('aws', [...base, ...args]);
      return String(stdout).trim();
    } catch (e) {
      if (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || ''))) {
        throw new CliError(EXIT.CONNECT, 'aws CLI not found — is it installed and on PATH?');
      }
      const stderr = (e && (e.stderr || e.message) || '').toString().trim();
      throw new CliError(EXIT.CONNECT, `aws ${what} failed${stderr ? `: ${stderr}` : ''}`);
    }
  };

  const arn = await runAws(
    ['ecs', 'list-tasks', '--cluster', cluster, '--family', family, '--desired-status', 'RUNNING', '--query', 'taskArns[0]', '--output', 'text'],
    'ecs list-tasks');
  if (!arn || arn === 'None') {
    throw new CliError(EXIT.CONNECT, `no running task for family ${family} in cluster ${cluster}`);
  }
  const taskId = arn.split('/').pop();

  const runtimeId = await runAws(
    ['ecs', 'describe-tasks', '--cluster', cluster, '--tasks', taskId, '--query', 'tasks[0].containers[0].runtimeId', '--output', 'text'],
    'ecs describe-tasks');
  if (!runtimeId || runtimeId === 'None') {
    throw new CliError(EXIT.CONNECT, `task ${taskId} has no runtimeId yet (still starting?) in cluster ${cluster}`);
  }
  return `ecs:${cluster}_${taskId}_${runtimeId}`;
}

// Pick a free loopback port (peer-tunnel.js:39-46 pattern). Promise form.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Does 127.0.0.1:<port> accept a TCP connection right now? One-shot probe.
function portAccepts(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
    sock.setTimeout(WAIT_POLL_MS, () => finish(false));
  });
}

// Substitute {port} across an argv array. Pure — leaf-tested.
function substitutePort(argv, port) {
  return argv.map((a) => String(a).replace(/\{port\}/g, String(port)));
}

// Wait until the port accepts or the deadline lapses. If the child dies first,
// reject with its stderr so a misconfig is diagnosable (never silent-timeout).
function waitForPort(port, { deadlineMs = WAIT_PORT_MS, isDead, stderr } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await portAccepts(port)) return resolve();
      if (isDead && isDead()) {
        return reject(new CliError(EXIT.CONNECT,
          `tunnel command exited before the port opened${stderr && stderr() ? `:\n${stderr()}` : ''}`));
      }
      if (Date.now() - start > deadlineMs) {
        return reject(new CliError(EXIT.CONNECT,
          `tunnel did not open a local port within ${Math.round(deadlineMs / 1000)}s${stderr && stderr() ? `:\n${stderr()}` : ''}`));
      }
      setTimeout(tick, WAIT_POLL_MS);
    };
    tick();
  });
}

// An opened transport: { baseUrl, close() }. Direct has nothing to close.
// spawnFn is injectable for tests (defaults to child_process.spawn); a fake
// child that listens on {port} exercises the whole path without real ssh.
async function openTransport(ctx, { spawnFn = spawn, execFn = execFileP, deadlineMs = WAIT_PORT_MS } = {}) {
  if (ctx.url) {
    return { baseUrl: ctx.url.replace(/\/+$/, ''), close() {} };
  }
  const remotePort = ctx.remotePort || DEFAULT_REMOTE_PORT;
  let argv;
  if (ctx.ssh) {
    argv = sshArgv(ctx.ssh, remotePort);
  } else if (ctx.ssm) {
    // ecs: derive the concrete target at open time (ids are ephemeral); a plain
    // target goes straight to the builder.
    let target = ctx.ssm.target;
    if (ctx.ssm.ecs) target = await resolveEcsTarget(ctx.ssm.ecs, { region: ctx.ssm.region, profile: ctx.ssm.profile, execFn });
    argv = ssmArgv({ target, region: ctx.ssm.region, profile: ctx.ssm.profile }, remotePort);
  } else if (ctx.kubectl) {
    argv = kubectlArgv(ctx.kubectl, remotePort);
  } else if (ctx.gcloud) {
    argv = gcloudArgv(ctx.gcloud, remotePort);
  } else if (ctx.az) {
    argv = azArgv(ctx.az, remotePort);
  } else if (Array.isArray(ctx.tunnel) && ctx.tunnel.length) {
    argv = ctx.tunnel.slice();
  } else {
    throw new CliError(EXIT.USAGE, 'context has no url, ssh, tunnel, or cloud transport');
  }

  const port = await pickFreePort();
  const [cmd, ...rest] = substitutePort(argv, port);

  let stderrBuf = '';
  let exited = false;
  // detached:true → the child leads its own process group, so kill(-pid)
  // sweeps helpers it forked. No shell: argv is passed literally.
  const child = spawnFn(cmd, rest, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  if (child.stderr) child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
  child.on('error', (e) => {
    exited = true;
    // A missing vendor binary (aws/kubectl/gcloud/az/ssh) is the common misconfig
    // — surface a pointed hint alongside the raw error (matches deploy.js's docker
    // ENOENT copy). The waitForPort reject relays stderrBuf verbatim.
    if (e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || ''))) {
      stderrBuf += `\n${cmd}: command not found — is ${cmd} installed and on PATH?`;
    } else {
      stderrBuf += `\n${e.message}`;
    }
  });
  child.on('exit', () => { exited = true; });

  const close = () => {
    try {
      // Kill the whole group (negative pid). Falls back to a plain child kill
      // if the platform/spawn didn't give us a group leader. Guard is > 0, not
      // non-null: kill(-0) would signal OUR OWN process group (spawnFn is an
      // injectable seam, so a fake child's pid shape isn't guaranteed).
      if (child.pid > 0) {
        try { process.kill(-child.pid, 'SIGTERM'); }
        catch { try { child.kill('SIGTERM'); } catch {} }
      }
    } catch {}
  };

  try {
    await waitForPort(port, { deadlineMs, isDead: () => exited, stderr: () => stderrBuf.trim() });
  } catch (e) {
    close();
    throw e;
  }
  return { baseUrl: `http://127.0.0.1:${port}`, close, stderr: () => stderrBuf.trim() };
}

module.exports = {
  DEFAULT_REMOTE_PORT, WAIT_PORT_MS,
  sshArgv, ssmArgv, kubectlArgv, gcloudArgv, azArgv,
  parseEcsSpec, resolveEcsTarget,
  pickFreePort, portAccepts, substitutePort, waitForPort, openTransport,
};
