// Run: node --test
// Pins the hub-relay wire-format commitments (relay-protocol.js) — the two shapes
// clodex blessed. These are bytes-on-the-wire contracts: a change here is a
// protocol change, so the test is deliberately strict about field presence AND
// absence (the terminal-leg strip is a loop-prevention FEATURE, not incidental).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  RELAY_ENVELOPE_V, RELAY_MAX_HOPS,
  relayVersionOk, isQualifiedSender, isRelayEnvelope,
  buildRelayEnvelope, hopRule, buildTerminalDm, computeRosterFor,
} = require('../relay-protocol');

test('constants are the committed values', () => {
  assert.strictEqual(RELAY_ENVELOPE_V, 1);
  assert.strictEqual(RELAY_MAX_HOPS, 1);
});

test('relayVersionOk: absent or <= known passes, newer is rejected (forward guard)', () => {
  assert.strictEqual(relayVersionOk(undefined), true); // pre-relay peer never set it
  assert.strictEqual(relayVersionOk(null), true);
  assert.strictEqual(relayVersionOk(1), true);
  assert.strictEqual(relayVersionOk(2), false);        // a future shape we can't parse
  assert.strictEqual(relayVersionOk('1'), false);      // non-integer is not a version
});

test('isRelayEnvelope: finalTarget is the sole discriminator', () => {
  assert.strictEqual(isRelayEnvelope({ finalTarget: 'worker@remote-linux' }), true);
  assert.strictEqual(isRelayEnvelope({ to: 'worker' }), false);   // plain direct DM
  assert.strictEqual(isRelayEnvelope({ finalTarget: '' }), false);
  assert.strictEqual(isRelayEnvelope(null), false);
  assert.strictEqual(isRelayEnvelope(undefined), false);
});

test('buildRelayEnvelope: carries rv + finalTarget + hops, seeds hops at the ceiling', () => {
  const e = buildRelayEnvelope({
    to: 'worker', finalTarget: 'worker@remote-linux',
    from: 'agent@docker', origin: 'hub', body: 'hi', urgent: true,
  });
  assert.deepStrictEqual(e, {
    rv: 1, to: 'worker', finalTarget: 'worker@remote-linux',
    from: 'agent@docker', origin: 'hub', body: 'hi', urgent: true, hops: 1,
  });
});

test('hopRule: 1 relays (decrement to 0), 0 drops, malformed drops', () => {
  assert.deepStrictEqual(hopRule(1), { relay: true, hops: 0 });
  assert.deepStrictEqual(hopRule(0), { relay: false, hops: 0 });
  assert.deepStrictEqual(hopRule(-3), { relay: false, hops: 0 });
  assert.deepStrictEqual(hopRule(undefined), { relay: false, hops: 0 });
  assert.deepStrictEqual(hopRule(2), { relay: true, hops: 1 }); // headroom, future intermediate hop
});

test('isQualifiedSender: bare name or one name@origin, both name-charset', () => {
  assert.strictEqual(isQualifiedSender('agent'), true);              // bare local
  assert.strictEqual(isQualifiedSender('agent@docker'), true);      // qualified (relay leg)
  assert.strictEqual(isQualifiedSender('a.b-c_1@remote-linux'), true);
  assert.strictEqual(isQualifiedSender('agent@a@b'), false);        // double-qualified — reject
  assert.strictEqual(isQualifiedSender('@docker'), false);          // empty name
  assert.strictEqual(isQualifiedSender('agent@'), false);           // empty origin
  assert.strictEqual(isQualifiedSender('bad name'), false);         // space
  assert.strictEqual(isQualifiedSender(''), false);
  assert.strictEqual(isQualifiedSender(null), false);
});

test('computeRosterFor: symmetric gate + split-horizon + liveness + type filter', () => {
  const statuses = [
    { id: 'hub', label: 'hub', online: true, caps: ['dm', 'relay'], sessions: [{ name: 'clodex', type: 'claude' }] },
    { id: 'rl', label: 'remote-linux', online: true, caps: ['dm'], sessions: [{ name: 'worker', type: 'claude' }, { name: 'ci', type: 'codex' }, { name: 'sh', type: 'bash' }] },
    { id: 'dk', label: 'docker', online: true, caps: ['dm'], sessions: [{ name: 'd1', type: 'claude' }] },
    { id: 'off', label: 'sleepy', online: false, caps: ['dm'], sessions: [{ name: 'z', type: 'claude' }] },
  ];
  const allowed = new Set(['dk', 'rl']); // hub + sleepy NOT allowed

  // docker (allowed) sees remote-linux's claude+codex (allowed), NOT bash, NOT
  // hub (not allowed), NOT sleepy (offline+not allowed), NOT its own d1 (split-horizon).
  assert.deepStrictEqual(
    computeRosterFor('dk', statuses, allowed),
    [{ name: 'worker', origin: 'remote-linux', type: 'claude' }, { name: 'ci', origin: 'remote-linux', type: 'codex' }],
  );
  // remote-linux (allowed) sees docker's d1, not its own agents.
  assert.deepStrictEqual(
    computeRosterFor('rl', statuses, allowed),
    [{ name: 'd1', origin: 'docker', type: 'claude' }],
  );
  // hub is not relayAllowed → empty roster (not in the mesh).
  assert.deepStrictEqual(computeRosterFor('hub', statuses, allowed), []);
  // A target not in the allowed set at all → empty.
  assert.deepStrictEqual(computeRosterFor('off', statuses, allowed), []);
});

const LOCAL_STATUSES = [
  { id: 'dk', label: 'docker', online: true, caps: ['dm'], sessions: [{ name: 'd1', type: 'claude' }] },
  { id: 'rl', label: 'remote-linux', online: true, caps: ['dm'], sessions: [{ name: 'worker', type: 'claude' }] },
];
const LOCAL_SESSIONS = [
  { name: 'clodex', type: 'claude' },
  { name: 'Codex', type: 'codex' },
  { name: 'shell', type: 'bash' },
];

test('computeRosterFor: the hub\'s OWN agents reach an allowed spoke, under its own label', () => {
  const allowed = new Set(['dk', 'rl']);
  const roster = computeRosterFor('dk', LOCAL_STATUSES, allowed, LOCAL_SESSIONS, 'hub');
  assert.deepStrictEqual(roster, [
    { name: 'worker', origin: 'remote-linux', type: 'claude' },
    { name: 'clodex', origin: 'hub', type: 'claude' },
    { name: 'Codex', origin: 'hub', type: 'codex' },
  ], 'peer rows unchanged and first; local rows appended under the hub label');
  for (const row of roster.filter((r) => r.name !== 'worker')) {
    assert.strictEqual(row.origin, 'hub',
      'origin is the suffix the spoke dials back through — a peer label here is unroutable');
  }
  assert.deepStrictEqual(computeRosterFor('dk', LOCAL_STATUSES, allowed), [
    { name: 'worker', origin: 'remote-linux', type: 'claude' },
  ], 'omitting the two new arguments is the pre-change behaviour exactly');
});

test('computeRosterFor: the symmetric gate still governs the hub\'s own agents', () => {
  const allowed = new Set(['dk', 'rl']);
  assert.deepStrictEqual(
    computeRosterFor('unmarked', LOCAL_STATUSES, allowed, LOCAL_SESSIONS, 'hub'),
    [],
    'a peer never marked relayAllowed gets nothing, the hub\'s own names included',
  );
  assert.deepStrictEqual(
    computeRosterFor('dk', LOCAL_STATUSES, new Set(), LOCAL_SESSIONS, 'hub'),
    [],
    'empty allow-list: nobody is in the mesh, so nobody learns the hub\'s names',
  );
});

test('computeRosterFor: a local BASH session is NEVER advertised — bash is private by design', () => {
  const allowed = new Set(['dk']);
  const roster = computeRosterFor('dk', [], allowed, LOCAL_SESSIONS, 'hub');
  assert.deepStrictEqual(roster.map((r) => r.name), ['clodex', 'Codex']);
  const leak = 'a bash session has no registry entry, no socket, is invisible to '
    + '[agent:who] and is not DM-able — publishing one to a spoke exposes a '
    + 'session the operator believes is private';
  assert.strictEqual(roster.some((r) => r.type === 'bash'), false, leak);
  assert.strictEqual(roster.some((r) => r.name === 'shell'), false, leak);
  assert.deepStrictEqual(
    computeRosterFor('dk', [], allowed, [{ name: 'shell', type: 'bash' }], 'hub'),
    [],
    'only bash present → nothing at all, not a row with a scrubbed type',
  );
});

test('computeRosterFor: local rows take the same name-regex and dedup as peer rows', () => {
  const allowed = new Set(['dk']);
  assert.deepStrictEqual(
    computeRosterFor('dk', [], allowed, [{ name: 'bad name', type: 'claude' }, { name: '..', type: 'claude' }], 'hub'),
    [],
    'an unroutable local name is dropped here, not shipped and bounced later',
  );
  assert.deepStrictEqual(
    computeRosterFor('dk', [], allowed, LOCAL_SESSIONS, 'not a label'),
    [],
    'an unroutable SELF label omits every local row rather than stamping it',
  );
  assert.deepStrictEqual(computeRosterFor('dk', [], allowed, LOCAL_SESSIONS, ''), []);
});

test('computeRosterFor: a local name colliding with a peer\'s dedups per origin, not globally', () => {
  const allowed = new Set(['dk', 'rl']);
  const statuses = [
    { id: 'rl', label: 'remote-linux', online: true, caps: ['dm'], sessions: [{ name: 'clodex', type: 'claude' }] },
  ];
  assert.deepStrictEqual(
    computeRosterFor('dk', statuses, allowed, [{ name: 'clodex', type: 'claude' }], 'hub'),
    [
      { name: 'clodex', origin: 'remote-linux', type: 'claude' },
      { name: 'clodex', origin: 'hub', type: 'claude' },
    ],
    'same bare name on a peer and on the hub: DIFFERENT agents, `name@origin` is '
    + 'the address, so dropping either makes one unreachable',
  );
  assert.deepStrictEqual(
    computeRosterFor('dk', [], allowed, [{ name: 'clodex', type: 'claude' }, { name: 'clodex', type: 'codex' }], 'hub'),
    [{ name: 'clodex', origin: 'hub', type: 'claude' }],
    'a true duplicate within one origin still collapses to one row',
  );
});

test('buildTerminalDm: STRIPS relay fields and preserves from fully-qualified', () => {
  const e = buildRelayEnvelope({
    to: 'worker', finalTarget: 'worker@remote-linux',
    from: 'agent@docker', origin: 'hub', body: 'hi', urgent: false,
  });
  const term = buildTerminalDm(e);
  // Exactly conn.dm's input signature {to,from,body,urgent} — the destination
  // can't tell it was relayed, and conn.dm stamps `origin` itself (not the caller).
  assert.deepStrictEqual(term, {
    to: 'worker', from: 'agent@docker', body: 'hi', urgent: false,
  });
  // The loop-prevention invariants, asserted explicitly:
  assert.strictEqual('finalTarget' in term, false, 'finalTarget must be stripped on the terminal leg');
  assert.strictEqual('hops' in term, false, 'hops must be stripped on the terminal leg');
  assert.strictEqual('rv' in term, false, 'rv must be stripped on the terminal leg');
  assert.strictEqual('origin' in term, false, 'origin is not caller-set — conn.dm stamps it');
  assert.strictEqual(term.from, 'agent@docker', 'from is sacred — never rewritten to the hop origin');
});
