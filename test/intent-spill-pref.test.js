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

const BOXES = [
  { key: 'spillTickets', v: 'prefsSpillTickets', id: 'prefs-spill-tickets', label: 'Spill ticket bodies (specs, reports, rejects)' },
  { key: 'spillMessages', v: 'prefsSpillMessages', id: 'prefs-spill-messages', label: 'Spill messages (dms, shouts)' },
  { key: 'spillProse', v: 'prefsSpillProse', id: 'prefs-spill-prose', label: 'Spill end-of-turn prose' },
];

function saveExpr(b, checkbox) {
  const m = rendererSrc.match(new RegExp(`\\n\\s*${b.key}: (.*),\\n`));
  assert.ok(m, `ENTER: the save payload names ${b.key} in renderer.js`);
  return new Function(b.v, `return ${m[1]};`)(checkbox);
}

function populate(b, settings) {
  const m = rendererSrc.match(new RegExp(`\\n\\s*if \\(${b.v}\\) ${b.v}\\.checked = (.*);\\n`));
  assert.ok(m, `ENTER: openPrefs paints ${b.v} from the settings object`);
  const box = { checked: 'untouched' };
  new Function(b.v, 's', `${b.v}.checked = ${m[1]};`)(box, settings);
  return box.checked;
}

test('the three checkboxes exist in the prefs markup with the wording the ticket fixed', () => {
  for (const b of BOXES) {
    assert.ok(html.includes(`id="${b.id}"`), `no ${b.id} checkbox means ${b.key} stays unreachable`);
    assert.ok(html.includes(`<span>${b.label}</span>`), `label for ${b.id}`);
  }
  assert.ok(!html.includes('id="prefs-intent-spill"'), 'the single switch is gone');
  assert.match(html, /Claude seats only; all three are on by default, and each applies to every running seat from its next turn\./);
  assert.match(html, /A spilled body is filed, and each request carries the two newest in full as examples; every earlier one appears in the transcript as the intent head, a bracketed runtime note and <code>\[agent:end\]<\/code>, the model sees only the ordinary confirmation/,
    'every body is filed, the two newest ride in full per request and earlier ones render as the intent around a runtime note, and the hint must say exactly that');
  assert.ok(!/receipt|Runtime note|filler/.test(html.slice(html.indexOf('prefs-spill-tickets') - 1500, html.indexOf('prefs-spill-prose') + 400)),
    'the receipt and the filler no longer exist, so the hint must not describe either');
  assert.match(html, /three kinds, each with its own switch: ticket bodies \(specs, reports, rejects\), messages \(dms between seats, shouts to the operator\), and the prose an agent writes after its last intent/,
    'the hint ENUMERATES what spills, so leaving a category out of it is a false promise about that channel');
});

test('renderer.js holds the checkbox elements, so the expressions have something to read', () => {
  for (const b of BOXES) {
    assert.ok(rendererSrc.includes(`const ${b.v} = document.getElementById('${b.id}');`), b.v);
  }
});

test('a ticked box saves true and an unticked one saves false', () => {
  for (const b of BOXES) {
    assert.strictEqual(saveExpr(b, { checked: true }), true, b.key);
    assert.strictEqual(saveExpr(b, { checked: false }), false, b.key);
  }
});

test('a missing control saves the default rather than undefined', () => {
  for (const b of BOXES) assert.strictEqual(saveExpr(b, null), true, b.key);
});

test('each box round-trips through a real settings store, independently', () => {
  for (const b of BOXES) {
    const { uiSettings } = openStores();
    assert.strictEqual(uiSettings.get()[b.key], true, `ENTER: ${b.key} ships on`);

    uiSettings.set({ [b.key]: saveExpr(b, { checked: false }) });
    assert.strictEqual(uiSettings.get()[b.key], false);
    assert.strictEqual(populate(b, uiSettings.get()), false,
      'reopening Preferences must show the box the operator cleared');
    for (const o of BOXES.filter((x) => x !== b)) {
      assert.strictEqual(uiSettings.get()[o.key], true, `clearing ${b.key} leaves ${o.key} on`);
    }

    uiSettings.set({ [b.key]: saveExpr(b, { checked: true }) });
    assert.strictEqual(uiSettings.get()[b.key], true);
    assert.strictEqual(populate(b, uiSettings.get()), true);
  }
});

test('populate reads its own key and not a neighbouring spill key', () => {
  for (const b of BOXES) {
    const others = Object.fromEntries(BOXES.filter((x) => x !== b).map((x) => [x.key, true]));
    assert.strictEqual(populate(b, { ...others, [b.key]: false }), false, b.key);
    const offOthers = Object.fromEntries(BOXES.filter((x) => x !== b).map((x) => [x.key, false]));
    assert.strictEqual(populate(b, { ...offOthers, [b.key]: true }), true, b.key);
  }
});

test('saving the spill boxes does not disturb the pref they were modelled on', () => {
  const { uiSettings } = openStores();
  uiSettings.set({ terminalRemote: 'on' });
  uiSettings.set({ spillTickets: false, spillMessages: true, spillProse: false });
  assert.strictEqual(uiSettings.get().terminalRemote, 'on');
});

test('the web bundle carries the same halves as the renderer source', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'web-dist', 'index.html'), 'utf8');
  assert.match(bundle, /every earlier one appears in the transcript as the intent head, a bracketed runtime note and <code>\[agent:end\]<\/code>, the model sees only the ordinary confirmation, and the terminal shows the filed path \(clickable\)/,
    'a rebuild is owed whenever the hint text moves, or the web operator reads the old promise');
  for (const b of BOXES) {
    assert.ok(bundle.includes(`id="${b.id}"`), `web-dist/index.html lacks the ${b.id} row`);
    assert.match(bundle, new RegExp(`${b.v} = document\\.getElementById\\("${b.id}"\\)`));
    assert.match(bundle, new RegExp(`${b.key}: ${b.v}`));
  }
});
