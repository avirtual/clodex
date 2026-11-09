'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METHOD = (name) => ({ header: new RegExp(`^ {4}(?:async )?${name}\\(`, 'm'), end: '\n    },\n' });

const ROWS = [
  { file: 'team-tickets.js', fn: '_roleInUse', ...METHOD('_roleInUse') },
  { file: 'team-tickets.js', fn: '_teamUnbind', ...METHOD('_teamUnbind') },
  { file: 'team-tickets.js', fn: '_requeueWaitingMerges', ...METHOD('_requeueWaitingMerges') },
  { file: 'team-tickets.js', fn: '_liveHandCount', ...METHOD('_liveHandCount') },
  { file: 'team-tickets.js', fn: '_startCapParked', ...METHOD('_startCapParked') },
  { file: 'team-tickets.js', fn: '_remoteTaskDone', ...METHOD('_remoteTaskDone') },
  { file: 'team-tickets.js', fn: '_watchParkedEscalation', ...METHOD('_watchParkedEscalation') },
  { file: 'team-tickets.js', fn: '_releaseDrainedEscalations', ...METHOD('_releaseDrainedEscalations') },
  { file: 'team-tickets.js', fn: '_taskListText', ...METHOD('_taskListText') },
  { file: 'team-tickets.js', fn: '_alarmCapParked', ...METHOD('_alarmCapParked') },
  { file: 'session-manager.js', fn: 'rename', ...METHOD('rename') },
  { file: 'remote-wiring.js', fn: 'ticketRows', header: /^ {2}function ticketRows\(/m, end: '\n  }\n' },
];

function bodyOf(row) {
  const src = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
  const m = row.header.exec(src);
  assert.ok(m, `${row.fn} not found in ${row.file}`);
  const stop = src.indexOf(row.end, m.index);
  assert.ok(stop > m.index, `${row.fn} end not found`);
  return src.slice(m.index, stop);
}

test('board-readers-cached: the table is not empty', () => {
  assert.strictEqual(ROWS.length, 12);
});

for (const row of ROWS) {
  test(`board-readers-cached: ${row.fn} reads the board through the cached parse`, () => {
    const body = bodyOf(row);
    assert.ok(body.includes('.read('), `${row.fn} has no .read(`);
    assert.ok(!body.includes('.load('), `${row.fn} still calls .load(`);
  });
}
