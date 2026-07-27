'use strict';
// ssh-keepalive.test.js — every ssh invocation this repo builds must be able to
// notice a dead far end (t43).
//
// THE DEFECT THIS PINS. cli/src/transport.js's sshArgv carried BatchMode,
// ExitOnForwardFailure, StrictHostKeyChecking and ConnectTimeout but NOT
// ServerAliveInterval/ServerAliveCountMax — alone among the repo's four ssh
// option sets, while its own comment claimed to mirror peer-tunnel.js's posture.
// An ssh tunnel whose remote end dies without closing TCP then has nothing
// probing it: the child stays alive, the forward reads as open, and it carries
// nothing. Same half-open shape as the SSE bug in t41, one layer down, and it
// survived for the same reason — the fix landed on the other side and never came
// back.
//
// WHY AN INVARIANT AND NOT FOUR LITERALS. A test asserting sshArgv's exact argv
// would have gone green the moment this fix landed and said nothing about a
// FIFTH call site added next year — which is exactly how the fourth one came to
// be missing. So the test below DISCOVERS the option sets from the source and
// demands the property of each. A new ssh call site fails it by default, and the
// only way to pass is to carry the keepalive or to argue with this file.
//
// WHY ServerAlive AND NOT TCP KEEPALIVE. ssh's ServerAlive* probes are sent over
// the encrypted channel and require a real response from the remote sshd, so
// they cannot be satisfied by a link that merely still routes packets. That is
// the standing rule about liveness signals that cost nothing to emit: a signal
// the far end can satisfy while dead proves nothing. Interval 15 with CountMax 2
// means a dead peer is noticed in ~30s and ssh exits.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// The marker for "this array is an ssh option list". BatchMode=yes is on every
// one of them by policy (Clodex never proxies an interactive prompt), it is an
// argv ELEMENT rather than prose, and it is not plausible for a future ssh call
// site to omit it — which is what makes it a usable anchor for discovery.
// Matched as a whole line so a mention in a comment cannot be picked up.
const BATCHMODE_LINE = /^\s*'-o',\s*'BatchMode=yes',?\s*$/;

// Tracked .js sources only. Tracked, via git, for the reason clodex's fix to the
// packaging guard established: a scan that enumerates the FILESYSTEM inherits
// every developer's local state — gitignored scratch dirs, vendored copies, an
// old checkout left in the tree. Asking git is asking the same oracle the repo
// itself uses. If git is unavailable this FAILS LOUDLY rather than silently
// narrowing to whatever happens to be on disk: a guard that quietly stops
// looking is worse than no guard.
function trackedSources() {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    assert.fail(`cannot enumerate tracked files via git (${e.message}) — this guard refuses to fall back to a filesystem walk`);
  }
  return out.split('\n').filter(Boolean).filter((f) => (
    // Tests state their own expectations and may legitimately write an option
    // list without a keepalive to prove one is missing. web-dist is generated.
    !f.startsWith('test/') && !f.startsWith('cli/test/') && !f.startsWith('web-dist/')
  ));
}

// The array literal enclosing `line` in `lines`: walk back to the line opening
// it and forward to the line closing it. These are flat string arrays written
// one element per line, so bracket counting is not needed — but a literal that
// does not close is reported rather than silently truncated to end-of-file.
function enclosingArray(lines, idx) {
  let start = idx;
  while (start >= 0 && !/\[\s*$/.test(lines[start])) start--;
  if (start < 0) return null;
  let end = idx;
  while (end < lines.length && !/^\s*\]/.test(lines[end])) end++;
  if (end >= lines.length) return null;
  return { start, end, text: lines.slice(start, end + 1).join('\n') };
}

// Every ssh option list in tracked source, as { file, line, text }.
function sshOptionSets() {
  const found = [];
  for (const file of trackedSources()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!src.includes('BatchMode=yes')) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!BATCHMODE_LINE.test(lines[i])) continue;
      const arr = enclosingArray(lines, i);
      assert.ok(arr, `${file}:${i + 1}: found an ssh option element outside any array literal this scanner can read — the scanner needs updating, do not delete this assertion`);
      found.push({ file, line: arr.start + 1, text: arr.text });
    }
  }
  return found;
}

// WINDOW: the discovery itself. Everything below asserts a property OF the found
// set, so a scanner that found nothing would make all of them vacuously true —
// the classic "green while asserting nothing". This test is what stops that: it
// fails if discovery breaks, if a call site disappears, or if one is added
// without this file being looked at.
//
// FILES, not file:line. Pinning line numbers would fail this guard every time a
// comment above one of these arrays grew — a guard that cries wolf on edits that
// change nothing is one somebody eventually deletes, and then the real property
// below goes unwatched. The file set is the thing worth being exact about.
test('the ssh option sets are discoverable, and there are exactly four', () => {
  const files = sshOptionSets().map((s) => s.file).sort();
  assert.deepStrictEqual(files, [
    'cli/src/deploy.js',      // SSH_DEPLOY_ARGS — the deploy run
    'cli/src/dial.js',        // SSH_BASE_ARGS — both GUI tunnel supervisors
    'cli/src/transport.js',   // sshArgv — the CLI's one-shot tunnel (t43's defect)
    'ssh-run.js',             // SSH_ARGS — the probe / remote script runner
  ], 'an ssh call site vanished or was added — a new one must carry the keepalive, and this list must name it');
});

// WINDOW: the property, on every discovered set. This is the assertion that
// would have caught the defect: before the fix, cli/src/transport.js's set is in
// the discovered list and lacks both options, so this fails naming that file.
test('every ssh invocation carries a keepalive that can detect a dead far end', () => {
  const sets = sshOptionSets();
  assert.ok(sets.length > 0, 'discovery found nothing — see the test above');
  for (const s of sets) {
    assert.ok(
      /'ServerAliveInterval=\d+'/.test(s.text),
      `${s.file}:${s.line}: an ssh invocation with no ServerAliveInterval. A tunnel whose far end dies without closing TCP would read as open forever — this is the t43 defect, and the t41 defect one layer up.`,
    );
    assert.ok(
      /'ServerAliveCountMax=\d+'/.test(s.text),
      `${s.file}:${s.line}: ServerAliveInterval with no ServerAliveCountMax — the probes are sent but never give up, so the connection is still never torn down.`,
    );
  }
});

// WINDOW: agreement across the four. The ticket's instruction was to use the
// values the others use and to REPORT rather than pick a winner if they
// disagreed — they agree, so that agreement is now pinned. A future call site
// choosing its own timings fails here, which is the conversation worth having:
// two different ideas of how long a dead box stays believed is the drift this
// whole ticket is about, in slow motion.
test('the four agree on the timings — one idea of how long a dead box is believed', () => {
  const sets = sshOptionSets();
  const intervals = new Set();
  const counts = new Set();
  for (const s of sets) {
    // Read through a null-safe match rather than `match(...)[1]`: on a set with
    // no keepalive at all that indexing throws a TypeError, and a guard that
    // dies by crash instead of by message tells the next reader nothing about
    // which call site is wrong. The missing-option case is the test above's to
    // report; this one records it as 'ABSENT' and lets the comparison say so.
    const iv = s.text.match(/'ServerAliveInterval=(\d+)'/);
    const cm = s.text.match(/'ServerAliveCountMax=(\d+)'/);
    intervals.add(iv ? iv[1] : `ABSENT(${s.file})`);
    counts.add(cm ? cm[1] : `ABSENT(${s.file})`);
  }
  assert.deepStrictEqual([...intervals], ['15'], 'ServerAliveInterval disagrees across call sites');
  assert.deepStrictEqual([...counts], ['2'], 'ServerAliveCountMax disagrees across call sites');
});

// WINDOW: the scanner's own blind spot. enclosingArray reads flat one-per-line
// literals; a set written inline (`['-o', 'BatchMode=yes', …]` on one line) would
// have its BatchMode line ALSO be its opening line, and the walk-back must still
// find it rather than run past. Pinned because a scanner that silently skips a
// call site is the failure mode that makes the test above vacuous — and unlike
// the count test, this one would not notice.
test('the scanner reads an inline option array, not only one-element-per-line', () => {
  const lines = ["const A = [", "  '-o', 'BatchMode=yes',", "  '-o', 'ServerAliveInterval=15',", "];"];
  const arr = enclosingArray(lines, 1);
  assert.ok(arr && arr.text.includes('ServerAliveInterval=15'));

  // A literal that never closes must return null (→ the assert in sshOptionSets
  // fires) rather than swallowing the rest of the file.
  assert.strictEqual(enclosingArray(["const A = [", "  '-o', 'BatchMode=yes',"], 1), null);
});

// ── the built argv, not just the source text ─────────────────────────────────
//
// WINDOW: the four builders CALLED. Everything above reads source text, which
// proves the option is written down — not that it reaches a spawn. A constant
// can be declared and never spread into the argv the child actually receives.
// These call the real exported builders and assert on their output.
test('the keepalive survives into the argv each builder actually produces', () => {
  const { sshArgv } = require('../cli/src/transport');
  const { sshTunnelArgv } = require('../cli/src/dial');
  const { SSH_ARGS } = require('../ssh-run');
  const { sshDeployArgs } = require('../cli/src/deploy');

  const built = {
    'transport.sshArgv': sshArgv('user@box', 7900),
    'dial.sshTunnelArgv': sshTunnelArgv('user@box', 7900, 51234),
    'ssh-run.SSH_ARGS': SSH_ARGS,
    'deploy.sshDeployArgs': sshDeployArgs('user@box'),
  };
  for (const [name, argv] of Object.entries(built)) {
    assert.ok(argv.includes('ServerAliveInterval=15'), `${name}: keepalive interval missing from the built argv`);
    assert.ok(argv.includes('ServerAliveCountMax=2'), `${name}: keepalive count missing from the built argv`);
    // -o must immediately precede each option, or ssh reads it as a hostname.
    for (const opt of ['ServerAliveInterval=15', 'ServerAliveCountMax=2']) {
      assert.strictEqual(argv[argv.indexOf(opt) - 1], '-o', `${name}: ${opt} is not preceded by -o`);
    }
  }
});

// WINDOW: the specific regression. sshArgv is the one that was wrong, and its
// full argv is pinned here so the fix is legible as a change to THIS function
// rather than only as a property of a discovered set. The {port} placeholder is
// part of the contract (the tunnel machinery substitutes it), so it is pinned
// too — a keepalive edit that disturbed the -L element would break the tunnel.
test('sshArgv (the t43 defect) builds the full expected template', () => {
  const { sshArgv } = require('../cli/src/transport');
  assert.deepStrictEqual(sshArgv('user@box', 7900), [
    'ssh', '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ConnectTimeout=10',
    '-L', '{port}:127.0.0.1:7900',
    'user@box',
  ]);
});
