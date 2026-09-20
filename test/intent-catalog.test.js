'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { GATEABLE_INTENTS, GATEABLE_TYPES, PRIVILEGED_INTENTS, LEGACY_INTENT_KEYS, canonicalIntentKey, intentEnabled, intentsAllowlistFromChecked, withoutPrivilegedIntents, deniedIntentCount } = require('../intent-catalog');

const ALL_TYPES = GATEABLE_INTENTS.map((i) => i.type);
// The ordinary (non-privileged) types — what "absent = all-enabled" covers, and
// what collapses back to null when every one is checked.
const NONPRIV_TYPES = GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).map((i) => i.type);

test('catalog: the 14 gateable types in grammar order (privileged last), name excluded', () => {
  assert.deepStrictEqual(
    GATEABLE_INTENTS.map((i) => i.type),
    ['dm', 'who', 'context', 'scratch', 'memory', 'spawn', 'file', 'resend', 'exec', 'remind', 'shout', 'term', 'reboot', 'team-create'],
  );
  // The privileged set, and the reason it is worth naming all three: `term`
  // runs arbitrary shell in the operator's own login shell, so a seat
  // deliberately given no shell tool would acquire one through it; `team-create`
  // writes a manifest under ~/.clodex/teams that binds a project root and a lead
  // seat name. Membership here is what makes withoutPrivilegedIntents strip them
  // at the mint/wire boundary — non-privileged, either could be granted by a
  // spawn template or a peer, i.e. by an agent rather than by the operator.
  assert.deepStrictEqual([...PRIVILEGED_INTENTS], ['reboot', 'term', 'team-create']);
  assert.strictEqual(GATEABLE_TYPES.has('reboot'), true);
  assert.strictEqual(GATEABLE_TYPES.has('term'), true);
  assert.strictEqual(GATEABLE_TYPES.has('team-create'), true);
  // Identity is never gateable.
  assert.strictEqual(GATEABLE_TYPES.has('name'), false);
  // Every catalog row has a non-empty label for the checklist.
  for (const i of GATEABLE_INTENTS) assert.ok(i.label && typeof i.label === 'string');
  // GATEABLE_TYPES is the type set of the ordered list.
  assert.strictEqual(GATEABLE_TYPES.size, GATEABLE_INTENTS.length);
});

test('intentEnabled: absent list → ordinary intents enabled, PRIVILEGED off (Task 27)', () => {
  for (const list of [undefined, null, 'not-an-array', 42, {}]) {
    assert.strictEqual(intentEnabled('dm', list), true);
    assert.strictEqual(intentEnabled('exec', list), true);
    assert.strictEqual(intentEnabled('shout', list), true);
    // reboot does NOT ride the all-enabled default — it must be granted explicitly.
    assert.strictEqual(intentEnabled('reboot', list), false);
  }
});

test('intentEnabled: a privileged intent fires only when explicitly listed', () => {
  // team-create alongside reboot: the inversion has to hold for EVERY member of
  // the set, and a per-verb assertion is what catches a member added to
  // GATEABLE_INTENTS but forgotten in PRIVILEGED_INTENTS — which reads as an
  // ordinary verb and rides the all-enabled default onto every existing seat.
  for (const t of PRIVILEGED_INTENTS) {
    assert.strictEqual(intentEnabled(t, null), false, `${t} must not ride the absent-list default`);
    assert.strictEqual(intentEnabled(t, []), false, `${t} is off under "everything gated"`);
    assert.strictEqual(intentEnabled(t, [t]), true, `${t} fires when explicitly granted`);
    assert.strictEqual(intentEnabled(t, ['dm', 'who']), false, `${t} is not granted by granting others`);
  }
  assert.strictEqual(intentEnabled('reboot', ['reboot']), true);
  assert.strictEqual(intentEnabled('reboot', ['dm', 'reboot']), true);
  assert.strictEqual(intentEnabled('reboot', ['dm', 'who']), false); // granted others, not reboot
  assert.strictEqual(intentEnabled('reboot', []), false);
});

test('t1037: scratch is gateable and ORDINARY — it rides the all-enabled default like context', () => {
  assert.strictEqual(GATEABLE_TYPES.has('scratch'), true);
  assert.strictEqual(PRIVILEGED_INTENTS.has('scratch'), false,
    'scratch recycles the seat\'s own process and truncates its transcript, which READS like a privileged '
    + 'capability. It is deliberately not one, for the same reason context reload is not: the blast radius is '
    + 'this seat\'s own context, and privileged means "an agent could otherwise mint it for a PEER it spawns". '
    + 'Asserted here rather than left to the ordered list above, which is edited in bulk — a scratch quietly '
    + 'added to PRIVILEGED_INTENTS would turn the verb off for every existing seat with no signal');
  assert.strictEqual(intentEnabled('scratch', null), true, 'a seat with no allowlist has it, exactly as it has context');
  assert.strictEqual(intentEnabled('scratch', []), false, '"everything gated" gates it too');
  assert.strictEqual(intentEnabled('scratch', ['scratch']), true);
  assert.strictEqual(intentEnabled('scratch', ['dm', 'context']), false, 'granting context does not grant it');
  assert.deepStrictEqual(withoutPrivilegedIntents(['dm', 'scratch']), ['dm', 'scratch'],
    'so a spawn template or a peer may grant it — that is what ordinary means here');
  const idx = GATEABLE_INTENTS.findIndex((i) => i.type === 'scratch');
  assert.strictEqual(GATEABLE_INTENTS[idx - 1].type, 'context',
    'it sits after context: catalog order is checklist order, and the two verbs that recycle a seat belong together');
});

test('withoutPrivilegedIntents: strips privileged from an array, passes non-arrays through', () => {
  assert.deepStrictEqual(withoutPrivilegedIntents(['dm', 'reboot', 'who']), ['dm', 'who']);
  assert.deepStrictEqual(withoutPrivilegedIntents(['dm', 'team-create', 'who']), ['dm', 'who']);
  assert.deepStrictEqual(withoutPrivilegedIntents(['reboot']), []); // privileged-only → everything gated
  assert.deepStrictEqual(withoutPrivilegedIntents(['dm', 'who']), ['dm', 'who']); // nothing to strip
  assert.deepStrictEqual(withoutPrivilegedIntents([]), []);
  // null/undefined (the all-enabled default) pass through untouched — the default
  // already excludes privileged via intentEnabled, so there's nothing to strip.
  assert.strictEqual(withoutPrivilegedIntents(null), null);
  assert.strictEqual(withoutPrivilegedIntents(undefined), undefined);
});

test('intentEnabled: present list → membership for gateable types', () => {
  const list = ['dm', 'exec', 'remind']; // a trader seat
  assert.strictEqual(intentEnabled('dm', list), true);
  assert.strictEqual(intentEnabled('exec', list), true);
  assert.strictEqual(intentEnabled('remind', list), true);
  assert.strictEqual(intentEnabled('who', list), false);
  assert.strictEqual(intentEnabled('spawn', list), false);
  assert.strictEqual(intentEnabled('shout', list), false);
});

test('intentEnabled: empty array is a real value → everything gated', () => {
  assert.strictEqual(intentEnabled('dm', []), false);
  assert.strictEqual(intentEnabled('exec', []), false);
  // …but name / non-gateable verbs survive even an empty list.
  assert.strictEqual(intentEnabled('name', []), true);
});

test('intentEnabled: name + non-gateable verbs are always enabled, list or not', () => {
  // name is identity — never gateable, regardless of the list.
  assert.strictEqual(intentEnabled('name', ['dm']), true);
  assert.strictEqual(intentEnabled('name', []), true);
  assert.strictEqual(intentEnabled('name', undefined), true);
  // A parsed-but-uncatalogued verb (e.g. a future non-gateable one) is enabled
  // even when a restrictive list is present — ungateable by omission.
  assert.strictEqual(intentEnabled('escape', ['dm']), true);
  assert.strictEqual(intentEnabled('peers', []), true);
});

test('intentsAllowlistFromChecked: every NON-privileged box checked (reboot off) → null', () => {
  // The all-enabled default persists as ABSENCE, never a frozen array — so a future
  // ordinary intent lights up in this seat by default. reboot unchecked is what
  // absence already means, so this is the collapse-to-null case. Order-independent.
  assert.strictEqual(intentsAllowlistFromChecked(NONPRIV_TYPES), null);
  assert.strictEqual(intentsAllowlistFromChecked(NONPRIV_TYPES.slice().reverse()), null);
});

test('intentsAllowlistFromChecked: a privileged grant forces an explicit array (no null collapse)', () => {
  // Checking EVERY box including reboot can't collapse to null — absence reads as
  // "reboot off", so null would silently drop the grant. GUI grant honored.
  const r = intentsAllowlistFromChecked(ALL_TYPES);
  assert.ok(Array.isArray(r));
  assert.ok(r.includes('reboot'), 'the reboot grant survives collection');
  assert.ok(r.includes('team-create'), 'and so does the team-create grant');
  assert.deepStrictEqual(r, ALL_TYPES); // catalog order, reboot last
});

test('intentsAllowlistFromChecked: a subset → the enabled list in CATALOG order', () => {
  // A trader seat, checked out of order in the DOM — normalized to catalog order.
  assert.deepStrictEqual(
    intentsAllowlistFromChecked(['remind', 'exec', 'dm']),
    ['dm', 'exec', 'remind'],
  );
});

test('intentsAllowlistFromChecked: nothing checked → [] (a real "everything gated" value)', () => {
  const r = intentsAllowlistFromChecked([]);
  assert.ok(Array.isArray(r));
  assert.strictEqual(r.length, 0);
});

test('deniedIntentCount: absent/null allowlist → 0 (the living all-enabled default)', () => {
  assert.strictEqual(deniedIntentCount(null), 0);
  assert.strictEqual(deniedIntentCount(undefined), 0);
  assert.strictEqual(deniedIntentCount('not-an-array'), 0);
});

test('deniedIntentCount: [] → every NON-privileged intent denied (privileged excluded)', () => {
  // reboot is off-by-default, so it's never counted as "removed" — the chip tallies
  // only the ordinary intents the operator actually gated.
  assert.strictEqual(deniedIntentCount([]), NONPRIV_TYPES.length);
});

test('deniedIntentCount: a subset → the complement count over non-privileged intents', () => {
  // Two ordinary allowed → the rest of the ordinary set denied (reboot never counts).
  assert.strictEqual(deniedIntentCount(['dm', 'who']), NONPRIV_TYPES.length - 2);
  // Every ordinary intent allowed (reboot off) → 0, the default posture.
  assert.strictEqual(deniedIntentCount(NONPRIV_TYPES), 0);
  // Granting reboot on top doesn't add a restriction.
  assert.strictEqual(deniedIntentCount(ALL_TYPES), 0);
});

test('deniedIntentCount: a privileged grant is not a restriction (never lights the chip)', () => {
  // A seat that ONLY has reboot granted has every ordinary intent gated — the count
  // is the ordinary set minus none, and reboot itself is excluded from the tally.
  assert.strictEqual(deniedIntentCount(['reboot']), NONPRIV_TYPES.length);
});

test('deniedIntentCount: strays in the list do not offset the denied count', () => {
  // A bogus/non-gateable entry can never mark a real intent enabled, so it can't
  // shrink the denied count — only catalog membership counts.
  assert.strictEqual(deniedIntentCount(['dm', 'name', 'bogus']), NONPRIV_TYPES.length - 1);
});

test('intentsAllowlistFromChecked: stray/non-gateable values are dropped, not counted', () => {
  // A stray `name` (never a checklist row) or an unknown token can't inflate the
  // count to "all" nor leak into the stored list — only catalog types survive.
  assert.deepStrictEqual(
    intentsAllowlistFromChecked([...NONPRIV_TYPES, 'name', 'bogus']),
    null, // the ordinary ones all present, reboot off → still the all-enabled default
  );
  assert.deepStrictEqual(
    intentsAllowlistFromChecked(['dm', 'name', 'bogus']),
    ['dm'], // strays dropped
  );
});

test('intentEnabled: a stored allowlist still spelling notify-user can still shout', () => {
  const legacy = ['dm', 'who', 'notify-user', 'exec'];
  assert.strictEqual(intentEnabled('shout', legacy), true,
    'every seat and team template gated before the t1016 flag day holds the RETIRED spelling; '
    + 'pure membership would strip the inbox channel from all of them, since this one predicate '
    + 'decides the grammar row, the spill arming and the fire-time gate alike');
  assert.strictEqual(intentEnabled('shout', ['notify-user']), true);
  assert.strictEqual(intentEnabled('spawn', legacy), false,
    'the migration is on STORED CAPABILITY DATA only — a legacy entry grants that one verb, not a wildcard');
  assert.strictEqual(intentEnabled('shout', ['dm', 'who']), false);
  assert.strictEqual(intentEnabled('shout', []), false);
  assert.strictEqual(GATEABLE_TYPES.has('notify-user'), false,
    'the retired spelling never became a second real catalog key — it is not an alias, and '
    + '[agent:notify-user] still fails to parse');
  assert.deepStrictEqual([...LEGACY_INTENT_KEYS], [['notify-user', 'shout']]);
  assert.strictEqual(canonicalIntentKey('notify-user'), 'shout');
  assert.strictEqual(canonicalIntentKey('dm'), 'dm');
});

test('deniedIntentCount: a legacy notify-user entry counts as the shout grant, not a denial', () => {
  assert.strictEqual(
    deniedIntentCount(NONPRIV_TYPES.map((t) => (t === 'shout' ? 'notify-user' : t))),
    0,
    'otherwise the templates chip shows a phantom lock on every pre-flag-day seat and the operator repairs a gate nobody set',
  );
});

test('intentsAllowlistFromChecked: the retired spelling is NOT re-persisted on save', () => {
  assert.deepStrictEqual(intentsAllowlistFromChecked(['dm', 'notify-user']), ['dm'],
    'the checklist collects catalog types, so a stray legacy token drops like any other stray — '
    + 'an edit-save is what finally rewrites the stored list to the new key');
});
