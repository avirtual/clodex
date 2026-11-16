'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { archiveConfirmText, guardedArchive } = require('../renderer/lib/archive-guard');

const BODY = 'Its process stops; the session is archived, not deleted, and can be resumed from its sidebar row.';

const ROWS = [
  ['idle seat, no ticket', { name: 'shop-hand', type: 'claude', activity: 'idle', team: 'shop', lead: 'shop' },
    `Archive session "shop-hand"?\n\n${BODY}`],
  ['working seat', { name: 'shop-hand', type: 'claude', activity: 'thinking', team: 'shop', lead: 'shop' },
    `Archive session "shop-hand"?\n\nWarning: shop-hand is working.\n\n${BODY}`],
  ['seat blocked on a dialog', { name: 'shop-hand', type: 'claude', activity: 'idle', attention: 'permission' },
    `Archive session "shop-hand"?\n\nWarning: shop-hand is working.\n\n${BODY}`],
  ['assignee of open ticket t123', { name: 'shop-hand', type: 'claude', activity: 'idle', ticket: 't123', team: 'shop', lead: 'shop' },
    `Archive session "shop-hand"?\n\nWarning: shop-hand holds ticket t123.\n\n${BODY}`],
  ['team lead', { name: 'shop', type: 'claude', activity: 'idle', team: 'shop', lead: 'shop' },
    `Archive session "shop"?\n\nWarning: shop is the lead of team shop.\n\n${BODY}`],
  ['working lead holding a ticket', { name: 'shop', type: 'codex', activity: 'thinking', ticket: 't9', team: 'shop', lead: 'shop' },
    `Archive session "shop"?\n\nWarning: shop is working and holds ticket t9 and is the lead of team shop.\n\n${BODY}`],
  ['bash session: always asks, never warns', { name: 'sh1', type: 'bash', activity: 'thinking', ticket: 't1', team: 'shop', lead: 'sh1' },
    `Archive session "sh1"?\n\n${BODY}`],
];

for (const label of ['idle seat, no ticket', 'working seat', 'assignee of open ticket t123', 'team lead', 'bash session: always asks, never warns']) {
  test(`ENTER: the table has the "${label}" row`, () => {
    assert.ok(ROWS.some(([l]) => l === label));
  });
}

for (const [label, row, want] of ROWS) {
  test(`archiveConfirmText: ${label}`, () => {
    assert.strictEqual(archiveConfirmText(row), want);
  });
}

function harness({ answer, lead = null }) {
  const calls = { confirm: [], archive: [], leadOf: [] };
  const deps = {
    leadOf: async (team) => { calls.leadOf.push(team); return lead; },
    confirm: (text) => { calls.confirm.push(text); return answer; },
    archive: async (name) => { calls.archive.push(name); },
  };
  return { calls, deps };
}

test('guardedArchive: a declined confirm archives nothing', async () => {
  const { calls, deps } = harness({ answer: false });
  const out = await guardedArchive({ name: 'shop-hand', type: 'claude', activity: 'idle', team: null }, deps);
  assert.strictEqual(out, false);
  assert.strictEqual(calls.confirm.length, 1, 'ENTER: the operator was asked');
  assert.deepStrictEqual(calls.archive, []);
});

test('guardedArchive: an accepted confirm archives once, and an idle seat is still asked', async () => {
  const { calls, deps } = harness({ answer: true });
  const out = await guardedArchive({ name: 'shop-hand', type: 'claude', activity: 'idle', team: null }, deps);
  assert.strictEqual(out, true);
  assert.deepStrictEqual(calls.confirm, [`Archive session "shop-hand"?\n\n${BODY}`]);
  assert.deepStrictEqual(calls.archive, ['shop-hand']);
});

test('guardedArchive: the lead comes from one leadOf lookup on the row team and lands in the text', async () => {
  const { calls, deps } = harness({ answer: true, lead: 'shop' });
  await guardedArchive({ name: 'shop', type: 'claude', activity: 'idle', team: 'shop' }, deps);
  assert.deepStrictEqual(calls.leadOf, ['shop']);
  assert.deepStrictEqual(calls.confirm, [`Archive session "shop"?\n\nWarning: shop is the lead of team shop.\n\n${BODY}`]);
  assert.deepStrictEqual(calls.archive, ['shop']);
});

test('renderer: every UI archive goes through requestArchiveRow, and the archive itself never asks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const callers = src.match(/[^\n]*\barchiveSessionRow\(/g) || [];
  assert.deepStrictEqual(callers.map((l) => l.trim()), [
    'async function archiveSessionRow(',
    'archive: (n) => archiveSessionRow(',
  ]);
  const start = src.indexOf('async function archiveSessionRow(');
  const body = src.slice(start, src.indexOf('\n}\n', start));
  assert.ok(body.includes('window.api.archiveSession('), 'ENTER: sliced the archive body');
  assert.doesNotMatch(body, /confirm\(/);
  assert.match(src, /requestArchiveRow\(name, 'sidebar'\)/);
  assert.match(src, /archiveSession: \(name\) => requestArchiveRow\(name, 'shortcut'\)/);
  assert.strictEqual((src.match(/guardedArchive\(/g) || []).length, 1, 'one shared guard call site');
});

test('main side: no archive path reaches a confirmation dialog', () => {
  for (const file of ['session-manager.js', 'ipc-handlers.js', 'team-tickets.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(/\barchive\(/.test(src), `ENTER: ${file} archives`);
    assert.doesNotMatch(src, /archive-guard|archiveConfirmText/, file);
  }
});
