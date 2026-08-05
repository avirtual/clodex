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

const { checkTicket, flagged, WINDOW_LINES, resolvePath, extractCandidates } = require('../src/ticket-refs');
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

// ── noise classes measured on the live board ────────────────────────────────
//
// The pinned fixture cannot expose these: t75/t76/t77 happen to cite only
// repo-local paths with real symbols. On the live open board they were 37 of 61
// flagged findings — every one a confident-looking claim about a real file,
// which is the shape that trains a reader to ignore the tool. Each case below
// is a string taken from a real open ticket, not an invented one.

// A backticked span is not automatically a symbol. Tickets backtick their OWN
// references, and binding one guarantees a miss reported against a real file:
// "`prompt-rails.js:33` does not occur in prompt-rails.js" reads exactly like
// drift. Scope limit 1 already covers the case — it must reach SKIPPED.
const CITATION_SPANS = [
  ['`prompt-rails.js:33`', 'a backticked path:line'],
  ['`:856`', 'a backticked bare line'],
  ['`clodex-paths.js:45,87`', 'a comma list of lines'],
  ['`cli/src/deploy.js:1-2`', 'a line range'],
  ['`findings.md)`', 'a path with trailing prose punctuation'],
  ['`transforms.py`', 'a bare path whose extension is not js'],
];

test('a backticked reference is a citation, not a symbol to look for', () => {
  for (const [span, why] of CITATION_SPANS) {
    const cands = extractCandidates(`the wiring at ${span} is the one to delete`);
    assert.deepStrictEqual(cands.map((c) => c.symbol), [],
      `${why}: ${span} was bound as a symbol — the tool then reports its own citation text `
      + 'missing from the file, which is indistinguishable from a real MOVED finding');
  }
});

// The other half of the same class: prose in backticks. A ticket quoting
// English, or quoting THIS TOOL's output back at itself, produces a candidate
// that can never match. `engine.js` inside the quoted output is enough to
// defeat a punctuation-only test, which is why the word-run and embedded-ref
// rules exist.
const PROSE_SPANS = [
  ['`# Heading`', 'a markdown heading quoted as prose'],
  ['`no such file`', "this tool's own NOT-FOUND detail, quoted"],
  ['`:856 does not occur in engine.js`', 'a quoted finding containing a real filename'],
  ['`prompt-rails.js:33 found at :1`', 'a quoted finding containing a citation'],
];

test('backticked prose is not a symbol, even when it contains a filename', () => {
  for (const [span, why] of PROSE_SPANS) {
    const cands = extractCandidates(`reported as ${span} against session-manager.js:100`);
    assert.deepStrictEqual(cands.map((c) => c.symbol), [],
      `${why}: ${span} was bound as a symbol`);
  }
});

// A quoted sentence can CONTAIN a code token — an error message, a test name —
// and one token is enough to defeat the punctuation test. These two rows are
// the only thing separating "drop the sentence, keep the symbol inside it"
// from binding the whole sentence and reporting it missing from a real file.
// Both spans are verbatim from the board (t25, t126).
test('a quoted sentence is prose even when it contains a code token', () => {
  assert.deepStrictEqual(
    extractCandidates('crashes with `TypeError: app.setAboutPanelOptions is not a function` at app-menus.js:431')
      .map((c) => c.symbol),
    ['app.setAboutPanelOptions'],
    'the SYMBOL inside the message is the checkable thing; binding the whole message reports '
    + 'an error string missing from the file, which is noise wearing a NOT-FOUND badge');
  assert.deepStrictEqual(
    extractCandidates("`'97 pins against the real budget leaves every id reachable'` at test/memory-store.test.js:184")
      .map((c) => c.symbol),
    [],
    'a quoted test name names nothing to grep for — the quote marks are code punctuation');
});

// And the rule must not eat real symbols. A multi-word span IS code when it
// carries code punctuation, and every multi-word symbol in real ticket text
// does. Without this the prose rule silently disables checking on the
// most specific references the board has.
const REAL_MULTIWORD_SYMBOLS = [
  '`const wc = e.sender`',
  '`entry.replyStderr === true`',
  '`existsSync(socket) && isAlive(pid)`',
  '`wireRouted && intentSource === \'jsonl\'`',
];

test('a multi-word span carrying code punctuation is still a symbol', () => {
  for (const span of REAL_MULTIWORD_SYMBOLS) {
    const cands = extractCandidates(`${span} at session-manager.js:100`);
    assert.strictEqual(cands.length, 1,
      `${span} must survive extraction — dropping it makes the reference uncheckable`);
    assert.strictEqual(cands[0].symbol, span.slice(1, -1));
  }
});

// ── basename resolution ─────────────────────────────────────────────────────

// The suffix match is on a path boundary. A bare endsWith makes `transport.js`
// match `agent-transport.js` — turning the unambiguous cases ambiguous, which
// is worse than not resolving at all: the tool then reports a symbol missing
// from a file the ticket never meant.
test('a cited basename matches on a path boundary, not a bare suffix', () => {
  const files = ['agent-transport.js', 'cli/src/transport.js', 'peer-import.js', 'cli/src/import.js'];
  assert.deepStrictEqual(resolvePath('transport.js', files), ['cli/src/transport.js'],
    'agent-transport.js ends with "transport.js" but is a DIFFERENT file');
  assert.deepStrictEqual(resolvePath('import.js', files), ['cli/src/import.js'],
    'peer-import.js is likewise not an import.js');
  assert.deepStrictEqual(resolvePath('nope.js', files), [],
    'no match must be empty, so the caller can report `no such file` honestly');
});

// An exact path is not a guess and must short-circuit — otherwise a cited
// `cli/src/transport.js` would be re-derived from the file list and could pick
// up a same-basename sibling.
test('an exactly-cited path resolves to itself alone', () => {
  const files = ['cli/src/transport.js', 'other/cli/src/transport.js'];
  assert.deepStrictEqual(resolvePath('cli/src/transport.js', files), ['cli/src/transport.js']);
});

// Which of several same-basename files a ticket meant is decided by the SYMBOL,
// because nothing else can decide it. Resolving on path shape first (shallowest
// wins, say) reports the symbol absent from a file that was never the referent
// — a confident NOT-FOUND about the wrong file, which is the exact failure this
// whole ticket exists to remove. Taken from t122: `renderer.js:168` for
// `taskDir` means plugins/tickets-viewer/renderer.js, not renderer/renderer.js.
test('an ambiguous basename resolves to the file the symbol is actually in', () => {
  const files = ['renderer/renderer.js', 'plugins/tickets-viewer/renderer.js'];
  const src = {
    'renderer/renderer.js': 'const a = 1;\n'.repeat(400),
    'plugins/tickets-viewer/renderer.js': `${'// filler\n'.repeat(197)}const art = t.taskDir;\n`,
  };
  const findings = checkTicket('tX', 'the artifact row at `taskDir` — renderer.js:168', (p) => src[p] || null, { files });
  assert.strictEqual(findings.length, 1, 'ENTER: exactly the one reference');
  const f = findings[0];
  assert.strictEqual(f.status, 'MOVED',
    'the symbol IS in one of the candidates, so this is drift — NOT-FOUND here would be the '
    + 'shallowest-wins bug, reporting absence from a file that was never the referent');
  assert.strictEqual(f.resolvedPath, 'plugins/tickets-viewer/renderer.js',
    'the finding must name the file it actually read; a basename match is a guess and an '
    + 'unshown guess cannot be checked by the reader');
  assert.strictEqual(f.foundAt, 198);
  assert.strictEqual(f.alternatives, 1, 'and the reader must be told another candidate existed');
});

// Resolution is OPT-IN. The pinned fixture passes no file list on purpose:
// resolving a historical reference against TODAY's file list is not a pinned
// read, and would let a file added since the pin change a verdict about it.
test('without a file list, every cited path is used verbatim', () => {
  const reads = [];
  const read = (p) => { reads.push(p); return null; };
  checkTicket('tX', 'see `someHelper` at renderer.js:12', read);
  assert.deepStrictEqual(reads, ['renderer.js'],
    'no opts.files means no resolution — the caller\'s path is the path, which is what keeps '
    + 'the pinned fixture a pinned read');
});
