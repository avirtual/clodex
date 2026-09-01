'use strict';
// Run: node --test test/body-preview.test.js
//
// t390 — a greedy intent body written on the lines FOLLOWING its intent line is
// stored complete but previewed as blank.
//
// THE SHAPE. `_extractIntents` joins the intent line's trailing text to the
// following lines with a newline. With no trailing text on the intent line that
// first fragment is `''`, so an intact body is stored with a LEADING newline.
// `body.split('\n')[0]` then renders present data as absent.
//
// WHY THE SUBJECTS DRIVE THE REAL ASSEMBLY. Every subject here builds its body by
// running `_extractIntents` over real turn text rather than hand-writing
// `'\nfirst real line'`. A hand-written leading newline would prove only that the
// helper handles a string the test invented; the claim under test is that this
// shape is what the SHIPPED scanner produces, and only the real assembly can
// establish that.
//
// WHY EVERY SUBJECT ASSERTS THE STORE FIRST (`ENTER:`). The whole defect is that
// a blank preview looks legitimate — indistinguishable from an empty body. A
// subject whose body never reached the store would make a blank preview CORRECT
// and would pass while measuring nothing. So each one pins the stored bytes
// before it looks at the readout.
//
// WHAT THE SURVEY FOUND, WHICH IS NOT WHAT THE TICKET ASSUMED. Four sites share
// the `split('\n')[0]` shape, but only ONE of them can exhibit the defect:
//
//   * remind list (session-manager.js) — DEFECTIVE. `sched.add` stores the body
//     verbatim, leading newline and all. This is the only site whose mutant goes
//     red, and the subject below is what pins it.
//   * memory list / the digest index — immune, and pinned as such below. The
//     body is trimmed THREE times before any preview sees it (the intent handler
//     before `remember`, `remember` itself, and `parseMemoryUnit` on every read).
//   * notify-user — immune, trimmed in the handler before the store.
//
// Those immunity subjects are not padding: the trims are load-bearing for a
// property nothing else states, and a refactor dropping one would silently
// reintroduce the blank row on the digest that every new session reads. They
// fail if an immunity stops holding, which is the only warning that would exist.

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');
const osReal = require('node:os');

const { previewLine } = require('../body-preview');
const { initStores } = require('../stores');
const { createRemindScheduler } = require('../remind-scheduler');
const { parseRemindSpec } = require('../remind-schedule');
const { createSessionManager } = require('../session-manager');
const { createMemoryStore, digestTiers } = require('../memory-store');
const { intentEnabled } = require('../intent-catalog');

const T0 = Date.UTC(2026, 7, 14, 9, 0, 0);

// The body shape under test, as an agent would actually write it: the intent
// line carries NO trailing text and the body starts on the next line.
const TURN = '[agent:remind in 1m]\nfirst real line\nsecond line';
const ASSEMBLED = '\nfirst real line\nsecond line';

function fakeClock(startMs) {
  let cur = startMs;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => cur,
    setTimer: (fn, delay) => { const h = ++seq; timers.set(h, { at: cur + delay, fn }); return h; },
    clearTimer: (h) => { timers.delete(h); },
  };
}

// A manager over REAL stores and a REAL scheduler. The readouts under test are
// built from what a store actually returns, so a stubbed store could hand back a
// body no shipped write path can produce — which is exactly the mistake that
// would make this file green over the wrong string.
function mkFixture() {
  const home = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t390-'));
  const userData = fsReal.mkdtempSync(pathReal.join(osReal.tmpdir(), 'clodex-t390-ud-'));

  const stores = initStores(userData, { log: console, registryDir: home });
  const clock = fakeClock(T0);
  const scheduler = createRemindScheduler({
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    store: stores.reminders,
    deliver: () => {},
  });
  const memoryStore = createMemoryStore(pathReal.join(home, 'memory'));

  const notified = [];
  const persistence = {
    list: () => [], get: () => null, upsert: () => {}, remove: () => {},
    markDigested: () => {}, setArchived: () => {}, setStripLevel: () => {}, setAutoCompact: () => {},
  };

  const deps = {
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
    getTemplates: () => ({ list: () => [] }),
    getRemindScheduler: () => scheduler,
    getNotifications: () => stores.notifications,
    memoryStore,
    parseRemindSpec,
    notifyOS: (opts) => notified.push(opts),
    intentEnabled,
    withoutPrivilegedIntentsFor: require('../intent-registry').withoutPrivilegedIntentsFor,
    // The REAL scanner seam, as engine.js injects it. These three drive
    // `_extractIntents`, which every subject here runs to build its body — an
    // omitted one arrives as `undefined` and throws on the first call rather
    // than quietly assembling a body this test then measures.
    fencedLines: require('../intent-scanner').fencedLines,
    parseIntent: require('../intent-scanner').parseIntent,
    looksLikeIntent: require('../intent-scanner').looksLikeIntent,
    bodyModeFor: require('../intent-registry').bodyModeFor,
    intentEnabledFor: require('../intent-registry').intentEnabledFor,
    pluginRowFor: require('../intent-registry').pluginRowFor,
    validIntentNames: require('../intent-registry').validIntentNames,
    fs: fsReal,
    path: pathReal,
    pathFor: require('../clodex-paths').pathFor,
    runDirFor: require('../clodex-paths').runDirFor,
    os: osReal,
    ensureDir: require('../fs-util').ensureDir,
    gitWorktree: require('../git-worktree'),
    childProcess: require('node:child_process'),
    countPending: require('../pending-store').countPending,
    isDraftOpen: require('../proxy-util').isDraftOpen,
    drainPending: require('../pending-store').drainPending,
    hasActivePending: require('../pending-store').hasActivePending,
    spillToFile: () => '/tmp/spill-stub.txt',
    MSG_MAX_AGE: 1800,
    termAvailableFor: require('../drawer-avail').termAvailableFor,
    REGISTRY_DIR: home,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    resolveTeam: () => null,
    findProjectRoot: () => null,
  };

  const SessionManager = createSessionManager(deps);
  const m = new SessionManager();
  const injected = [];
  m._injectText = (s, text, opts) => {
    const out = opts && typeof opts.produce === 'function' ? opts.produce() : text;
    if (out == null || out === '') return;
    injected.push(out);
  };
  m._broadcast = () => {};
  m._sendToSession = () => {};
  m._memoryAck = (s, text) => injected.push(text);

  const session = {
    name: 'lead', type: 'claude', agentType: 'claude', cwd: home,
    pty: { pid: 1 }, activityState: 'idle',
  };
  m.sessions.set('lead', session);

  return {
    m, session, injected, notified, memoryStore,
    reminders: stores.reminders,
    notifications: stores.notifications,
    // The body EXACTLY as the shipped scanner assembles it from real turn text.
    assemble: (turn) => {
      const intents = m._extractIntents(turn);
      assert.strictEqual(intents.length, 1, 'ENTER: the turn text parsed to exactly one intent');
      return intents[0].body;
    },
    cleanup() {
      scheduler.stop();
      try { fsReal.rmSync(home, { recursive: true, force: true }); } catch {}
      try { fsReal.rmSync(userData, { recursive: true, force: true }); } catch {}
    },
  };
}

// ── the helper, pinned directly ────────────────────────────────────────────

test('previewLine picks the first NON-EMPTY line, which is the whole fix', () => {
  // The defect's shape: a leading newline from the greedy assembly.
  assert.strictEqual(previewLine(ASSEMBLED, 60), 'first real line');
  // `split('\n')[0]` returns '' here. Stating the contrast in the file that
  // pins the fix means a future reader cannot mistake this for a style change.
  assert.strictEqual(ASSEMBLED.split('\n')[0], '',
    'the shape this helper exists for: line 0 of an intact body is empty');

  // Several leading blanks — the same failure, just further from the boundary.
  assert.strictEqual(previewLine('\n\n\n  \n  the real line\nmore', 60), 'the real line');

  // The ordinary case must be untouched, or the fix would be a regression for
  // every body written on the intent line.
  assert.strictEqual(previewLine('BODY on the intent line', 60), 'BODY on the intent line');

  // Whitespace-only previews as '' BY DESIGN: a body with no non-blank line has
  // nothing to show, so blank is the honest answer and the caller's `|| fallback`
  // takes over. This is the one case where a blank preview is correct.
  assert.strictEqual(previewLine('\n   \n\t\n  ', 60), '');
  assert.strictEqual(previewLine('', 60), '');

  // Trimmed, so leading indentation on the first real line does not eat the
  // slice budget and render a preview of pure whitespace.
  assert.strictEqual(previewLine('\n        indented body', 60), 'indented body');
  assert.strictEqual(previewLine('\ntrailing spaces   ', 60), 'trailing spaces');

  // The cap applies AFTER the trim, and is measured on the real line. This
  // asserted a bare `'x'.repeat(60)` — no mark — until the cut became visible.
  // That expectation was wrong in the same class as the blank preview this file
  // exists for, reporting partial data as complete instead of present data as
  // absent. Do not restore it: on a path the unmarked fragment stays
  // syntactically valid and reads as a shorter path that was never in the body.
  assert.strictEqual(previewLine('\n' + 'x'.repeat(100), 60), 'x'.repeat(59) + '…');
  assert.strictEqual(previewLine('\nabc'), 'abc', 'an omitted max returns the whole line');

  // Non-strings reach this from stores whose records predate a field.
  assert.strictEqual(previewLine(undefined, 60), '');
  assert.strictEqual(previewLine(null, 60), '');
  assert.strictEqual(previewLine(42, 60), '');
});

// ── the assembly, pinned so the subjects below are not built on a guess ────

test('the greedy assembly stores a following-lines body with a LEADING newline', () => {
  const f = mkFixture();
  try {
    // deepStrictEqual on the whole parsed intent, not a body probe: the leading
    // newline must be the ONLY oddity, and a property match would read around a
    // spec the assembly had eaten.
    const intents = f.m._extractIntents(TURN);
    assert.deepStrictEqual(intents, [{ type: 'remind', spec: 'in 1m', body: ASSEMBLED }]);

    // The body is INTACT — 28 bytes, both lines present. Nothing was dropped;
    // this is the fact the blank preview was misread as contradicting.
    assert.strictEqual(Buffer.byteLength(intents[0].body, 'utf8'), 28);
    assert.ok(intents[0].body.includes('first real line'));
    assert.ok(intents[0].body.includes('second line'));

    // The same verb with its body ON the intent line assembles with no leading
    // newline — the contrast that makes the defect shape-specific rather than
    // universal, and the reason a test covering only this form proves nothing.
    assert.strictEqual(f.assemble('[agent:remind in 1m] BODY on the intent line'),
      'BODY on the intent line');
  } finally { f.cleanup(); }
});

// ── site 1: remind list — THE defective readout ────────────────────────────

test('remind list previews the first real line of a following-lines body', () => {
  const f = mkFixture();
  try {
    const body = f.assemble(TURN);
    f.m._handleRemindIntent(f.session, 'in 1m', body);

    // ENTER: the reminder exists AND its body reached the store INTACT. Without
    // this, a blank preview below would be the correct rendering of an empty
    // body and the subject would measure nothing.
    const mine = f.reminders.listForAgent('lead');
    assert.strictEqual(mine.length, 1, 'ENTER: exactly one reminder was armed');
    assert.strictEqual(mine[0].body, ASSEMBLED,
      'ENTER: the store holds the body verbatim, leading newline included — ' +
      'this site does NOT trim, which is why it is the one that breaks');

    f.injected.length = 0;
    f.m._handleRemindIntent(f.session, 'list', '');

    const out = f.injected.join('\n');
    assert.ok(out.includes('1 reminder(s):'), `ENTER: a list readout was produced — got ${JSON.stringify(out)}`);
    assert.ok(out.includes('first real line'),
      `the readout must show the body's first REAL line — got ${JSON.stringify(out)}`);
    // The precise defect: a row that ends at the spec, with the ` — ` preview
    // separator absent or trailing nothing.
    assert.ok(!/—\s*$/m.test(out), 'no row may end with an empty preview');
    assert.ok(out.includes(`${mine[0].id}  in 1m — first real line`),
      `the whole row shape must be intact — got ${JSON.stringify(out)}`);
  } finally { f.cleanup(); }
});

test('remind list still renders an intent-line body and omits the dash when there is none', () => {
  const f = mkFixture();
  try {
    // The regression guard for the ordinary form...
    f.m._handleRemindIntent(f.session, 'in 1m', f.assemble('[agent:remind in 1m] on the line'));
    f.injected.length = 0;
    f.m._handleRemindIntent(f.session, 'list', '');
    assert.ok(f.injected.join('\n').includes('in 1m — on the line'));

    // ...and for a genuinely empty body, where NO preview is the right readout.
    // The separator must not appear orphaned — the branch that decides this moved
    // into the helper's caller, so it needs its own subject.
    const g = mkFixture();
    try {
      g.m._handleRemindIntent(g.session, 'in 1m', '   \n  ');
      const armed = g.reminders.listForAgent('lead');
      assert.strictEqual(armed.length, 1, 'ENTER: the whitespace-body reminder armed');
      g.injected.length = 0;
      g.m._handleRemindIntent(g.session, 'list', '');
      const out = g.injected.join('\n');
      assert.ok(out.includes('in 1m'), `ENTER: the row is present — got ${JSON.stringify(out)}`);
      assert.ok(!out.includes('—'), `a body with no real line gets no separator — got ${JSON.stringify(out)}`);
    } finally { g.cleanup(); }
  } finally { f.cleanup(); }
});

// ── sites 2+3: memory — immune, and that immunity is the assertion ─────────

test('a memory saved with a following-lines body is trimmed before storage, so both memory readouts are immune', () => {
  const f = mkFixture();
  try {
    const body = f.assemble('[agent:memory remember]\nfirst real line\nsecond line');
    assert.strictEqual(body, ASSEMBLED, 'ENTER: memory remember is greedy and produced the defect shape');

    f.m._handleMemoryIntent(f.session, 'remember', body);

    // ENTER: the unit exists and BOTH lines survived. The trim removes the
    // leading newline only — a trim that ate the body would also produce a
    // "correct" blank preview, which is the confusion this asserts away.
    const units = f.memoryStore.list('lead');
    assert.strictEqual(units.length, 1, 'ENTER: exactly one unit was saved');
    assert.strictEqual(units[0].body, 'first real line\nsecond line',
      'the stored body is trimmed at BOTH ends and otherwise whole');

    // The immunity itself: three trims stand between the assembly and any
    // preview (the handler, remember(), and parseMemoryUnit on read). If a
    // refactor drops them, this goes red before the blank row ships.
    assert.notStrictEqual(units[0].body[0], '\n',
      'no leading newline reaches the store — this is what makes both memory readouts immune');

    f.injected.length = 0;
    f.m._handleMemoryIntent(f.session, 'list', '');
    const out = f.injected.join('\n');
    assert.ok(/1 unit\(s\)/.test(out), `ENTER: a list readout was produced — got ${JSON.stringify(out)}`);
    assert.ok(out.includes(`${units[0].id}: first real line`),
      `the index row must carry the first real line — got ${JSON.stringify(out)}`);

    // The digest index (memory-store.js) — the readout delivered into EVERY new
    // session, and the one where a blank row would do the most damage.
    const tiers = digestTiers(units);
    assert.strictEqual(tiers.full.length + tiers.title.length, 1,
      'ENTER: the single unit was actually tiered, not dropped before the index');
    assert.ok(tiers.text.includes('first real line'),
      `the digest must carry the first real line — got ${JSON.stringify(tiers.text)}`);
  } finally { f.cleanup(); }
});

test('the digest INDEX LINE previews the first real line of an untrimmed body', () => {
  // Defence in depth, and the reason the helper went into memory-store.js rather
  // than only into the one defective site: `digestTiers` is exported and takes
  // units from its CALLER, so its correctness must not rest on a trim performed
  // three layers away by a different module.
  //
  // THE BODY IS OVERSIZED ON PURPOSE. `indexLine` — the only caller of the
  // preview in this module — runs only for a unit demoted to the TITLE tier. A
  // short unit rides in the `full` tier, where the whole body is emitted and any
  // assertion on the text passes whatever the preview does. That is not a
  // hypothetical: the first version of this subject used a short body, and the
  // mutant reverting this site survived it. Over RECENT_BODY_CAP (600) the unit
  // overflows to the index, which is the branch under test.
  const units = [{
    id: 'mem-1-aaaaaa', scope: '', tags: '', operatorPinned: false, pinned: false,
    body: '\nfirst real line\n' + 'x'.repeat(700),
    learned_at: new Date(T0).toISOString(),
  }];
  const tiers = digestTiers(units, { now: T0 });

  // ENTER: the unit reached the TITLE tier specifically. Asserting only
  // "survived tiering" is what let the mutant through — the tier it lands in is
  // the whole point, and `full` would make the text assertion vacuous.
  assert.deepStrictEqual(tiers.title, ['mem-1-aaaaaa'],
    'ENTER: the oversized unit was demoted to the index, which is the tier that previews');
  assert.deepStrictEqual(tiers.full, [], 'ENTER: no body was emitted, so the text below is the index line alone');

  assert.ok(tiers.text.includes('first real line'),
    `an untrimmed body must index by its first real line — got ${JSON.stringify(tiers.text)}`);
  assert.ok(!tiers.text.includes('mem-1-aaaaaa  ('),
    'the id must not be followed straight by the age — that is the blank-preview row');
});

// ── site 4: notify-user — immune, and the degradation the ticket asked about ─

test('notify-user trims before the store, so its OS preview is immune', () => {
  const f = mkFixture();
  try {
    const body = f.assemble('[agent:notify-user]\nfirst real line\nsecond line');
    assert.strictEqual(body, ASSEMBLED, 'ENTER: notify-user is greedy and produced the defect shape');

    f.m._handleNotifyUserIntent(f.session, body);

    // ENTER: the note reached the inbox with both lines.
    const notes = f.notifications.list();
    assert.strictEqual(notes.length, 1, 'ENTER: exactly one note was filed');
    assert.strictEqual(notes[0].body, 'first real line\nsecond line');

    assert.strictEqual(f.notified.length, 1, 'ENTER: one OS notification was raised');
    assert.strictEqual(f.notified[0].body, 'first real line',
      'the OS notification previews the first real line, not the generic fallback');
  } finally { f.cleanup(); }
});

// ── t609: a truncation with no mark reads as a complete line ────────────────
//
// The blank preview above reports present data as absent. This is the same class
// in the other direction: partial data as complete. A path is the worst case,
// because the fragment stays syntactically valid — the reported row cut inside
// "tasks" and read as an instruction naming a directory nowhere in the body.

test('previewLine marks a cut line, and never overruns the width it was given', () => {
  // The reported body, verbatim. It ends at a FILE; the readout ended at a
  // directory, and the reader acted on the readout.
  const FIELD = 'Read @/Users/bogdan/.clodex/projects/wb-wrap-ui-5bc8ce0a/tasks/reboot-baseline/live.md — the lead\'s state file: ...';
  const out = previewLine(FIELD, 60);

  // Hardcoded, not recomputed by the rule under test: an expectation built with
  // `slice(0, 59) + '…'` would assert only that the code agrees with itself.
  assert.strictEqual(out, 'Read @/Users/bogdan/.clodex/projects/wb-wrap-ui-5bc8ce0a/ta…');
  assert.strictEqual(out.length, 60, 'the mark is spent INSIDE the budget, not added to it');

  // The two ways to get this wrong, each with its own assertion so a failure
  // names the property that broke rather than just the value.
  assert.ok(out.endsWith('…'), 'no mark: a bare slice(0, max) reds here');
  assert.ok(out.length <= 60, 'overrun: slice(0, max) + the mark reds here');

  // The boundary. Exactly max is NOT a truncation, so it must not be marked —
  // a fix that ellipsizes at `>=` corrupts a line that fit.
  assert.strictEqual(previewLine('x'.repeat(60), 60), 'x'.repeat(60));
  assert.strictEqual(previewLine('x'.repeat(61), 60), 'x'.repeat(59) + '…');

  // Trailing space is eaten before the mark so a cut at a word boundary does not
  // render as 'word …'.
  assert.strictEqual(previewLine('aaaa bbbb cccc', 11), 'aaaa bbbb…');

  // Degenerate widths have no room for both a character and its mark; returning
  // a mark alone would claim a preview where none fits. max 1 is the case that
  // shipped wrong: it has room for the mark ALONE, which is exactly the value
  // this rule forbids, so the guard is `< 2` and not `< 1`.
  assert.strictEqual(previewLine('anything', 0), '');
  assert.strictEqual(previewLine('anything', 1), '');
  assert.strictEqual(previewLine('anything', 2), 'a…', 'max 2 is the narrowest width that fits both');
});

test('the no-max path is unchanged, which is pending-store.js\'s contract', () => {
  // pending-store.js calls previewLine with NO max and spends its own ellipsis
  // budget (its comment names the double-truncation hazard). If this path ever
  // starts clamping, peekPending truncates twice and its length assertion reds.
  const long = 'y'.repeat(200);
  assert.strictEqual(previewLine(long), long, 'no max returns the WHOLE line, unmarked');
  assert.strictEqual(previewLine(`\n${long}`), long);
});
