'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { initStores } = require('../stores.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');

function openStores() {
  const dir = mkTmpRoot('clodex-spill-');
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'),
  });
}

function saveExpr(checkbox) {
  const m = rendererSrc.match(/\n\s*intentSpill: (.*),\n/);
  assert.ok(m, 'ENTER: the save payload names intentSpill in renderer.js');
  return new Function('prefsIntentSpill', `return ${m[1]};`)(checkbox);
}

function populate(settings) {
  const m = rendererSrc.match(/\n\s*if \(prefsIntentSpill\) prefsIntentSpill\.checked = (.*);\n/);
  assert.ok(m, 'ENTER: openPrefs paints prefsIntentSpill from the settings object');
  const box = { checked: 'untouched' };
  new Function('prefsIntentSpill', 's', `prefsIntentSpill.checked = ${m[1]};`)(box, settings);
  return box.checked;
}

test('the checkbox exists in the prefs markup with the wording the ticket fixed', () => {
  assert.ok(html.includes('id="prefs-intent-spill"'),
    'no checkbox means the store key stays unreachable, which is the state before this ticket');
  assert.match(html, /<span>Spill long intent bodies to files<\/span>/);
  assert.match(html, /Claude seats only; on by default, and a change applies to every running seat from its next turn\./);
  assert.match(html, /its transcript keeps a one-line <code>… filed at &lt;path&gt;<\/code> note in place of the body \(the path is clickable\), the model is never sent it, and a <code>\[clodex\] … filed at …<\/code> note on its next prompt names the file/,
    'the transcript keeps a one-line note with a clickable path the model never sees, and the hint must say exactly that');
  assert.ok(!/receipt|Runtime note|filler/.test(html.slice(html.indexOf('prefs-intent-spill') - 1200, html.indexOf('prefs-intent-spill') + 400)),
    'the receipt and the filler no longer exist, so the hint must not describe either');
  assert.match(html, /Ticket specs and reports, messages between seats, operator notes and context handoffs over 800 bytes/,
    'the hint ENUMERATES what spills, so leaving a verb out of it is a false promise about that channel');
});

test('renderer.js holds the checkbox element, so the two expressions have something to read', () => {
  assert.match(rendererSrc,
    /const prefsIntentSpill = document\.getElementById\('prefs-intent-spill'\);/);
});

test('a ticked box saves `on` and an unticked one saves `off`', () => {
  assert.strictEqual(saveExpr({ checked: true }), 'on');
  assert.strictEqual(saveExpr({ checked: false }), 'off');
});

test('a missing control saves `off` rather than undefined', () => {
  assert.strictEqual(saveExpr(null), 'off');
});

test('the box round-trips through a real settings store', () => {
  const { uiSettings } = openStores();
  assert.strictEqual(uiSettings.get().intentSpill, 'on', 'ENTER: on is the shipped default');

  uiSettings.set({ intentSpill: saveExpr({ checked: false }) });
  assert.strictEqual(uiSettings.get().intentSpill, 'off');
  assert.strictEqual(populate(uiSettings.get()), false,
    'reopening Preferences must show the box the operator cleared');

  uiSettings.set({ intentSpill: saveExpr({ checked: true }) });
  assert.strictEqual(uiSettings.get().intentSpill, 'on');
  assert.strictEqual(populate(uiSettings.get()), true);
});

test('populate reads intentSpill and not a neighbouring on/off key', () => {
  assert.strictEqual(populate({ intentSpill: 'on', terminalRemote: 'off' }), true);
  assert.strictEqual(populate({ intentSpill: 'off', terminalRemote: 'on' }), false);
});

test('saving the spill box does not disturb the pref it was modelled on', () => {
  const { uiSettings } = openStores();
  uiSettings.set({ terminalRemote: 'on' });
  uiSettings.set({ intentSpill: 'on' });
  assert.strictEqual(uiSettings.get().terminalRemote, 'on');
});

test('the web bundle carries the same three halves as the renderer source', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8');
  assert.ok(bundle.includes('id="prefs-intent-spill"'));
  assert.match(bundle, /its transcript keeps a one-line <code>… filed at &lt;path&gt;<\/code> note in place of the body \(the path is clickable\), the model is never sent it, and a <code>\[clodex\] … filed at …<\/code> note on its next prompt names the file/,
    'a rebuild is owed whenever the hint text moves, or the web operator reads the old promise');
  assert.match(bundle, /prefsIntentSpill = document\.getElementById\("prefs-intent-spill"\)/);
  assert.match(bundle, /intentSpill: prefsIntentSpill/);
});
