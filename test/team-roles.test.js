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
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote, reservedRoleTemplate,
  parseDuration, formatDuration, formatBlockedBy,
  leadSeatCandidates, leadResolution,
  reservedRemovalWarning,
  teamStage, roleSummaries, activityTime, ticketLine, absentStockRoles, absentStockNote, offerDispatchLine, fieldReveal,
  accountOptions,
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
  assert.deepStrictEqual(rows[2], { key: 'runner', account: '', brief: 'runs things', prompt: 'p', template: 'fable-lead', dispatch: 'worktree', cwd: '', readOnly: false });
  // `dispatch` normalizes to 'standing', NOT to '': absent IS standing on disk,
  // and a blank would leave the row's picker with no selected option, which
  // buildSavePatch then drops — a Save that silently declines to save.
  // `cwd` normalizes to '' (unlike dispatch): absent means "the team root", and
  // the row's control is a free-text input whose empty state says exactly that.
  assert.deepStrictEqual(rows[3], { key: 'bare', account: '', brief: '', prompt: '', template: '', dispatch: 'standing', cwd: '', readOnly: false });
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
  assert.deepStrictEqual(p, { brief: 'b', prompt: 'p', cwd: '', account: '' });
  assert.ok(!('template' in p), 'blank template omitted, not sent as ""/null');
  // A non-blank template is included; all values trimmed.
  assert.deepStrictEqual(
    buildSavePatch({ brief: '  b  ', prompt: '  p  ', template: '  fable-lead  ' }),
    { brief: 'b', prompt: 'p', template: 'fable-lead', cwd: '', account: '' },
  );
  // Blank brief/prompt ARE sent (backend stores '' — a legitimate clear); missing
  // form values normalize to '' without throwing.
  assert.deepStrictEqual(buildSavePatch({ brief: '', prompt: '', template: '' }), { brief: '', prompt: '', cwd: '', account: '' });
  assert.deepStrictEqual(buildSavePatch({}), { brief: '', prompt: '', cwd: '', account: '' });
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
    { brief: 'b', prompt: 'p', cwd: 'api', account: '' },
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
    { brief: 'b', prompt: 'p', dispatch: 'spawn', cwd: '', account: '' },
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
    { brief: 'b', prompt: 'p', dispatch: 'standing', cwd: '', account: '' },
  );
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: '  worktree  ' }),
    { brief: 'b', prompt: 'p', dispatch: 'worktree', cwd: '', account: '' },
    'trimmed like every other value',
  );
  // A value the backend would throw on is dropped rather than forwarded — the
  // throw would take the brief/prompt edits sent alongside it down too.
  for (const bad of ['', 'sometimes', undefined]) {
    const p = buildSavePatch({ brief: 'b', prompt: 'p', dispatch: bad });
    assert.ok(!('dispatch' in p), `off-enum dispatch ${JSON.stringify(bad)} is omitted`);
    assert.deepStrictEqual(p, { brief: 'b', prompt: 'p', cwd: '', account: '' }, 'and the rest of the patch is unharmed');
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

test('r1 MF1: the stock `lead` role is exactly the shape that exposed the dead Clear', () => {
  // Not an edge case, which is why this pins the SHAPE and not just the leaf:
  // STOCK_ROLE_DEFS.lead carries a template and no dispatch — a reserved role
  // is refused one — so it is standing, so its template is stale. A default
  // team's `lead` row hits this the first time anyone expands it.
  const { STOCK_ROLE_DEFS } = require('../team-manifest');
  const lead = STOCK_ROLE_DEFS.lead;
  assert.ok(lead, 'ENTER: the stock lead def exists — a rename would leave every assertion below vacuous');
  assert.ok(lead.template, 'the stock lead names a template');
  assert.strictEqual(lead.dispatch, undefined, 'and no dispatch, so it is standing');
  const reveal = fieldReveal(lead.dispatch, { cwd: lead.cwd, template: lead.template });
  assert.strictEqual(reveal.template, 'stale',
    'so a default team shows a stale template on `lead` — which must therefore not carry a Clear');
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

// The operator could not change the reviewer's model from the GUI at all: the
// reserved row showed no template control, so the only route was hand-editing the
// template JSON (which a release overwrites). These pin the resolution the row
// now displays. The names are the spawn-path defaults in team-tickets.js —
// DEFAULT_LEAD_TEMPLATE and DEFAULT_REVIEWER_TEMPLATE — and a drift between the
// two sends the operator to edit a file the seat never boots on, which is the bug
// this fixes in a new costume.
test('reservedRoleTemplate: a reserved role with no stored template resolves to the spawn default', () => {
  assert.strictEqual(reservedRoleTemplate('reviewer', ''), 'clodex-team-reviewer');
  assert.strictEqual(reservedRoleTemplate('lead', ''), 'clodex-team-lead');
});

test('reservedRoleTemplate: a stored template wins over the default, and an unknown key resolves to blank', () => {
  assert.strictEqual(reservedRoleTemplate('reviewer', 'my-own-reviewer'), 'my-own-reviewer',
    'a team that set its own reviewer template must see THAT name, not the stock one it does not boot on');
  assert.strictEqual(reservedRoleTemplate('whatever', ''), '',
    'an unknown reserved key has no default to claim: blank renders as the dash, never as another role\'s template');
});

test('reservedRoleNote tells the operator the template is editable even though the role is locked', () => {
  // The lock note was the ONLY text on the row and it said "locked" without
  // qualification, so an operator reading it concluded the model was unreachable.
  for (const key of ['lead', 'reviewer']) {
    const note = reservedRoleNote(key);
    assert.match(note, /template/,
      `ENTER: the ${key} note must mention the template at all, or the assertions below are vacuous`);
    assert.match(note, /model/,
      `the ${key} note must say the MODEL is what the template carries: that is the setting the operator came to change`);
    assert.match(note, /yours to edit/,
      `the ${key} note must say the template is editable — "locked" alone is what sent the operator to hand-edit JSON`);
  }
});

// `reservedRoleTemplate: a reserved role with no stored template…` above hardcodes
// the two stems, so it only asserts the renderer agrees with itself: a cold review
// mutated team-tickets.js's DEFAULT_LEAD_TEMPLATE /
// DEFAULT_REVIEWER_TEMPLATE to `…-DRIFT` and the whole suite stayed green. This is
// the pin that was missing. team-tickets.js exports neither constant, so the
// literals are scraped from its source — the team-uses.js shape (regex-extract,
// compare the capture), not the host-stamp one, because nothing here needs the
// main-process module EVALUATED: the facts are two string literals, and a scrape
// that reads them cannot itself restate them.
//
// Each row names its own main-process constant rather than deriving the name from
// the role key: `DEFAULT_LEAD_TEMPLATE` spelled out is what fails loudly if the
// constant is renamed, where a computed `DEFAULT_${KEY}_TEMPLATE` would quietly
// stop finding anything the moment the naming convention moved.
test('t888 parity: each reserved default is the literal team-tickets.js actually spawns on', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'team-tickets.js'), 'utf-8');
  for (const [key, constName] of [['lead', 'DEFAULT_LEAD_TEMPLATE'], ['reviewer', 'DEFAULT_REVIEWER_TEMPLATE']]) {
    const m = new RegExp(`^const ${constName} = '([^']+)';$`, 'm').exec(src);
    assert.ok(m, `ENTER: team-tickets.js declares ${constName} as a single-quoted literal — `
      + 'without this the assertion below has nothing to compare and would pass vacuously');
    assert.strictEqual(reservedRoleTemplate(key, ''), m[1],
      `the popover's ${key} row resolves a template the spawn path does not use: `
      + `${constName} moved and RESERVED_ROLE_TEMPLATE did not. The row would send the operator `
      + 'to edit a file no seat boots on — the exact bug the control was added to fix');
  }
});

// RESERVED_ROLE_KEYS and RESERVED_ROLE_TEMPLATE are a second pair that must stay
// in step, and only the second has a live accessor. A third reserved key added to
// the Set alone renders the row as `—` with the title `no template named ""
// is installed…` — a dead Open button and no way to see which seat the role boots
// on. Neither constant is exported, so the Set is scraped and evaluated (the
// host-stamp shape): restating its members here would pin this file against
// itself and see no drift at all.
test('t888: every RESERVED_ROLE_KEYS member has a RESERVED_ROLE_TEMPLATE default to resolve', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'lib', 'team-roles.js'), 'utf-8');
  const m = /^const RESERVED_ROLE_KEYS = (new Set\(\[[^\]]*\]\));$/m.exec(src);
  assert.ok(m, 'ENTER: found the RESERVED_ROLE_KEYS declaration to scrape');
  const keys = [...new Function(`return ${m[1]};`)()];
  assert.ok(keys.length > 0, 'ENTER: the scraped Set has members, or the loop below asserts nothing');
  for (const key of keys) {
    assert.notStrictEqual(reservedRoleTemplate(key, ''), '',
      `reserved key \`${key}\` has no entry in RESERVED_ROLE_TEMPLATE: its row renders the dash `
      + 'with a permanently disabled Open, and the operator cannot reach the template its seats boot on');
  }
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
  assert.match(offerDispatchLine(undefined), /standing/);
  assert.strictEqual(offerDispatchLine(null), offerDispatchLine(undefined));
  assert.strictEqual(offerDispatchLine('standing'), offerDispatchLine(undefined));
  assert.match(offerDispatchLine('worktree'), /worktree/);
  assert.match(offerDispatchLine('worktree'), /branch, tree and seat/);
  assert.doesNotMatch(offerDispatchLine('worktree'), /standing/);
  assert.match(offerDispatchLine('spawn'), /one-shot seat/);
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
    account: '',
    dispatch: 'standing',
    readOnly: false,
    seats: { total: 0, working: 0, names: [] },
    note: 'no seat in this window',
  }]);
});

// ── The account picker's option list ─────────────────────────────────────────
// Whole objects throughout: `selected` and `marked` are the two bits that decide
// what the operator sees pre-picked, and a per-key probe would pass on a list
// that offered the right labels with nothing chosen.
test('accountOptions: no registered accounts offers the default alone', () => {
  // The honest offer when the registry is empty or its listing failed — the
  // popover collapses both to []. Dropping this option would leave a picker with
  // no way back to "the account Clodex runs on".
  assert.deepStrictEqual(accountOptions([], ''), [
    { value: '', text: 'default (the account Clodex runs on)', selected: true, marked: false },
  ]);
  assert.deepStrictEqual(accountOptions(null, ''), [
    { value: '', text: 'default (the account Clodex runs on)', selected: true, marked: false },
  ], 'a missing list is the same offer, not a crash');
});

test('accountOptions: registered labels follow the default, in list order, with the stored one selected', () => {
  const accounts = [{ label: 'work' }, { label: 'personal' }];
  assert.deepStrictEqual(accountOptions(accounts, 'personal'), [
    { value: '', text: 'default (the account Clodex runs on)', selected: false, marked: false },
    { value: 'work', text: 'work', selected: false, marked: false },
    { value: 'personal', text: 'personal', selected: true, marked: false },
  ]);
  // Blank stored → the default is what is pre-picked, and no label is.
  assert.deepStrictEqual(accountOptions(accounts, '').map((o) => o.selected), [true, false, false]);
});

test('accountOptions: a stored label the registry does not offer is appended, marked and selected', () => {
  // Not a hypothetical: an account can be removed from the registry while a role
  // still names it. Blanking it here would make a Save that never touched the
  // field silently clear the role's account.
  assert.deepStrictEqual(accountOptions([{ label: 'work' }], 'retired'), [
    { value: '', text: 'default (the account Clodex runs on)', selected: false, marked: false },
    { value: 'work', text: 'work', selected: false, marked: false },
    { value: 'retired', text: 'retired (not a registered account)', selected: true, marked: true },
  ]);
  // A stored label that IS offered must not be appended a second time — and the
  // whole list, so this also pins that the offered label is the SELECTED one.
  assert.deepStrictEqual(accountOptions([{ label: 'work' }], 'work'), [
    { value: '', text: 'default (the account Clodex runs on)', selected: false, marked: false },
    { value: 'work', text: 'work', selected: true, marked: false },
  ]);
});

// Driven by the SHAPE accounts.list() really returns — a synthetic `default` row
// first (accounts.js:104,138), not a hand-written array of custom labels. Against
// the round-1 helper this list rendered "default" twice, and picking the second
// stored the literal string on the role.
test('accountOptions: the registry\'s synthetic default row does not become a second default option', () => {
  const real = [
    { label: 'default', email: null, configDir: '/Users/x/.claude', plan: 'unknown', addedAt: null },
    { label: 'work', email: 'w@x.io', configDir: '/Users/x/.claude-work', plan: 'max', addedAt: 1 },
  ];
  assert.deepStrictEqual(accountOptions(real, ''), [
    { value: '', text: 'default (the account Clodex runs on)', selected: true, marked: false },
    { value: 'work', text: 'work', selected: false, marked: false },
  ]);
  assert.strictEqual(accountOptions(real, '').filter((o) => o.value === '').length, 1,
    'exactly one default option, and its value is the empty string absence is stored as');
  assert.ok(!accountOptions(real, '').some((o) => o.value === 'default'),
    'no option stores the literal "default" — the backend reads that as no account at all');
});

test('accountOptions: a role already carrying the literal "default" selects the default option', () => {
  // The round-1 bug's residue on disk. resolveAccountLabel (accounts.js:54) reads
  // 'default' as "no account", so marking it "(not a registered account)" would
  // be a falsehood — and appending it would offer the same choice twice again.
  const real = [{ label: 'default', configDir: '/Users/x/.claude' }, { label: 'work', configDir: '/w' }];
  assert.deepStrictEqual(accountOptions(real, 'default'), [
    { value: '', text: 'default (the account Clodex runs on)', selected: true, marked: false },
    { value: 'work', text: 'work', selected: false, marked: false },
  ]);
});

test('roleSummaries: a role with an account carries it, so the collapsed row can show it', () => {
  // The chip is built from this key. A role whose seats boot on a named account
  // says so without being expanded, beside the dispatch chip.
  const manifest = { name: 'shop', roles: { hand: { account: 'work' }, bare: {} } };
  const out = roleSummaries(manifest, [], {});
  assert.deepStrictEqual(out.map((r) => [r.key, r.account]), [['hand', 'work'], ['bare', '']],
    'the account as stored, and "" for a role that has none');
});

test('roleSummaries: a one-seat role reads the bare seat NAME, not a count', () => {
  const sessions = [{ name: 'shop-hand', role: 'hand', team: 'shop', activity: 'idle' }];
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, sessions, {});
  assert.deepStrictEqual(out, [{
    key: 'hand',
    account: '',
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
    account: '',
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
  assert.deepStrictEqual(Object.keys(out[0]).sort(), ['account', 'dispatch', 'key', 'note', 'readOnly', 'seats']);
});

// ── B: the note says what the role is DOING, from team:activity ───────────────
// A per-ticket role read "no seat in this window" while its hand was mid-ticket,
// because the seat counts are workspace-scoped and its seat lives in a worktree.
// These notes come from the board instead. Every one is a literal: the whole
// value of the row is the sentence an operator reads off it.

// Local-time constructions on purpose — activityTime formats in the viewer's zone,
// so a UTC epoch literal would render differently per machine and pin nothing.
const NOW = new Date(2026, 8, 9, 23, 30).getTime();
const TODAY_2116 = new Date(2026, 8, 9, 21, 16).getTime();
const YESTERDAY_2116 = new Date(2026, 8, 8, 21, 16).getTime();

const ACT_ROLES = (hand) => ({ ok: true, team: 'shop', roles: { hand }, reviewer: { live: [], last: null }, counts: {} });
const WT = { name: 'shop', roles: { hand: { dispatch: 'worktree' } } };

test('roleSummaries: one live per-ticket seat names its seat AND its ticket, with the step', () => {
  const act = ACT_ROLES({ dispatch: 'worktree', live: [{ seat: 'shop-hand-783', ticket: 't783', step: 'working' }], open: [], last: null });
  const out = roleSummaries(WT, [], { activity: act, now: NOW });
  // The WHOLE row, because `seats` is what the dot and its hover title are built
  // from: the session rows here are EMPTY (a worktree hand runs in its own
  // window), so counting them colours the dot `none` and titles it "0 seat(s), 0
  // working" beside a note naming the seat that is working right now.
  assert.deepStrictEqual(out, [{
    key: 'hand',
    account: '',
    dispatch: 'worktree',
    readOnly: false,
    seats: { total: 1, working: 1, names: ['shop-hand-783'] },
    note: 'shop-hand-783 on t783 (working)',
  }]);
});

test('roleSummaries: a live seat at the review step reads "in review", not "working"', () => {
  // The two steps have different answers to "should I wait for it": a seat in
  // verify is done and being checked, and calling that "working" invites a nudge.
  const act = ACT_ROLES({ dispatch: 'worktree', live: [{ seat: 'shop-hand-783', ticket: 't783', step: 'verify' }], open: [], last: null });
  const out = roleSummaries(WT, [], { activity: act, now: NOW });
  assert.strictEqual(out[0].note, 'shop-hand-783 on t783 (in review)');
  assert.deepStrictEqual(out[0].seats, { total: 1, working: 0, names: ['shop-hand-783'] },
    'the seat is live but not working — the dot must read idle, not ok');
});

test('roleSummaries: two live per-ticket seats list both seats with their tickets', () => {
  const act = ACT_ROLES({
    dispatch: 'worktree',
    live: [{ seat: 'shop-hand-783', ticket: 't783', step: 'working' }, { seat: 'shop-hand-784', ticket: 't784', step: 'working' }],
    open: [],
    last: null,
  });
  const out = roleSummaries(WT, [], { activity: act, now: NOW });
  assert.strictEqual(out[0].note, '2 seats: shop-hand-783 on t783, shop-hand-784 on t784');
});

test('roleSummaries: no seat but an open ticket names the ticket, and its step only when not working', () => {
  // A parked ticket is waiting on the OPERATOR, an ordinary open one on the loop.
  // Naming the step unconditionally would put "(working)" beside every id and
  // bury the one word that means something.
  const parked = ACT_ROLES({ dispatch: 'worktree', live: [], open: [{ id: 't790', title: null, assignee: null, step: 'parked' }], last: null });
  assert.strictEqual(roleSummaries(WT, [], { activity: parked, now: NOW })[0].note, 'no seat now · t790 parked');
  const working = ACT_ROLES({ dispatch: 'worktree', live: [], open: [{ id: 't790', title: null, assignee: null, step: 'working' }], last: null });
  assert.strictEqual(roleSummaries(WT, [], { activity: working, now: NOW })[0].note, 'no seat now · t790');
});

test('roleSummaries: nothing live and nothing open says the role is per-ticket, not that it is broken', () => {
  // "no seat in this window" reads as a misconfiguration. A per-ticket role with
  // no ticket is idle and correct, and this is the sentence that says so.
  const act = ACT_ROLES({ dispatch: 'worktree', live: [], open: [], last: null });
  assert.strictEqual(roleSummaries(WT, [], { activity: act, now: NOW })[0].note, 'one seat per ticket · none running');
});

test('roleSummaries: the last landed ticket carries its outcome word and time', () => {
  const mk = (outcome, at) => ACT_ROLES({ dispatch: 'worktree', live: [], open: [], last: { id: 't783', title: 'x', at, outcome } });
  const note = (outcome, at) => roleSummaries(WT, [], { activity: mk(outcome, at), now: NOW })[0].note;
  assert.strictEqual(note('accepted', TODAY_2116), 'one seat per ticket · none running · last t783 landed 21:16');
  // A merge that failed is NOT a landing: the branch is still unmerged and
  // someone has to act, so it must not read with the same word as a success.
  assert.strictEqual(note('merge-failed', TODAY_2116), 'one seat per ticket · none running · last t783 merge FAILED 21:16');
  assert.strictEqual(note('cancelled', TODAY_2116), 'one seat per ticket · none running · last t783 cancelled 21:16');
  assert.strictEqual(note('accepted', YESTERDAY_2116), 'one seat per ticket · none running · last t783 landed Sep 8');
});

test('roleSummaries: a STANDING role keeps its seat-count note even with activity present', () => {
  // The seat counts are the truth for a standing role — its seat is the operator's
  // own, long-lived, and not minted by any ticket. Byte-identical to the no-activity
  // row: the whole object, so a note swapped in there cannot hide behind a field.
  const act = ACT_ROLES({ dispatch: 'standing', live: [], open: [], last: { id: 't783', title: 'x', at: TODAY_2116, outcome: 'accepted' } });
  const out = roleSummaries({ name: 'shop', roles: { hand: {} } }, [], { lead: 'shop-lead', activity: act, now: NOW });
  assert.deepStrictEqual(out, [{
    key: 'hand',
    account: '',
    dispatch: 'standing',
    readOnly: false,
    seats: { total: 0, working: 0, names: [] },
    note: 'no seat in this window',
  }]);
});

test('roleSummaries: the reviewer row states it is spawned per round and drops the dispatch key', () => {
  // team-manifest.js does not read the reviewer's `dispatch` — the loop reaches it
  // through [agent:team-review] and spawns one per round, so a chip showing that
  // value names a mode nothing honours. What makes buildSummaryLine drop the chip
  // is the `reviewer: true` flag beside it, not the absent `dispatch`.
  const rev = (reviewer) => ({ ok: true, team: 'shop', roles: {}, reviewer, counts: {} });
  const manifest = { name: 'shop', roles: { reviewer: { dispatch: 'worktree' } } };
  const live = roleSummaries(manifest, [], { activity: rev({ live: [{ ticket: 't783', round: 1, seat: 'shop-reviewer-783-r1' }], last: null }), now: NOW });
  assert.deepStrictEqual(live, [{
    key: 'reviewer',
    account: '',
    readOnly: true,
    seats: { total: 0, working: 0, names: [] },
    reviewer: true,
    note: 'reviewing t783 (round 1)',
  }]);
  const idle = roleSummaries(manifest, [], { activity: rev({ live: [], last: null }), now: NOW });
  assert.strictEqual(idle[0].note, 'spawned per review round · none now');
  const last = roleSummaries(manifest, [], { activity: rev({ live: [], last: { ticket: 't783', round: 1, verdict: 'ACCEPT', at: TODAY_2116 } }), now: NOW });
  assert.strictEqual(last[0].note, 'spawned per review round · none now · last t783 ACCEPT r1 21:16');
});

test('roleSummaries: activity ABSENT or ok:false leaves every row exactly as it was', () => {
  // The channel can fail (manifest unreadable) and the web host has no such api at
  // all. A blank or stale line on a row whose job is to state the truth is worse
  // than the seat-count note it replaced, so the fallback is the OLD row entire.
  const manifest = { name: 'shop', roles: { reviewer: {}, hand: { dispatch: 'worktree' } } };
  const sessions = [{ name: 'shop-hand', role: 'hand', team: 'shop', activity: 'working' }];
  const expected = [
    { key: 'reviewer', account: '', dispatch: 'standing', readOnly: true, seats: { total: 0, working: 0, names: [] }, note: 'no seat in this window' },
    { key: 'hand', account: '', dispatch: 'worktree', readOnly: false, seats: { total: 1, working: 1, names: ['shop-hand'] }, note: 'shop-hand' },
  ];
  assert.deepStrictEqual(roleSummaries(manifest, sessions, {}), expected, 'no activity option at all');
  assert.deepStrictEqual(roleSummaries(manifest, sessions, { activity: { ok: false, error: 'boom' } }), expected, 'a failed read');
});

test('roleSummaries: a per-ticket role the activity does not carry falls back to its seat note', () => {
  // `roles` is keyed off the manifest the BACKEND loaded, which can be a moment
  // behind the one rendered here — a role added since is absent, and inventing
  // "one seat per ticket · none running" for it would state a board fact nobody read.
  const act = { ok: true, team: 'shop', roles: {}, reviewer: { live: [], last: null }, counts: {} };
  const out = roleSummaries(WT, [], { activity: act, now: NOW });
  assert.strictEqual(out[0].note, 'no seat in this window');
});

test('activityTime: HH:MM today, "Mon D" any other day, blank for a non-number', () => {
  assert.strictEqual(activityTime(TODAY_2116, NOW), '21:16');
  assert.strictEqual(activityTime(new Date(2026, 8, 9, 9, 5).getTime(), NOW), '09:05', 'zero-padded both halves');
  assert.strictEqual(activityTime(YESTERDAY_2116, NOW), 'Sep 8');
  // Same clock time, a year apart: a day comparison on hours/minutes alone would
  // call this today and print 21:16 for something twelve months old.
  assert.strictEqual(activityTime(new Date(2025, 8, 9, 21, 16).getTime(), NOW), 'Sep 9');
  assert.strictEqual(activityTime(null, NOW), '');
  assert.strictEqual(activityTime(undefined, NOW), '');
});

// One ticket, one line, as the operator reads it. Literals throughout: the whole
// value of building the string in a pure leaf is that the pin is the sentence.
test('ticketLine: an open ticket names its seat and its step, "working since" carrying the clock', () => {
  const open = (over) => ticketLine({ id: 't786', title: 'the roles popover', assignee: 'hand-786', step: 'working', since: TODAY_2116, round: null, ...over }, NOW);
  assert.strictEqual(open(), 't786 · the roles popover · hand-786 · working since 21:16');
  assert.strictEqual(open({ step: 'review', round: 2 }), 't786 · the roles popover · hand-786 · in review (round 2)');
  assert.strictEqual(open({ step: 'parked' }), 't786 · the roles popover · hand-786 · parked');
  assert.strictEqual(open({ step: 'undelivered' }), 't786 · the roles popover · hand-786 · undelivered');
  // A backlog ticket has no seat and no start: "unassigned" is the honest word,
  // and a blank there would read as a seat whose name failed to render.
  assert.strictEqual(open({ step: 'backlog', assignee: null, since: null }),
    't786 · the roles popover · unassigned · backlog');
  // Started but with no usable stamp: the word survives, the clock does not —
  // "working since " with nothing after it states a time that was never read.
  assert.strictEqual(open({ since: null }), 't786 · the roles popover · hand-786 · working');
});

test('ticketLine: a landed ticket names its outcome, its time and its review rounds', () => {
  const landed = (over) => ticketLine({ id: 't785', title: 'team:activity', at: TODAY_2116, outcome: 'accepted', rounds: 2, ...over }, NOW);
  assert.strictEqual(landed(), 't785 · team:activity · merged 21:16 · 2 rounds');
  assert.strictEqual(landed({ rounds: 1 }), 't785 · team:activity · merged 21:16 · 1 round');
  // Zero rounds is not "0 rounds": a ticket that never reached a review has no
  // round count to state, and printing one invents a review that did not happen.
  assert.strictEqual(landed({ rounds: 0 }), 't785 · team:activity · merged 21:16');
  // A failed merge is NOT a landing — the branch is still unmerged and someone
  // has to act, so it must not read with the same word as a success.
  assert.strictEqual(landed({ outcome: 'merge-failed', rounds: 0 }), 't785 · team:activity · merge FAILED 21:16');
  assert.strictEqual(landed({ outcome: 'cancelled', rounds: 0 }), 't785 · team:activity · cancelled 21:16');
  assert.strictEqual(landed({ at: YESTERDAY_2116, rounds: 0 }), 't785 · team:activity · merged Sep 8');
});

test('ticketLine: a title longer than 60 chars is truncated with an ellipsis, not wrapped', () => {
  // The line is one row in a fixed-width popover; an untruncated title pushes the
  // step — the one part that says what to DO — off the end of the row.
  const title = 'x'.repeat(70);
  const out = ticketLine({ id: 't1', title, assignee: null, step: 'parked' }, NOW);
  assert.strictEqual(out, `t1 · ${'x'.repeat(60)}… · unassigned · parked`);
  const exact = 'y'.repeat(60);
  assert.strictEqual(ticketLine({ id: 't1', title: exact, assignee: null, step: 'parked' }, NOW),
    `t1 · ${exact} · unassigned · parked`, '60 is not over the limit');
  assert.strictEqual(ticketLine({ id: 't1', title: null, assignee: null, step: 'parked' }, NOW),
    't1 · untitled · unassigned · parked', 'a title-less ticket says so rather than rendering a gap');
});

test('the roles popover renders the Tickets section, its header sentence and both empty states', () => {
  // The section is the only place the loop is stated to the owner, and the empty
  // states are what the WEB host shows: `team:activity` is not shimmed there, so
  // `activity` is null and a section that rendered nothing would read as a team
  // with no board rather than a host that cannot see one.
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');
  const fn = /function buildTicketsSection\([\s\S]*?\n  \}/.exec(pop);
  assert.ok(fn, 'ENTER: found buildTicketsSection — a rename would reduce every assertion below to nothing');
  const src = fn[0];
  assert.ok(src.includes('Filed with [agent:task add], worked on their own branch, reviewed by a cold seat, merged by the loop.'),
    'the header sentence says what the loop does with a ticket');
  assert.ok(src.includes("'No open tickets.'") && src.includes("'Nothing landed yet.'"), 'both empty states');
  assert.ok(src.includes("list('Open'") && src.includes("list('Landed'"), 'Open above Landed');
  assert.match(src, /const tickets = act && act\.tickets \? act\.tickets : null;/,
    'the rows come off `activity.tickets`, and an ABSENT activity must fall to the empty states rather than throw');
  // SECURITY: ticket titles are agent-written strings. Every one of them lands as
  // textContent in this nodeIntegration renderer — an attribute or an innerHTML
  // here would make an agent-authored title executable.
  assert.ok(!/innerHTML|setAttribute|\.title =/.test(src),
    'agent-written titles must reach the DOM only as textContent');
  assert.match(pop, /ticketsSection\.appendChild\(buildTicketsSection\(activity\)\)/,
    'and renderRows must actually append it — a builder nobody calls renders no section');
});

test('the roles popover header explains the two kinds of role', () => {
  // The chips say `standing` and `worktree` with nothing on screen saying what
  // either does; this sentence is the only place the distinction is stated.
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf-8');
  assert.ok(html.includes("A standing role is one live seat you sit yourself; a per-ticket role gets a fresh seat, branch and checkout for every ticket, torn down when it lands."),
    'ENTER: the intro line carries the standing-vs-per-ticket sentence');
  assert.ok(html.includes('no config files needed'), 'the original reassurance survives');
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

// --- t790: the role prompt picker's two team-aware helpers -------------------
// Both are pure and live in this leaf for the reason the header states — the
// popover's DOM wiring is untested, so the branch that decides WHICH sentence a
// stored prompt gets has to be reachable without a DOM.
const { promptOptionGroups, storedPromptNote } = require('../renderer/lib/team-roles');

test('promptOptionGroups: the team\'s own stems lead, in a group of their own', () => {
  const groups = promptOptionGroups(['t-one', 'lib-a', 't-two', 'lib-b'], ['t-one', 't-two'], 'shop');
  assert.deepStrictEqual(groups, [
    { label: 'Team shop', names: ['t-one', 't-two'] },
    { label: null, names: ['lib-a', 'lib-b'] },
  ], 'team group first, then the ungrouped library remainder');
});

test('promptOptionGroups: no team-owned stems means no group at all', () => {
  assert.deepStrictEqual(promptOptionGroups(['lib-a'], [], 'shop'),
    [{ label: null, names: ['lib-a'] }], 'a lone library list is ungrouped, not wrapped in an empty optgroup');
  // ENTER: the same names DO group when the team owns them, so the assertion
  // above is about the ownership, not about the function returning one group.
  assert.strictEqual(promptOptionGroups(['lib-a'], ['lib-a'], 'shop')[0].label, 'Team shop');
});

test('promptOptionGroups: without a team name there is nothing to label a group with', () => {
  assert.deepStrictEqual(promptOptionGroups(['a'], ['a'], ''),
    [{ label: null, names: ['a'] }], 'the New Session flow passes no team; every stem is ungrouped');
});

test('storedPromptNote: an OFFERED prompt needs no extra option', () => {
  assert.strictEqual(storedPromptNote('p', { offered: ['p'], all: ['p'] }), null);
  assert.strictEqual(storedPromptNote('', { offered: [] }), null, 'no stored prompt, no note');
});

test('storedPromptNote: a team-owned stem is named plainly — neither warning is true of it', () => {
  const note = storedPromptNote('house-style', {
    offered: [], all: [], teamOwned: ['house-style'], team: 'shop',
  });
  assert.strictEqual(note.label, 'house-style',
    'no "(missing from library)" and no rail warning: the file is on disk and is what the seat reads');
  assert.match(note.title, /teams\/shop\/prompts\/system\/house-style\.md/,
    'the title names the file it resolves to, which is the fact the stem alone hides');
});

test('storedPromptNote: team-owned wins over the library-shaped verdicts', () => {
  // The same stem, off the rail and absent from `all`, WOULD read "missing from
  // library" — so this pins the precedence, not merely the wording.
  const asLibrary = storedPromptNote('house-style', { offered: [], all: [] });
  assert.match(asLibrary.label, /missing from library/, 'ENTER: without team ownership it is accused');
  const asTeam = storedPromptNote('house-style', { offered: [], all: [], teamOwned: ['house-style'], team: 'shop' });
  assert.ok(!/missing/.test(asTeam.label), 'ownership silences the accusation');
});

test('storedPromptNote: the three library verdicts are unchanged', () => {
  assert.match(storedPromptNote('p', { offered: [], all: [], listingOk: false }).title,
    /listing unavailable/, 'a failed listing accuses the prompt of nothing');
  assert.match(storedPromptNote('p', { offered: [], all: ['p'] }).label,
    /not an append-rail prompt/, 'present on disk but off the rail');
  assert.match(storedPromptNote('p', { offered: [], all: [] }).label,
    /missing from library/, 'absent from disk entirely');
});

// --- t792: the role template picker ------------------------------------------
const { templateOptionGroups, templateRowFor } = require('../renderer/lib/team-roles');

// One listing, every discriminator the real `templates:list` returns: library
// rows have neither `team` nor `plugin`, team rows carry `team`, plugin rows
// carry `plugin` and a `<plugin>:<stem>` name (see engine.js listAllTemplates).
const ROWS = [
  { name: 'clodex-team-hand', id: 'clodex-team-hand' },
  { name: 'fable-design', id: 'fable-design' },
  { name: 'hand', id: 'team:shop:hand', team: 'shop' },
  { name: 'lead', id: 'team:other:lead', team: 'other' },
  { name: 'rev:audit', id: 'rev:audit', plugin: 'rev' },
];

test('templateOptionGroups: (none) first, then Team / Library / Plugins in that order', () => {
  const groups = templateOptionGroups(ROWS, 'shop', '');
  assert.deepStrictEqual(groups.map((g) => g.label), [null, 'Team shop', 'Library', 'Plugins'],
    'the group order is the RESOLUTION order — a spawn for this team reads its own copy first');
  assert.deepStrictEqual(groups[0].options, [{ value: '', label: '(none)' }],
    'the empty option leads, so a role with no template has something selected');
  assert.deepStrictEqual(groups[1].options, [{ value: 'hand', label: 'hand' }],
    'the team group holds THIS team\'s row, labelled by the stem the role field stores');
  assert.deepStrictEqual(groups[2].options.map((o) => o.value), ['clodex-team-hand', 'fable-design'],
    'library rows are the ones with neither discriminator');
});

test('templateOptionGroups: another team\'s templates are not offered', () => {
  // The defect this closes: `lead` belongs to team `other` and naming it from
  // team `shop` stores a stem that resolves to the LIBRARY at spawn time, or to
  // nothing — the one wrong pick the field can make that still validates.
  const values = templateOptionGroups(ROWS, 'shop', '').flatMap((g) => g.options.map((o) => o.value));
  assert.ok(values.includes('hand'), 'ENTER: this team\'s own row IS offered, so the absence below is the filter');
  assert.ok(!values.includes('lead'), 'a row owned by another team must not appear');
});

test('templateOptionGroups: with no team, the Team group is absent — not empty', () => {
  const groups = templateOptionGroups(ROWS, '', '');
  assert.deepStrictEqual(groups.map((g) => g.label), [null, 'Library', 'Plugins'],
    'an unnamed team can own nothing, and an empty optgroup renders as a bare heading');
});

test('templateOptionGroups: plugin rows are listed but unselectable', () => {
  const plugins = templateOptionGroups(ROWS, 'shop', '').find((g) => g.label === 'Plugins');
  assert.deepStrictEqual(plugins.options, [{
    value: 'rev:audit',
    label: 'rev:audit',
    disabled: true,
    title: 'a plugin template cannot be a role template: '
      + 'the role field takes a plain name, and a plugin\'s is "<plugin>:<stem>"',
  }], 'setRole validates the template against NAME_RE, which has no colon — a role can never hold one');
});

test('templateOptionGroups: a stored stem the listing does not offer is synthesized (missing)', () => {
  const groups = templateOptionGroups(ROWS, 'shop', 'gone-away');
  const last = groups[groups.length - 1];
  assert.strictEqual(last.label, null, 'the synthesized option sits outside every group');
  assert.strictEqual(last.options.length, 1);
  assert.strictEqual(last.options[0].value, 'gone-away',
    'the VALUE is the stored stem verbatim: the select is what Save reads, so anything else rewrites the role');
  assert.strictEqual(last.options[0].label, 'gone-away (missing)');
  assert.match(last.options[0].title, /no template named "gone-away" is installed/);
});

test('templateOptionGroups: an OFFERED stored stem synthesizes nothing, in any group', () => {
  // ENTER for the test above: the synthesis is keyed on absence from the whole
  // listing, so each group has to be able to satisfy it.
  for (const stored of ['hand', 'fable-design', 'rev:audit', '']) {
    const groups = templateOptionGroups(ROWS, 'shop', stored);
    assert.ok(!groups.some((g) => g.options.some((o) => /\(missing\)/.test(o.label))),
      `"${stored}" is in the listing (or blank) and must not be accused of being missing`);
  }
});

test('templateOptionGroups: a failed or empty listing still carries the stored stem', () => {
  // The listing is one IPC call per open; a reject leaves `rows` empty. Dropping
  // the stored stem there would make the select read '' and Save omit a blank
  // template — the value survives on disk, but the operator is shown a role with
  // no template it never had.
  for (const rows of [[], null, undefined]) {
    const groups = templateOptionGroups(rows, 'shop', 'clodex-team-hand');
    assert.deepStrictEqual(groups.map((g) => g.label), [null, null], 'nothing to group, just (none) + the stem');
    assert.strictEqual(groups[1].options[0].value, 'clodex-team-hand');
  }
});

test('templateOptionGroups: a row without a usable name is skipped, not rendered blank', () => {
  const groups = templateOptionGroups([{ id: 'x' }, { name: '', id: 'y' }, { name: 'ok', id: 'ok' }], 'shop', '');
  assert.deepStrictEqual(groups.map((g) => g.label), [null, 'Library']);
  assert.deepStrictEqual(groups[1].options, [{ value: 'ok', label: 'ok' }],
    'an unnamed row would render as an empty option that stores an empty template');
});

test('templateRowFor: this team\'s row wins over the library copy it shadows', () => {
  // The CHANGELOG's promise is "Open the hand's template, set the model, save".
  // The library row comes FIRST in the listing (engine.js emits library, then
  // plugin, then team rows), so a name-only find opens the library copy — a file
  // no seat for this team reads, which is the silent edit t748 closed for the
  // drawer.
  const shadowed = [
    { name: 'hand', id: 'hand' },
    { name: 'hand', id: 'team:shop:hand', team: 'shop' },
  ];
  assert.strictEqual(templateRowFor(shadowed, 'shop', 'hand').id, 'team:shop:hand');
  // ENTER: the library row IS reachable by the same call for a team that does not
  // own the stem, so the assertion above is about precedence, not about the find.
  assert.strictEqual(templateRowFor(shadowed, 'other', 'hand').id, 'hand');
});

test('templateRowFor: another team\'s row is never the Open target', () => {
  // `lead` is owned by team `other`. Opening it from team `shop` would edit
  // another team's file from a popover that names neither it nor the team.
  assert.strictEqual(templateRowFor(ROWS, 'shop', 'lead'), null);
  assert.strictEqual(templateRowFor(ROWS, 'other', 'lead').id, 'team:other:lead',
    'ENTER: its OWN team reaches it, so the null above is the ownership check');
});

test('templateRowFor: the team\'s own row is found, and a library row still is', () => {
  assert.strictEqual(templateRowFor(ROWS, 'shop', 'hand').id, 'team:shop:hand');
  assert.strictEqual(templateRowFor(ROWS, 'shop', 'fable-design').id, 'fable-design');
});

test('templateRowFor: (none) opens nothing, even against a row named \'\'', () => {
  // `select.value` is '' for the (none) option, and a listing row with an empty
  // name would match it by equality — enabling Open on a selection that names no
  // template at all.
  const withBlank = [{ name: '', id: 'blank' }, ...ROWS];
  assert.strictEqual(templateRowFor(withBlank, 'shop', ''), null);
  assert.strictEqual(templateRowFor(withBlank, 'shop', null), null);
});

test('templateRowFor: a plugin row is never the Open target', () => {
  // Same reason it is unselectable in the picker: a role can never hold one, so
  // Open on it would edit a file this role does not read.
  assert.strictEqual(templateRowFor(ROWS, 'shop', 'rev:audit'), null);
  assert.strictEqual(templateRowFor([], 'shop', 'anything'), null, 'and an empty listing opens nothing');
  assert.strictEqual(templateRowFor(null, 'shop', 'anything'), null, 'as does a failed one');
});

test('t792 wiring: the row template field is a select the save path reads, and an Open beside it', () => {
  // The popover is DOM-bound and has no unit tests (its header says so), so this
  // pins the wire by shape. Each fact below, missing, leaves templateOptionGroups
  // perfectly correct and the feature broken.
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');
  const fn = /function buildTemplateControl\([\s\S]*?\n  \}/.exec(pop);
  assert.ok(fn, 'ENTER: found buildTemplateControl — a rename would reduce every assertion below to nothing');
  // CODE ONLY: every negative below is about what the control DOES, and the
  // comments in it name `data-act` and the attribute route precisely because
  // those are the traps — matching them would fail on the prose explaining them.
  const src = fn[0].split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  assert.match(src, /select\.dataset\.f = 'template'/,
    'the save path reads `[data-f="template"]`.value, so the select must carry the same hook the input did');
  assert.match(src, /templateOptionGroups\(templateRows, teamName\(\), stored\)/,
    'the options come from the helper, over the cached listing and THIS team');
  assert.ok(!/<input|type = 'text'/.test(src), 'no text input survives in the template control');
  // SECURITY: stems come from an agent-writable team.json and from template JSON
  // in this nodeIntegration renderer.
  assert.ok(!/innerHTML|setAttribute/.test(src),
    'stems must land as `.value`/`textContent` properties, never in an attribute');
  assert.match(src, /opt\.value = o\.value;/, 'option values by PROPERTY');
  assert.match(src, /opt\.textContent = o\.label;/, 'option labels by PROPERTY');

  assert.match(src, /open\.textContent = 'Open'/, 'the Open button is beside the select');
  assert.ok(!/open\.dataset\.act|data-act/.test(src),
    'Open must NOT carry data-act: the list delegation matches button[data-act] and would route it through the row switch');
  assert.match(src, /open\.disabled = !rowFor\(\)/,
    'Open is dead unless the selection names a row the editor can be seeded from');
  assert.match(src, /select\.addEventListener\('change', syncOpen\)/,
    'and it re-syncs on every change, or it stays dead after the first real pick');
  assert.match(src, /const rowFor = \(\) => templateRowFor\(templateRows, teamName\(\), select\.value\)/,
    'the Open target is resolved by the team-first helper, over THIS team — a name-only find '
    + 'over the raw listing opens another team\'s file, or the library copy of a stem this team shadows');
  assert.match(src, /closeTeamRolesPopover\(\);\n\s*if \(typeof openTemplate === 'function'\) openTemplate\(row\)/,
    'the click closes the popover and hands the ROW to the injected opener — no globals');
});

test('t792 wiring: the template listing is fetched once per open, and the field renders from it', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');

  const open = pop.slice(pop.indexOf('async function openTeamRolesPopover'));
  const openBody = open.slice(0, open.indexOf('\n  }\n'));
  assert.match(openBody, /await populateTemplateOptions\(\)/,
    'the listing is fetched on OPEN — renderRows runs again per disclose and after every mutation');
  const rows = pop.slice(pop.indexOf('function renderRows'));
  assert.ok(!/window\.api\.listTemplates/.test(rows.slice(0, rows.indexOf('\n  }\n'))),
    'and never from renderRows, which would be one IPC round trip per repaint');

  const reveal = /function renderRevealedFields\([\s\S]*?\n  \}/.exec(pop);
  assert.ok(reveal, 'ENTER: found renderRevealedFields');
  assert.match(reveal[0], /buildTemplateControl\(stored\)/, 'the revealed template field is the picker');

  // The rebuild path: `template` is no longer an <input>, so a selector that
  // still says `input[data-f=…]` reads '' for it and a dispatch change silently
  // reverts an unsaved pick.
  const live = /const liveValues = \(\) => \{[\s\S]*?\n {8}\};/.exec(pop);
  assert.ok(live, 'ENTER: found the live-values reader the rebuild seeds from');
  assert.ok(!/input\[data-f/.test(live[0]),
    'the reader must match on data-f alone — an `input[…]` selector cannot see the template select');
});

test('t792 wiring: the Open routes a team row to the drawer\'s own team opener', () => {
  // The team branch is the one that needs the third argument (`{ team }`), and
  // getting it wrong opens the LIBRARY copy of the same stem — an edit to a file
  // no spawn for this team reads, which is the silent failure t748 closed for the
  // drawer. renderer.js must reuse the drawer's opener rather than grow a copy.
  const rj = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf-8');
  const wire = /const \{ openTeamRolesPopover \} = initTeamRolesPopover\(\{[\s\S]*?\n\}\);/.exec(rj);
  assert.ok(wire, 'ENTER: found the popover construction — a rename would vacuum out this test');
  assert.match(wire[0], /if \(row\.team\) \{\n\s*if \(templatesDrawerOpenTeam\) templatesDrawerOpenTeam\(row\);/,
    'a team row goes to the drawer\'s openTeamTemplate, which passes the team owner');
  assert.match(wire[0], /openTemplateEditor\(row\)/, 'a library row goes straight to the editor');

  const drawers = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'library-drawers.js'), 'utf-8');
  assert.match(drawers, /return \{ refreshTemplatesList, openTeamTemplate \};/,
    'and the drawer EXPORTS it — a second copy of the team-owner argument would drift from this one');
  assert.match(drawers, /openTemplateEditor\(tpl, null, \{ team: tpl\.team \}\)/,
    'ENTER: that opener is the one carrying the team owner, which is why it is shared rather than re-written');
  assert.match(rj, /openTeamTemplate: templatesDrawerOpenTeam \} = initLibraryDrawers\(/,
    'renderer.js binds the export it calls');
  // ORDER: initLibraryDrawers runs far below the popover construction, so the
  // opener must be read from the binding at CLICK time. Destructuring it into the
  // deps object instead would capture null and make every Open a no-op.
  assert.ok(rj.indexOf('initTeamRolesPopover({') < rj.indexOf('} = initLibraryDrawers('),
    'ENTER: the drawer is initialised AFTER the popover, which is why the opener is read late');
  assert.match(wire[0], /openTemplate: \(row\) => \{/,
    'the dep is a function reading the binding, not the binding\'s value at construction time');
});

// ── the reserved row's template control ─────────────────────────────────────
// The three tests above pin string RESOLUTION only. A cold review deleted BOTH
// added pieces from the popover's read-only arm — the `data-field="template"`
// markup line and the whole holder/val/tplRow/open block — and 253 tests stayed
// green: the operator-visible name, the Open button and its disabled state could
// all be removed in silence. These are the source-shape pins that mirror the ones
// t792 shipped for the IDENTICAL control on the editable row.
const reservedTemplateControl = () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'popovers', 'team-roles-popover.js'), 'utf-8');
  const from = pop.indexOf('if (row.readOnly) {');
  assert.ok(from > 0, 'ENTER: found the read-only arm — a rename would reduce every assertion below to nothing');
  const to = pop.indexOf('holder.appendChild(open);', from);
  assert.ok(to > from, 'ENTER: the arm still ends by appending the Open button');
  const arm = pop.slice(from, to + 'holder.appendChild(open);'.length);
  const blockFrom = arm.indexOf('const holder = body.querySelector');
  assert.ok(blockFrom > 0, 'ENTER: found the control block inside that arm');
  // CODE ONLY for the block: the negatives below are about what it DOES, and the
  // comments around it name `data-act` and attributes precisely because those are
  // the traps — matching them would fail on the prose explaining them.
  const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return { arm: strip(arm), block: strip(arm.slice(blockFrom)) };
};

test('t888 wiring: the reserved row shows the template name it resolves, in a field the block can find', () => {
  const { arm, block } = reservedTemplateControl();

  assert.match(arm, /<div class="team-role-ro-field" data-field="template"><span>template<\/span><\/div>/,
    'the read-only markup carries the template field — without it there is no row for the name to land in');
  assert.match(block, /const holder = body\.querySelector\('\.team-role-ro-field\[data-field="template"\]'\)/,
    'and the block fills THAT field: the markup hook and the query are one fact, so they move together');

  assert.match(block, /reservedRoleTemplate\(row\.key, row\.template\)/,
    'the name is resolved stored-first by the helper, not read raw — a team that set its own '
    + 'reviewer template must see THAT stem, not the stock one its seats do not boot on');
  // SECURITY: `row.template` comes from an agent-writable team.json, in this
  // nodeIntegration renderer.
  assert.match(block, /val\.textContent = name \|\| '—';/,
    'the stem lands as textContent, and an unresolvable one renders the dash rather than blank');
  assert.ok(!/innerHTML|setAttribute/.test(block),
    'the stem must never reach an attribute, where a `" onfocus="` payload would break out');
});

test('t888 wiring: reserved Open is team-first, dead on an unresolvable stem, and outside the click delegation', () => {
  const { block } = reservedTemplateControl();

  assert.match(block, /const tplRow = name \? templateRowFor\(templateRows, teamName\(\), name\) : null;/,
    'the Open target is resolved by the team-first helper over THIS team — a name-only find over the '
    + 'raw listing opens another team\'s file, or the library copy of a stem this team shadows');
  assert.match(block, /open\.textContent = 'Open';/, 'the Open button is beside the name');
  assert.match(block, /open\.disabled = !tplRow;/,
    'Open is dead unless the resolved stem names a row the editor can be seeded from');
  assert.match(block, /if \(!tplRow\) return;\n\s*closeTeamRolesPopover\(\);\n\s*if \(typeof openTemplate === 'function'\) openTemplate\(tplRow\);/,
    'the click re-checks the target, closes the popover and hands the ROW to the injected opener — no globals');

  // THE LOCK: this is the one assertion here that guards more than wiring. The
  // row-scoped list delegation matches `button[data-act]` and routes what it
  // finds through the switch that reaches role-def writes. A reserved row's
  // definition is locked; a `data-act` on this button would put a door into that
  // path on exactly the row whose whole point is that it has none.
  assert.ok(!/dataset\.act|data-act/.test(block),
    'the reserved Open must NOT carry data-act: it would join the delegation that reaches role-def writes');
});
