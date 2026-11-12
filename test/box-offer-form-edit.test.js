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

function harness() {
  const pending = [];
  const ctx = {
    window: { api: { offerGet: () => new Promise((resolve) => pending.push(resolve)) } },
    document: { createElement: () => el({ dataset: {} }) },
    prefsBoxOfferShown: null,
    prefsBoxOfferBlock: el(),
    prefsBoxOfferEnabled: el(),
    prefsBoxOfferBoxes: el(),
    prefsBoxOfferAvailability: el(),
    prefsBoxOfferSchedule: el(),
    prefsBoxOfferPeers: el(),
    prefsBoxOfferPeerName: el(),
    prefsBoxOfferScope: el(),
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
    fnSource('refreshBoxOfferPrefs'),
    'globalThis.ui = { render: renderBoxOfferPrefs, refresh: refreshBoxOfferPrefs, mark: markBoxOfferEdited };',
  ].join('\n'), ctx);
  const answer = async (st) => { pending.shift()(st); await new Promise((r) => setImmediate(r)); };
  return { ctx, ui: ctx.ui, answer, pending };
}

const OFF = { scope: 'run', enabled: false, boxes: 1, availability: 'always', peers: [] };
const state = (stored) => ({ self: 'workbox', stored, effective: stored, forced: false, warning: null, facts: null, peers: [{ name: 'murmur', from: 'peer' }], runner: null, claims: [] });

test('a slow offer:get on open does not untick an Offer box the operator ticked meanwhile', async () => {
  const { ctx, ui, answer, pending } = harness();
  const opening = ui.refresh();
  assert.strictEqual(pending.length, 1, 'ENTER: the refresh is waiting on offer:get');
  ctx.prefsBoxOfferEnabled.checked = true;
  ui.mark();
  await answer(state(OFF));
  await opening;
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, true, 'the tick survives the late render');
  assert.strictEqual(ctx.prefsBoxOfferShown.stored, OFF, 'the state itself is still taken in');
});

test('an untouched form is filled from the stored record when offer:get answers', async () => {
  const { ctx, ui, answer } = harness();
  ctx.prefsBoxOfferEnabled.checked = true;
  const opening = ui.refresh();
  await answer(state({ ...OFF, peers: [{ name: 'murmur' }] }));
  await opening;
  assert.strictEqual(ctx.prefsBoxOfferEnabled.checked, false);
  assert.strictEqual(ctx.prefsBoxOfferScope.value, 'run');
  assert.deepStrictEqual(ctx.prefsBoxOfferPeers.children, [{ peer: 'murmur', checked: true }]);
});
