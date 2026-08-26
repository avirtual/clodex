'use strict';

// Run: node --test
//
// REPO-WIDE census of every process.kill() in non-test source. Sibling to
// sigkill-pid-guard.test.js, which pins session-manager.js's two call sites from
// the outside by driving kill()/archive(). This file pins the CLASS instead: a
// non-positive pid must not reach process.kill ANYWHERE.
//
// Why a census and not a cleverer scan. process.kill reads a non-positive pid as
// a BROADCAST, not an id (-1 = every process the user may signal; 0 = our own
// process group), and the guard against that is one comparison sitting some
// arbitrary distance up-call from the signal — in a helper, in a default
// parameter, at the point a pidfile is parsed. No regex over a call site can see
// it. So the test does not try: it requires each site to be ENUMERATED here with
// the guard that covers it named as a literal, and fails when the set of sites
// changes. A new call site fails this test whether or not it is guarded, and
// clearing that failure means writing down which guard covers it — which is the
// review this class of bug has never had. Three independent copies of the same
// `> 0` check existed across three files before anyone noticed they were the
// same check.
//
// The history is the argument for repo-wide. 12ec89d fixed session-manager.js
// after a fixture's `pid: -1` SIGKILLed ~277 of the operator's processes;
// team-tickets.js had carried the identical guard, with a comment explaining
// exactly why, since long before. Neither reached wirescope-supervisor.js,
// scripts/clodex-monitor.js's stop path, or drawer-pty.js, all three of which
// were still live when this file was written (t490).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// Non-test source only. Test files are DELIBERATELY out of scope: `pty: { pid: -1 }`
// in a fixture is adjudicated correct (t489) — a plausible-but-dead POSITIVE pid
// is the genuinely dangerous stub, because it passes every guard and pids are
// recycled, so it can intermittently signal a real unrelated process. A scan that
// flagged fixtures would get the fixtures changed, which is the wrong direction.
function sourceFiles() {
  return execFileSync('git', ['ls-files', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n')
    .filter((f) => f && !f.startsWith('test/') && !f.startsWith('cli/test/'));
}

// Comments blanked before matching: this file's own prose quotes `process.kill(-1)`,
// and so do the guard comments in the modules being scanned. A scan that counted
// prose would report them.
function callsIn(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/process\.kill\(\s*([^,)]+?)\s*,\s*([^)]+?)\s*\)/g)]
    .map((m) => ({ file: rel, pid: m[1], sig: m[2] }));
}

// A liveness probe. Signal 0 delivers nothing, so a broadcast pid here is a wrong
// ANSWER, not a massacre — and every probe in this repo gates a REFUSAL (wedge a
// restore, defer a merge, refuse to take a lock), never a kill, so a probe that
// lies reads a dead thing as alive and fails CLOSED. They are censused rather
// than filtered out: if one of these is ever changed to send a real signal, its
// row stops matching and this test says so. That is the only reason the split is
// safe to draw.
const isProbe = (c) => c.sig === '0';

// Every process.kill in non-test source, with the guard that covers it.
//
// `guard` is a literal from the guarding source, asserted to still be present in
// `file`. It is the comparison itself, not a paraphrase: softening `> 0` to a
// truthiness test, or moving it, breaks the row. Where several sites share one
// guard (a funnel — a helper, a parsed pidfile) they carry the same literal, and
// that repetition is the point: it shows the funnel is real.
const CENSUS = [
  // ── SIGNALS ──
  {
    file: 'cli/src/dial.js', pid: '-child.pid', sig: "'SIGTERM'", count: 1,
    guard: 'if (group && child.pid > 0)',
    why: 'killDial checks the live child handle before negating it into a group signal',
  },
  {
    file: 'drawer-pty.js', pid: 'pid', sig: 'sig', count: 1,
    guard: 'if (!(pid > 0)) {',
    why: "the killProcess default's own refusal — engine.js injects no killPid, so this default IS production",
  },
  {
    file: 'scripts/clodex-monitor.js', pid: '-child.pid', sig: "'SIGTERM'", count: 1,
    guard: 'if (!(child.pid > 0)) return;',
    why: "killTarget refuses before either signal; a failed spawn leaves child.pid undefined and -undefined is NaN",
  },
  {
    file: 'scripts/clodex-monitor.js', pid: '-child.pid', sig: "'SIGKILL'", count: 1,
    guard: 'if (!(child.pid > 0)) return;',
    why: 'the 2s escalation inside the same killTarget, behind the same refusal',
  },
  {
    file: 'scripts/clodex-monitor.js', pid: 'state.pid', sig: "'SIGTERM'", count: 1,
    guard: 'if (state.pid > 0) {',
    why: 'FILE provenance — read back from the watcher state JSON, so it really can be non-positive',
  },
  {
    file: 'session-manager.js', pid: 'pid', sig: "'SIGKILL'", count: 1,
    guard: 'if (!(pid > 0)) {',
    why: "sigkillPid, the funnel both the kill() and archive() backstops go through (12ec89d)",
  },
  {
    file: 'team-tickets.js', pid: '-child.pid', sig: "'SIGKILL'", count: 1,
    guard: 'if (child.pid > 0) {',
    why: 'the suite runner\'s group kill; this guard predates the incident and is what the others were missing',
  },
  {
    file: 'wirescope-supervisor.js', pid: 'pid', sig: "'SIGTERM'", count: 2,
    guard: 'if (!(rec.pid > 0)) {',
    why: 'stop() and restart() both signal _survivorPid()\'s return; the pidfile read is the funnel',
  },
  {
    file: 'wirescope-supervisor.js', pid: 'pid', sig: "'SIGKILL'", count: 1,
    guard: 'if (!(rec.pid > 0)) {',
    why: "restart()'s escalation — reached because kill(-1, 0) does not throw, so gone() never ends the poll",
  },

  // ── PROBES (signal 0) ──
  {
    file: 'agent-transport.js', pid: 'pid', sig: '0', count: 1, probe: true,
    why: 'isAlive over a registry file; a lying probe keeps a stale agent.json blocking a name',
  },
  {
    file: 'headless-main.js', pid: 'prev', sig: '0', count: 1, probe: true,
    why: 'single-instance pidfile; a lying probe refuses to start rather than starting twice',
  },
  {
    file: 'scripts/clodex-monitor.js', pid: 'pid', sig: '0', count: 1, probe: true,
    why: "isAlive for the monitor list; its caller gates on `s.pid > 0` so a broadcast pid is reaped, not listed forever",
  },
  {
    file: 'scripts/run-tests.js', pid: 'holder', sig: '0', count: 1, probe: true,
    why: 'suite-lock holder liveness; a lying probe waits for a lock instead of stealing it',
  },
  {
    file: 'wirescope-supervisor.js', pid: 'rec.pid', sig: '0', count: 1, probe: true,
    why: '_survivorPid\'s own liveness check, which now runs AFTER the `> 0` refusal above it',
  },
  {
    file: 'wirescope-supervisor.js', pid: 'pid', sig: '0', count: 1, probe: true,
    why: "restart()'s gone() poll; only reached for a pid _survivorPid already vetted",
  },
];

const key = (c) => `${c.file} :: process.kill(${c.pid}, ${c.sig})`;

function scanned() {
  const counts = new Map();
  for (const f of sourceFiles()) {
    for (const c of callsIn(f)) counts.set(key(c), (counts.get(key(c)) || 0) + 1);
  }
  return counts;
}

test('ENTER: the scan actually finds process.kill call sites in the known files', () => {
  // Without this every assertion below is "the scanned set equals the censused
  // set", which is equally true of a scan that matched NOTHING — a renamed
  // method, a changed glob or a broken regex would empty both sides and this
  // file would go green over an unscanned repo.
  const counts = scanned();
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  assert.ok(total >= 16,
    `the repo-wide scan found only ${total} process.kill call sites; it found 16 when this census was `
    + 'written. A number this low means the scan has stopped reaching the source, not that the calls went away.');

  // Named files, not just a count: a glob that silently stopped including
  // scripts/ or cli/ would still clear the total above on the remaining files.
  for (const f of ['session-manager.js', 'team-tickets.js', 'wirescope-supervisor.js',
    'scripts/clodex-monitor.js', 'cli/src/dial.js', 'drawer-pty.js']) {
    assert.ok([...counts.keys()].some((k) => k.startsWith(`${f} ::`)),
      `${f} contributed no call sites to the scan — it is known to contain at least one, so the file `
      + 'list or the matcher has stopped covering it');
  }
});

test('every process.kill in non-test source is censused, and nothing censused has vanished', () => {
  const found = scanned();
  const expected = new Map(CENSUS.map((c) => [key(c), c.count]));

  const uncensused = [...found].filter(([k, n]) => (expected.get(k) || 0) < n)
    .map(([k, n]) => `${k} (found ${n}, censused ${expected.get(k) || 0})`);
  assert.deepStrictEqual(uncensused, [],
    'these process.kill call sites are not in this file\'s CENSUS:\n  ' + uncensused.join('\n  ')
    + '\n\nA non-positive pid is a BROADCAST, not an id: -1 signals every process the user may signal (this '
    + 'happened — ~277 processes, three times, through a bare `catch {}`), and 0 signals our own process '
    + 'group. Before adding a row: find the guard that makes a non-positive pid unreachable at your site, '
    + 'and if there is none, write one (`if (!(pid > 0))`) rather than censusing the hole. Put the guard at '
    + 'the point the pid ENTERS — a parsed pidfile, a helper — not at each call, which is how this repo ended '
    + 'up with three copies of one check and a fourth site nobody guarded at all.');

  const missing = [...expected].filter(([k, n]) => (found.get(k) || 0) < n)
    .map(([k, n]) => `${k} (censused ${n}, found ${found.get(k) || 0})`);
  assert.deepStrictEqual(missing, [],
    'these censused call sites no longer exist as written:\n  ' + missing.join('\n  ')
    + '\n\nIf the call was deleted, delete its row. If it was RESPELLED, the row must be updated — a census '
    + 'that silently stops matching is a test that pins nothing.');
});

test('every censused guard literal is still present in the file it guards', () => {
  // The half that is not a headcount. Deleting a `> 0` while leaving the call
  // site untouched passes the census above, and is exactly the regression this
  // whole class is about.
  const guarded = CENSUS.filter((c) => !c.probe);
  assert.ok(guarded.length >= 9,
    `only ${guarded.length} censused sites carry a guard; there were 9 when this was written, so guards have `
    + 'been dropped from rows rather than from code');

  for (const row of guarded) {
    const src = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    assert.ok(src.includes(row.guard),
      `${row.file} no longer contains its censused guard:\n    ${row.guard}\n`
      + `  It covers process.kill(${row.pid}, ${row.sig}) — ${row.why}.\n`
      + '  Without it a non-positive pid reaches process.kill and becomes a broadcast. If the guard moved or '
      + 'was rewritten, this row must be updated to the new literal AND the new form must still refuse 0 and '
      + 'every negative — `> 0`, not a truthiness test: `-1` is truthy.');
  }
});

test('no censused liveness probe has become a real signal', () => {
  // The probes are exempt from needing a `> 0` guard ONLY because signal 0
  // delivers nothing. That exemption must not silently widen: if one of these
  // rows ever sends a real signal, its `sig` changes, the census above stops
  // matching it, and this subject names why that matters.
  for (const row of CENSUS.filter((c) => c.probe)) {
    assert.strictEqual(row.sig, '0',
      `${row.file}'s censused probe is marked probe:true but sends ${row.sig}. A probe row exists to be `
      + 'exempt from the guard requirement; a row that sends a real signal is not a probe and needs a guard.');
    const src = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    assert.ok(new RegExp(`process\\.kill\\(\\s*${row.pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*0\\s*\\)`).test(src),
      `${row.file} no longer probes with process.kill(${row.pid}, 0). If it now sends a signal, it needs a `
      + '`> 0` guard and a non-probe census row.');
  }
});
