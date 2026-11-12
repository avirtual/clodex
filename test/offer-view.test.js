'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  PEER_NOTE, ownFactsLine, peerOfferLine, peerChoices, peerNameToAdd, selfLabelLine, offerFormProblem, offerRecordFromForm, offerStatusText,
  runIsolationLine, runConsentText,
} = require('../renderer/lib/offer-view');
const { sanitizeBoxOffer } = require('../box-offer');

const MURMUR_ROW = {
  route: 'r1', provenance: 'hello', name: 'murmur', at: 1,
  offer: { scope: 'discovery', boxes: 2, open: true, kinds: ['container'], facts: { os: 'linux', arch: 'x64', cpus: 16, memMb: 65536, runtime: { platforms: ['linux/amd64'] } } },
};

test('the popover line for a peer that offers boxes names count, open state, os/arch and runtime', () => {
  assert.strictEqual(peerOfferLine([MURMUR_ROW], 'murmur'), '2 boxes · open now · linux/x64 · runtime linux/amd64');
  const closed = { ...MURMUR_ROW, offer: { ...MURMUR_ROW.offer, boxes: 1, open: false, facts: { ...MURMUR_ROW.offer.facts, runtime: null } } };
  assert.strictEqual(peerOfferLine([closed], 'murmur'), '1 box · closed now · linux/x64 · no container runtime');
});

test('no popover line for a peer without an offer row, or with only an announce row', () => {
  assert.strictEqual(peerOfferLine([MURMUR_ROW], 'laptop'), null);
  assert.strictEqual(peerOfferLine([], 'murmur'), null);
  assert.strictEqual(peerOfferLine([{ ...MURMUR_ROW, provenance: 'announce' }], 'murmur'), null);
});

test('the facts line shows os/arch, cores, memory and the runtime or none found', () => {
  assert.strictEqual(
    ownFactsLine({ os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] } }),
    'darwin/arm64 · 10 cores · 32 GB memory · container runtime linux/arm64',
  );
  assert.strictEqual(
    ownFactsLine({ os: 'linux', arch: 'x64', cpus: 2, memMb: 512, runtime: null }),
    'linux/x64 · 2 cores · 512 MB memory · container runtime: none found',
  );
});

test('the peer note says the list is not an access control and how a dialing node is named', () => {
  assert.strictEqual(PEER_NOTE, 'This list decides which peers are shown this offer. It is not an access control. Nothing runs on this machine because of it yet. A node that dials this machine is named by its own label, which is its hostname unless it set one.');
  assert.ok(!/can use/.test(PEER_NOTE));
  assert.strictEqual(selfLabelLine('laptop'), "This machine's label is laptop: a node it dials sees it by that name.");
  assert.strictEqual(selfLabelLine(null), '');
});

test('peer choices list configured peers, then dialed-in nodes with when they were seen, then stored names', () => {
  const rows = [
    { name: 'murmur', from: 'peer' }, { name: 'has space', from: 'peer' }, { name: 'laptop', from: 'peer' }, { name: 'murmur', from: 'peer' },
    { name: 'studio', from: 'dialed', seenAt: 1000 }, { name: 'attic', from: 'dialed', seenAt: 3 * 3600000 },
  ];
  const now = 3 * 3600000 + 120000;
  assert.deepStrictEqual(
    peerChoices(rows, { peers: [{ name: 'laptop' }, { name: 'gone' }, { name: 'studio' }] }, now),
    [
      { name: 'murmur', note: null, ticked: false },
      { name: 'laptop', note: null, ticked: true },
      { name: 'studio', note: 'dials this machine, seen 3h ago', ticked: true },
      { name: 'attic', note: 'dials this machine, seen 2m ago', ticked: false },
      { name: 'gone', note: null, ticked: true },
    ],
  );
});

test('a stored ticked name that is neither configured nor seen is still listed and ticked', () => {
  assert.deepStrictEqual(peerChoices([], { peers: [{ name: 'gone' }] }, 0), [{ name: 'gone', note: null, ticked: true }]);
});

test('a typed name is trimmed and validated, and a duplicate is ignored', () => {
  assert.deepStrictEqual(peerNameToAdd(' laptop ', ['murmur']), { name: 'laptop' });
  assert.deepStrictEqual(peerNameToAdd('murmur', ['murmur']), { name: 'murmur', duplicate: true });
  for (const bad of ['', 'has space', '..', 'x'.repeat(65)]) {
    assert.deepStrictEqual(peerNameToAdd(bad, []), { error: 'a name is 1-64 letters, digits, dot, dash or underscore' }, bad);
  }
});

test('the form problem names the cause the sanitiser would refuse', () => {
  const base = { boxes: '2', availability: 'schedule', peers: [] };
  for (const bad of ['0', '17', '1.5', '']) {
    assert.strictEqual(offerFormProblem({ ...base, boxes: bad, schedule: [] }), 'boxes must be a whole number from 1 to 16', bad);
  }
  assert.strictEqual(offerFormProblem({ ...base, schedule: [{ days: [], from: '09:00', to: '17:00' }] }), 'a schedule window has no day ticked');
  assert.strictEqual(offerFormProblem({ ...base, schedule: [{ days: [1], from: '', to: '17:00' }] }), 'a schedule window has an empty time');
  assert.strictEqual(offerFormProblem({ ...base, schedule: [{ days: [1], from: '09:00', to: '09:00' }] }), 'a schedule window starts and ends at the same time');
  assert.strictEqual(offerFormProblem({ boxes: '16', availability: 'always', schedule: [{ days: [] }], peers: Array.from({ length: 33 }, (_, i) => `n${i}`) }), 'more than 32 peers ticked');
  assert.strictEqual(offerFormProblem({ ...base, schedule: [{ days: [1], from: '22:00', to: '07:00' }] }), null);
});

test('the form record passes the sanitiser for always and schedule, scope discovery', () => {
  const always = offerRecordFromForm({ enabled: true, boxes: '3', availability: 'always', schedule: [{ days: [1], from: '09:00', to: '17:00' }], peers: ['murmur'] });
  assert.deepStrictEqual(always, { scope: 'discovery', enabled: true, boxes: 3, availability: 'always', peers: [{ name: 'murmur' }] });
  assert.deepStrictEqual(sanitizeBoxOffer(always), always);
  const sched = offerRecordFromForm({ enabled: false, boxes: '1', availability: 'schedule', schedule: [{ days: [5, 1], from: '22:00', to: '07:00' }], peers: [] });
  assert.deepStrictEqual(sched.schedule, [{ days: [1, 5], from: '22:00', to: '07:00' }]);
  assert.deepStrictEqual(sanitizeBoxOffer(sched), sched);
});

test('status text: forced, invalid stored, off, on', () => {
  assert.strictEqual(offerStatusText({ forced: true, warning: null, effective: null }), 'Set by environment (CLODEX_BOX_OFFER); change it there.');
  assert.strictEqual(offerStatusText({ forced: false, warning: 'stored offer invalid, treated as off', effective: null }), 'Stored offer invalid, treated as off.');
  assert.strictEqual(offerStatusText({ forced: false, warning: null, effective: null }), 'Off.');
  assert.strictEqual(offerStatusText({ forced: false, warning: null, effective: { enabled: true } }), 'Announced to the ticked peers at the next hello.');
});

test('the form record carries scope run only when run is chosen', () => {
  const run = offerRecordFromForm({ scope: 'run', enabled: true, boxes: '1', availability: 'always', schedule: [], peers: ['murmur'] });
  assert.deepStrictEqual(run, { scope: 'run', enabled: true, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }] });
  assert.deepStrictEqual(sanitizeBoxOffer(run), run);
  assert.strictEqual(offerRecordFromForm({ scope: 'other', enabled: true, boxes: '1', availability: 'always', peers: [] }).scope, 'discovery');
});

test('the run line states the isolation in force, or that the runner is off', () => {
  assert.strictEqual(runIsolationLine({ status: 'running', isolation: 'none' }), "Jobs run through this machine's test runner, isolation none: suites run as this user, unisolated.");
  assert.strictEqual(runIsolationLine({ status: 'starting', isolation: 'user' }), "Jobs run through this machine's test runner, isolation user: suites run as a separate user account.");
  assert.strictEqual(runIsolationLine({ status: 'off', isolation: 'none' }), 'Test runner is off: nothing runs until it is turned on above.');
  assert.strictEqual(runIsolationLine(null), 'Test runner is off: nothing runs until it is turned on above.');
});

test('the run confirmation lists every peer being authorised and the isolation', () => {
  assert.strictEqual(
    runConsentText(['murmur', 'laptop'], { status: 'running', isolation: 'none' }),
    "These peers may run their teams' test jobs on this machine:\n  murmur\n  laptop\n\nJobs run through this machine's test runner, isolation none: suites run as this user, unisolated.\n\nAllow?",
  );
  assert.strictEqual(
    runConsentText([], { status: 'off', isolation: 'user' }),
    'No peer is ticked: no one may run test jobs here until one is.\n\nTest runner is off: nothing runs until it is turned on above.\n\nAllow?',
  );
});
