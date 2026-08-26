'use strict';
// workspace-count-suffix.test.js — the Window/tray workspace row must count the
// SAME population its Delete Workspace… dialog is about to destroy.
//
// THE SEAM. deleteWorkspaceDetail already took both populations (F005). The
// label beside it did not: it counted listForWorkspace, the live map, so a
// workspace holding only archived seats rendered with NO suffix at all — the
// visual vocabulary for "empty" — and then its confirm dialog said it holds N
// archived sessions this deletes. Two halves, each correct on its own terms,
// disagreeing about what a workspace contains. The label is what an operator
// reads before deciding to open the menu at all.
//
// The two counts are disjoint by construction (savedForWorkspace filters out
// anything in the live map), which is why summing them is not double-counting.
// That property is asserted below rather than assumed, because the sum is only
// meaningful while it holds.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStores } = require('../stores.js');
const { createSessionManager } = require('../session-manager.js');
const { workspaceCountSuffix } = require('../app-menus.js');
const { mkTmpRoot } = require('./lib/tmp-roots');

// ── Pure copy assertions ────────────────────────────────────────────────────

test('workspaceCountSuffix: archived-only workspace does not render as empty', () => {
  // The bug, stated as a test: 3 archived + 0 running used to yield ''.
  assert.strictEqual(workspaceCountSuffix(0, 3), ' — 3 sessions');
  assert.strictEqual(workspaceCountSuffix(0, 1), ' — 1 session');
});

test('workspaceCountSuffix: a genuinely empty workspace still renders bare', () => {
  // The absence must survive the fix, or the suffix stops meaning anything.
  assert.strictEqual(workspaceCountSuffix(0, 0), '');
});

test('workspaceCountSuffix: running-only keeps the pre-existing copy', () => {
  assert.strictEqual(workspaceCountSuffix(2, 0), ' — 2 sessions');
  assert.strictEqual(workspaceCountSuffix(1, 0), ' — 1 session');
});

test('workspaceCountSuffix: mixed names the reachable subset', () => {
  // Total first (it is what the delete destroys), running qualified — a click
  // reaches only those.
  assert.strictEqual(workspaceCountSuffix(1, 2), ' — 3 sessions (1 running)');
});

test('workspaceCountSuffix: pluralisation follows the TOTAL, not either part', () => {
  // 1+1 is two sessions. Agreeing with `running` here would print "1 sessions"
  // or "2 session" depending on which half was consulted.
  assert.strictEqual(workspaceCountSuffix(1, 1), ' — 2 sessions (1 running)');
});

// ── The disjointness the sum depends on ─────────────────────────────────────

function realStores() {
  const dir = mkTmpRoot('clodex-wscount-');
  return initStores(dir, {
    log: { info: () => {}, error: () => {} },
    registryDir: path.join(dir, 'registry'),
    resourcesDir: path.join(dir, '__no_seed__'), // absent on purpose: suppresses library seeding
  }).persistence;
}

function realManager(persistence) {
  const SessionManager = createSessionManager({
    getRemoteServer: () => null,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => persistence,
  });
  return new SessionManager();
}

test('savedForWorkspace and listForWorkspace never report the same seat', () => {
  const persistence = realStores();
  const mgr = realManager(persistence);
  const WS = 'ws-under-test';

  // Two archived rows and one live-and-persisted row in ONE workspace, plus a
  // row in a DIFFERENT workspace that must not leak into either count.
  persistence.upsert({ name: 'arch-1', type: 'claude', cwd: '/tmp', workspaceId: WS, sessionId: 'sid-a1' });
  persistence.upsert({ name: 'arch-2', type: 'claude', cwd: '/tmp', workspaceId: WS, sessionId: 'sid-a2' });
  persistence.upsert({ name: 'live-1', type: 'claude', cwd: '/tmp', workspaceId: WS, sessionId: 'sid-l1' });
  persistence.upsert({ name: 'elsewhere', type: 'claude', cwd: '/tmp', workspaceId: 'other-ws', sessionId: 'sid-e' });
  persistence.setArchived('arch-1', true);
  persistence.setArchived('arch-2', true);

  // The live map is reached directly: this test is about the two READERS of a
  // seat's state, not about spawning. A PTY-bearing session is what neither
  // reader may double-count.
  mgr.sessions.set('live-1', {
    name: 'live-1', type: 'claude', workspaceId: WS, cwd: '/tmp',
    pty: { pid: 4242 }, // list() reads pty.pid; nothing here spawns one
  });

  const running = mgr.listForWorkspace(WS).map(s => s.name);
  const saved = mgr.savedForWorkspace(WS).map(e => e.name);

  // ENTER: both sides must be non-empty, or the disjointness below is vacuous
  // — two empty sets never intersect, and every assertion after it would hold
  // over a fixture that built nothing.
  assert.ok(running.length > 0, `ENTER: live map produced no rows (got ${JSON.stringify(running)})`);
  assert.ok(saved.length > 0, `ENTER: persistence produced no saved rows (got ${JSON.stringify(saved)})`);

  assert.deepStrictEqual(running, ['live-1']);
  assert.deepStrictEqual(saved.sort(), ['arch-1', 'arch-2']);

  const overlap = running.filter(n => saved.includes(n));
  assert.deepStrictEqual(overlap, [], 'the two counts must be disjoint for their sum to be a count');

  // The workspace scoping both readers depend on.
  assert.ok(!saved.includes('elsewhere'), 'savedForWorkspace leaked another workspace');
  assert.ok(!running.includes('elsewhere'), 'listForWorkspace leaked another workspace');

  // And the label the operator actually sees for this state — the archived
  // seats are visible, the reachable subset is named.
  assert.strictEqual(
    workspaceCountSuffix(running.length, saved.length),
    ' — 3 sessions (1 running)',
  );
});

test('a workspace whose seats are ALL archived is the case the label used to hide', () => {
  const persistence = realStores();
  const mgr = realManager(persistence);
  const WS = 'all-archived';

  persistence.upsert({ name: 'only-arch', type: 'claude', cwd: '/tmp', workspaceId: WS, sessionId: 'sid-o' });
  persistence.setArchived('only-arch', true);

  const running = mgr.listForWorkspace(WS);
  const saved = mgr.savedForWorkspace(WS);

  // ENTER: the fixture must actually produce the asymmetric state. If the row
  // never landed, `saved` is empty, the suffix is '' — and a test asserting
  // the OLD buggy output would pass for the wrong reason.
  assert.strictEqual(running.length, 0, 'ENTER: expected no running seats');
  assert.strictEqual(saved.length, 1, `ENTER: expected the archived row, got ${JSON.stringify(saved.map(e => e.name))}`);

  assert.strictEqual(workspaceCountSuffix(running.length, saved.length), ' — 1 session');
});
