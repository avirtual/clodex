// Run: node --test
// Pure helpers for the team-management popover (T29 Layer A Slice 3). The popover
// DOM is untested (imperative wiring); these three side-effect-free helpers hold
// the logic worth pinning — row-model from a manifest, add-role client validation,
// and the C5 block → inline message.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  teamRoleRows, validateAddRole, buildSavePatch, reservedRoleNote,
  parseDuration, formatDuration, formatBlockedBy,
  leadSeatCandidates, leadResolution,
  absentReservedRoles, reservedRemovalWarning, absentReservedNote,
  REMOVABLE_RESERVED_ROLE_KEYS,
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

test('absentReservedRoles: names a removed reviewer, and nothing when the team has one', () => {
  // The add-it-back affordance's whole input. A team with no reviewer row at all
  // is how this orphan state stayed invisible.
  assert.deepStrictEqual(absentReservedRoles({ roles: { lead: {}, hand: {} } }), ['reviewer']);
  assert.deepStrictEqual(absentReservedRoles({ roles: { lead: {}, reviewer: {} } }), [],
    'a team WITH a reviewer gets no synthetic row — it already has a real one');
  // A lead-less manifest never reaches the popover (loadManifest throws first),
  // but the helper must not invent a `lead` row for one: it is not removable, so
  // it can never be re-added from here either.
  assert.deepStrictEqual(absentReservedRoles({ roles: {} }), ['reviewer']);
  assert.deepStrictEqual(absentReservedRoles(null), ['reviewer'], 'no manifest → no throw');
});

test('absentReservedRoles rows are NOT in teamRoleRows — the schema-pinned model stays manifest-only', () => {
  // The legibility test reads teamRoleRows' keys as the schema fields a row can
  // display, and every caller relies on "one row per role in the manifest". A
  // synthetic absent-role row folded in there would break both at once, silently.
  const manifest = { roles: { lead: {}, hand: {} } };
  assert.deepStrictEqual(teamRoleRows(manifest).map((r) => r.key), ['lead', 'hand'],
    'the row model still describes exactly what is on disk');
  assert.deepStrictEqual(absentReservedRoles(manifest), ['reviewer'],
    'and the absent one is reported separately');
});

test('reservedRemovalWarning / absentReservedNote say what is LOST, not merely what changed', () => {
  // Removal is destructive, one click away, and its only other symptom arrives a
  // ticket later at the review step — so the confirm has to carry the consequence.
  assert.match(reservedRemovalWarning('reviewer'), /escalate to you at the review step/);
  assert.match(absentReservedNote('reviewer'), /escalate to the lead at the review step/);
  // An unknown key still gets a safe, non-empty line rather than undefined text.
  assert.ok(reservedRemovalWarning('mystery').length > 0);
  assert.ok(absentReservedNote('mystery').length > 0);
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
