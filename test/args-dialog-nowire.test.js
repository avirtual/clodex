'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const ipcSrc = fs.readFileSync(path.join(root, 'ipc-handlers.js'), 'utf8');

test('the Edit dialog has a Wire off row with its checkbox', () => {
  assert.match(html, /<label id="args-no-wire-row">Wire off/);
  assert.match(html, /<input type="checkbox" id="args-no-wire"/);
});

test('openArgsDialog gates the Wire off row on caps.noWire and hides it on a peer row', () => {
  assert.match(rendererSrc, /const noWireEditable = caps\.noWire && !argsSource;/);
  assert.match(rendererSrc, /argsNoWireRow\.style\.display = noWireEditable \? '' : 'none'/);
  assert.match(rendererSrc, /argsNoWire\.checked = noWireEditable && res\.noWire === true/);
});

test('the save sends noWire as the trailing setSessionArgs positional, undefined when the row is hidden', () => {
  assert.match(rendererSrc, /argsNoWireRow\.style\.display === 'none' \|\| !argsNoWire\)\s*\? undefined : argsNoWire\.checked/);
  assert.match(rendererSrc, /env, plugins, io, effort, mcpServers, noWire\]\)/);
});

test('session:setArgs takes noWire as its trailing parameter and puts it on the patch', () => {
  assert.match(ipcSrc, /handle\('session:setArgs', async \(e, [^)]*, mcpServers, noWire\) =>/);
  assert.match(ipcSrc, /plugins, io, effort, mcpServers, noWire,\s*\}, workspaceOfSender\(e\)\)/);
});

test('both restart rebuilds take noWire from the restart result', () => {
  assert.match(rendererSrc, /rebuildLiveRow\(name, snap, \{ io: res\.io, backend: res\.backend, noWire: res\.noWire \}\)/);
  assert.match(rendererSrc, /: snap\.effort \}, \{ io: res\.io, backend: res\.backend, noWire: res\.noWire \}\)/);
});
