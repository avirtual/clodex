'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { peerChoices } = require('../renderer/lib/offer-view');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

function fnSource(name) {
  const re = new RegExp(`\\n(async )?function ${name}\\(`);
  const m = re.exec(src);
  assert.ok(m, `${name} not found in renderer.js`);
  const end = src.indexOf('\n}\n', m.index + 1);
  return src.slice(m.index + 1, end + 2);
}

function el(extra = {}) {
  return {
    checked: false, value: '', textContent: '', disabled: false, children: [],
    replaceChildren(...kids) { this.children = kids; },
    append(...kids) { this.children.push(...kids); },
    classList: { toggle() {} },
    querySelectorAll: () => [],
    ...extra,
  };
}

function harness({ shown = null } = {}) {
  const pending = [];
  const controls = {
    prefsBoxOfferEnabled: el(),
    prefsBoxOfferBoxes: el(),
    prefsBoxOfferAvailability: el(),
    prefsBoxOfferPeerName: el(),
    prefsBoxOfferScope: el(),
  };
  const ctx = {
    window: { api: { offerGet: () => new Promise((resolve) => pending.push(resolve)) } },
    document: { createElement: () => el({ dataset: {} }) },
    prefsBoxOfferShown: shown,
    prefsBoxOfferBlock: el({ querySelectorAll: () => Object.values(controls) }),
    ...controls,
    prefsBoxOfferSchedule: el(),
    prefsBoxOfferPeers: el(),
    prefsBoxOfferSelf: el(),
    prefsBoxOfferFacts: el(),
    prefsBoxOfferStatus: el(),
    boxOfferWindowRow: (w) => w,
    boxOfferPeerRow: (c) => ({ peer: c.name, checked: c.ticked }),
    offerPeerChoices: peerChoices,
    syncBoxOfferScope() {},
    syncBoxOfferSchedule() {},
    offerSelfLabelLine: () => '',
    ownFactsLine: () => '',
    offerStatusText: () => '',
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let prefsBoxOfferEdited = false;',
    fnSource('markBoxOfferEdited'),
    fnSource('renderBoxOfferPrefs'),
    fnSource('boxOfferKeepsForm'),
    fnSource('refreshBoxOfferPrefs'),
    'globalThis.ui = { render: renderBoxOfferPrefs, refresh: refreshBoxOfferPrefs, mark: markBoxOfferEdited };',
  ].join('\n'), ctx);
  const answer = async (st) => { pending.shift()(st); await new Promise((r) => setImmediate(r)); };
  return { ctx, ui: ctx.ui, answer, pending };
}

const OFF = { scope: 'run', enabled: false, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }] };
const state = (stored) => ({ self: 'workbox', stored, effective: stored, forced: false, warning: null, facts: null, peers: [{ name: 'murmur', from: 'peer' }], runner: null, claims: [] });

test('reopen: a slow offer:get does not untick an Offer box ticked meanwhile when the stored record is unchanged', async () => {
  const { ctx, ui, answer, pending } = harness({ shown: state(OFF) });
  const opening = ui.refresh();
  assert.strictEqual(pending.length, 1, 'ENTER: the refresh is waiting on offer:get');
  assert.deepStrictEqual(ctx.prefsBoxOfferPeers.children, [{ peer: 'murmur', checked: true }], 'the form already shows the stored record');
  assert.strictEqual(ctx.prefsBoxOfferEnabled.disabled, false, 'a filled form stays editable during the wait');
  ctx.prefsBoxOfferEnabled.checked = true;
  ui.mark();
  await answer(state(OFF));
  await opening;
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, true, 'the tick survives the late render');
  assert.strictEqual(ctx.prefsBoxOfferScope.value, 'run');
  assert.deepStrictEqual(ctx.prefsBoxOfferPeers.children, [{ peer: 'murmur', checked: true }]);
});

test('reopen: last session leftovers are cleared before the answer arrives', async () => {
  const { ctx, ui, answer } = harness({ shown: state(OFF) });
  ctx.prefsBoxOfferEnabled.checked = true;
  ctx.prefsBoxOfferScope.value = 'discovery';
  const opening = ui.refresh();
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, false);
  assert.strictEqual(ctx.prefsBoxOfferScope.value, 'run');
  await answer(state(OFF));
  await opening;
});

test('an edit during the wait yields to a stored record that changed since the form was filled', async () => {
  const { ctx, ui, answer } = harness({ shown: state(OFF) });
  const opening = ui.refresh();
  ctx.prefsBoxOfferEnabled.checked = true;
  ui.mark();
  const changed = { ...OFF, boxes: 3, peers: [{ name: 'murmur' }, { name: 'hollow' }] };
  await answer(state(changed));
  await opening;
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, false);
  assert.strictEqual(ctx.prefsBoxOfferBoxes.value, '3');
  assert.deepStrictEqual(ctx.prefsBoxOfferPeers.children, [{ peer: 'murmur', checked: true }, { peer: 'hollow', checked: true }]);
});

test('first open: the controls are disabled until offer:get answers, then filled from the stored record', async () => {
  const { ctx, ui, answer } = harness();
  const opening = ui.refresh();
  assert.strictEqual(ctx.prefsBoxOfferEnabled.disabled, true, 'a blank form cannot be ticked during the wait');
  assert.strictEqual(ctx.prefsBoxOfferScope.disabled, true);
  await answer(state(OFF));
  await opening;
  assert.strictEqual(ctx.prefsBoxOfferEnabled.disabled, false);
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, false);
  assert.strictEqual(ctx.prefsBoxOfferScope.value, 'run');
  assert.deepStrictEqual(ctx.prefsBoxOfferPeers.children, [{ peer: 'murmur', checked: true }]);
});
