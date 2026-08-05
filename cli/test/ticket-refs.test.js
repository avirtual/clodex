'use strict';

// ticket-refs.js against the cluster that motivated it.
//
// THE ACCEPTANCE CRITERION HAS TWO HALVES AND THE SECOND IS THE HARD ONE:
// flag every known defect, AND leave the references that were correct alone. A
// checker that flags everything passes the first half trivially and is worse
// than nothing, because it trains its reader to skip the output. Every
// must-not-flag assertion below is load-bearing for that reason — and one of
// them caught a real false positive during development, where a symbol
// mentioned in the NEXT PARAGRAPH was genuinely the nearest one by character
// distance to a correct reference.
//
// The cited files are read at a PINNED commit (see the fixture file for why —
// against today's tree, t75's one correct reference is indistinguishable from
// the defects). If git cannot produce the pin, these tests fail rather than
// silently checking nothing.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { checkTicket, flagged, WINDOW_LINES } = require('../src/ticket-refs');
const { PIN, TICKETS } = require('./fixtures/ticket-refs-fixtures');

const REPO = path.join(__dirname, '..', '..');

function readPinned(p) {
  try {
    return execFileSync('git', ['show', `${PIN}:${p}`], { encoding: 'utf-8', cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const runAll = () => Object.entries(TICKETS).flatMap(([id, text]) => checkTicket(id, text, readPinned));

// A `git show` that cannot reach the pin returns null for every path, which
// makes every reference NOT-FOUND — "all defects flagged" would then pass for
// the wrong reason while the must-not-flag half fails confusingly. Establish
// the fixture is readable before reading anything into the results.
test('fixture: the pinned tree is readable, or every assertion below is about nothing', () => {
  const src = readPinned('agent-transport.js');
  assert.ok(src && src.length > 1000,
    `could not read agent-transport.js at ${PIN} — the pin is unreachable in this clone`);
  const lines = src.split('\n');
  assert.match(lines[85], /fs\.existsSync\(info\.socket\) && isAlive\(info\.pid\)/,
    'ENTER: at the pin, agent-transport.js:86 IS the liveness guard t75 cites — this is the '
    + 'anchor for the whole must-not-flag half, and in today\'s tree it lands on comment prose');
});

// ── half one: every known defect is flagged, with the RIGHT line ─────────────
//
// foundAt is asserted, not just the status. A defect reported with the wrong
// symbol still has status MOVED: during development engine.js:1451 was reported
// as `_cleanup found at :713` when the reference is about waitForSessionExit at
// :1445. Status-only assertions stay green through that, while the output sends
// the reader 700 lines wrong.
const KNOWN_DEFECTS = [
  { ticket: 't77', ref: 'engine.js:1451', symbol: 'waitForSessionExit', foundAt: 1445 },
  { ticket: 't77', ref: 'ipc-handlers.js:351', symbol: 'waitForSessionExit', foundAt: 348 },
  { ticket: 't77', ref: 'session-manager.js:2368', symbol: '_cleanup', foundAt: 2287 },
  { ticket: 't77', ref: 'session-manager.js:2366', symbol: 'rmSync', foundAt: 2301 },
  // Not one of the four the ticket counted, but defective by content at the
  // pin: :1380 lands on an unrelated comment; isStaleRegistration is at :1339.
  { ticket: 't75', ref: 'session-manager.js:1380', symbol: 'isStaleRegistration', foundAt: 1339 },
];

test('flags every known defect, naming the line the symbol actually lives on', () => {
  const findings = runAll();
  assert.ok(findings.length > 10,
    `ENTER: only ${findings.length} findings — the fixtures produced almost nothing, so what `
    + 'follows would be asserting against an empty run');

  for (const want of KNOWN_DEFECTS) {
    const got = findings.find((f) => f.ticket === want.ticket && f.ref === want.ref && f.status === 'MOVED');
    assert.ok(got, `${want.ticket} ${want.ref} must be flagged MOVED — it is a known defect at ${PIN}`);
    assert.strictEqual(got.foundAt, want.foundAt,
      `${want.ref}: MOVED must carry the REAL line, which is the whole value of the finding`);
    assert.match(got.symbol, new RegExp(want.symbol.replace(/[$]/g, '\\$')),
      `${want.ref}: flagged on the wrong symbol — the status is right and the output misleads`);
  }
});

// ── half two: the correct references are left alone ─────────────────────────
//
// These were verified by hand against the pinned tree. Any of them appearing in
// the flagged set is a false positive, which is the failure mode that makes the
// tool worse than not having it.
const CORRECT_AT_PIN = [
  ['t75', 'agent-transport.js:86'],    // the liveness guard, exactly
  ['t75', 'agent-transport.js:103'],   // its cleanup-side twin
  ['t75', 'agent-transport.js:34-37'], // isAlive / kill(pid,0)
  ['t75', 'agent-transport.js:64'],    // the record that stores pid
  ['t75', 'agent-transport.js:211'],   // send resolving false
  ['t75', 'session-manager.js:1300-1313'], // the pre-bind probe
  ['t76', 'agent-transport.js:100-104'],   // cleanup's read-then-unlink
  ['t76', 'agent-transport.js:105-117'],   // the why-not-unlink comment
  ['t77', 'engine.js:1293'],               // a real waitForSessionExit call
  ['t77', 'engine.js:1253-1257'],          // the 300ms-sleep note
  ['t77', 'test/plugin-host-engine.test.js:138-151'], // the indexOf-ordering pin
];

test('flags none of the references that were correct at the pin', () => {
  const findings = runAll();
  const bad = flagged(findings);
  // GUARD BEFORE THE ABSENCE. `bad` containing none of the correct references
  // is trivially true of a run that produced no findings at all, and equally
  // true of one that produced only SKIPPED. Prove the flagging path fired.
  assert.ok(bad.length >= KNOWN_DEFECTS.length,
    `ENTER: only ${bad.length} flagged findings — the must-not-flag assertions below are `
    + 'satisfied by a tool that flags nothing, so they mean nothing without this');

  for (const [ticket, ref] of CORRECT_AT_PIN) {
    const seen = findings.find((f) => f.ticket === ticket && f.ref === ref);
    assert.ok(seen, `ENTER: ${ticket} ${ref} was never extracted — it cannot be "not flagged" if it is not there`);
    assert.ok(!bad.includes(seen),
      `FALSE POSITIVE: ${ticket} ${ref} was correct at ${PIN} but got ${seen.status} `
      + `(${seen.detail}) — a checker that flags correct references trains its reader to ignore it`);
  }
});

// ── the scope limits, pinned as behaviour rather than left in prose ─────────

test('a reference naming no symbol is SKIPPED, and the miss is visible in the output', () => {
  const findings = checkTicket('t76', TICKETS.t76, readPinned);
  const ref = findings.find((f) => f.ref === 'session-manager.js:1350-1353');
  assert.ok(ref, 'ENTER: the reference was extracted');
  // This one IS defective at the pin — :1350-1353 is a Transport construction;
  // the re-read guard it describes is at :1312. The tool cannot see it, because
  // the ticket describes it in prose without naming a symbol. Pinned as a KNOWN
  // MISS so the limit is a measured fact rather than a claim in a comment, and
  // so that a future version closing it fails here and gets to update the doc.
  assert.strictEqual(ref.status, 'SKIPPED',
    'scope limit 1: prose-only references are unreachable by this technique');
  assert.match(ref.detail, /no symbol/,
    'and the reason must be in the output — a silent skip reads as a clean check');
});

test('SKIPPED and RESOLVED are reported but never flagged', () => {
  const findings = runAll();
  const statuses = new Set(findings.map((f) => f.status));
  assert.ok(statuses.has('SKIPPED') && statuses.has('RESOLVED') && statuses.has('MOVED'),
    `ENTER: expected all three statuses in the fixture run, saw ${[...statuses].join(',')}`);
  for (const f of flagged(findings)) {
    assert.ok(f.status === 'MOVED' || f.status === 'NOT-FOUND',
      `${f.ref}: ${f.status} is not a problem and must stay out of the flagged set`);
  }
});

// The window is the tool's one tuning knob and the specific way it goes quietly
// useless: widen it and a symbol occurring twice starts resolving to the wrong
// occurrence, reporting RESOLVED for a reference that is wrong. Two of the
// known defects sit within 6 lines of their real symbol, so a window that grew
// to 6 would silently stop flagging them.
test('the match window is a tight named constant, not a literal', () => {
  assert.strictEqual(typeof WINDOW_LINES, 'number', 'exported so its value is reviewable');
  assert.ok(WINDOW_LINES <= 3,
    `WINDOW_LINES is ${WINDOW_LINES}: widening it makes MOVED defects resolve against a `
    + 'nearby unrelated occurrence — ipc-handlers.js:351 sits 3 lines from its real symbol');
});

// The false positive that the must-not-flag half caught during development: a
// symbol mentioned in a later paragraph, annotating nothing, was the nearest by
// character distance to a correct reference in the paragraph above.
test('a symbol in a different paragraph does not annotate a reference', () => {
  const text = 'The guard is at agent-transport.js:86 and holds.\n\n'
    + 'Separately, listPeers was kept synchronous as a scope decision.';
  const findings = checkTicket('tX', text, readPinned);
  const ref = findings.find((f) => f.ref === 'agent-transport.js:86');
  assert.ok(ref, 'ENTER: the reference was extracted');
  assert.strictEqual(ref.status, 'SKIPPED',
    'the only symbol is across a blank line, so nothing annotates this reference — binding it '
    + 'anyway is how a correct reference gets flagged, since by raw distance it IS the nearest');
});

// One symbol routinely governs a LIST of references. Without run-extension only
// the nearest of the three is ever checked, and two known defects go unseen.
test('one symbol governs a comma-run of references', () => {
  const findings = checkTicket('t77', TICKETS.t77, readPinned);
  const run = ['engine.js:1293', 'engine.js:1451', 'ipc-handlers.js:351']
    .map((r) => findings.find((f) => f.ref === r));
  assert.ok(run.every(Boolean), 'ENTER: all three references in the run were extracted');
  assert.deepStrictEqual(run.map((f) => f.status), ['RESOLVED', 'MOVED', 'MOVED'],
    'the single waitForSessionExit governs all three — binding it to only the nearest leaves '
    + 'two of the four known defects unchecked');
});

// When a sentence names several symbols and the reference is wrong about all of
// them, MOVED must report the one whose real line is NEAREST — that is the one
// the reference was aimed at. Reporting another sends the reader to a different
// function, with a finding that still LOOKS right because the status is.
//
// This is pinned synthetically because no fixture reference happens to bind two
// symbols that BOTH miss: in t77 the nearest symbol is also the first bound, so
// the fixtures alone cannot tell the two rules apart. Measured, not assumed —
// swapping nearest for first-bound left the whole fixture suite green.
test('MOVED reports the nearest missing symbol, not the first one bound', () => {
  // `_cleanup` (declared at :2287) is named FIRST; `sessions.delete` (at :2312)
  // is named second and is the nearer to the cited :2368. The two rules disagree
  // here, which is the only reason this case is worth writing.
  const text = '`_cleanup` ends with `sessions.delete` (session-manager.js:2368)';
  const findings = checkTicket('tX', text, readPinned);
  assert.strictEqual(findings.length, 1, 'ENTER: exactly the one reference');
  const f = findings[0];
  assert.strictEqual(f.status, 'MOVED', 'ENTER: both symbols miss, so this is the MOVED path');
  assert.strictEqual(f.symbol, 'sessions.delete',
    'the nearer symbol is the one the reference was aimed at; reporting `_cleanup` at :2287 '
    + 'points the reader at a different statement 25 lines away');
  assert.strictEqual(f.foundAt, 2312);
});

// A dotted symbol must not be mistaken for a file path. An unanchored
// extension test matches INSIDE `sessions.delete`, which silently drops the
// symbol the ticket actually named — and the reference then gets reported
// against whatever else it bound, with a plausible-looking status.
test('a dotted symbol is a symbol, not a file path', () => {
  const findings = checkTicket('tX', 'see `sessions.delete` at session-manager.js:2368', readPinned);
  assert.strictEqual(findings.length, 1, 'ENTER: exactly the one reference');
  assert.strictEqual(findings[0].symbol, 'sessions.delete',
    'the symbol must survive extraction — dropping it makes the reference uncheckable or '
    + 'checkable against the wrong thing');
  assert.strictEqual(findings[0].foundAt, 2312);
});

test('a reference to a file that does not exist is NOT-FOUND, not a crash', () => {
  const findings = checkTicket('tX', 'see `someHelper` at no/such/file.js:12', readPinned);
  assert.strictEqual(findings.length, 1, 'ENTER: exactly the one reference');
  assert.strictEqual(findings[0].status, 'NOT-FOUND');
  assert.match(findings[0].detail, /no such file/);
});
