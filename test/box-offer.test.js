'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  sanitizeBoxOffer, offerFromEnv, scheduleOpen, wireEntry, offerEntry, sanitizeWireOffers, warnStoredOffer, bootOffer, offerEnabled, runGrant,
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
  ['scope: "build"', with_({ scope: 'build' })],
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


test('wireEntry carries exactly scope, boxes, open, kinds and facts', () => {
  const facts = {
    os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] },
    host: 'murmur', version: '5.176.0',
  };
  const friday23 = new Date(2026, 10, 13, 23, 0);
  assert.deepStrictEqual(wireEntry(VALID, facts, 'laptop', friday23), {
    scope: 'discovery', boxes: 2, open: true, kinds: ['container'],
    facts: { os: 'darwin', arch: 'arm64', cpus: 10, memMb: 32768, runtime: { platforms: ['linux/arm64'] } },
  });
  assert.strictEqual(wireEntry(VALID, facts, 'stranger', friday23), null);
  assert.strictEqual(wireEntry({ ...VALID, enabled: false }, facts, 'laptop', friday23), null);
  assert.strictEqual(wireEntry(null, facts, 'laptop', friday23), null);
});

test('wireEntry reports runtime null when no platform was probed', () => {
  const entry = wireEntry(ALWAYS, { os: 'linux', arch: 'x64', cpus: 4, memMb: 8192, runtime: null }, 'murmur');
  assert.deepStrictEqual(entry.facts, { os: 'linux', arch: 'x64', cpus: 4, memMb: 8192, runtime: null });
});

test('offerEntry is the entry without the peer filter', () => {
  const facts = { os: 'linux', arch: 'x64', cpus: 4, memMb: 8192, runtime: null };
  assert.deepStrictEqual(offerEntry(ALWAYS, facts), {
    scope: 'discovery', boxes: 1, open: true, kinds: ['container'], facts,
  });
  assert.strictEqual(offerEntry({ ...ALWAYS, enabled: false }, facts), null);
});

const WIRE_OWN = {
  scope: 'discovery', boxes: 2, open: true, kinds: ['container'],
  facts: { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384, runtime: { platforms: ['linux/amd64'] } },
};

test('sanitizeWireOffers accepts own and drops relayed', () => {
  assert.deepStrictEqual(sanitizeWireOffers({ own: WIRE_OWN, relayed: [WIRE_OWN] }), { own: WIRE_OWN });
  assert.deepStrictEqual(sanitizeWireOffers({ own: { ...WIRE_OWN, kinds: ['native'] } }), { own: { ...WIRE_OWN, kinds: ['native'] } });
  assert.deepStrictEqual(sanitizeWireOffers({}), { own: null });
  assert.deepStrictEqual(sanitizeWireOffers({ own: null }), { own: null });
  assert.strictEqual(sanitizeWireOffers('x'), null);
});

const WIRE_REFUSALS = [
  ['an extra entry key', { ...WIRE_OWN, host: 'murmur' }],
  ['scope: "build"', { ...WIRE_OWN, scope: 'build' }],
  ['an unknown kind', { ...WIRE_OWN, kinds: ['vm'] }],
  ['empty kinds', { ...WIRE_OWN, kinds: [] }],
  ['an extra fact', { ...WIRE_OWN, facts: { ...WIRE_OWN.facts, version: '5.176.0' } }],
  ['a missing fact', { ...WIRE_OWN, facts: { os: 'linux', arch: 'x64', cpus: 8, memMb: 16384 } }],
  ['cpus: 0', { ...WIRE_OWN, facts: { ...WIRE_OWN.facts, cpus: 0 } }],
  ['a runtime with no platform', { ...WIRE_OWN, facts: { ...WIRE_OWN.facts, runtime: { platforms: [] } } }],
  ['runtime: true', { ...WIRE_OWN, facts: { ...WIRE_OWN.facts, runtime: true } }],
];

for (const [label, own] of WIRE_REFUSALS) {
  test(`sanitizeWireOffers refuses an own with ${label} whole`, () => {
    assert.strictEqual(sanitizeWireOffers({ own }), null);
  });
}

test('a sparse days array is refused', () => {
  const days = [1, 2, 3];
  delete days[1];
  assert.strictEqual(sanitizeBoxOffer(with_({ schedule: [{ days, from: '22:00', to: '07:00' }] })), null);
});

test('a sparse schedule array is refused', () => {
  const schedule = [{ days: [1], from: '22:00', to: '07:00' }, { days: [2], from: '22:00', to: '07:00' }];
  delete schedule[0];
  assert.strictEqual(sanitizeBoxOffer(with_({ schedule })), null);
});

test('warnStoredOffer warns once naming boxOffer for an invalid stored record, never for a valid or absent one', () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.strictEqual(warnStoredOffer(() => ({ boxOffer: with_({ scope: 'build' }) }), warn), true);
  assert.deepStrictEqual(warnings, ['ui-settings boxOffer is not a valid box offer; box offer off']);
  assert.strictEqual(warnStoredOffer(() => ({ boxOffer: VALID }), warn), false);
  assert.strictEqual(warnStoredOffer(() => ({ theme: 'dark' }), warn), false);
  assert.strictEqual(warnStoredOffer(() => { throw new Error('ENOENT'); }, warn), false);
  assert.strictEqual(warnings.length, 1);
});

test('offerFromEnv: unset is undefined, bad JSON or bad record is null with one error', () => {
  const errors = [];
  const log = { error: (m) => errors.push(m) };
  assert.strictEqual(offerFromEnv({}, log), undefined);
  assert.deepStrictEqual(offerFromEnv({ CLODEX_BOX_OFFER: JSON.stringify(ALWAYS) }, log), ALWAYS);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(offerFromEnv({ CLODEX_BOX_OFFER: '{nope' }, log), null);
  assert.strictEqual(offerFromEnv({ CLODEX_BOX_OFFER: JSON.stringify(with_({ scope: 'build' })) }, log), null);
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
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ boxOffer: with_({ scope: 'build' }) }));
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

test('bootOffer: a set CLODEX_BOX_OFFER wins and the stored setting is never read or warned about', () => {
  const lines = [];
  const log = { error: (m) => lines.push(['error', m]), warn: (m) => lines.push(['warn', m]) };
  let reads = 0;
  const readStored = () => { reads++; return { boxOffer: with_({ scope: 'build' }) }; };
  assert.deepStrictEqual(bootOffer({ CLODEX_BOX_OFFER: JSON.stringify(VALID) }, readStored, log), sanitizeBoxOffer(VALID));
  assert.strictEqual(bootOffer({ CLODEX_BOX_OFFER: '{nope' }, readStored, log), null);
  assert.strictEqual(reads, 0, 'the stored setting was read while the env var is set');
  assert.deepStrictEqual(lines.map(([level]) => level), ['error']);
  assert.strictEqual(bootOffer({}, readStored, log), undefined);
  assert.strictEqual(reads, 1);
  assert.deepStrictEqual(lines[1], ['warn', 'ui-settings boxOffer is not a valid box offer; box offer off']);
});

test('offerEnabled decides on the sanitised record, not the raw enabled flag', () => {
  assert.strictEqual(offerEnabled(VALID), true);
  assert.strictEqual(offerEnabled(with_({ scope: 'build' })), false);
  assert.strictEqual(with_({ scope: 'build' }).enabled, true);
  assert.strictEqual(offerEnabled(with_({ enabled: false })), false);
  assert.strictEqual(offerEnabled(null), false);
  const engine = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.ok(engine.includes('if (offerEnabled(getBoxOffer())) runtimeProbe.refresh();'), 'engine.js boot probe does not decide on offerEnabled');
  assert.ok(engine.includes('const envBoxOffer = bootOffer('), 'engine.js does not boot the offer through bootOffer');
});

const RUN = with_({ scope: 'run' });
const FRIDAY_23 = new Date(2026, 10, 13, 23, 0);
const FRIDAY_2159 = new Date(2026, 10, 13, 21, 59);

test('a run record passes the sanitiser whole and keeps its scope', () => {
  assert.deepStrictEqual(sanitizeBoxOffer(RUN), {
    scope: 'run',
    enabled: true,
    boxes: 2,
    availability: 'schedule',
    schedule: [{ days: [1, 2, 3, 4, 5], from: '22:00', to: '07:00' }],
    peers: [{ name: 'murmur' }, { name: 'laptop' }],
  });
});

const GRANTS = [
  ['a discovery record', VALID, 'laptop', FRIDAY_23, { admit: false, serve: false }],
  ['a disabled run record', { ...RUN, enabled: false }, 'laptop', FRIDAY_23, { admit: false, serve: false }],
  ['an unlisted peer', RUN, 'stranger', FRIDAY_23, { admit: false, serve: false }],
  ['a closed schedule', RUN, 'laptop', FRIDAY_2159, { admit: false, serve: true }],
  ['a ticked peer inside the window', RUN, 'laptop', FRIDAY_23, { admit: true, serve: true }],
];

for (const [label, offer, peer, now, want] of GRANTS) {
  test(`runGrant for ${label}`, () => {
    assert.deepStrictEqual(runGrant(offer, peer, now), want);
  });
}

test('a stored discovery record loads as discovery and grants nothing', () => {
  const dir = mkTmpRoot('clodex-boxoffer-');
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify({ boxOffer: ALWAYS }));
  const loaded = openStores(dir).uiSettings.get().boxOffer;
  assert.deepStrictEqual(loaded, ALWAYS);
  assert.deepStrictEqual(runGrant(loaded, 'murmur', FRIDAY_23), { admit: false, serve: false });
});

test('a run record\'s entry says run only when asked for, so hello stays discovery', () => {
  const facts = { os: 'linux', arch: 'x64', cpus: 4, memMb: 8192, runtime: null };
  assert.strictEqual(wireEntry(RUN, facts, 'laptop', FRIDAY_23).scope, 'discovery');
  assert.strictEqual(wireEntry(RUN, facts, 'laptop', FRIDAY_23, { run: true }).scope, 'run');
  assert.strictEqual(wireEntry(VALID, facts, 'laptop', FRIDAY_23, { run: true }).scope, 'discovery');
});

test('sanitizeWireOffers accepts an own with scope run', () => {
  assert.deepStrictEqual(sanitizeWireOffers({ own: { ...WIRE_OWN, scope: 'run' } }), { own: { ...WIRE_OWN, scope: 'run' } });
});
