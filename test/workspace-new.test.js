'use strict';
// workspace-new.test.js — the workspace:new handler must PERSIST the record and
// RETURN its id, not just create a window. The web frontend stubs createWindow
// (browser tabs self-navigate), so the record has to be minted in the handler
// itself; otherwise the browser's New Workspace jumps to a phantom id absent from
// workspaces.json — missing from the Window switcher and gone at container
// relaunch. On desktop createWindow's own `if (!ws)` upsert then finds the record
// and no-ops, so the desktop path is behaviorally unchanged. registerIpcHandlers
// is transport-agnostic (Phase 1), so we drive it with capturing seams — no
// electron, no engine.

const { test } = require('node:test');
const assert = require('node:assert');
const { registerIpcHandlers } = require('../ipc-handlers');

function fixture() {
  const handlers = new Map();
  const capture = { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => handlers.set(ch, fn) };
  const records = [];
  const calls = { createWindow: [], refreshApp: 0, refreshTray: 0 };
  const workspaces = {
    get: (id) => records.find((w) => w.id === id) || null,
    upsert: (ws) => {
      const idx = records.findIndex((w) => w.id === ws.id);
      if (idx >= 0) records[idx] = { ...records[idx], ...ws }; else records.push(ws);
    },
  };
  registerIpcHandlers({
    ...capture,
    workspaces,
    // createWindow mirrors the desktop's own idempotent upsert so the test proves
    // the handler's pre-upsert makes it a no-op (record already present).
    createWindow: (id) => { calls.createWindow.push(id); if (!workspaces.get(id)) workspaces.upsert({ id, name: 'New Workspace', bounds: null }); },
    refreshAppMenu: () => { calls.refreshApp += 1; },
    refreshTrayMenu: () => { calls.refreshTray += 1; },
    log: { info() {}, error() {} },
  });
  return { handler: handlers.get('workspace:new'), records, calls };
}

test('workspace:new persists a record and returns its id', () => {
  const { handler, records, calls } = fixture();
  assert.equal(typeof handler, 'function', 'workspace:new handler registered');

  const id = handler({});
  assert.equal(typeof id, 'string', 'returns the minted id');
  assert.ok(/^ws-/.test(id), 'id follows the ws- convention');

  const rec = records.find((w) => w.id === id);
  assert.ok(rec, 'the workspace record was persisted (not a phantom)');
  assert.equal(rec.name, 'New Workspace', 'named like the desktop non-default branch');
  assert.equal(rec.bounds, null, 'bounds default to null');

  assert.deepEqual(calls.createWindow, [id], 'createWindow called once with the same id');
  assert.equal(calls.refreshApp, 1);
  assert.equal(calls.refreshTray, 1);
});

test('workspace:new pre-upsert makes createWindow\'s own upsert a no-op (single record)', () => {
  const { handler, records } = fixture();
  const id = handler({});
  assert.equal(records.filter((w) => w.id === id).length, 1, 'exactly one record for the new id');
});
