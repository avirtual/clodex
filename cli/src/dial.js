// dial.js — ONE spawn-and-kill for every Clodex port forward (t42 / L1).
//
// Three modules used to carry their own copy of this: peer-tunnel.js (the wire
// supervisor), web-tunnel.js (the on-demand web forward) and transport.js's
// openTransport (the CLI's one-shot open). Same stdio, same detach reasoning,
// same process-group kill with the same `pid > 0` guard, same ENOENT sentence —
// written out three times. A drift between three copies of a KILL path is a bug
// nobody notices, which is the whole reason this module exists.
//
// WHAT IS HERE: build the argv, spawn it, accumulate stderr, classify a spawn
// failure, kill the process group. WHAT IS NOT: retry, backoff, deadlines, port
// pinning, give-up caps, and every rendering decision. Those are the
// supervisors' and they stay where they are — the three callers differ in policy
// far more than they differ in mechanism, and folding policy in here is how a
// shared primitive becomes a thing with four flags nobody can read.
//
// EVERY DIVERGENCE BETWEEN THE THREE COPIES IS A PARAMETER, NOT A BRANCH ON WHO
// IS CALLING. The dial has no idea which supervisor it serves. Where the three
// had silently drifted, the drift is preserved and named at its parameter — this
// is a behaviour-preserving refactor, so reconciling a drift is a separate
// decision with its own evidence, not something to slip in under a move.
//
// Leaf by construction: node:* only, never requires an app file. The direction
// is app → cli/, the same one peer-tunnel.js:35, web-tunnel.js:73 and
// peer-client.js already take; cli/ ships in the DMG (build.files).
'use strict';

const { spawn } = require('child_process');

// How much child stderr the GUI supervisors keep. They keep a TAIL rather than
// the whole stream because a tunnel child is long-lived and respawns forever —
// an unbounded buffer on a flapping forward grows for the life of the app, and
// the only thing either UI renders is the LAST line anyway.
//
// openTransport passes 0 (unbounded) and that is drift D2, preserved: its child
// is torn down within the open deadline, so in practice the buffer is bounded by
// process lifetime rather than by a slice — EXCEPT under `port-forward`, which
// holds the same child (and the same buffer) for a whole foreground session.
const STDERR_TAIL_BYTES = 500;

// The ssh options every LONG-LIVED Clodex forward uses. Byte-identical to what
// peer-tunnel.js and web-tunnel.js each carried, and consistent with ssh-run.js
// and deploy.js.
//
// Deliberately NOT shared with transport.js's `sshArgv`, which is missing
// ServerAliveInterval/ServerAliveCountMax (drift D4). Unifying them would ADD
// two options to what the CLI spawns — a behaviour change, out of scope here.
// The two live in the same directory now so the gap is legible instead of being
// hidden behind a module boundary; see tasks/l1-dial/journal.md.
//
// BatchMode=yes: never block on an interactive prompt, since nothing here can
// answer one. StrictHostKeyChecking=accept-new: TOFU on first contact, still
// loud on a CHANGED key. ExitOnForwardFailure=yes: a local bind that lost its
// port fails honestly instead of silently forwarding nowhere.
const SSH_BASE_ARGS = [
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'ConnectTimeout=10',
];

// The supervised `ssh -N -L` forward, argv INCLUDING the command word. Pure
// string assembly over DATA — a host and two ports — which is the whole point of
// building argv at spawn time: no executable string is ever persisted, so a
// settings file can never carry a command line the app later runs.
function sshTunnelArgv(sshHost, remotePort, localPort) {
  return ['ssh', ...SSH_BASE_ARGS, '-L', `${localPort}:127.0.0.1:${remotePort}`, sshHost];
}

// Classify a child_process 'error' event into the structured failure t42 asked
// for. The dial does NOT decide where any of this is shown: t40 found the CLI's
// error path is the same information as the GUI's, rendered twice and more
// richly, so the split is rendering and rendering belongs to the caller.
//
//   reason    — machine-readable class, for a caller that wants to branch
//   message   — the raw error text, unmodified
//   diagnosis — the human sentence, or null when there is nothing to add
//   stderr    — whatever the child said before dying
//
// A missing vendor CLI (aws/kubectl/gcloud/az) is the common cloud misconfig and
// reads as a bare ENOENT with no hint of WHICH binary. Naming it is the single
// most useful thing this layer can say.
function classifySpawnError(e, cmd, stderrText = '') {
  const notFound = !!(e && (e.code === 'ENOENT' || /ENOENT/.test(e.message || '')));
  return {
    reason: notFound ? 'not-found' : 'spawn-failed',
    message: (e && e.message) || String(e),
    diagnosis: notFound ? `${cmd}: command not found — is ${cmd} installed and on PATH?` : null,
    stderr: stderrText,
  };
}

// Kill a dialled child. Two parameters, each one a drift made explicit:
//
//   group        — every cloud CLI forks helpers (aws its session-manager-plugin,
//                  kubectl and gcloud their own) that a plain child-kill orphans,
//                  and an orphaned forward to a REMOTE box is the worst outcome
//                  any of these modules has. So a cloud child leads its own
//                  process group and is killed by group. The GUI supervisors pass
//                  group only for cloud kinds and keep ssh's plain kill;
//                  openTransport detaches unconditionally and passes true always
//                  (drift D1 — TESTED on both sides, so a deliberate divergence
//                  rather than an accident).
//   fallbackKill — what to do when there is no usable group. The GUI supervisors
//                  fall back to a plain child.kill(); openTransport has no such
//                  arm and signals NOTHING (drift D3). Preserved, not fixed.
//
// The guard is `> 0`, not merely non-null: kill(-0) signals OUR OWN process
// group, and spawnFn is an injectable seam, so a fake child's pid shape is not
// guaranteed to be a real pid.
function killDial(child, { group = false, fallbackKill = true } = {}) {
  if (!child) return;
  try {
    if (group && child.pid > 0) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch { try { child.kill('SIGTERM'); } catch {} }
    } else if (fallbackKill) {
      child.kill();
    }
  } catch {}
}

// Spawn one dial. `argv` is the full argv INCLUDING the command word, already
// port-substituted by the caller — the dial takes bytes, not a destination, so
// it needs no cloud-kind table and stays a leaf.
//
// Returns a handle rather than the bare child, because the stderr accumulator
// has to live somewhere and every caller needs to read it. The child itself is
// exposed as `.child`: the supervisors store it, compare identity against it
// (web-tunnel's probe checks `this._child === child`), and wire their own exit
// policy to it. Nothing here subscribes to 'error' or 'exit' — those carry
// policy, and all three callers do genuinely different things with them.
//
// `detached` is spread in rather than passed as `detached: false`, because both
// GUI supervisors' tests assert the KEY IS ABSENT for ssh (`!('detached' in
// opts)`), not merely falsy. No shell: argv is passed literally.
// `spawnFn || spawn` rather than a default parameter: the supervisors hold their
// injected spawn as `null` when none was given (their managers pass one through
// only in tests), and a default parameter fires on `undefined` alone.
function spawnDial(argv, { spawnFn, detached = false, stderrLimit = 0 } = {}) {
  const [cmd, ...rest] = argv;
  const child = (spawnFn || spawn)(cmd, rest, {
    stdio: ['ignore', 'ignore', 'pipe'],
    ...(detached ? { detached: true } : {}),
  });

  let buf = '';
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      if (stderrLimit > 0) buf = buf.slice(-stderrLimit);
    });
  }

  return {
    cmd,
    child,
    stderr: () => buf,
    // openTransport folds its spawn-failure sentence INTO the stderr stream, so
    // waitForPort's reject relays it verbatim to the operator; the GUI puts the
    // same sentence in `lastError` instead. Same information, two renderings —
    // the seam t40 named. This method exists for the first of those and is
    // unused by the second.
    appendStderr(text) {
      buf += text;
      if (stderrLimit > 0) buf = buf.slice(-stderrLimit);
    },
    failure: (e) => classifySpawnError(e, cmd, buf),
    kill: (opts) => killDial(child, opts),
  };
}

module.exports = {
  STDERR_TAIL_BYTES, SSH_BASE_ARGS,
  sshTunnelArgv, classifySpawnError, killDial, spawnDial,
};
