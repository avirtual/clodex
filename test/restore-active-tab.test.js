'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SRC = read('renderer/renderer.js');
const PEERS = read('renderer/peers-ui.js');
const CSS = read('renderer/styles.css');

function switchSessionBody(src) {
  const m = src.match(/function switchSession\(name\)\s*\{[\s\S]*?\n\}/);
  return m ? m[0] : null;
}

function restoreLoop(src) {
  const m = src.match(/\(async function restoreSessions\(\)[\s\S]*?\n\}\)\(\);/);
  return m ? m[0] : null;
}

test('switchSession persists the tab it switched to, so a relaunch has something to restore', () => {
  const body = switchSessionBody(SRC);
  assert.ok(body, 'ENTER: switchSession(name) is still the one switch path');

  const assign = body.indexOf('activeSession = name;');
  assert.ok(assign > 0, 'ENTER: switchSession still assigns activeSession');

  const write = body.search(/setSidebarView\(\{\s*activeSession:\s*name\s*\}\)/);
  assert.ok(write > 0,
    'switchSession must write setSidebarView({ activeSession: name }): without it the '
    + 'workspace never learns which tab the operator was on');
  assert.ok(assign < write, 'the persist follows the assignment it records');
  assert.match(body.slice(write), /^setSidebarView\(\{[^)]*\}\)\.catch\(/,
    'the persist is fire-and-forget: a rejected view write must not break the switch');
});

test('the view write is a one-key patch, and peers-ui never carries activeSession', () => {
  const body = switchSessionBody(SRC);
  assert.ok(body, 'ENTER: switchSession(name) is still the one switch path');
  const call = body.match(/setSidebarView\(\{[^)]*\}\)/);
  assert.ok(call, 'ENTER: the persist call is there to inspect');
  assert.strictEqual(call[0], 'setSidebarView({ activeSession: name })',
    'exactly one key: workspaces.setView MERGES, so a wider object would clobber '
    + 'expandedPeers and the sidebar filter keys');

  assert.match(PEERS, /setSidebarView\(/, 'ENTER: peers-ui really does write the view');
  for (const m of PEERS.matchAll(/setSidebarView\(([\s\S]{0,120}?)\)/g)) {
    assert.ok(!/activeSession\s*:/.test(m[1]),
      `peers-ui must not carry activeSession — renderer.js owns that key: ${m[1]}`);
  }
});

test('peer sections are gated on the local restore finishing, and the gate always lifts', () => {
  const loop = restoreLoop(SRC);
  assert.ok(loop, 'ENTER: the restoreSessions IIFE is still the restore path');

  const add = loop.search(/classList\.add\('sessions-restored'\)/);
  assert.ok(add > 0, 'the restore marks the body once local sessions are in the sidebar');

  const fin = loop.search(/\}\s*finally\s*\{/);
  assert.ok(fin > 0,
    'the marker must sit in a finally: an early return or a rejected restoreSessions would '
    + 'otherwise leave peers hidden forever');
  assert.ok(fin < add, 'and the add is inside that finally, not before it');
});

test('styles.css hides peer rows until the restore marker lands', () => {
  const rule = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, sel]) => /body:not\(\.sessions-restored\)\s*\[data-peer-ui\]/.test(sel));
  assert.ok(rule, 'styles.css carries a body:not(.sessions-restored) [data-peer-ui] rule');
  assert.match(rule[2], /display\s*:\s*none/,
    'and it hides them: peer sections paint within ~500ms while local sessions take 2-3s');

  assert.match(PEERS, /dataset\.peerUi\s*=/,
    'ENTER: peers-ui still stamps data-peer-ui on the rows this rule selects');
});
