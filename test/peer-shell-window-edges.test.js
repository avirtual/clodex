'use strict';

// t379: the WIRING of the two edges where a renderer stops existing.
//
// `test/peer-shell-reload.test.js` proves the drop BEHAVES correctly over a real
// wire — one window's seats shed, another's survive. It cannot prove that main.js
// actually calls it, and the behaviour is identical at both edges by
// construction (the same method, the same workspace id), so a behavioural test
// cannot discriminate them either. What differs is only whether each edge is
// wired at all, and that is exactly the defect r1 found: the drop existed and
// was correct, and a window close never reached it.
//
// main.js requires electron and cannot be require()d here, so these are source
// pins — the same technique and the same reason as test/reboot-idle-wait-seam.js.
// A source pin is weak evidence of behaviour and strong evidence of PRESENCE,
// which is the property that regressed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Slice a handler body by BALANCING braces from its opening one, so an inner
// object or arrow literal cannot end the capture early and leave assertions
// reading a truncated slice where an absence is vacuously "true".
function handlerBody(src, head) {
  const at = src.indexOf(head);
  assert.ok(at > 0, `${head} is present in main.js`);
  const open = src.indexOf('{', at + head.length - 1);
  assert.ok(open > at, `${head} has a block body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error(`unbalanced braces in ${head}`);
}

test('BOTH edges where a renderer stops existing drop that window\'s peer terminal wants', () => {
  const closed = handlerBody(SRC, "win.on('closed', () => {");
  // ENTER: the slice must reach the handler's last statement, or an assertion
  // that something is PRESENT could fail for the wrong reason and one that it is
  // absent would pass vacuously.
  assert.match(closed, /refreshTrayMenu\(\)/,
    'ENTER: the captured close handler runs to its final call, so what follows is measured against the whole body');

  // The close edge is the one r1 found missing, and the worse of the two: after
  // unregisterWindow no navigation for this workspace can ever fire again, so a
  // want left here is permanent rather than self-healing.
  assert.match(closed, /dropWtermsForWindow\(workspaceId\)/,
    'closing a window sheds its peer terminal wants — otherwise an SSE, the far box\'s watcher mark and a spawned shell are held forever by a window that no longer exists');

  // Order matters only in one direction: the drop reads the peer manager, which
  // unregisterWindow does not touch, but a future edit that moved the drop after
  // a teardown of the engine would silently no-op. Pin that it precedes it.
  //
  // Both needles are CALL-shaped, not bare names: the prose above the drop
  // mentions `unregisterWindow` by name, so a name match finds the comment
  // first and reports an ordering violation that is not in the code. A pin that
  // fails on its own explanation is worse than no pin.
  assert.ok(closed.indexOf('pm.dropWtermsForWindow(') < closed.indexOf('manager.unregisterWindow('),
    'the drop runs while the window is still registered, so a future teardown between them cannot make it a silent no-op');

  const nav = handlerBody(SRC, "win.webContents.on('did-start-navigation', (details) => {");
  assert.match(nav, /dropWtermsForWindow\(workspaceId\)/, 'a reload sheds them too');
  // A same-document navigation keeps the renderer that placed the wants, and a
  // subframe never places any. Dropping on either would shed a live window's
  // streams — the over-reach hazard this ticket was fenced against.
  assert.match(nav, /isMainFrame/, 'and only for the main frame');
  assert.match(nav, /isSameDocument/, 'and only across documents, so an in-page navigation cannot shed a live renderer\'s streams');
});
