'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { initialSeatView, rememberedSeatView, seatViewSettings, createSeatView, applySeatView } = require('../renderer/lib/seat-view');

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

const PREFS_PTY = { transcriptPane: true, transcriptPaneMode: 'conversation', io: 'pty' };
const PREFS_STREAM = { transcriptPane: true, transcriptPaneMode: 'conversation', io: 'stream' };
for (const [remembered, settings, view] of [
  [undefined, PREFS_PTY, 'conversation'],
  ['internals', PREFS_PTY, 'internals'],
  ['terminal', PREFS_PTY, 'terminal'],
  ['terminal', PREFS_STREAM, 'conversation'],
  ['internals', PREFS_STREAM, 'internals'],
  ['bogus', PREFS_PTY, 'conversation'],
]) {
  test(`a rebuilt seat that last showed ${remembered} under ${settings.io} opens in ${view}`, () => {
    assert.strictEqual(rememberedSeatView(remembered, settings), view);
  });
}

for (const [applies, rebuilt] of [
  [[], 'conversation'],
  [['internals'], 'internals'],
  [['internals', 'terminal'], 'terminal'],
  [['terminal', 'conversation'], 'conversation'],
]) {
  test(`a pty seat shown ${JSON.stringify(applies)} is rebuilt in ${rebuilt}`, () => {
    const memory = new Map();
    const make = () => Object.assign(createSeatView(rememberedSeatView(memory.get('s1'), PREFS_PTY)), {
      liveSplit: { setRaw() {}, refresh() {} },
      onView: (v) => memory.set('s1', v),
    });
    const first = make();
    for (const v of applies) applySeatView(first, v);
    assert.strictEqual(make().view, rebuilt);
  });
}
