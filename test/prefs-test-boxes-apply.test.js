'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const offerView = require('../renderer/lib/offer-view');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

function fnSource(name) {
  const re = new RegExp(`\\n(async )?function ${name}\\(`);
  const m = re.exec(src);
  assert.ok(m, `${name} not found in renderer.js`);
  const end = src.indexOf('\n}\n', m.index + 1);
  return src.slice(m.index + 1, end + 2);
}

function el(extra = {}) {
  const classes = new Set();
  const listeners = {};
  return {
    checked: false, value: '', textContent: '', disabled: false, children: [], dataset: {},
    replaceChildren(...kids) { this.children = kids; },
    append(...kids) { this.children.push(...kids); },
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      add(c) { classes.add(c); },
      contains: (c) => classes.has(c),
    },
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, target) { for (const fn of listeners[type] || []) fn({ target }); },
    ...extra,
  };
}

const RUNNER = { status: 'off', setting: { enabled: false, isolation: 'user', work: null }, effective: {}, forced: [] };
const OFFER = { scope: 'discovery', enabled: false, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }] };
const offerState = (stored) => ({ self: 'workbox', stored, effective: stored, forced: false, warning: null, facts: null, peers: [{ name: 'murmur', from: 'peer' }], runner: null, claims: [] });
const REFUSED = 'invalid test runner setting';

function harness({ runnerAnswer = null } = {}) {
  const calls = [];
  const toasts = [];
  const group = { open: false };
  const scrolled = [];
  const block = (name) => el({ closest: (sel) => (sel === 'details' ? group : null), scrollIntoView: () => scrolled.push(name) });
  const offerControls = {
    prefsBoxOfferEnabled: el(), prefsBoxOfferBoxes: el(), prefsBoxOfferAvailability: el(),
    prefsBoxOfferPeerName: el(), prefsBoxOfferScope: el(),
  };
  const ctx = {
    window: {
      api: {
        suiteRunnerSet: async (rec) => {
          calls.push(['suiteRunnerSet', structuredClone(rec)]);
          return runnerAnswer || { ok: true, state: { ...RUNNER, setting: rec } };
        },
        offerSet: async (rec, confirm) => { calls.push(['offerSet', structuredClone(rec), confirm]); return { ok: true, state: offerState(rec) }; },
      },
      confirm: () => true,
    },
    document: { getElementById: () => el(), createElement: () => el() },
    showToast: (text) => toasts.push(text),
    setTimeout: () => {},
    prefsOverlay: el(),
    prefsSuiteRunnerBlock: block('runner'),
    prefsSuiteRunnerEnabled: el(), prefsSuiteRunnerIsolation: el(), prefsSuiteRunnerWork: el(),
    prefsSuiteRunnerBoxImage: el(), prefsSuiteRunnerSlots: el(), prefsSuiteRunnerBuildBoxes: el(),
    prefsSuiteRunnerShares: null, prefsSuiteRunnerShareRows: null,
    prefsSuiteRunnerNoneNote: el(), prefsSuiteRunnerStatus: el(),
    prefsTestBoxesUnsaved: el(),
    prefsBoxOfferBlock: block('offer'),
    ...offerControls,
    prefsBoxOfferSchedule: el(),
    prefsBoxOfferPeers: el({ querySelectorAll() { return this.children; } }),
    prefsBoxOfferSelf: el(), prefsBoxOfferFacts: el(), prefsBoxOfferStatus: el(),
    boxOfferWindowRow: (w) => w,
    boxOfferPeerRow: (c) => ({ dataset: { peer: c.name }, checked: c.ticked }),
    readBoxOfferSchedule: () => [],
    syncBoxOfferScope() {},
    syncBoxOfferSchedule() {},
    offerSelfLabelLine: () => '',
    ownFactsLine: () => '',
    offerPeerChoices: offerView.peerChoices,
    offerFormProblem: offerView.offerFormProblem,
    offerRecordFromForm: offerView.offerRecordFromForm,
    offerRunnerFrom: offerView.offerRunnerFrom,
    offerRunConsentText: offerView.runConsentText,
    offerStatusText: () => '',
    suiteRunnerRecordFromForm: offerView.suiteRunnerRecordFromForm,
    writePrefsSettings: async () => { calls.push(['setSettings']); },
    closePrefs: () => { calls.push(['closePrefs']); },
  };
  ctx.prefsBoxOfferBlock.querySelectorAll = () => Object.values(offerControls);
  vm.createContext(ctx);
  vm.runInContext([
    'let prefsSuiteRunnerShown = null;',
    'let prefsSuiteRunnerEdited = false;',
    'let prefsBoxOfferShown = null;',
    'let prefsBoxOfferEdited = false;',
    ...['syncTestBoxesUnsaved', 'markSuiteRunnerEdited', 'suiteRunnerStatusText', 'renderSuiteRunnerPrefs', 'refreshSuiteRunnerPrefs',
      'suiteRunnerRecordToSave', 'saveSuiteRunnerBlock', 'applyTestBoxSettings', 'wireSuiteRunnerPrefs', 'markBoxOfferEdited',
      'renderBoxOfferPrefs', 'saveBoxOfferBlock', 'savePrefs'].map(fnSource),
    'wireSuiteRunnerPrefs();',
    'renderSuiteRunnerPrefs(' + JSON.stringify(RUNNER) + ');',
    'renderBoxOfferPrefs(' + JSON.stringify(offerState(OFFER)) + ');',
    'globalThis.ui = { apply: applyTestBoxSettings, save: savePrefs, markOffer: markBoxOfferEdited };',
  ].join('\n'), ctx);
  const tickRunner = () => { ctx.prefsSuiteRunnerEnabled.checked = true; ctx.prefsSuiteRunnerBlock.fire('change', ctx.prefsSuiteRunnerEnabled); };
  const tickOffer = () => { ctx.prefsBoxOfferEnabled.checked = true; ctx.ui.markOffer(); };
  const unsaved = () => (ctx.prefsTestBoxesUnsaved.classList.contains('hidden') ? null : ctx.prefsTestBoxesUnsaved.textContent);
  return { ctx, ui: ctx.ui, calls, toasts, group, scrolled, tickRunner, tickOffer, unsaved };
}

const RUNNER_ON = { enabled: true, isolation: 'user', work: null };
const OFFER_ON = { scope: 'discovery', enabled: true, boxes: 1, availability: 'always', peers: [{ name: 'murmur' }] };

function section() {
  const start = html.indexOf('<details class="prefs-group" data-group="test-boxes">');
  assert.ok(start >= 0, 'test-boxes group not found');
  return html.slice(start, html.indexOf('</details>', start));
}

test('the Test boxes section has exactly one Apply button, and the Box image row has none', () => {
  const s = section();
  assert.strictEqual((s.match(/<button[^>]*>Apply[^<]*<\/button>/g) || []).length, 1);
  assert.match(s, /<button id="prefs-box-offer-apply"[^>]*>Apply test box settings<\/button>/);
  const row = s.slice(s.indexOf('<span>Box image</span>'), s.indexOf('</div>', s.indexOf('<span>Box image</span>')));
  assert.ok(row.includes('id="prefs-suite-runner-boxImage"'), 'ENTER: the Box image row was found');
  assert.ok(!row.includes('<button'));
  const offerEnd = s.indexOf('id="prefs-test-boxes-unsaved"');
  assert.ok(s.indexOf('id="prefs-box-offer-block"') < offerEnd && offerEnd < s.indexOf('id="prefs-box-offer-apply"'), 'the Apply row sits after the offer block');
});

test('the hints name the single Apply and Save, and the build hint names the Docker login', () => {
  const s = section();
  assert.ok(s.includes('Applies when you press Apply test box settings, or Save, with no restart; while test jobs run, the change is saved and applies when they finish.'));
  assert.ok(s.includes('Applies when you press Apply test box settings, or Save; peers see the change at their next hello.'));
  assert.ok(s.includes('Off: a job whose image is missing is refused, as before. Builds can pull any image your Docker login can.</p>'));
  const blockStart = s.indexOf('id="prefs-suite-runner-block"');
  const build = s.indexOf('id="prefs-suite-runner-buildBoxes"');
  assert.ok(blockStart < build && build < s.indexOf('id="prefs-box-offer-block"'), 'the build switch lives in the runner block');
});

test('runner ticked only: Apply sends the runner record once and no offer', async () => {
  const h = harness();
  h.tickRunner();
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Test runner');
  await h.ui.apply();
  assert.deepStrictEqual(h.calls, [['suiteRunnerSet', RUNNER_ON]]);
  assert.strictEqual(h.unsaved(), null);
});

test('offer edited only: Apply sends the offer and not the runner', async () => {
  const h = harness();
  h.tickOffer();
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Offer test boxes');
  await h.ui.apply();
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'offerSet'), [['offerSet', OFFER_ON, undefined]]);
  assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'suiteRunnerSet'), []);
});

test('both edited: the runner is saved first, then the offer', async () => {
  const h = harness();
  h.tickOffer();
  h.tickRunner();
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Test runner, Offer test boxes');
  await h.ui.apply();
  assert.deepStrictEqual(h.calls.map((c) => c[0]), ['suiteRunnerSet', 'offerSet']);
  assert.strictEqual(h.unsaved(), null);
});

test('a refused runner still lets the offer save, and keeps its form and unsaved mark', async () => {
  const h = harness({ runnerAnswer: { ok: false, error: REFUSED, state: RUNNER } });
  h.tickRunner();
  h.tickOffer();
  const refused = await h.ui.apply();
  assert.deepStrictEqual(h.calls.map((c) => c[0]), ['suiteRunnerSet', 'offerSet']);
  assert.strictEqual(refused.length, 1);
  assert.strictEqual(h.toasts.length, 1);
  assert.ok(h.toasts[0].includes(REFUSED), h.toasts[0]);
  assert.ok(h.toasts[0].startsWith('Test runner'), h.toasts[0]);
  assert.strictEqual(h.ctx.prefsSuiteRunnerEnabled.checked, true);
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Test runner');
});

test('the build switch alone marks the runner block unsaved', () => {
  const h = harness();
  assert.strictEqual(h.unsaved(), null);
  h.ctx.prefsSuiteRunnerBuildBoxes.checked = true;
  h.ctx.prefsSuiteRunnerBlock.fire('change', h.ctx.prefsSuiteRunnerBuildBoxes);
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Test runner');
});

test('Save with the runner edited applies it once and closes', async () => {
  const h = harness();
  h.tickRunner();
  await h.ui.save();
  assert.deepStrictEqual(h.calls, [['setSettings'], ['suiteRunnerSet', RUNNER_ON], ['closePrefs']]);
});

test('Save with a refused runner writes the settings, stays open and shows the runner block', async () => {
  const h = harness({ runnerAnswer: { ok: false, error: REFUSED, state: RUNNER } });
  h.tickRunner();
  await h.ui.save();
  assert.deepStrictEqual(h.calls.map((c) => c[0]), ['setSettings', 'suiteRunnerSet']);
  assert.deepStrictEqual(h.scrolled, ['runner']);
  assert.strictEqual(h.group.open, true);
});

test('Save with no edits in the section sends neither call', async () => {
  const h = harness();
  await h.ui.save();
  assert.deepStrictEqual(h.calls, [['setSettings'], ['closePrefs']]);
});

test('Apply, then Save with no further edit, sends nothing twice', async () => {
  const h = harness();
  h.tickRunner();
  h.tickOffer();
  await h.ui.apply();
  await h.ui.save();
  assert.deepStrictEqual(h.calls.map((c) => c[0]), ['suiteRunnerSet', 'offerSet', 'setSettings', 'closePrefs']);
});

const PENDING = { ...RUNNER, status: 'running', remoteEnabled: true, setting: { ...RUNNER_ON, slots: 2 }, pending: true, runningJobs: 2 };
const PENDING_LINE = 'Saved. Applies when the running test jobs finish (2 running).';

test('a deferred save shows the pending line, clears the unsaved mark and keeps the saved record in the form', async () => {
  const h = harness({ runnerAnswer: { ok: true, pending: true, state: PENDING } });
  h.tickRunner();
  assert.strictEqual(h.unsaved(), 'Unsaved changes in: Test runner', 'ENTER: the block was edited');
  const refused = await h.ui.apply();
  assert.deepStrictEqual([refused.length, h.toasts], [0, []]);
  assert.strictEqual(h.ctx.prefsSuiteRunnerStatus.textContent, PENDING_LINE);
  assert.strictEqual(h.unsaved(), null);
  assert.deepStrictEqual([h.ctx.prefsSuiteRunnerEnabled.checked, h.ctx.prefsSuiteRunnerSlots.value], [true, '2']);
});

test('opening Preferences with a change pending shows the pending line', async () => {
  const h = harness();
  h.ctx.window.api.suiteRunnerGet = async () => PENDING;
  assert.notStrictEqual(h.ctx.prefsSuiteRunnerStatus.textContent, PENDING_LINE, 'ENTER: the line starts as the idle one');
  await h.ctx.refreshSuiteRunnerPrefs();
  assert.strictEqual(h.ctx.prefsSuiteRunnerStatus.textContent, PENDING_LINE);
});
