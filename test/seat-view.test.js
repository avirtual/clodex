'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { initialSeatView, seatViewSettings, createSeatView, applySeatView } = require('../renderer/lib/seat-view');

for (const [settings, view] of [
  [{ transcriptPane: false, transcriptPaneMode: 'conversation', io: 'pty' }, 'terminal'],
  [{ transcriptPane: true, transcriptPaneMode: 'conversation', io: 'pty' }, 'conversation'],
  [{ transcriptPane: true, transcriptPaneMode: 'internals', io: 'pty' }, 'internals'],
  [{ transcriptPane: false, transcriptPaneMode: 'conversation', io: 'stream' }, 'conversation'],
  [{ transcriptPane: false, transcriptPaneMode: 'internals', io: 'stream' }, 'internals'],
]) {
  test(`${JSON.stringify(settings)} opens in ${view}`, () => {
    assert.strictEqual(initialSeatView(settings), view);
  });
}

test('the Prefs select writes transcriptPane + transcriptPaneMode and Terminal keeps the current mode', () => {
  assert.deepStrictEqual(seatViewSettings('conversation', 'internals'), { transcriptPane: true, transcriptPaneMode: 'conversation' });
  assert.deepStrictEqual(seatViewSettings('internals', 'conversation'), { transcriptPane: true, transcriptPaneMode: 'internals' });
  assert.deepStrictEqual(seatViewSettings('terminal', 'internals'), { transcriptPane: false, transcriptPaneMode: 'internals' });
});

test('a stream seat has no Terminal: applying it leaves the view and the pane mode alone', () => {
  const modes = [];
  const entry = Object.assign(createSeatView('internals'), { liveSplit: null, stream: { setMode: (m) => modes.push(m) } });
  applySeatView(entry, 'terminal');
  assert.deepStrictEqual([entry.view, modes], ['internals', []]);
  applySeatView(entry, 'conversation');
  assert.deepStrictEqual([entry.view, entry.lastView, modes], ['conversation', 'conversation', ['conversation']]);
});
