// Run: node --test
// Source pins for renderer/renderer.js chrome that no headless harness reaches:
// the sidebar ✉ badge's click handler runs against a real DOM row and a live IPC
// bridge, so its behaviour is pinned by shape here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// flushPending refuses with reason `busy` / `compact-window` / `dialog-blocked`
// (session-manager.js flushPending, via _injectHoldReason). A refusal the badge
// does not explain is the defect this pins: the click cleared nothing, said
// nothing, and looked broken.
test('the ✉ badge click handler carries a tip for every reason flushPending can refuse with', () => {
  const handler = SRC.match(/const pendingEl = item\.querySelector[\s\S]{0,1200}?\n  }\n/);
  assert.ok(handler, 'ENTER: the badge click handler is still found by this anchor');
  const src = handler[0];

  for (const RE of [
    /'dialog-blocked':\s*'Blocked on a permission dialog — answer it first, then flush'/,
    /busy:\s*'Seat is mid-turn — parked messages ride its next prompt; flush again when it is idle'/,
    /'compact-window':\s*'Seat is compacting — flush again once it settles'/,
  ]) {
    assert.ok(RE.test(src), `badge tip missing for ${RE}`);
  }

  assert.ok(/r\.ok === false/.test(src), 'the tip is set on the refusal verdict, not unconditionally');
});
