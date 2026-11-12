'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  PEER_NOTE, ownFactsLine, peerOfferLine, peerChoices, offerRecordFromForm, offerStatusText,
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

test('the peer note says the list is not an access control', () => {
  assert.strictEqual(PEER_NOTE, 'This list decides which peers are shown this offer. It is not an access control, and nothing runs on this machine because of it yet.');
  assert.ok(!/can use/.test(PEER_NOTE));
});

test('peer choices keep configured valid labels and stored names, ticking the stored ones', () => {
  assert.deepStrictEqual(
    peerChoices(['murmur', 'has space', 'laptop', 'murmur'], { peers: [{ name: 'laptop' }, { name: 'gone' }] }),
    [{ name: 'murmur', ticked: false }, { name: 'laptop', ticked: true }, { name: 'gone', ticked: true }],
  );
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
