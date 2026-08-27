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

// Comments blanked to spaces, offsets preserved — but string literals are SKIPPED
// OVER, not blanked, and that asymmetry is the whole point of this function.
//
// Adapted from the `stripNonCode` in test/sigkill-pid-guard.test.js (which took it
// from test/preserve-census.test.js); copied rather than shared because those files
// export nothing, and `require`-ing one .test.js from another re-registers its
// subjects in this process, so the suite would run them twice and report inflated
// counts.
//
// The defect being fixed is the naive `/\/\/[^\n]*/g` this replaced: a `//` inside a
// string literal ate the rest of that line. wirescope-supervisor.js is scanned here
// and carries exactly that shape (`http://127.0.0.1:${port}`), so a process.kill
// sharing a line with a URL would have gone unseen by BOTH rawCount and callsIn —
// consistently, which is why the raw-vs-parsed check below could never catch it.
//
// It diverges from the guard file's version by KEEPING string bodies: `callsIn`
// reads each site's signal argument as a literal (`'SIGKILL'`) and every CENSUS row
// keys on it, so blanking strings would empty the `sig` of every row that keys on a
// quoted signal and the census would key nothing.
//
// Skipping the literal is enough to fix the line-eating; blanking it is not needed
// for that and costs the census its identity.
function stripNonCode(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (src[i] === "'" || src[i] === '"' || src[i] === '`') {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      out += src.slice(i, stop);
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

// This file's own prose quotes `process.kill(-1)`, and so do the guard comments in
// the modules being scanned. A scan that counted prose would report them. Every
// scan below goes through this — a check that reads raw source is a check a comment
// can satisfy.
function codeOf(rel) {
  return stripNonCode(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// The parse is deliberately NARROW — two comma-separated arguments, neither
// containing a paren — and `rawCount` is what keeps that narrowness honest. A
// spelling this regex cannot read is not a site that passes the census, it is a
// site the census cannot SEE, which is strictly worse: it contributes nothing to
// `scanned()`, so it can never appear as uncensused and nothing fails. Two legal
// spellings evade it, and both were demonstrated against this file:
//
//   process.kill(rec.pid)                     one-arg — signal defaults to SIGTERM,
//                                             so process.kill(-1) really does broadcast
//   process.kill(Number(rec.pid), 'SIGKILL')  the pid group stops at the inner paren
//
// Counting raw `process.kill(` occurrences and requiring the two numbers to agree
// turns "cannot see it" into a loud failure, which is the only version of this
// pin that matches its own contract at the top of the file.
function callsIn(rel) {
  const code = codeOf(rel);
  return [...code.matchAll(/process\.kill\(\s*([^,)]+?)\s*,\s*([^)]+?)\s*\)/g)]
    .map((m) => ({ file: rel, pid: m[1], sig: m[2] }));
}

// Whitespace-tolerant where `callsIn` is not, deliberately: `process.kill (pid, sig)`
// and `process . kill(pid, sig)` are legal spellings that the narrow parse cannot
// read, so counting them with the same literal would have made them invisible to
// both halves at once — the defect this pair exists to close. Counted here and
// unparsed there, they surface as a loud raw-vs-parsed mismatch instead.
// `const k = process.kill` stays out of reach of any static scan; that is accepted,
// not an oversight to widen this regex over.
function rawCount(rel) {
  return (codeOf(rel).match(/process\s*\.\s*kill\s*\(/g) || []).length;
}

// A liveness probe. Signal 0 delivers nothing, so a broadcast pid here is a wrong
// ANSWER, not a massacre — and every probe in this repo gates a REFUSAL (wedge a
// restore, defer a merge, refuse to take a lock), never a kill, so a probe that
// lies reads a dead thing as alive and fails CLOSED. They are censused rather
// than filtered out: if one of these is ever changed to send a real signal, its
// row stops matching and this test says so. That is the only reason the split is
// safe to draw.

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

test('every process.kill call site is one the census can actually READ', () => {
  // The must-fix. `scanned()` can only report sites the narrow regex parses, so a
  // site written in a spelling it cannot read is invisible rather than uncensused
  // — it fails nothing, and the census silently stops being a census. This subject
  // is what makes the file's opening claim ("a new call site fails this test
  // whether or not it is guarded") true; without it that claim was false, and two
  // legal spellings were shown to walk straight past every other subject here.
  const mismatched = [];
  for (const f of sourceFiles()) {
    const raw = rawCount(f);
    const parsed = callsIn(f).length;
    if (raw !== parsed) mismatched.push(`${f}: ${raw} written, ${parsed} readable`);
  }
  assert.deepStrictEqual(mismatched, [],
    'these files contain a process.kill the census cannot parse:\n  ' + mismatched.join('\n  ')
    + '\n\nThe matcher reads exactly `process.kill(pid, SIG)` with two comma-separated arguments and no '
    + 'parens inside either. Two legal spellings evade it and are the reason this check exists:\n'
    + '  process.kill(rec.pid)                    — one argument; the signal DEFAULTS to SIGTERM, so a '
    + 'non-positive pid here still broadcasts\n'
    + "  process.kill(Number(rec.pid), 'SIGKILL') — the pid group stops at the inner paren\n"
    + '  process.kill (pid, SIG)                  — rawCount tolerates the space, the parse does not\n'
    + 'Comments are blanked before both counts, so prose never lands here — but STRING BODIES are not (the '
    + "census keys on each site's `'SIGKILL'` literal, so they have to survive). A file that merely PRINTS "
    + 'the text `process.kill(` inside a string therefore raw-counts without parsing, and shows up as a '
    + 'spurious row here; hoist that text out of the literal or split it.\n'
    + 'Respell the call as `process.kill(pid, SIG)` with a bare identifier for the pid (hoist any expression '
    + 'into a const first, which is what every guarded site in this repo already does), or teach the matcher '
    + 'the new shape. Do NOT relax this assertion: a site the census cannot see is worse than an uncensused '
    + 'one, because nothing fails.');
});

test('every process.kill in non-test source is censused, and nothing censused has vanished', () => {
  const found = scanned();

  // A duplicated key would otherwise be silently collapsed by the Map below,
  // keeping only the last row and halving the count this census expects — an
  // under-count that reads as a passing census while a real call site goes
  // unaccounted for.
  const keys = CENSUS.map(key);
  assert.strictEqual(new Set(keys).size, CENSUS.length,
    'two CENSUS rows share a key, so one silently overwrites the other and its `count` is lost. Sites that '
    + 'genuinely share a spelling belong in ONE row with `count` raised, not in two.');

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
    // codeOf, not the raw source: the comment block above each of these guards
    // quotes the guard literal while explaining it, so a raw `includes` stays
    // green when the guard is DELETED and only its rationale is left behind.
    const src = codeOf(row.file);
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
    // codeOf, not the raw source, for the reason the guard subject above gives: a
    // deleted probe whose rationale still spells `process.kill(pid, 0)` in prose
    // would keep this row green over code that no longer exists.
    const src = codeOf(row.file);
    assert.ok(new RegExp(`process\\.kill\\(\\s*${row.pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*0\\s*\\)`).test(src),
      `${row.file} no longer probes with process.kill(${row.pid}, 0). If it now sends a signal, it needs a `
      + '`> 0` guard and a non-probe census row.');
  }
});

test('the comment/string strip does not swallow a file tail', () => {
  // An unterminated `/*` blanks every byte to EOF, and every scan above then reads
  // an empty file and PASSES. That is the failure this whole file exists to prevent,
  // reached from the inside: for a file carrying a CENSUS row the blanking is loud
  // (its row stops being found and `missing` fires), so the real exposure is a file
  // with NO row that later gains a call site — invisible rather than uncensused.
  // CENSUS names only a small subset of the files scanned here, so a canary over
  // censused files would miss precisely the gap. This runs over `sourceFiles()`,
  // the scan's real input.
  //
  // Measured, not assumed: an unterminated quote or a regex containing a quote does
  // NOT blank a tail in this copy of the strip — it keeps string bodies (`:90`), so a
  // mis-paired quote leaks a COMMENT through un-blanked instead. That is a false
  // POSITIVE (prose can satisfy a scan), the opposite direction, and no tail canary
  // of any shape catches it.
  const blanked = [];
  for (const f of sourceFiles()) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = codeOf(f);

    // The premise the offset comparison stands on, and the one check here that DOES
    // abort the run: once the strip stops being offset-preserving the tail read below
    // is comparing offsets that no longer line up, so collecting its verdicts would
    // just be collecting noise. stripNonCode replaces comments with equal-length runs
    // of spaces and copies strings verbatim.
    assert.strictEqual(code.length, raw.length,
      `stripNonCode is no longer offset-preserving on ${f} (${raw.length} in, ${code.length} out). `
      + 'The tail check below compares the two by OFFSET, so it reads the wrong character once this '
      + 'holds and stops being a canary at all. Restore length preservation — comments must become '
      + 'equal-length spaces, strings must be copied through — before touching that check.');

    let last = raw.length - 1;
    while (last >= 0 && /\s/.test(raw[last])) last -= 1;
    if (last < 0) continue; // a whitespace-only file has no tail to lose

    // No literal from any scanned file appears here on purpose: a hardcoded last
    // line per file is 9+ literals that go stale on any refactor of any of them,
    // and a stale canary gets deleted rather than fixed.
    if (/\s/.test(code[last])) blanked.push(f);
  }

  // Collected rather than asserted in the loop: a tree-wide breakage — the shape an
  // edit to the strip itself produces — is one failure naming every affected file,
  // not one file per run.
  assert.deepStrictEqual(blanked, [],
    'stripNonCode blanked the tail of these files:\n  ' + blanked.join('\n  ')
    + '\n\nThe last non-blank character of the source is blank after the strip, so every scan in this '
    + 'file reads a truncated version of it and PASSES over anything in the eaten span. Two causes this '
    + 'check cannot tell apart — rule out the second before touching the strip:\n'
    + '  1. an unterminated `/*` ran to EOF (the defect; no other shape blanks a tail in this copy of '
    + 'the strip, which keeps string bodies).\n'
    + '  2. the file legitimately now ENDS with a comment, which the strip blanks correctly. '
    + 'No scanned file did when this was written; if one does now, the canary needs that file taught to '
    + 'it — the strip is not wrong.');
});

test('no comment leaks through the strip un-blanked', () => {
  // The OPPOSITE direction from the tail canary above, and invisible to it. A regex
  // containing a quote (`/[']/`) or an unterminated quote desyncs the scanner: the
  // quote branch runs to the next matching quote, which can be on a LATER line, so a
  // `//` comment in between is never recognised as a comment and is copied through
  // verbatim. The strip stays offset-preserving throughout, so neither the length
  // assert nor the tail read above can see it — the tail is over-copied, not blanked.
  //
  // A leaked comment is read as CODE by every scan in this file. Measured on a planted
  // copy — three lines, in this order, are enough:
  //
  //     const re = /[']/;
  //     // process.kill(-1, 'SIGKILL')   <- prose, not a call
  //     const x = 1;
  //
  // `rawCount` then saw 2 sites in a file with 1, and the parse returned `-1, 'SIGKILL'`
  // — a broadcast call site conjured out of prose.
  //
  // Measured, not reasoned, on which direction is quiet. A leak also lands in `found`,
  // so it usually fires `uncensused` loudly; a key that COLLIDES with an existing CENSUS
  // row still reds it, because the row's `count` doubles. The silent case is narrow and
  // real: prose conjuring back a site that was REMOVED from the file, at the same key and
  // the same count. Planted, every other subject here stayed green — including the ENTER
  // floor, whose `total >= 16` the prose was holding up — and only this one fired.
  //
  // This detects the CONSEQUENCE, not the cause: teaching stripNonCode to model
  // regex literals or `${…}` is a real parser and a third divergent copy of one, and
  // that fence stands (t493, t497). A line whose trimmed form starts with `//` is a
  // comment under every lexical reading but one, and that one is named in the message
  // below — no parsing required to say so.
  const suspect = [];
  const leaked = [];
  for (const f of sourceFiles()) {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = codeOf(f);
    if (code.length !== raw.length) continue; // the subject above owns that failure

    let off = 0;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      // Narrowed to the prose that can actually satisfy a scan here. A leak of any
      // other comment is equally real but harmless to THIS file's checks, and a
      // detector that fired on all of them would be reporting the strip's whole
      // imprecision rather than a defect anyone must act on.
      //
      // `//` only, and that is a real gap: a leaked `/* … process.kill … */` block is
      // just as readable-as-code and passes here unseen. No scanned file has one today,
      // so this is an unclosed hole rather than a live one — a leaked block comment is
      // the case to extend this predicate for, not a reason to distrust a green run.
      if (t.startsWith('//') && t.includes('process.kill')) {
        suspect.push(`${f}: ${t.slice(0, 60)}`);
        if (code.slice(off, off + line.length).trim() !== '') leaked.push(`${f}: ${t.slice(0, 60)}`);
      }
      off += line.length + 1;
    }
  }

  // ENTER: the reduction above sits between the strip and an emptiness assert, so a
  // matcher that stopped selecting lines would vacuum out the check and leave it
  // green. NOT held by this file's own prose — `sourceFiles()` filters `test/`, so
  // nothing here is scanned. It rides entirely on five guard comments in four
  // production files (drawer-pty.js, session-manager.js, wirescope-supervisor.js,
  // scripts/clodex-monitor.js twice), which is free-form prose nothing else pins:
  // margin of 2, and a reword is a legitimate reason for this to move.
  assert.ok(suspect.length >= 3,
    `only ${suspect.length} comment lines mentioning process.kill were found across the scanned set; `
    + 'there were 5 when this was written, in four production files — drawer-pty.js, session-manager.js, '
    + 'wirescope-supervisor.js and scripts/clodex-monitor.js (twice). This test file is NOT among them: '
    + 'sourceFiles() filters test/, so this file contributes nothing to the floor. Three causes:\n'
    + '  1. the line matcher or the file list has stopped selecting, and the emptiness assert below '
    + 'proves nothing — the scan is broken.\n'
    + '  2. one of those guard comments was reworded to stop spelling `process.kill` (say, `kill()` '
    + 'instead). Nothing is wrong: the prose moved, the scan is fine, and the FLOOR is what should '
    + 'change. Re-grep the scanned set and set it to what is really there.\n'
    + '  3. stripNonCode stopped preserving offsets on one of those four files, so the length guard '
    + 'at the top of this loop skipped it before any line was examined — it counted toward neither '
    + 'number. The matcher and the prose are both fine; the strip is what broke. Do not start here: '
    + "the subject above ('the comment/string strip does not swallow a file tail') asserts that "
    + 'condition directly and names the offending file and its two lengths. Fix what IT reports, and '
    + 'this floor comes back on its own.');

  assert.deepStrictEqual(leaked, [],
    'these COMMENT lines survived stripNonCode un-blanked:\n  ' + leaked.join('\n  ')
    + '\n\nSomething above each line desynced the scanner — most likely a regex literal containing a '
    + "quote (`/[']/`, `/can't/`) or an unterminated quote — so the strip is inside a string scan where "
    + 'the source is inside a comment, and every scan in this file now reads that prose as CODE.\n'
    + 'Fix the SOURCE line, not the strip: hoist the offending literal, escape the quote, or use a '
    + 'character class that does not contain one. Teaching stripNonCode to parse regex literals or '
    + '`${…}` interpolation is deliberately not the answer — it is a real parser, and it would be the '
    + 'third divergent copy of one across this suite.\n'
    + 'ONE false positive is possible and is the only one: a line reading `// …process.kill…` inside a '
    + 'multi-line TEMPLATE LITERAL is not a comment, and is correctly copied through. If that is what '
    + 'this is, the strip is right — move the assertion, not the strip.');
});
