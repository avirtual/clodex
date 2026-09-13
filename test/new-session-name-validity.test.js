'use strict';
// Run: node --test test/new-session-name-validity.test.js
//
// t684 — the New Session dialog's name field. Bogdan deleted a seat, reopened
// the dialog with the same name, configured skills/tools/options, pressed OK: the
// dialog CLOSED, an alert then said the name is archived, and the whole
// configuration was gone. Two mechanisms, one field:
//
//   BEFORE submit, the conflict is knowable — `session:reservedNames` returns
//   every live and persisted name — so the field says which kind of name it is
//   and Create is disabled while it is unusable.
//
//   AT submit the list may be stale (a seat spawned by an intent between the
//   fetch and the press), so the server refusal stays authoritative. What
//   changes is that the refusal no longer costs the form: the dialog does not
//   close until the reply says ok.
//
// The decision lives in renderer/lib/name-validity.js because renderer.js is
// DOM-bound with no harness. That split is exactly what the source-shape pins at
// the bottom guard: a leaf that decides correctly is worth nothing if doCreate
// closes the dialog before asking it. Those pins cannot prove the code RUNS —
// only that the close is not sitting where it used to.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  SESSION_NAME_RE, NAME_MESSAGES,
  reservedSets, reservedUnion, nameFieldState, createButtonState,
  paintNameField, applyCreateResult,
} = require('../renderer/lib/name-validity');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

// The smallest document the painters touch: className/textContent/style on the
// hint and the input, classList on the overlay. Deliberately not jsdom — every
// assertion here is about which property gets set, and a real DOM would add a
// dependency and nothing else.
function els() {
  const classes = new Set(['hidden']);
  return {
    input: { value: '', style: { borderColor: '' } },
    hint: { className: 'hint-text', textContent: '' },
    overlay: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      _visible: () => !classes.has('hidden'),
      _show: () => classes.delete('hidden'),
    },
  };
}

const SETS = reservedSets({
  ok: true,
  names: ['alice', 'archie', 'orphan'],
  live: ['alice'],
  persisted: ['archie'],
});

// ── the split reply ─────────────────────────────────────────────────────────

test('reservedSets splits the reply, and a name only in `names` still counts as taken', () => {
  assert.deepStrictEqual(
    { live: [...SETS.live], persisted: [...SETS.persisted], taken: [...SETS.taken] },
    { live: ['alice'], persisted: ['archie'], taken: ['orphan'] },
    'orphan is in neither half, so it lands in the compatibility bucket rather than being dropped',
  );
  assert.deepStrictEqual([...reservedUnion(SETS)].sort(), ['alice', 'archie', 'orphan']);
});

test('an OLD-shape reply (names only) still blocks every name it lists', () => {
  // The renderer may be newer than the host it talks to over the web frontend,
  // and a reply with no `live`/`persisted` must not degrade to "nothing taken" —
  // that is the silent direction, since the field would go green on a name the
  // server will refuse.
  const old = reservedSets({ ok: true, names: ['alice', 'archie'] });
  assert.deepStrictEqual([...reservedUnion(old)].sort(), ['alice', 'archie']);
  assert.strictEqual(nameFieldState('alice', old).ok, false);
  assert.strictEqual(nameFieldState('alice', old).message, NAME_MESSAGES.taken);
});

test('a missing reply reserves nothing rather than throwing', () => {
  const none = reservedSets(null);
  assert.deepStrictEqual([...reservedUnion(none)], []);
  assert.strictEqual(nameFieldState('alice', none).ok, true);
});

// ── the field's verdict ─────────────────────────────────────────────────────
//
// Each row carries its own literal message. The messages are NOT computed from
// NAME_MESSAGES by the rule the code uses — a table that re-applied the code's
// own lookup would assert only that the code agrees with itself, and could not
// express the case where two kinds collapse onto one sentence, which is the
// whole defect (one alert said "archived or saved" for both).

const CASES = [
  { name: 'alice', kind: 'live', ok: false, message: 'That name is taken by a live session — pick another name.' },
  { name: 'archie', kind: 'persisted', ok: false, message: 'That name is taken by an archived session — unarchive it or pick another name.' },
  { name: 'orphan', kind: 'taken', ok: false, message: 'That name is already taken — pick another name.' },
  { name: 'bad name', kind: 'invalid', ok: false, message: 'Letters, numbers, dot, underscore and hyphen only (1–64 characters), and never all dots.' },
  { name: '..', kind: 'invalid', ok: false, message: 'Letters, numbers, dot, underscore and hyphen only (1–64 characters), and never all dots.' },
  { name: 'a/b', kind: 'invalid', ok: false, message: 'Letters, numbers, dot, underscore and hyphen only (1–64 characters), and never all dots.' },
  { name: '', kind: 'empty', ok: false, message: '' },
  { name: '   ', kind: 'empty', ok: false, message: '' },
  { name: 'bob', kind: 'free', ok: true, message: '' },
  { name: '.hidden', kind: 'free', ok: true, message: '' },
  { name: '  bob  ', kind: 'free', ok: true, message: '' },
];

for (const c of CASES) {
  test(`name ${JSON.stringify(c.name)} → ${c.kind}`, () => {
    assert.deepStrictEqual(nameFieldState(c.name, SETS), { ok: c.ok, kind: c.kind, message: c.message });
  });
}

test('the four refusal kinds say four DIFFERENT things', () => {
  const said = CASES.filter((c) => !c.ok && c.message).map((c) => c.message);
  assert.strictEqual(new Set(said).size, 4,
    'live, archived, taken and invalid must not collapse onto one sentence');
});

test('the name grammar is the one the main process gates on', () => {
  assert.strictEqual(String(SESSION_NAME_RE), String(/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/));
});

// ── the Create button ───────────────────────────────────────────────────────

test('Create is disabled while the name is unusable and enabled when it is free', () => {
  const gate = { ok: true, disabled: false, notice: null };
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('alice', SETS), toolGate: gate, mode: 'create' }),
    { disabled: true, title: NAME_MESSAGES.live });
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('', SETS), toolGate: gate, mode: 'create' }),
    { disabled: true, title: '' });
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('bob', SETS), toolGate: gate, mode: 'create' }),
    { disabled: false, title: '' });
});

test('the tools gate still wins, and the template editor is not gated on session names', () => {
  const blocked = { ok: false, disabled: true, notice: { text: 'Install Claude Code first' } };
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('bob', SETS), toolGate: blocked, mode: 'create' }),
    { disabled: true, title: 'Install Claude Code first' },
    'a free name must not re-enable Create over a missing CLI');
  // Save Template writes a template file, not a session: a template may legally
  // be named after an archived session, so the reserved set must not reach it.
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('alice', SETS), toolGate: { disabled: false }, mode: 'template' }),
    { disabled: false, title: '' });
});

// ── painting ────────────────────────────────────────────────────────────────

test('a refusal marks the field and clears when it goes free', () => {
  const e = els();
  paintNameField(e, nameFieldState('archie', SETS));
  assert.strictEqual(e.hint.textContent, NAME_MESSAGES.persisted);
  assert.strictEqual(e.hint.className, 'hint-text name-hint-bad');
  assert.strictEqual(e.input.style.borderColor, '#e94560');

  paintNameField(e, nameFieldState('bob', SETS));
  assert.strictEqual(e.hint.textContent, '');
  assert.strictEqual(e.hint.className, 'hint-text');
  assert.strictEqual(e.input.style.borderColor, '');
});

test('the marked class exists in the stylesheet the hint names', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /\.hint-text\.name-hint-bad\s*\{/,
    'paintNameField writes name-hint-bad; without a rule the refusal reads as an ordinary dim hint');
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="name-hint"/, 'the dialog must carry the slot the reason is written into');
});

// ── the submit refusal (the defect) ─────────────────────────────────────────

test('a {ok:false} create reply keeps the overlay up, shows the error, and touches no field', () => {
  const e = els();
  e.overlay._show();
  e.input.value = 'archie';
  const closed = applyCreateResult(e, { ok: false, error: 'A session named "archie" is archived or saved — unarchive it or pick another name.' });
  assert.strictEqual(closed, false);
  assert.strictEqual(e.overlay._visible(), true, 'the configured form must survive the refusal');
  assert.strictEqual(e.input.value, 'archie', 'the name the operator typed stays typed');
  assert.strictEqual(e.hint.textContent, 'A session named "archie" is archived or saved — unarchive it or pick another name.');
  assert.strictEqual(e.hint.className, 'hint-text name-hint-bad');
});

test('a reply with no error text still keeps the dialog open and says something', () => {
  const e = els();
  e.overlay._show();
  assert.strictEqual(applyCreateResult(e, { ok: false }), false);
  assert.strictEqual(e.overlay._visible(), true);
  assert.strictEqual(e.hint.textContent, 'unknown error');
});

test('a {ok:true} reply closes the dialog', () => {
  const e = els();
  e.overlay._show();
  assert.strictEqual(applyCreateResult(e, { ok: true }), true);
  assert.strictEqual(e.overlay._visible(), false);
});

// ── the wiring renderer.js cannot be tested through ─────────────────────────

function doCreateSource() {
  const start = rendererSrc.indexOf('async function doCreate() {');
  assert.ok(start >= 0, 'doCreate not found in renderer.js');
  const end = rendererSrc.indexOf('\nfunction submitDialog()', start);
  assert.ok(end > start, 'the end of doCreate not found');
  return rendererSrc.slice(start, end);
}

test('doCreate closes the dialog NOWHERE except through applyCreateResult', () => {
  const src = doCreateSource();
  assert.strictEqual((src.match(/\bcloseDialog\s*\(/g) || []).length, 0,
    'a closeDialog() inside doCreate runs before the reply lands — that is the defect');
  assert.ok(src.includes('applyCreateResult(nameFieldEls(), result)'),
    'the host create must route its reply through the seam that only closes on ok');
  assert.ok(src.includes('applyCreateResult(nameFieldEls(), peerOutcome)'),
    'the sandbox create arm had the same shape and must route through it too');
});

test('doCreate refuses a second press while the first create is still in flight', () => {
  const src = doCreateSource();
  assert.strictEqual((src.match(/createInFlight = true;/g) || []).length, 1,
    'the flag must be raised exactly once, on the one path that reaches the server');
  assert.strictEqual((src.match(/createInFlight = false;/g) || []).length, 1,
    'more than one clear means one of them runs on a path that did not raise it');
  const cleared = src.indexOf('createInFlight = false;');
  const fin = src.lastIndexOf('} finally {', cleared);
  assert.ok(fin >= 0 && fin < cleared,
    'the clear must sit inside a finally — an early return on any refusal arm would otherwise wedge the button for the rest of the dialog');
  const guard = src.indexOf('if (createInFlight) return;');
  assert.ok(guard >= 0, 'the second press is refused by an early return, not by the button alone: Enter reaches doCreate whatever the button says');
  const firstAwait = src.indexOf('await ');
  assert.ok(firstAwait > guard,
    'the guard must precede every await, or the second press is already past it while the first round-trip is open');
});

test('Create is disabled while a create is in flight, whatever the name says', () => {
  const gate = { ok: true, disabled: false, notice: null };
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('bob', SETS), toolGate: gate, mode: 'create', inFlight: true }),
    { disabled: true, title: '' });
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('bob', SETS), toolGate: gate, mode: 'template', inFlight: true }),
    { disabled: true, title: '' },
    'inFlight is checked before the mode short-circuit, which returns enabled unconditionally — a later check would be unreachable');
  assert.deepStrictEqual(
    createButtonState({ nameState: nameFieldState('bob', SETS), toolGate: gate, mode: 'create', inFlight: false }),
    { disabled: false, title: '' });
});

test('doCreate raises no blocking alert for a create refusal', () => {
  const src = doCreateSource();
  assert.strictEqual((src.match(/\balert\s*\(\s*`Create /g) || []).length, 0,
    'a modal alert is what dismissed the dialog behind it; the reason goes inline now');
});

test('a server refusal re-fetches the reserved sets before the operator can retype', () => {
  const src = doCreateSource();
  const applied = src.indexOf('applyCreateResult(nameFieldEls(), result)');
  const refetch = src.indexOf('window.api.reservedSessionNames()');
  assert.ok(refetch > applied,
    'the re-fetch answers a refusal, so it must follow the reply rather than racing it');
  assert.ok(src.indexOf('dialogReservedSets = reservedSets(', refetch) > refetch,
    'the fresh reply must be stored the way openDialog stores it, or the as-you-type gate keeps the sets that were already wrong');
  assert.ok(src.indexOf('refreshNameValidity()', refetch) > refetch,
    're-running the gate is what turns the fresh sets into a verdict on the name still in the field');
  assert.ok(src.lastIndexOf('applyCreateResult(nameFieldEls(), result)') > refetch,
    'refreshNameValidity repaints the hint, so the server reason must be painted back when the fresh sets have nothing of their own to say');
});

test('a refused create rolls the opt-in worktree back before the failure branch returns', () => {
  const src = doCreateSource();
  const block = src.indexOf('if (!applyCreateResult(nameFieldEls(), result)) {');
  assert.ok(block >= 0, 'the create-failure block was not found in doCreate');
  const ret = src.indexOf('return;', block);
  assert.ok(ret > block, 'the create-failure block returns nowhere');
  const rollback = src.indexOf('window.api.removeWorktree(worktree.path)', block);
  assert.ok(rollback > block && rollback < ret,
    'the worktree is created before the spawn is asked for, so a refusal that returns without removing it leaves a branch and a checkout nothing names');
});

test('the rollback is guarded, so a plain-cwd create never asks to remove a worktree', () => {
  const src = doCreateSource();
  const block = src.indexOf('if (!applyCreateResult(nameFieldEls(), result)) {');
  const rollback = src.indexOf('window.api.removeWorktree(worktree.path)', block);
  assert.ok(rollback > block, 'the rollback is missing from the create-failure block');
  const guard = src.lastIndexOf('if (worktree) {', rollback);
  assert.ok(guard > block && guard < rollback,
    'without an if (worktree) in the block, a session spawned in a plain cwd would hand removeWorktree a null');
});

test('the name field is re-checked on every keystroke and again at submit', () => {
  assert.match(rendererSrc, /inputName\.addEventListener\('input', \(\) => refreshNameValidity\(\)\)/,
    'without the input listener the reason only ever appears after a failed submit');
  const src = doCreateSource();
  assert.ok(src.includes('if (!refreshNameValidity().ok) return;'),
    'submit must re-check: Enter reaches doCreate whatever the button says');
});

test('openDialog holds the SPLIT reserved sets, not just the flat name list', () => {
  assert.match(rendererSrc, /dialogReservedSets = reservedSets\(reserved\)/);
  assert.match(rendererSrc, /dialogReservedNames = reservedUnion\(dialogReservedSets\)/,
    'the auto-suffix still needs the union, and deriving it keeps the two from drifting');
});

test('session:reservedNames returns both halves and keeps the flat list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ipc-handlers.js'), 'utf8');
  const m = src.match(/handle\('session:reservedNames'[\s\S]*?\n  \}\);/);
  assert.ok(m, 'the handler was not found');
  assert.match(m[0], /names:/, 'the old array stays for callers that only want membership');
  assert.match(m[0], /live:/);
  assert.match(m[0], /persisted:/);
});
