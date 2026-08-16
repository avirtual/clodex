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
  assert.deepStrictEqual(rows[2], { key: 'runner', brief: 'runs things', prompt: 'p', template: 'fable-lead', dispatch: 'worktree', readOnly: false });
  // `dispatch` normalizes to 'standing', NOT to '': absent IS standing on disk,
  // and a blank would leave the row's picker with no selected option, which
  // buildSavePatch then drops — a Save that silently declines to save.
  assert.deepStrictEqual(rows[3], { key: 'bare', brief: '', prompt: '', template: '', dispatch: 'standing', readOnly: false });
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
  assert.deepStrictEqual(p, { brief: 'b', prompt: 'p' });
  assert.ok(!('template' in p), 'blank template omitted, not sent as ""/null');
  // A non-blank template is included; all values trimmed.
  assert.deepStrictEqual(
    buildSavePatch({ brief: '  b  ', prompt: '  p  ', template: '  fable-lead  ' }),
    { brief: 'b', prompt: 'p', template: 'fable-lead' },
  );
  // Blank brief/prompt ARE sent (backend stores '' — a legitimate clear); missing
  // form values normalize to '' without throwing.
  assert.deepStrictEqual(buildSavePatch({ brief: '', prompt: '', template: '' }), { brief: '', prompt: '' });
  assert.deepStrictEqual(buildSavePatch({}), { brief: '', prompt: '' });
});

test('buildSavePatch: sends `dispatch` for BOTH enum values, drops an off-enum one', () => {
  // `standing` must be sent, not treated as a blank-and-omit like `template`:
  // the picker has no empty state, so omitting the default would make
  // worktree → standing unreachable from the only door that can undo it.
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: 'standing' }),
    { brief: 'b', prompt: 'p', dispatch: 'standing' },
  );
  assert.deepStrictEqual(
    buildSavePatch({ brief: 'b', prompt: 'p', dispatch: '  worktree  ' }),
    { brief: 'b', prompt: 'p', dispatch: 'worktree' },
    'trimmed like every other value',
  );
  // A value the backend would throw on is dropped rather than forwarded — the
  // throw would take the brief/prompt edits sent alongside it down too.
  for (const bad of ['', 'sometimes', undefined]) {
    const p = buildSavePatch({ brief: 'b', prompt: 'p', dispatch: bad });
    assert.ok(!('dispatch' in p), `off-enum dispatch ${JSON.stringify(bad)} is omitted`);
    assert.deepStrictEqual(p, { brief: 'b', prompt: 'p' }, 'and the rest of the patch is unharmed');
  }
});

test('reservedRoleNote: newcomer-facing lock reason for lead/reviewer, safe generic otherwise', () => {
  assert.match(reservedRoleNote('lead'), /Runs the team/);
  assert.match(reservedRoleNote('reviewer'), /Independently checks the lead's work/);
  // Any other (no other reserved key today) → a safe generic, never empty.
  assert.match(reservedRoleNote('whatever'), /Managed by Clodex/);
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

test('leadSeatCandidates: agent seats under the team root, in order; a BASH seat is never eligible', () => {
  const sessions = [
    { name: 'shop-lead', type: 'claude', cwd: '/proj/shop' },
    { name: 'shop-shell', type: 'bash', cwd: '/proj/shop' },       // private: no registry, no socket
    { name: 'shop-codex', type: 'codex', cwd: '/proj/shop/api' },  // containment, not equality
    { name: 'other', type: 'claude', cwd: '/proj/shop-other' },    // sibling, NOT a descendant
    { name: 'elsewhere', type: 'claude', cwd: '/tmp' },
    { name: 'gone', type: 'claude', cwd: '/proj/shop', archivedAt: 123 },
  ];
  // ENTER: the two rows this filter is FOR must be in the input, or the
  // assertions below are true of a set that never contained them — the bash
  // exclusion in particular would "pass" against a list with no bash row at all.
  assert.ok(sessions.some((s) => s.type === 'bash' && s.cwd === '/proj/shop'),
    'ENTER: a bash session inside the team root must be in the input');
  assert.ok(sessions.some((s) => s.archivedAt), 'ENTER: an archived seat must be in the input');

  assert.deepStrictEqual(leadSeatCandidates(sessions, '/proj/shop'), ['shop-lead', 'shop-codex'],
    'agent types under the root only, input order preserved');
  // The sibling-path case gets its own assertion: `/proj/shop-other` starts with
  // the root as a STRING, and a prefix test without the separator boundary would
  // hand another project's seat to this team.
  assert.strictEqual(leadSeatCandidates(sessions, '/proj/shop').includes('other'), false,
    'a sibling directory sharing the root as a string prefix is not inside it');
  // A trailing slash on the root must not change the answer.
  assert.deepStrictEqual(leadSeatCandidates(sessions, '/proj/shop/'), ['shop-lead', 'shop-codex']);
  // The bash-only root: empty, which is what makes the popover's empty state the
  // thing the operator reads (the crypto-app case).
  assert.deepStrictEqual(leadSeatCandidates([{ name: 'crypto-bash', type: 'bash', cwd: '/proj/crypto' }], '/proj/crypto'), []);
  // Degenerate inputs never throw.
  assert.deepStrictEqual(leadSeatCandidates(null, '/proj/shop'), []);
  assert.deepStrictEqual(leadSeatCandidates(sessions, ''), [], 'no root → nothing is knowably inside it');
  assert.deepStrictEqual(leadSeatCandidates([{ type: 'claude', cwd: '/proj/shop' }], '/proj/shop'), [], 'a nameless row is not a seat');
});

test('leadResolution: live / stopped / missing are three distinct states', () => {
  const live = ['shop-lead'];
  const known = ['shop-lead', 'shop-old-lead'];
  assert.deepStrictEqual(leadResolution('shop-lead', { live, known }),
    { state: 'live', name: 'shop-lead', note: 'running now' });
  // STOPPED IS NOT BROKEN: it has a record and restarts by name. The whole point
  // of splitting this from `missing` is that the popover must not cry wolf here.
  assert.deepStrictEqual(leadResolution('shop-old-lead', { live, known }),
    { state: 'stopped', name: 'shop-old-lead', note: 'not running — it restarts under this name' });
  // MISSING: the crypto-app orphan — no session, live or persisted, ever.
  const missing = leadResolution('crypto-app-lead', { live, known });
  assert.strictEqual(missing.state, 'missing');
  assert.strictEqual(missing.name, 'crypto-app-lead');
  assert.match(missing.note, /no session by this name exists/);
  // No pointer at all.
  assert.strictEqual(leadResolution('', { live, known }).state, 'unset');
  assert.strictEqual(leadResolution(null, { live, known }).state, 'unset');
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
