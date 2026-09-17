// Run: node --test test/jsonl-activity-turnend.test.js
//
// The ACTIVITY edge of the watcher, which is a different seam from the onText
// meta pinned in test/spoken-replies.test.js: `clodexctl exec` waits on the
// wire's `activity` event with turnEnd:true, and while the jsonl path reported
// every idle flush as a turn end that wait ended on the first tool call.
//
// Driven through the real line handler for the same reason spoken-replies is:
// a unit assertion on isTurnEndEntry says what the function returns, never
// whether the value reaches _onActivity.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createJsonlWatcher } = require('../jsonl-watcher');

function runWatcher(entries, onActivity) {
  const dir = mkTmpRoot('clodex-watcher-');
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: dir });
  const edges = [];
  const w = new JsonlWatcher('seat', () => {}, () => {},
    (state, turnEnd) => {
      edges.push([state, turnEnd]);
      if (onActivity) onActivity(state, turnEnd);
    });
  w._fd = fs.openSync(file, 'r');
  w._position = 0;
  w._readLines();
  // The terminator is the last line, leaving text pending exactly as a live
  // transcript does between turns; stop() performs the same final flush the
  // 1s-silence timer would.
  w.stop();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return edges;
}

test('an inter-tool flush reports idle with turnEnd false', () => {
  const edges = runWatcher([
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'working on it' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
  ]);
  assert.ok(edges.some(([s]) => s === 'idle'),
    'the idle edge must be observed at all — a silent watcher would pass every turnEnd assertion below');
  assert.deepStrictEqual(edges, [['thinking', false], ['idle', false]]);
});

test('a terminal end_turn flush reports idle with turnEnd true', () => {
  const edges = runWatcher([
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done' }] } },
  ]);
  assert.ok(edges.some(([s]) => s === 'idle'), 'the idle edge must be observed at all');
  assert.deepStrictEqual(edges, [['thinking', false], ['idle', true]]);
});

test('Codex task_complete reports idle with turnEnd true', () => {
  const edges = runWatcher([
    { type: 'event_msg', payload: { type: 'agent_message', message: 'all done' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.deepStrictEqual(edges, [['thinking', false], ['idle', true]]);
});

test('text, tool call, more text, end_turn: exactly one turnEnd edge and it is last', () => {
  const edges = runWatcher([
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'first' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'second' }] } },
  ]);
  const ends = edges.filter(([s, t]) => s === 'idle' && t === true);
  assert.strictEqual(ends.length, 1, `expected one turn-end edge, got ${JSON.stringify(edges)}`);
  assert.deepStrictEqual(edges[edges.length - 1], ['idle', true],
    'the turn-end edge must be the LAST one — the dedupe must not swallow a true edge that follows a false one for the same state');
  assert.deepStrictEqual(edges, [['thinking', false], ['idle', false], ['thinking', false], ['idle', true]]);
});

// THE DEDUPE RULE ITSELF, driven at the seam rather than through the line
// handler — deliberately, and this is the one pin here that no entry sequence
// can produce. Today every idle edge is preceded by a thinking edge (idle is
// emitted only from a flush that had pending text, and the branch that sets
// pending text emits thinking), so a state-only dedupe would never swallow a
// turn end. That invariant lives in _readLines, not in _setActivity, and the
// wait `clodexctl exec` performs is unrecoverable if it is ever broken: a
// swallowed true edge is a hang, not a late event. So the seam carries its own
// rule and this states it.
test('_setActivity: a true turn end is delivered even when the state did not change', () => {
  const { JsonlWatcher } = createJsonlWatcher({ REGISTRY_DIR: mkTmpRoot('clodex-watcher-') });
  const edges = [];
  const w = new JsonlWatcher('seat', () => {}, () => {}, (s, t) => edges.push([s, t]));

  w._setActivity('idle', false);
  w._setActivity('idle', false);
  w._setActivity('idle', true);
  w._setActivity('idle', true);
  assert.deepStrictEqual(edges, [['idle', true]],
    'no duplicate idle/false edges, one idle/true edge even without a state change, and no repeat of it');
});

// SOURCE SHAPE, because the callback session-manager hands the watcher cannot
// be reached without spawning a PTY. The end-to-end below drives the same
// expression; this is what says the shipped line IS that expression.
test('session-manager wires the watcher activity edge through turnEnd', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf-8');
  assert.ok(
    src.includes("(state, turnEnd) => this._emitActivity(name, state, state === 'idle' && !!turnEnd)"),
    'the JsonlWatcher construction must pass the watcher turnEnd through to _emitActivity',
  );
  assert.ok(
    !src.includes("(state) => this._emitActivity(name, state, state === 'idle')"),
    'the bare-idle form must be gone: it reports every inter-tool flush as a turn end',
  );
});

// END TO END over the real _emitActivity: the wire event `clodexctl exec` waits
// on is notifyActivity's third argument, and nothing between the watcher and it
// may flatten the flag.
test('the wire activity event carries false for a tool flush and true at end_turn', () => {
  const { mk } = require('./lib/session-fixtures');
  const wire = [];
  const m = mk({ getRemoteServer: () => ({ notifyActivity: (n, s, t) => wire.push([n, s, t]) }) });
  m.sessions.set('seat', { name: 'seat', workspaceId: 'ws1', activityState: 'idle' });

  runWatcher([
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'first' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result' }] } },
    { type: 'assistant', requestId: 'r1', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'second' }] } },
  ], (state, turnEnd) => m._emitActivity('seat', state, state === 'idle' && !!turnEnd));

  const idles = wire.filter(([, s]) => s === 'idle').map(([, , t]) => t);
  assert.deepStrictEqual(idles, [false, true],
    `the tool-result idle must reach the wire false and only the end_turn idle true — got ${JSON.stringify(wire)}`);
});
