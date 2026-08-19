// Run: node --test
// Pure helpers for the team-management popover (T29 Layer A Slice 3). The popover
// DOM is untested (imperative wiring); these three side-effect-free helpers hold
// the logic worth pinning — row-model from a manifest, add-role client validation,
// and the C5 block → inline message.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote,
  parseDuration, formatDuration, formatBlockedBy,
  leadSeatCandidates, leadResolution,
  reservedRemovalWarning,
  teamStage, roleSummaries, absentStockRoles, absentStockNote, offerDispatchLine, fieldReveal,
  reconcileReveal, clearableFields,
  REMOVABLE_RESERVED_ROLE_KEYS, OFFERABLE_STOCK_ROLE_KEYS, DISPATCH_VALUES,
} = require('../renderer/lib/team-roles');

test('teamRoleRows: one row per role in key order, reserved keys marked read-only', () => {
  const manifest = {
    name: 'shop',
    roles: {
      lead: { brief: 'the lead', prompt: 'clodex-team-lead' },
      reviewer: { brief: 'the reviewer' },
      runner: { brief: 'runs things', prompt: 'p', template: 'fable-lead', dispatch: 'worktree' },
      bare: {},
    },
  };
  const rows = teamRoleRows(manifest);
  assert.deepStrictEqual(rows.map((r) => r.key), ['lead', 'reviewer', 'runner', 'bare'], 'manifest key order preserved');
  // lead + reviewer are operator-owned → read-only; ordinary roles editable.
  assert.strictEqual(rows[0].readOnly, true, 'lead read-only');
  assert.strictEqual(rows[1].readOnly, true, 'reviewer read-only');
  assert.strictEqual(rows[2].readOnly, false, 'runner editable');
  assert.strictEqual(rows[3].readOnly, false, 'bare editable');
  // Descriptive fields surfaced; missing ones normalize to ''. WHOLE row: the
  // legibility test pins this model's keys against the schema, and a partial
  // probe here would let a field the row shows but nothing sets slip through.
  assert.deepStrictEqual(rows[2], { key: 'runner', brief: 'runs things', prompt: 'p', template: 'fable-lead', dispatch: 'worktree', cwd: '', readOnly: false });
  // `dispatch` normalizes to 'standing', NOT to '': absent IS standing on disk,
  // and a blank would leave the row's picker with no selected option, which
  // buildSavePatch then drops — a Save that silently declines to save.
  // `cwd` normalizes to '' (unlike dispatch): absent means "the team root", and
  // the row's control is a free-text input whose empty state says exactly that.
  assert.deepStrictEqual(rows[3], { key: 'bare', brief: '', prompt: '', template: '', dispatch: 'standing', cwd: '', readOnly: false });
});

test('teamRoleRows: a role cwd reaches the row it belongs to', () => {
  const rows = teamRoleRows({ roles: { api: { cwd: 'api' }, web: {} } });
  // ENTER: the row under test is the one carrying the cwd — asserting '' on the
  // other row alone would be true of a model that dropped the field entirely.
  assert.strictEqual(rows[0].cwd, 'api', 'the value is shown on ITS role');
  assert.strictEqual(rows[1].cwd, '', 'and does not bleed onto the role beside it');
});

test('teamRoleRows: an absent/empty manifest yields no rows (no throw)', () => {
  assert.deepStrictEqual(teamRoleRows(null), []);
  assert.deepStrictEqual(teamRoleRows({}), []);
  assert.deepStrictEqual(teamRoleRows({ roles: {} }), []);
});

test('validateAddRole: requires a name, enforces the role charset, refuses reserved keys', () => {
  assert.deepStrictEqual(validateAddRole({ name: '' }), { ok: false, error: 'a role name is required' });
  assert.deepStrictEqual(validateAddRole({ name: '   ' }), { ok: false, error: 'a role name is required' });
  assert.strictEqual(validateAddRole({ name: 'bad name!' }).ok, false, 'space/bang off-charset');
  assert.strictEqual(validateAddRole({ name: 'a'.repeat(33) }).ok, false, 'over 32 chars');
  // C1 mirror: lead/reviewer refused client-side (backend is the real gate).
  assert.match(validateAddRole({ name: 'lead' }).error, /operator-owned/);
  assert.match(validateAddRole({ name: 'reviewer' }).error, /operator-owned/);
});

test('validateAddRole: template must be a bare NAME; blank normalizes to null', () => {
  assert.strictEqual(validateAddRole({ name: 'runner', template: '/tmp/evil.json' }).ok, false, 'path refused');
  assert.strictEqual(validateAddRole({ name: 'runner', template: 'bad name!' }).ok, false, 'off-charset refused');
  assert.deepStrictEqual(validateAddRole({ name: 'runner' }), { ok: true, name: 'runner', template: null });
  assert.deepStrictEqual(validateAddRole({ name: '  runner  ', template: '  fable-lead  ' }), { ok: true, name: 'runner', template: 'fable-lead' }, 'trims both');
});

test('buildSavePatch: sends brief/prompt (blank clears) but OMITS a blank template', () => {
  // The bug this pins: a blank template must NOT be in the patch — backend setRole
  // re-validates `template` as a NAME whenever the key is present, so '' throws and
  // every Save on a template-less role (the common case) would fail.
  const p = buildSavePatch({ brief: 'b', prompt: 'p', template: '' });
  assert.deepStrictEqual(p, { brief: 'b', prompt: 'p', cwd: '' });
  assert.ok(!('template' in p), 'blank template omitted, not sent as ""/null');
  // A non-blank template is included; all values trimmed.
  assert.deepStrictEqual(
    buildSavePatch({ brief: '  b  ', prompt: '  p  ', template: '  fable-lead  ' }),
    { brief: 'b', prompt: 'p', template: 'fable-lead', cwd: '' },
  );
  // Blank brief/prompt ARE sent (backend stores '' — a legitimate clear); missing
  // form values normalize to '' without throwing.
  assert.deepStrictEqual(buildSavePatch({ brief: '', prompt: '', template: '' }), { brief: '', prompt: '', cwd: '' });
  assert.deepStrictEqual(buildSavePatch({}), { brief: '', prompt: '', cwd: '' });
});

test('buildSavePatch: a blank `cwd` IS sent — unlike template, blank is a real clear', () => {
  // The asymmetry is deliberate and is the whole reason cwd is not treated like
  // template: setRole DELETES the key on a blank, so sending it is how a role
  // gets moved back to the team root. Omitting it would make that unreachable
  // from the only door that can undo it.
  const cleared = buildSavePatch({ brief: 'b', prompt: 'p', cwd: '' });
  assert.ok('cwd' in cleared, 'ENTER: the key is present — an omitted cwd is the bug this pins');
  assert.strictEqual(cleared.cwd, '');
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', cwd: '  api  ' }),
    { brief: 'b', prompt: 'p', cwd: 'api' },
    'trimmed like every other value',
  );
});

// t423: `spawn` is the value most likely to be missed here, because the mirror
// is the SILENT half of the pair — a value present in the picker but absent from
// DISPATCH_VALUES is dropped by the gate below, so the control appears to work
// and saves nothing. Asserts the whole patch, not `'dispatch' in p`: a partial
// match reads around a value that arrived mangled.
test('buildSavePatch: `spawn` survives the mirror gate', () => {
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: 'spawn' }),
    { brief: 'b', prompt: 'p', dispatch: 'spawn', cwd: '' },
    'the third value is forwarded — a mirror missing it drops the operator\'s choice in silence',
  );
  // The mirror is a mirror: it must carry exactly what the manifest accepts, and
  // nothing pins the two lists to each other (different processes). This at least
  // holds the renderer side to the three values it is meant to have.
  assert.deepStrictEqual([...DISPATCH_VALUES].sort(), ['spawn', 'standing', 'worktree'],
    'the renderer mirror carries all three dispatch values');
});

// The two dispatch pickers are SIBLINGS, and a value added to one and not the
// other is invisible from the app: r1 shipped the row editor's `spawn` option
// while the Add Role form still offered two, so the first door an operator
// knocks on could not create the role at all. Read from the sources the operator
// actually uses rather than from a list here, which could agree with nothing.
test('both dispatch pickers offer exactly DISPATCH_VALUES', () => {
  const optionsIn = (text, label) => {
    const sel = /<select[^>]*>([\s\S]*?)<\/select>/.exec(text);
    assert.ok(sel, `ENTER: found the ${label} <select> — a restructured control would reduce this to asserting nothing`);
    const vals = [...sel[1].matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(vals.length > 1, `ENTER: the ${label} picker yielded options`);
    return vals;
  };
  const rd = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf-8');

  // The Add Role form. Sliced from its own id so a second <select> in the block
  // (prompt) cannot be measured in its place.
  const html = rd('renderer', 'index.html');
  const addAt = html.indexOf('id="team-roles-add-dispatch"');
  assert.ok(addAt > 0, 'ENTER: the Add Role dispatch picker is in index.html');
  assert.deepStrictEqual(
    optionsIn(html.slice(html.lastIndexOf('<select', addAt)), 'Add Role form').sort(),
    [...DISPATCH_VALUES].sort(),
    'the Add Role form must offer every dispatch value — a value only reachable by editing an '
    + 'existing role is one an operator cannot create',
  );

  // The row editor is a SEGMENTED control now (B4), not a <select>: its segments
  // are generated by iterating DISPATCH_VALUES, so thevalue-drift this test guards
  // against on the Add Role form cannot happen there by construction. What CAN
  // drift is the explanation table beside it, which is keyed by hand — a value
  // missing from it renders a segment whose title is the bare value, i.e. a
  // control that silently stops explaining one of its three modes.
  const pop = rd('renderer', 'popovers', 'team-roles-popover.js');
  const genAt = pop.indexOf('for (const value of DISPATCH_VALUES)');
  assert.ok(genAt > 0,
    'ENTER: the row editor builds its segments by iterating DISPATCH_VALUES — if that loop is '
    + 'replaced by a hand-written list, this test must go back to reading the values themselves');
  const helpBlock = /const DISPATCH_HELP = \{([\s\S]*?)\};/.exec(pop);
  assert.ok(helpBlock, 'ENTER: found the DISPATCH_HELP table');
  const helpKeys = [...helpBlock[1].matchAll(/^\s*([a-z]+):/gm)].map((m) => m[1]);
  assert.ok(helpKeys.length > 1, 'ENTER: the help table yielded keys');
  assert.deepStrictEqual(
    helpKeys.sort(),
    [...DISPATCH_VALUES].sort(),
    'every dispatch value needs its one-line explanation: B4 puts it in the segment title rather '
    + 'than the visible label, so a missing key is a mode the operator can select and never learn',
  );
});

test('B4: the dispatch segments are a real radiogroup, one tab stop, no attribute interpolation', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');
  const fn = /function buildDispatchSegments\([\s\S]*?\n  \}/.exec(pop);
  assert.ok(fn, 'ENTER: found buildDispatchSegments — a renamed builder would reduce this to asserting nothing');
  const src = fn[0];

  // NATIVE radios, which is what makes the keyboard behaviour the platform's:
  // arrow keys moving within the group, Space/Enter selecting, and exactly ONE
  // tab stop for the whole group are all free for `input type=radio` sharing a
  // name, and all things a role="radio" div would have to hand-implement.
  assert.match(src, /radio\.type = 'radio'/, 'segments must be native radios');
  assert.match(src, /radio\.name = gname/, 'sharing one group name is what makes them ONE tab stop and one arrow-key group');
  assert.match(src, /\$\{\+\+dispatchGroupSeq\}/,
    'the group name must be per-render-unique: same-named radios anywhere in the document are ONE '
    + 'group, so a second rendered editor would silently uncheck the first');
  assert.match(src, /group\.setAttribute\('role', 'radiogroup'\)/, 'the container is announced as a radiogroup');
  assert.match(src, /group\.setAttribute\('aria-label'/, 'and carries a name, since its caption sits outside the control');
  // B4: the explanation rides `title`, never the visible label.
  assert.match(src, /seg\.title = DISPATCH_HELP/, 'each segment explains itself through title');
  assert.match(src, /txt\.textContent = value/, 'while the visible label stays the bare one-word value');

  // SECURITY (file header's rule): nothing agent-writable may reach an attribute
  // in this nodeIntegration renderer. The segment values come from a module
  // constant, but the rule is structural — assert the shape, not the provenance.
  assert.ok(!/value="/.test(src), 'no value="…" attribute — values are assigned by property');
  assert.match(src, /radio\.value = value;/, 'the value lands as a PROPERTY assignment');

  // The checked state must be driven by the CURRENT value rather than left to a
  // `checked` attribute in a template string — the fallback for an off-enum
  // stored dispatch depends on exactly one segment being checked.
  assert.match(src, /radio\.checked = value === current/, 'checked state tracks the current dispatch');
});

// The BEHAVIOUR behind these source pins — arrow-key navigation, the single tab
// stop, focus, and the stale/carry-forward interleavings — is the browser's, and
// this repo has no DOM in its suite (jsdom is not a dependency, and would not
// implement radio-group navigation if it were: that is precisely why the control
// is built on native radios). It is covered by two runnable checks instead:
//
//   ./node_modules/.bin/electron manual/team-popover-keyboard.js
//   ./node_modules/.bin/electron manual/team-popover-stale-fields.js
//
// Both self-assert and exit nonzero on failure. Run them when touching the
// dispatch control or the cwd/template reveal — the tests below pin the shape
// those checks depend on, not the behaviour itself.
test('B4: aria-checked is the radios\' own, and the CSS keeps them focusable', () => {
  // A visually-hidden radio must stay focusable: `display:none` (or
  // `visibility:hidden`) removes it from the tab order and from the group's
  // arrow-key navigation, which would silently undo the entire reason for
  // choosing native radios. The offset/opacity idiom keeps it focusable.
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf-8');
  const rule = /\.team-role-segment input \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'ENTER: found the segment input rule — without it the radios render as visible bullets');
  const body = rule[1];
  assert.ok(!/display:\s*none/.test(body),
    'display:none would make the radio unfocusable and drop it out of the arrow-key group');
  assert.ok(!/visibility:\s*hidden/.test(body),
    'visibility:hidden has the same effect on focusability');
  assert.match(body, /opacity:\s*0/, 'hidden by opacity, which preserves focusability');

  // The focus ring has to be drawn on the LABEL, because the input carrying
  // focus is invisible. Without this the group looks unfocused while it is being
  // navigated by keyboard — the failure mode that makes a segmented control
  // unusable without a mouse.
  assert.match(css, /\.team-role-segment:has\(input:focus-visible\)/,
    'the focus ring must be drawn on the label; the focused input itself is invisible');
  assert.match(css, /\.team-role-segment:has\(input:checked\)/,
    'and the checked segment must be visually distinguishable');
});

test('buildSavePatch: sends `dispatch` for BOTH enum values, drops an off-enum one', () => {
  // `standing` must be sent, not treated as a blank-and-omit like `template`:
  // the picker has no empty state, so omitting the default would make
  // worktree → standing unreachable from the only door that can undo it.
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: 'standing' }),
    { brief: 'b', prompt: 'p', dispatch: 'standing', cwd: '' },
  );
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: '  worktree  ' }),
    { brief: 'b', prompt: 'p', dispatch: 'worktree', cwd: '' },
    'trimmed like every other value',
  );
  // A value the backend would throw on is dropped rather than forwarded — the
  // throw would take the brief/prompt edits sent alongside it down too.
  for (const bad of ['', 'sometimes', undefined]) {
    const p = buildSavePatch({ brief: 'b', prompt: 'p', dispatch: bad });
    assert.ok(!('dispatch' in p), `off-enum dispatch ${JSON.stringify(bad)} is omitted`);
    assert.deepStrictEqual(p, { brief: 'b', prompt: 'p', cwd: '' }, 'and the rest of the patch is unharmed');
  }
});

test('fieldReveal: spawn/worktree make BOTH fields plain editable fields', () => {
  // Whole-object deepStrictEqual, not a per-key probe: a reveal that forgot to
  // return one of the two keys would come back `undefined`, and `undefined`
  // compares unequal to every state string while a per-key check for the OTHER
  // field still passes. The object is the unit under test.
  assert.deepStrictEqual(fieldReveal('spawn', { cwd: '', template: '' }), { cwd: 'edit', template: 'edit' });
  assert.deepStrictEqual(fieldReveal('worktree', { cwd: 'api', template: 'fable-lead' }), { cwd: 'edit', template: 'edit' });
  // A stored value does not change the state on the active paths — 'edit' is
  // 'edit' whether or not something is in the box.
  assert.deepStrictEqual(fieldReveal('spawn', { cwd: 'api', template: '' }), { cwd: 'edit', template: 'edit' });
});

test('fieldReveal: standing + EMPTY hides, standing + STORED goes stale — per field, independently', () => {
  assert.deepStrictEqual(fieldReveal('standing', { cwd: '', template: '' }), { cwd: 'hidden', template: 'hidden' });
  assert.deepStrictEqual(fieldReveal('standing', { cwd: 'api', template: 'fable-lead' }), { cwd: 'stale', template: 'stale' });
  // The two fields are decided SEPARATELY. One object per role carrying one
  // state for both would hide a stale cwd whenever the template happened to be
  // blank — which is the exact data-losing shape R4 exists to prevent.
  assert.deepStrictEqual(fieldReveal('standing', { cwd: 'api', template: '' }), { cwd: 'stale', template: 'hidden' });
  assert.deepStrictEqual(fieldReveal('standing', { cwd: '', template: 'fable-lead' }), { cwd: 'hidden', template: 'stale' });
});

test('fieldReveal: whitespace is not a stored value — it hides rather than going stale', () => {
  // buildSavePatch trims before sending, so a whitespace-only cwd submits as ''
  // and is already the cleared state. Calling it 'stale' would offer a Clear
  // button for a value that is, after the trim every write path applies,
  // already blank.
  assert.deepStrictEqual(fieldReveal('standing', { cwd: '   ', template: '\t' }), { cwd: 'hidden', template: 'hidden' });
});

test('fieldReveal: an UNRECOGNIZED dispatch reveals as if standing — never as spawn', () => {
  // Fail-closed, mirroring roleSummaries' stance rather than teamRoleRows'. A
  // hand-edited team.json holding a mode this build does not model must not make
  // a field VANISH that the unknown mode might depend on — and must not be
  // written back either (buildSavePatch drops an off-enum dispatch; pinned above).
  for (const weird of ['teleport', '', null, undefined, 'SPAWN', 'spawn ', 42, {}]) {
    assert.deepStrictEqual(
      fieldReveal(weird, { cwd: 'api', template: 'fable-lead' }),
      { cwd: 'stale', template: 'stale' },
      `unrecognized dispatch ${JSON.stringify(weird)} must reveal like standing, showing the stored values`,
    );
    assert.deepStrictEqual(
      fieldReveal(weird, { cwd: '', template: '' }),
      { cwd: 'hidden', template: 'hidden' },
      `and hide them when there is nothing stored (${JSON.stringify(weird)})`,
    );
  }
  // A PADDED enum value is unrecognized too, and deliberately so: loadManifest
  // refuses an off-enum dispatch outright and resolveSeatShape compares with
  // ===, so ' spawn ' behaves as spawn nowhere in the app. Revealing it as
  // editable would be this surface inventing a mode the engine does not honour.
  assert.deepStrictEqual(fieldReveal('  spawn  ', { cwd: '', template: '' }), { cwd: 'hidden', template: 'hidden' });
});

test('fieldReveal: a missing values object is the all-empty case, not a throw', () => {
  // The Add Role subpanel calls this with nothing stored yet.
  assert.deepStrictEqual(fieldReveal('standing'), { cwd: 'hidden', template: 'hidden' });
  assert.deepStrictEqual(fieldReveal('spawn'), { cwd: 'edit', template: 'edit' });
  assert.deepStrictEqual(fieldReveal('standing', {}), { cwd: 'hidden', template: 'hidden' });
});

test('fieldReveal: `hidden` is reachable ONLY for an empty value — hiding can never lose data', () => {
  // The property the whole split rests on, asserted directly rather than left as
  // a consequence of the cases above: across every dispatch, a field that comes
  // back 'hidden' had nothing in it. buildSavePatch always sends `cwd`, so if
  // this ever became false the form would submit an invisible, unclearable value.
  const values = ['', '   ', 'api', 'a/b', 'fable-lead'];
  const dispatches = ['standing', 'spawn', 'worktree', 'teleport', ''];
  let hiddenSeen = 0;
  for (const d of dispatches) {
    for (const cwd of values) {
      const out = fieldReveal(d, { cwd, template: cwd });
      if (out.cwd === 'hidden') { hiddenSeen++; assert.strictEqual(cwd.trim(), '', `hid a non-empty cwd under dispatch ${d}`); }
    }
  }
  // ENTER: the interesting case actually occurred. Without this the loop above
  // is vacuously true of a fieldReveal that never returns 'hidden' at all.
  assert.ok(hiddenSeen > 0, 'ENTER: at least one hidden state was produced — otherwise the invariant is asserted over nothing');
});

test('r1 MF1: only `cwd` is clearable — a blank `template` never reaches the backend', () => {
  // The bug this pins: the editor offered a Clear on a stale `template` titled
  // "Remove the stored template. Takes effect when you Save." It could not.
  // buildSavePatch OMITS a blank template (setRole validates any present
  // `template` against NAME_RE and throws on ''), so Clear → Save round-tripped
  // to `role "x" saved` with the value still on disk and no error anywhere.
  assert.deepStrictEqual(clearableFields(), ['cwd']);

  // Derived, not declared — this is the assertion that makes it stay true. If
  // the backend ever grows clear-template semantics and buildSavePatch starts
  // sending a blank one, clearableFields picks it up and this flips on its own.
  const blanked = buildSavePatch({ brief: '', prompt: '', cwd: '', template: '' });
  assert.ok('cwd' in blanked, 'a blank cwd IS transmitted — that is what makes its Clear honest');
  assert.ok(!('template' in blanked), 'a blank template is omitted — so a Clear there would be a lie');
});

test('r1 MF1: the stock `hand` role is exactly the shape that exposed the dead Clear', () => {
  // Not an edge case, which is why this pins the SHAPE and not just the leaf:
  // STOCK_ROLE_DEFS.hand carries a template and no dispatch, so it is standing,
  // so its template is stale — a default team's `hand` row hits this the first
  // time anyone expands it.
  const { STOCK_ROLE_DEFS } = require('../team-manifest');
  const hand = STOCK_ROLE_DEFS.hand;
  assert.ok(hand, 'ENTER: the stock hand def exists — a rename would leave every assertion below vacuous');
  assert.ok(hand.template, 'the stock hand names a template');
  assert.strictEqual(hand.dispatch, undefined, 'and no dispatch, so it is standing');
  const reveal = fieldReveal(hand.dispatch, { cwd: hand.cwd, template: hand.template });
  assert.strictEqual(reveal.template, 'stale',
    'so a default team shows a stale template on `hand` — which must therefore not carry a Clear');
  assert.ok(!clearableFields().includes('template'),
    'the field a default team shows stale is the one field whose Clear cannot work');
});

test('r1 MF2: an unchanged reveal is NOT rebuilt — that rebuild discarded unsaved input', () => {
  // Rebuilding empties the container and re-seeds it, so a rebuild on a
  // transition where nothing changed state silently reverted whatever had been
  // typed. Both of these are edit → edit: nothing needs rebuilding at all.
  const both = { cwd: 'edit', template: 'edit' };
  assert.deepStrictEqual(
    reconcileReveal(both, 'worktree', { cwd: '', template: '' }),
    { reveal: both, rebuild: false },
    'spawn → worktree leaves both fields editable, so the DOM must be left alone',
  );
  assert.deepStrictEqual(
    reconcileReveal(both, 'spawn', { cwd: 'api', template: 'fable-design' }),
    { reveal: both, rebuild: false },
    'and a stored value does not change that — the states are what decide',
  );
  // A first paint has nothing on screen yet, so it always builds.
  assert.deepStrictEqual(
    reconcileReveal(null, 'spawn', { cwd: '', template: '' }),
    { reveal: both, rebuild: true },
    'no previous reveal means the fields do not exist yet',
  );
});

test('r1 MF2: a CHANGED reveal rebuilds, and the state comes from STORED, never from live input', () => {
  // standing + stored → both stale; switching to spawn makes them editable, so
  // the states differ and the rebuild is required.
  const stale = { cwd: 'stale', template: 'stale' };
  const out = reconcileReveal(stale, 'spawn', { cwd: 'api', template: 'fable-design' });
  assert.deepStrictEqual(out, { reveal: { cwd: 'edit', template: 'edit' }, rebuild: true });

  // The half that is easy to get backwards, and that I did get backwards first:
  // the STATE must be decided from the stored def. Deciding it from the live
  // input would promote a merely-TYPED value to `stale` — a disabled field that
  // Save still reads — writing a standing role a cwd that was never on disk.
  const typedButUnstored = reconcileReveal({ cwd: 'edit', template: 'edit' }, 'standing', { cwd: '', template: '' });
  assert.deepStrictEqual(typedButUnstored.reveal, { cwd: 'hidden', template: 'hidden' },
    'nothing stored means hidden, however much the operator typed — the value is dropped, unwritten');
  assert.strictEqual(typedButUnstored.rebuild, true);

  // And the mirror: a value that IS on disk goes stale rather than vanishing,
  // because buildSavePatch would otherwise keep resubmitting it invisibly.
  assert.deepStrictEqual(
    reconcileReveal({ cwd: 'edit', template: 'edit' }, 'standing', { cwd: 'api', template: 'fable-design' }).reveal,
    stale,
  );
});

test('r1 MF2: every dispatch pair either changes state or is skipped — no rebuild is gratuitous', () => {
  // The property behind the fix, over the whole transition matrix rather than
  // the two interleavings the review happened to find.
  const stored = { cwd: 'api', template: 'fable-design' };
  let skipped = 0;
  for (const from of DISPATCH_VALUES) {
    for (const to of DISPATCH_VALUES) {
      const prev = fieldReveal(from, stored);
      const { reveal, rebuild } = reconcileReveal(prev, to, stored);
      if (!rebuild) {
        skipped++;
        assert.deepStrictEqual(reveal, prev,
          `${from} → ${to} skipped the rebuild, so the states must be identical`);
      }
    }
  }
  // ENTER: skips actually occurred. Without this the assertion above is true of
  // an implementation that rebuilds unconditionally — i.e. of the bug.
  assert.ok(skipped >= DISPATCH_VALUES.length,
    `ENTER: at least the identity transitions skipped the rebuild (saw ${skipped})`);
});

test('r2 nit1: a pending Clear reaches the STATE source, so the field hides on the way back', () => {
  // The leaf half of the round trip. `stale` vs `hidden` is decided from what is
  // STORED, so the question is what the editor calls "stored" after a Clear. If
  // it keeps meaning "what was on disk when the row opened", standing → spawn →
  // standing re-derives `stale` from the value the operator just cleared and
  // rebuilds an empty, disabled field carrying a Clear that now does nothing.
  const onDisk = { cwd: 'api', template: 'fable-design' };
  const stored = { ...onDisk };

  const reveal = fieldReveal('standing', stored);
  assert.strictEqual(reveal.cwd, 'stale', 'ENTER: the row opens with a genuinely stale cwd — without it the rest is vacuous');

  // The Clear, as the popover's handler performs it: the value is gone as far as
  // Save is concerned from this click onward, so it must be gone here too.
  stored.cwd = '';

  const toSpawn = reconcileReveal(reveal, 'spawn', stored);
  assert.strictEqual(toSpawn.rebuild, true, 'ENTER: stale → edit must rebuild, or the return trip below tests nothing');
  const back = reconcileReveal(toSpawn.reveal, 'standing', stored);
  assert.deepStrictEqual(back, {
    reveal: { cwd: 'hidden', template: 'stale' },
    rebuild: true,
  }, 'a cleared cwd returns as HIDDEN; reading the on-disk value here resurrects it as an empty stale box');

  // And the contrast that makes it a real distinction rather than a constant:
  // the SAME trip against the untouched snapshot is exactly the defect.
  const stale = reconcileReveal(toSpawn.reveal, 'standing', onDisk);
  assert.strictEqual(stale.reveal.cwd, 'stale',
    'ENTER: the frozen snapshot really does yield `stale` — this is the state the fix removes');
});

test('r2 nit1: the editor feeds reconcileReveal a snapshot its Clear can mutate', () => {
  // The wiring half, and the half that actually regresses: the leaf above is
  // correct with or without the fix, because the defect was WHICH object the
  // editor handed it. There is no DOM in this suite, so this pins the shape the
  // behaviour rests on; the behaviour itself is asserted end-to-end by
  // `manual/team-popover-stale-fields.js` ("a cleared cwd is HIDDEN on the way
  // back to standing").
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');

  const editor = /const stored = \{ cwd: row\.cwd, template: row\.template \};[\s\S]*?renderRevealedFields\(revealBox, shownReveal[^\n]*\n/.exec(pop);
  assert.ok(editor, 'ENTER: found the editor\'s reveal wiring — a rename would reduce every assertion below to nothing');
  const src = editor[0];

  assert.match(src, /const onClear = \(f\) => \{ stored\[f\] = ''; \};/,
    'the Clear handler must blank the STATE source, not only the input');
  assert.match(src, /reconcileReveal\(shownReveal, dispatch, stored\)/,
    'and the state must be derived from that mutable snapshot');
  assert.ok(!/reconcileReveal\([^)]*\{ cwd: row\.cwd/.test(src),
    'deriving state from a fresh `row` read re-freezes the snapshot and restores the defect');
  // Both halves of one line: every REBUILT field set is wired to the same
  // handler (or a Clear on a rebuilt field is lost again), and its values still
  // come from the live inputs — that second half is r1 MF2 and must not regress
  // here, since seeding a rebuild from `stored` would revert unsaved typing.
  assert.match(src, /renderRevealedFields\(revealBox, reveal, liveValues\(\), onClear\)/,
    'rebuilds must pass the live values AND the clear handler');
});

test('r3 nit2: Clear leaves the stale cwd INERT — the role is still standing', () => {
  // The door the stale/hidden states left open. Clear un-stales the field in
  // place; if it also re-enables the input, the operator can type a fresh cwd
  // into a role that dispatches `standing`, Save writes it, and nothing consumes
  // or shows it again — the haunted value everything else here prevents. The
  // field must stay VISIBLE (removing it mid-interaction yanks it from under the
  // cursor, and `manual/team-popover-stale-fields.js` pins its presence) and
  // must stay disabled until a dispatch that actually reads a cwd rebuilds it.
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');

  const handler = /clear\.addEventListener\('click', \(\) => \{[\s\S]*?\n {10}\}\);/.exec(pop);
  assert.ok(handler, 'ENTER: found the Clear handler — a rename would vacuum out every assertion below');
  const src = handler[0];
  assert.match(src, /input\.value = '';/, 'ENTER: this really is the handler that blanks the input');

  // Any MENTION of `disabled`, not just the literal re-enable: `leave it alone`
  // is the whole fix, and `removeAttribute('disabled')` or `disabled = someFlag`
  // would satisfy a narrower pattern while restoring the defect.
  assert.ok(!/\binput\.disabled\b/.test(src),
    're-enabling the input lets a fresh cwd be typed into a standing role, which Save persists invisibly');
  assert.ok(!/removeAttribute\(\s*['"`]disabled/.test(src),
    'and the attribute route is the same defect wearing a different spelling');
  assert.ok(!/field\.remove\(\)|input\.remove\(\)/.test(src),
    'and the field is not removed either — inert beats vanishing under the cursor');

  // r4: the note is RETEXTED, not removed. Dropping it left an empty, disabled,
  // unexplained box — the field kept its inertness and lost the only thing that
  // said why. The input above is still disabled at this point, so a note that
  // deletes itself here is a state that explains nothing.
  assert.ok(!/why\.remove\(\)/.test(src),
    'the Clear removed the note, leaving an empty disabled box with nothing saying why it is inert');
  assert.match(src, /why\.textContent =/,
    'the Clear must retext the note in place — that is what keeps the cleared state self-explaining');

  // The other half of "inert": the field was disabled when rendered stale, so
  // saying nothing in the handler is what keeps it that way. If the render side
  // ever stopped disabling, the absence above would assert nothing.
  const stale = /if \(state === 'stale'\) \{[\s\S]*?clear\.addEventListener/.exec(pop);
  assert.ok(stale, 'ENTER: found the stale branch that renders the field in the first place');
  assert.match(stale[0], /input\.disabled = true;/,
    'the stale field starts disabled — that is the state the Clear handler must leave alone');

  // A standing role really does regain an editable cwd on an active dispatch,
  // so the inertness above is scoped to `standing` rather than permanent.
  assert.strictEqual(fieldReveal('spawn', { cwd: '', template: 'fable-design' }).cwd, 'edit',
    'a rebuild under spawn renders `edit`, which is the enabled path');
});

test('reservedRoleNote: newcomer-facing lock reason for lead/reviewer, safe generic otherwise', () => {
  assert.match(reservedRoleNote('lead'), /Runs the team/);
  assert.match(reservedRoleNote('reviewer'), /Independently checks the lead's work/);
  // Any other (no other reserved key today) → a safe generic, never empty.
  assert.match(reservedRoleNote('whatever'), /Managed by Clodex/);
});

// t421. `reviewer` is removable BY THE OPERATOR and `lead` is not, and these
// helpers are how the popover renders that split. The membership assertion is the
// point: a `lead` that leaked into the removable set would put a Remove button on
// a role whose absence makes the whole team fail to load.
test('REMOVABLE_RESERVED_ROLE_KEYS is exactly {reviewer} — never `lead`', () => {
  assert.deepStrictEqual([...REMOVABLE_RESERVED_ROLE_KEYS], ['reviewer']);
  assert.strictEqual(REMOVABLE_RESERVED_ROLE_KEYS.has('lead'), false,
    'loadManifest hard-requires `lead`; offering to remove it would produce a team.json that cannot load');
});

test('absentStockRoles: every absent STOCK role is offered, `lead` never', () => {
  // The offer-card affordance's whole input. A team with no row at all for a
  // missing role is how this orphan state stayed invisible — for `reviewer` until
  // a ticket reached the review step, for `hand` until a dispatch had nowhere to
  // land.
  assert.deepStrictEqual(absentStockRoles({ roles: { lead: {}, hand: {} } }), ['reviewer']);
  assert.deepStrictEqual(absentStockRoles({ roles: { lead: {}, reviewer: {} } }), ['hand'],
    'a removed hand is offered too — it is not reserved, so nothing else guards its absence');
  assert.deepStrictEqual(absentStockRoles({ roles: { lead: {}, hand: {}, reviewer: {} } }), [],
    'a team WITH both gets no offer cards — it already has real rows');
  // A lead-less manifest never reaches the popover (loadManifest throws first),
  // but the helper must not invent a `lead` offer for one: the lead decision is
  // its own block, and Enable would write a def where a POINTER is what is missing.
  assert.deepStrictEqual(absentStockRoles({ roles: {} }), ['hand', 'reviewer']);
  assert.deepStrictEqual(absentStockRoles(null), ['hand', 'reviewer'], 'no manifest → no throw');
  assert.strictEqual(OFFERABLE_STOCK_ROLE_KEYS.includes('lead'), false);
});

test('offer cards are NOT rows in teamRoleRows — the schema-pinned model stays manifest-only', () => {
  // The legibility test reads teamRoleRows' keys as the schema fields a row can
  // display, and every caller relies on "one row per role in the manifest". A
  // synthetic absent-role row folded in there would break both at once, silently.
  const manifest = { roles: { lead: {}, hand: {} } };
  assert.deepStrictEqual(teamRoleRows(manifest).map((r) => r.key), ['lead', 'hand'],
    'the row model still describes exactly what is on disk');
  assert.deepStrictEqual(absentStockRoles(manifest), ['reviewer'],
    'and the absent one is reported separately');
});

test('reservedRemovalWarning / absentStockNote say what is LOST, not merely what changed', () => {
  // Removal is destructive, one click away, and its only other symptom arrives a
  // ticket later at the review step — so the confirm has to carry the consequence.
  assert.match(reservedRemovalWarning('reviewer'), /escalate to you at the review step/);
  assert.match(absentStockNote('reviewer'), /escalate to the lead at the review step/);
  // The hand's consequence is different and must READ differently: nothing
  // implements the specs the lead writes.
  assert.match(absentStockNote('hand'), /Nothing implements/);
  // An unknown key still gets a safe, non-empty line rather than undefined text.
  assert.ok(reservedRemovalWarning('mystery').length > 0);
  assert.ok(absentStockNote('mystery').length > 0);
});

test('offerDispatchLine names the dispatch CONCEPT on a role the team does not have (R2)', () => {
  // Hiding field density is the point of the redesign; hiding the app's
  // differentiator is not. An operator who only ever sees offer cards must still
  // learn that dispatch exists.
  assert.match(offerDispatchLine(), /standing/);
  // A FIXED string, not a value read off a def: no stock def ships a `dispatch`,
  // so anything "read" here would be invented. Pinned so a later edit that starts
  // interpolating a mode has to come through this assertion.
  assert.strictEqual(offerDispatchLine(), offerDispatchLine());
});

// ── A1: the three-way stage ──────────────────────────────────────────────────
test('teamStage: unset → setup, missing/ineligible → repair, stopped/live → normal', () => {
  assert.strictEqual(teamStage({ state: 'unset' }), 'setup');
  assert.strictEqual(teamStage({ state: 'missing' }), 'repair');
  assert.strictEqual(teamStage({ state: 'ineligible' }), 'repair');
  assert.strictEqual(teamStage({ state: 'live' }), 'normal');
  // `stopped` is NORMAL and that is the finding R1 was raised on: its own note
  // says it restarts under this name, so treating it as broken puts a working
  // team into repair mode.
  assert.strictEqual(teamStage({ state: 'stopped' }), 'normal',
    'a stopped lead is known-and-restartable, not broken');
});

test('teamStage: an UNRECOGNIZED state falls to repair, never to normal', () => {
  // Repair is the mode that still shows everything. A state this function cannot
  // reason about must not select the mode that HIDES the lead decision, which is
  // what `setup` does, nor claim the team is fine.
  assert.strictEqual(teamStage({ state: 'wat' }), 'repair');
  assert.strictEqual(teamStage({}), 'repair');
  assert.strictEqual(teamStage(null), 'repair', 'no resolution → no throw');
});

// ── A2: the summary row model ────────────────────────────────────────────────
// Whole objects, not probed fields: an unwired seat count arrives as `undefined`,
// and a regex over the note would happily match around it.
test('roleSummaries: a zero-seat role SCOPES its "no seat" note to this window', () => {
  // The rows are workspace-scoped, so zero seats here does not mean zero seats.
  // The unqualified wording was a falsehood about a role running in another
  // window; leadResolution's `stopped` note carries the same qualifier.
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, [], { lead: 'shop-lead' });
  assert.deepStrictEqual(out, [{
    key: 'hand',
    dispatch: 'standing',
    readOnly: false,
    seats: { total: 0, working: 0, names: [] },
    note: 'no seat in this window',
  }]);
});

test('roleSummaries: a one-seat role reads the bare seat NAME, not a count', () => {
  const sessions = [{ name: 'shop-hand', role: 'hand', team: 'shop', activity: 'idle' }];
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, sessions, {});
  assert.deepStrictEqual(out, [{
    key: 'hand',
    dispatch: 'standing',
    readOnly: false,
    seats: { total: 1, working: 0, names: ['shop-hand'] },
    note: 'shop-hand',
  }]);
});

test('roleSummaries: multi-seat counts WORKING as not-idle, in the order given', () => {
  const sessions = [
    { name: 'shop-hand', role: 'hand', team: 'shop', activity: 'working' },
    { name: 'shop-hand2', role: 'hand', team: 'shop', activity: 'idle' },
    { name: 'shop-hand3', role: 'hand', team: 'shop', activity: 'thinking' },
  ];
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, sessions, {});
  assert.deepStrictEqual(out, [{
    key: 'hand',
    dispatch: 'standing',
    readOnly: false,
    seats: { total: 3, working: 2, names: ['shop-hand', 'shop-hand2', 'shop-hand3'] },
    note: '3 seats · 2 working',
  }]);
});

test('roleSummaries: a lead seat named OFF-convention resolves through the `lead` pointer', () => {
  // The normal case, not an edge one: the backend's matchSeatRole short-circuits
  // on `seatName === team.lead`, so a lead called `boss` holds the role while
  // matching on `<team>-lead` finds nothing. Role matching alone would report
  // "no seat" for a team whose lead is running right there.
  const sessions = [
    { name: 'boss', role: 'lead', team: 'shop', activity: 'working' },
    { name: 'shop-hand', role: 'hand', team: 'shop', activity: 'idle' },
  ];
  const out = roleSummaries({ name: 'shop', roles: { lead: {}, hand: {} } }, sessions, { lead: 'boss' });
  assert.deepStrictEqual(out.map((r) => [r.key, r.seats]), [
    ['lead', { total: 1, working: 1, names: ['boss'] }],
    ['hand', { total: 1, working: 0, names: ['shop-hand'] }],
  ]);
});

test('roleSummaries: seats of ANOTHER team holding the same role key are not counted', () => {
  // Session rows are workspace-scoped, not team-scoped: two teams open in one
  // window both have a `hand`, and matching on the role key alone would have each
  // report the other's seats as its own.
  const sessions = [
    { name: 'shop-hand', role: 'hand', team: 'shop', activity: 'idle' },
    { name: 'api-hand', role: 'hand', team: 'api', activity: 'working' },
  ];
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, sessions, {});
  assert.deepStrictEqual(out[0].seats, { total: 1, working: 0, names: ['shop-hand'] });
});

test('roleSummaries: an unknown dispatch on disk normalizes to standing', () => {
  // A hand-edited team.json can hold anything. The chip has no picker behind it
  // to correct a made-up mode, and `standing` is what the role actually behaves
  // as, so displaying the raw value would state a behaviour the app does not have.
  const out = roleSummaries({ name: 'shop', roles: { a: { dispatch: 'teleport' }, b: { dispatch: 'worktree' }, c: {} } }, [], {});
  assert.deepStrictEqual(out.map((r) => r.dispatch), ['standing', 'worktree', 'standing']);
  assert.deepStrictEqual(out.map((r) => r.key), ['a', 'b', 'c'], 'ENTER: all three rows survived to be checked');
});

test('roleSummaries: reserved keys are marked readOnly, same as the row model', () => {
  const out = roleSummaries({ name: 'shop', roles: { lead: {}, reviewer: {}, hand: {} } }, [], {});
  assert.deepStrictEqual(out.map((r) => [r.key, r.readOnly]), [['lead', true], ['reviewer', true], ['hand', false]]);
});

test('roleSummaries: keys are EXACTLY the summary shape — it must not grow into the schema model', () => {
  // teamRoleRows' keys are pinned as schema fields by team-role-schema-legibility.
  // This model is separate precisely so presentation can vary without touching
  // that gate; asserting the whole key set is what keeps the two from converging.
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, [], {});
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['dispatch', 'key', 'note', 'readOnly', 'seats']);
});

test('parseDuration: friendly units → ms; bare number = minutes; rejects junk/zero/blank', () => {
  assert.deepStrictEqual(parseDuration('30m'), { ok: true, ms: 1800000 });
  assert.deepStrictEqual(parseDuration('2h'), { ok: true, ms: 7200000 });
  assert.deepStrictEqual(parseDuration('90s'), { ok: true, ms: 90000 });
  assert.deepStrictEqual(parseDuration('1d'), { ok: true, ms: 86400000 });
  assert.deepStrictEqual(parseDuration('1.5h'), { ok: true, ms: 5400000 });
  assert.deepStrictEqual(parseDuration('  45  '), { ok: true, ms: 2700000 }, 'bare number = minutes');
  assert.deepStrictEqual(parseDuration('2H'), { ok: true, ms: 7200000 }, 'unit case-insensitive');
  assert.strictEqual(parseDuration('').ok, false, 'blank rejected');
  assert.strictEqual(parseDuration('soon').ok, false, 'junk rejected');
  assert.strictEqual(parseDuration('30x').ok, false, 'unknown unit rejected');
  assert.strictEqual(parseDuration('0m').ok, false, 'zero rejected');
  assert.strictEqual(parseDuration('-30m').ok, false, 'negative rejected');
  assert.deepStrictEqual(parseDuration('300500ms'), { ok: true, ms: 300500 }, 'ms unit accepted');
  // T33 item 3: the reject copy enumerates the accepted forms incl. ms, so a
  // raw-number typer learns ms is valid instead of getting an opaque bounce.
  assert.match(parseDuration('soon').error, /500ms/, 'junk-reject copy enumerates ms');
  assert.match(parseDuration('').error, /500ms/, 'blank-reject copy enumerates ms');
});

test('formatDuration: friendliest exact unit; round-trips parseDuration; empty for invalid', () => {
  assert.strictEqual(formatDuration(1800000), '30m');
  assert.strictEqual(formatDuration(300000), '5m');
  assert.strictEqual(formatDuration(7200000), '2h');
  assert.strictEqual(formatDuration(86400000), '1d');
  assert.strictEqual(formatDuration(90000), '90s');
  assert.strictEqual(formatDuration(0), '');
  assert.strictEqual(formatDuration(null), '');
  assert.strictEqual(formatDuration(-5), '');
  // Round-trip: format then parse returns the same ms for producible values —
  // INCLUDING the `${ms}ms` fallback (nit-1: parse accepts the ms unit).
  for (const ms of [1800000, 300000, 7200000, 86400000, 90000, 300500]) {
    assert.deepStrictEqual(parseDuration(formatDuration(ms)), { ok: true, ms });
  }
  assert.strictEqual(formatDuration(300500), '300500ms', 'fallback stays parseable');
});

// --- the lead SEAT front door (t420) ---------------------------------------

test('leadSeatCandidates: agent seats OF THIS TEAM, in order; a BASH seat is never eligible', () => {
  // `team` is the row's own membership answer from session-manager (teamFor →
  // resolveTeam → cwdInProject), so this fixture carries the two cases a path
  // comparison in the renderer would get wrong: a seat in a linked WORKTREE of
  // the root (member of `shop`, path nowhere near it) and a seat under a NESTED
  // team's root (path inside `/proj/shop`, member of `shop-api`).
  const sessions = [
    { name: 'shop-lead', type: 'claude', cwd: '/proj/shop', team: 'shop' },
    { name: 'shop-shell', type: 'bash', cwd: '/proj/shop', team: 'shop' },        // private: no registry, no socket
    { name: 'shop-wt', type: 'codex', cwd: '/elsewhere/shop-t9', team: 'shop' },  // linked worktree, still `shop`
    { name: 'api-hand', type: 'claude', cwd: '/proj/shop/api', team: 'shop-api' },// nested team owns it
    { name: 'elsewhere', type: 'claude', cwd: '/tmp', team: null },
    { name: 'gone', type: 'claude', cwd: '/proj/shop', team: 'shop', archivedAt: 123 },
  ];
  // ENTER: the rows this filter is FOR must be in the input, or the assertions
  // below are true of a set that never contained them — the bash exclusion in
  // particular would "pass" against a list with no bash row at all.
  assert.ok(sessions.some((s) => s.type === 'bash' && s.team === 'shop'),
    'ENTER: a bash session belonging to the team must be in the input');
  assert.ok(sessions.some((s) => s.archivedAt), 'ENTER: an archived seat must be in the input');
  assert.ok(sessions.some((s) => s.team === 'shop' && !s.cwd.startsWith('/proj/shop')),
    'ENTER: a worktree seat whose PATH is outside the root must be in the input');
  assert.ok(sessions.some((s) => s.cwd.startsWith('/proj/shop/') && s.team !== 'shop'),
    'ENTER: a nested-team seat whose PATH is inside the root must be in the input');

  assert.deepStrictEqual(leadSeatCandidates(sessions, 'shop'), ['shop-lead', 'shop-wt'],
    'agent seats of this team only, input order preserved');
  // Both path-vs-membership cases get their own assertion, because they fail in
  // OPPOSITE directions and one filter could fix either alone.
  assert.strictEqual(leadSeatCandidates(sessions, 'shop').includes('api-hand'), false,
    'a seat inside the root but owned by a NESTED team is not this team’s to offer');
  assert.strictEqual(leadSeatCandidates(sessions, 'shop').includes('shop-wt') , true,
    'a seat in a linked worktree IS a member, though its path is outside the root');
  // The bash-only team: empty, which is what makes the popover's empty state the
  // thing the operator reads (the crypto-app case).
  assert.deepStrictEqual(leadSeatCandidates([{ name: 'crypto-bash', type: 'bash', cwd: '/p', team: 'crypto-app' }], 'crypto-app'), []);
  // Degenerate inputs never throw.
  assert.deepStrictEqual(leadSeatCandidates(null, 'shop'), []);
  assert.deepStrictEqual(leadSeatCandidates(sessions, ''), [], 'no team name → nothing to match against');
  assert.deepStrictEqual(leadSeatCandidates([{ type: 'claude', team: 'shop' }], 'shop'), [], 'a nameless row is not a seat');
});

test('leadResolution: a LIVE BASH seat reads as ineligible, never as "running now"', () => {
  // The measured crypto-app path end to end: the root holds one session, it is
  // bash, the picker is therefore empty, the empty state invites typing a name,
  // and the only name the operator can see is the bash one. setLead accepts it
  // (NAME_RE only — correct, the writer cannot know session types), so THIS is
  // the only place the trap can be sprung.
  const sessions = [{ name: 'crypto-bash', type: 'bash', cwd: '/proj/crypto', team: 'crypto-app' }];
  assert.ok(sessions.some((s) => s.type === 'bash'), 'ENTER: the live bash row must be in the input');
  const res = leadResolution('crypto-bash', { sessions, known: ['crypto-bash'] });
  assert.strictEqual(res.state, 'ineligible', 'a live bash lead is NOT the healthy state');
  assert.notStrictEqual(res.state, 'live', 'and specifically never reads as running');
  assert.match(res.note, /no messaging registry/);
  // It is also NOT 'stopped', even though the name is in the known list — the
  // seat is running, it just cannot ever be reached.
  assert.notStrictEqual(res.state, 'stopped');
});

test('leadResolution: live / stopped / missing / unset are otherwise distinct states', () => {
  const sessions = [
    { name: 'shop-lead', type: 'claude', cwd: '/proj/shop', team: 'shop' },
    { name: 'shop-shell', type: 'bash', cwd: '/proj/shop', team: 'shop' },
  ];
  const known = ['shop-lead', 'shop-shell', 'shop-old-lead'];
  assert.deepStrictEqual(leadResolution('shop-lead', { sessions, known }),
    { state: 'live', name: 'shop-lead', note: 'running now' });
  // STOPPED IS NOT BROKEN: it has a record and restarts by name. The whole point
  // of splitting this from `missing` is that the popover must not cry wolf here.
  // "in this window" because the live rows are workspace-scoped and the known
  // names are not — a lead running in another workspace lands in this arm.
  assert.deepStrictEqual(leadResolution('shop-old-lead', { sessions, known }),
    { state: 'stopped', name: 'shop-old-lead', note: 'not running in this window — it restarts under this name' });
  // MISSING: the orphan pointer — no session, live or persisted, ever.
  const missing = leadResolution('crypto-app-lead', { sessions, known });
  assert.strictEqual(missing.state, 'missing');
  assert.strictEqual(missing.name, 'crypto-app-lead');
  assert.match(missing.note, /no session by this name exists/);
  // No pointer at all.
  assert.strictEqual(leadResolution('', { sessions, known }).state, 'unset');
  assert.strictEqual(leadResolution(null, { sessions, known }).state, 'unset');
  // Absent listings must not turn a real pointer into a claim it is live.
  assert.strictEqual(leadResolution('shop-lead', {}).state, 'missing');
  assert.strictEqual(leadResolution('shop-lead').state, 'missing');
});

test('formatBlockedBy: names blocking seats + open tickets, empty when nothing blocks', () => {
  assert.strictEqual(formatBlockedBy(null), '');
  assert.strictEqual(formatBlockedBy({ seats: [], tickets: [] }), '');
  assert.strictEqual(formatBlockedBy({ seats: ['shop-runner-1'], tickets: [] }), 'seat(s): shop-runner-1');
  assert.strictEqual(formatBlockedBy({ seats: [], tickets: ['t3'] }), 'open ticket(s): t3');
  assert.strictEqual(
    formatBlockedBy({ seats: ['shop-runner-1', 'shop-runner-2'], tickets: ['t3'] }),
    'seat(s): shop-runner-1, shop-runner-2; open ticket(s): t3',
  );
});
