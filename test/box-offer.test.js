'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  sanitizeBoxOffer, offerFromEnv, scheduleOpen, wireEntry, sanitizeWireOffers,
} = require('../box-offer');
const { initStores } = require('../stores.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const VALID = {
  scope: 'discovery',
  enabled: true,
  boxes: 2,
  availability: 'schedule',
  schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '07:00' }],
  peers: [{ name: 'murmur' }, { name: 'laptop' }],
};

const ALWAYS = {
  scope: 'discovery',
  enabled: true,
  boxes: 1,
  availability: 'always',
  peers: [{ name: 'murmur' }],
};

const with_ = (patch) => ({ ...VALID, ...patch });

test('a full valid record passes the sanitiser whole', () => {
  assert.deepStrictEqual(sanitizeBoxOffer(VALID), {
    scope: 'discovery',
    enabled: true,
    boxes: 2,
    availability: 'schedule',
    schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '07:00' }],
    peers: [{ name: 'murmur' }, { name: 'laptop' }],
  });
  assert.deepStrictEqual(sanitizeBoxOffer(ALWAYS), {
    scope: 'discovery', enabled: true, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }],
  });
});

const REFUSALS = [
  ['33 peers', with_({ peers: Array.from({ length: 33 }, (_, i) => ({ name: `p${i}` })) })],
  ['boxes: 0', with_({ boxes: 0 })],
  ['boxes: 17', with_({ boxes: 17 })],
  ['to: "24:00"', with_({ schedule: [{ days: [1], from: '22:00', to: '24:00' }] })],
  ['an unknown key', with_({ host: 'murmur' })],
  ['an unknown key in a window', with_({ schedule: [{ days: [1], from: '22:00', to: '07:00', tz: 'UTC' }] })],
  ['a duplicate peer name', with_({ peers: [{ name: 'murmur' }, { name: 'murmur' }] })],
  ['availability: "idle"', { ...ALWAYS, availability: 'idle' }],
  ['a missing scope', (() => { const r = { ...VALID }; delete r.scope; return r; })()],
  ['scope: "run"', with_({ scope: 'run' })],
  ['a peer entry carrying passOn', with_({ peers: [{ name: 'murmur', passOn: false }] })],
  ['a wildcard peer', with_({ peers: [{ name: '*' }] })],
  ['schedule with availability always', { ...ALWAYS, schedule: [{ days: [1], from: '22:00', to: '07:00' }] }],
  ['days: [7]', with_({ schedule: [{ days: [7], from: '22:00', to: '07:00' }] })],
  ['an empty schedule', with_({ schedule: [] })],
];

for (const [label, raw] of REFUSALS) {
  test(`sanitiser refuses ${label} with a whole-record null`, () => {
    assert.strictEqual(sanitizeBoxOffer(raw), null);
  });
}

test('scheduleOpen across midnight belongs to the window\'s start day', () => {
  const offer = with_({ schedule: [{ days: [5], from: '22:00', to: '07:00' }] });
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 13, 23, 0)), true, 'Friday 23:00');
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 14, 3, 0)), true, 'Saturday 03:00');
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 14, 7, 0)), false, 'Saturday 07:00');
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 13, 21, 59)), false, 'Friday 21:59');
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 13, 3, 0)), false, 'Friday 03:00');
  assert.strictEqual(scheduleOpen(offer, new Date(2026, 10, 14, 23, 0)), false, 'Saturday 23:00');
});

test('scheduleOpen: always is open, a disabled or absent offer is closed', () => {
  assert.strictEqual(scheduleOpen(ALWAYS, new Date(2026, 10, 14, 3, 0)), true);
  assert.strictEqual(scheduleOpen({ ...ALWAYS, enabled: false }, new Date(2026, 10, 14, 3, 0)), false);
  assert.strictEqual(scheduleOpen(null, new Date(2026, 10, 14, 3, 0)), false);
});

test('wireEntry carries only scope, boxes, platforms, runtime and open', () => {
  const facts = {
    platforms: ['linux/arm64'], runtime: true, now: new Date(2026, 10, 13, 23, 0),
    host: 'murmur', version: '5.176.0',
  };
  assert.deepStrictEqual(wireEntry(VALID, facts, 'laptop'), {
    scope: 'discovery', boxes: 2, platforms: ['linux/arm64'], runtime: true, open: true,
  });
  assert.strictEqual(wireEntry(VALID, facts, 'stranger'), null);
  assert.strictEqual(wireEntry({ ...VALID, enabled: false }, facts, 'laptop'), null);
  assert.strictEqual(wireEntry(null, facts, 'laptop'), null);
});

test('sanitizeWireOffers accepts own and drops relayed', () => {
  const own = { scope: 'discovery', boxes: 2, platforms: ['linux/amd64'], runtime: false, open: true };
  assert.deepStrictEqual(sanitizeWireOffers({ own, relayed: [own] }), { own });
  assert.deepStrictEqual(sanitizeWireOffers({ own: { ...own, host: 'murmur' } }), { own: null });
  assert.deepStrictEqual(sanitizeWireOffers({ own: { ...own, scope: 'run' } }), { own: null });
  assert.deepStrictEqual(sanitizeWireOffers({}), { own: null });
  assert.strictEqual(sanitizeWireOffers('x'), null);
});

test('offerFromEnv: unset is undefined, bad JSON or bad record is null with one error', () => {
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  assert.strictEqual(offerFromEnv({}, log), undefined);
  assert.deepStrictEqual(offerFromEnv({ CLODEX_BOX_OFFER: JSON.stringify(ALWAYS) }, log), ALWAYS);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(offerFromEnv({ CLODEX_BOX_OFFER: '{nope' }, log), null);
  assert.strictEqual(offerFromEnv({ CLODEX_BOX_OFFER: JSON.stringify(with_({ scope: 'run' })) }, log), null);
  assert.strictEqual(errors.length, 2);
});

function openStores(dir) {
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

test('a settings file without boxOffer loads as off', () => {
  const dir = mkTmpRoot('clodex-boxoffer-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ theme: 'dark' }));
  assert.strictEqual(openStores(dir).uiSettings.get().boxOffer, null);
});

test('an invalid stored record loads as off', () => {
  const dir = mkTmpRoot('clodex-boxoffer-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ boxOffer: with_({ scope: 'run' }) }));
  assert.strictEqual(openStores(dir).uiSettings.get().boxOffer, null);
});

test('set stores a valid record, keeps it across an invalid set, and clears on null', () => {
  const dir = mkTmpRoot('clodex-boxoffer-');
  const ui = openStores(dir).uiSettings;
  ui.set({ boxOffer: VALID });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().boxOffer, VALID);
  ui.set({ boxOffer: with_({ boxes: 0 }) });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().boxOffer, VALID);
  ui.set({ theme: 'dark' });
  assert.deepStrictEqual(openStores(dir).uiSettings.get().boxOffer, VALID);
  ui.set({ boxOffer: null });
  assert.strictEqual(openStores(dir).uiSettings.get().boxOffer, null);
});
