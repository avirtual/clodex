'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summaryParts, footerOf, createTranscriptRows } = require('../renderer/transcript-rows');
const { fakeDocument } = require('./lib/fake-dom');

function mount() {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const rows = createTranscriptRows(doc, pane, {});
  return { pane, render: (records) => rows.render(records) };
}

const prompt = { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' };
const prose = { id: 'a1', kind: 'assistant', ts: null, turn: 1, text: 'on it' };
const pending = { id: 't1', kind: 'tool', ts: null, turn: 1, name: 'Bash', arg: 'date', state: 'pending', sum: null };
const done = { ...pending, state: 'ok', sum: { exit: 0, lines: 1, interrupted: false, background: false, persisted: null, only: 'Wed Sep 24 10:42:13 2026' } };
const bash = (sum, state = 'ok') => ({ kind: 'tool', name: 'Bash', state, sum: { exit: 0, lines: 0, interrupted: false, background: false, persisted: null, only: null, ...sum } });
const text = (parts) => parts.map(([t]) => t).join('');

test('a changed sig replaces only its own element; the turn block and its other rows keep their nodes', () => {
  const m = mount();
  m.render([prompt, prose, pending]);
  const turn = m.pane.childNodes[0];
  const [head, body, tool] = turn.childNodes;
  m.render([prompt, prose, done]);
  assert.strictEqual(m.pane.childNodes.length, 1);
  assert.strictEqual(m.pane.childNodes[0], turn);
  assert.strictEqual(turn.childNodes[0], head);
  assert.strictEqual(turn.childNodes[1], body);
  assert.notStrictEqual(turn.childNodes[2], tool);
  assert.strictEqual(tool.parentNode, null);
  assert.strictEqual(turn.childNodes[2].textContent, 'BashdateWed Sep 24 10:42:13 2026');
});

test('an unchanged record keeps its node identity across renders, a new one is appended and a gone one removed', () => {
  const m = mount();
  m.render([prompt, prose]);
  const turn = m.pane.childNodes[0];
  const [head, body] = turn.childNodes;
  m.render([prompt, prose]);
  assert.deepStrictEqual(turn.childNodes, [head, body]);
  const next = { id: 'p2', kind: 'prompt', ts: null, turn: 2, text: 'again', source: 'typed' };
  m.render([prompt, prose, next]);
  assert.strictEqual(m.pane.childNodes.length, 2);
  assert.strictEqual(m.pane.childNodes[0], turn);
  assert.deepStrictEqual(turn.childNodes, [head, body]);
  m.render([next]);
  assert.strictEqual(m.pane.childNodes.length, 1);
  assert.strictEqual(turn.parentNode, null);
  assert.strictEqual(m.pane.childNodes[0].childNodes[0].textContent, 'again');
});

test('markup in prompt, prose and tool arguments lands as text, never as elements', () => {
  const m = mount();
  const evil = '<img src=x onerror=alert(1)>&amp;';
  m.render([{ ...prompt, text: evil }, { ...prose, text: evil }, { ...pending, arg: evil }]);
  const all = [];
  const walk = (n) => { all.push(n); (n.childNodes || []).forEach(walk); };
  walk(m.pane);
  assert.deepStrictEqual([...new Set(all.filter((n) => n.nodeType === 1).map((n) => n.tag))].sort(), ['div', 'span']);
  const turn = m.pane.childNodes[0];
  assert.strictEqual(turn.childNodes[0].textContent, evil);
  assert.strictEqual(turn.childNodes[1].textContent, evil);
  assert.strictEqual(turn.childNodes[2].childNodes[2].textContent, evil);
});

test('a tool row is mark, name, argument and summary, with its state in the class', () => {
  const m = mount();
  m.render([pending]);
  const row = m.pane.childNodes[0].childNodes[0];
  assert.deepStrictEqual([row.className, row.dataset.id], ['tr-row tr-tool tr-state-pending', 't1']);
  assert.deepStrictEqual(row.childNodes.map((n) => [n.className, n.textContent]), [
    ['tr-mark', ''], ['tr-tool-name', 'Bash'], ['tr-tool-arg', 'date'], ['tr-tool-sum', 'running'],
  ]);
});

test('tool summaries read as the design table says', () => {
  const rows = [
    [bash({ lines: 30 }), '30 lines'],
    [bash({ lines: 1, only: 'Wed Sep 24' }), 'Wed Sep 24'],
    [bash({}), 'no output'],
    [bash({ exit: 1, lines: 4 }, 'error'), 'exit 1 · 4 lines'],
    [bash({ exit: null, lines: 0 }, 'error'), 'exit ?'],
    [{ kind: 'tool', name: 'Bash', state: 'error', sum: { message: 'Blocked: sleep 240' } }, 'Blocked: sleep 240'],
    [{ kind: 'tool', name: 'Bash', state: 'denied', sum: { message: 'x' } }, 'denied'],
    [bash({ background: true }), 'background'],
    [bash({ persisted: 47860, lines: 900 }), '46.7 KB'],
    [{ kind: 'tool', name: 'Edit', state: 'ok', sum: { file: 'a', add: 12, del: 3 } }, '+12 −3'],
    [{ kind: 'tool', name: 'Write', state: 'ok', sum: { file: 'a', created: true, add: 120, del: 0 } }, 'new · 120 lines'],
    [{ kind: 'tool', name: 'Read', state: 'ok', sum: { file: 'a', from: 1, to: 40, total: 428 } }, '1–40 of 428'],
    [{ kind: 'tool', name: 'Grep', state: 'ok', sum: { files: 3, lines: 14 } }, '14 lines in 3 files'],
    [{ kind: 'tool', name: 'Glob', state: 'ok', sum: { files: 9, truncated: false } }, '9 files'],
    [{ kind: 'tool', name: 'Agent', state: 'ok', sum: { description: 'Survey', model: 'haiku', status: 'completed' } }, 'Survey haiku'],
  ];
  assert.deepStrictEqual(rows.map(([r]) => text(summaryParts(r))), rows.map(([, want]) => want));
  assert.deepStrictEqual(summaryParts({ kind: 'tool', name: 'Edit', state: 'ok', sum: { add: 1, del: 2 } }), [['+1', 'tr-add'], [' ', ''], ['−2', 'tr-del']]);
  assert.deepStrictEqual(summaryParts(bash({ exit: 1, lines: 4 }, 'error')), [['exit 1 · 4 lines', 'tr-err']]);
});

test('a turn with a turn-end gets a footer of duration, tool count, errors and files changed; a live turn gets none', () => {
  const edit = { id: 't2', kind: 'tool', ts: null, turn: 1, name: 'Edit', arg: '/r/notes.txt', state: 'ok', sum: { file: '/r/notes.txt', add: 1, del: 1 } };
  const failed = { ...bash({ exit: 1, lines: 2 }, 'error'), id: 't3', ts: null, turn: 1, arg: 'false' };
  const end = { id: 'e1', kind: 'turn-end', ts: null, turn: 1, durationMs: 14000, messageCount: 9 };
  assert.strictEqual(footerOf([prompt, done, edit]), null);
  assert.deepStrictEqual(footerOf([prompt, done, edit, failed, end]), {
    durationMs: 14000, tools: 3, errors: 1, files: [{ file: '/r/notes.txt', add: 1, del: 1 }], compacted: null,
  });
  const m = mount();
  m.render([prompt, done, edit, failed, end]);
  const turn = m.pane.childNodes[0];
  const footer = turn.childNodes[turn.childNodes.length - 1];
  assert.strictEqual(turn.childNodes.length, 5);
  assert.strictEqual(footer.className, 'tr-row tr-footer');
  assert.strictEqual(footer.textContent, '14s · 3 tools · 1 error · notes.txt +1 −1');
  const link = footer.childNodes.find((n) => n.tag === 'a');
  assert.deepStrictEqual([link.className, link.dataset.path], ['pane-link', '/r/notes.txt']);
});

test('an inbound delivery renders as a sender card: the badge leads the text span, then byte size and the attachment as a path link', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'wirescope', text: 'Message (1569 bytes) attached: @/r/msg-6.txt', attached: { path: '/r/msg-6.txt', bytes: 1569 } }]);
  const card = m.pane.childNodes[0].childNodes[0];
  assert.strictEqual(card.className, 'tr-row tr-head tr-inbound');
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const text = card.childNodes[0];
  assert.deepStrictEqual(text.childNodes.map((n) => n.textContent), ['∿wirescope', '1.5 KB ', 'msg-6.txt']);
  assert.strictEqual(text.childNodes[0].className, 'tr-sender tr-sender-system');
  const link = text.childNodes[2];
  assert.deepStrictEqual([link.tag, link.textContent, link.dataset.path], ['a', 'msg-6.txt', '/r/msg-6.txt']);
});

test('an inbound from a system sender draws a system badge inline at the head of its text, not the wire\'s "from X" text', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'reminder', text: 'continue: t1 build' }]);
  const card = m.pane.childNodes[0].childNodes[0];
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const badge = card.childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-system');
  assert.strictEqual(badge.title, 'reminder');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', '◷'], ['tr-sender-name', 'reminder']]);
  assert.deepStrictEqual(card.childNodes[0].childNodes.map((n) => n.data ?? n.textContent), ['◷reminder', 'continue: t1 build']);
});

test('an inbound from a seat draws a seat badge inline: role initial, team prefix dropped, full token in the title', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'clodex-hand-1138-r2', text: 'done' }]);
  const card = m.pane.childNodes[0].childNodes[0];
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const badge = card.childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-seat');
  assert.strictEqual(badge.title, 'clodex-hand-1138-r2');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', 'H'], ['tr-sender-name', 'hand-1138-r2']]);
});

test('a two-paragraph inbound renders the badge once, first in the text span, with the prose following in the same span', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'reminder', text: 'first para\n\nsecond para' }]);
  const card = m.pane.childNodes[0].childNodes[0];
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const text = card.childNodes[0];
  assert.deepStrictEqual(text.childNodes.map((n) => n.className), ['tr-sender tr-sender-system', undefined, undefined, undefined, undefined]);
  assert.deepStrictEqual(text.childNodes.map((n) => n.data ?? n.textContent), ['◷reminder', 'first para', '\n', '\n', 'second para']);
});

test('a prompt head carries its local clock time; a boundary reads its token drop; an API error is an error notice', () => {
  const ts = new Date(2026, 8, 24, 10, 42).getTime();
  const m = mount();
  m.render([
    { ...prompt, ts },
    { id: 'b1', kind: 'boundary', ts: null, turn: 1, what: 'compact', trigger: 'manual', preTokens: 209703, postTokens: 7870 },
    { id: 'x1', kind: 'assistant', ts: null, turn: 1, text: 'API Error: 500', apiError: true },
  ]);
  const [head, boundary, notice] = m.pane.childNodes[0].childNodes;
  assert.deepStrictEqual(head.childNodes.map((n) => [n.className, n.textContent]), [['tr-head-text', 'run it'], ['tr-time', '10:42']]);
  assert.strictEqual(boundary.textContent, 'compacted · 210k → 8k tokens · manual');
  assert.deepStrictEqual([notice.className, notice.textContent], ['tr-row tr-notice tr-notice-error', 'API Error: 500']);
});

test('the turn-end record renders no row of its own', () => {
  const m = mount();
  m.render([{ id: 'e1', kind: 'turn-end', ts: null, turn: 0, durationMs: 2500, messageCount: 2 }]);
  assert.deepStrictEqual(m.pane.childNodes[0].childNodes.map((n) => n.textContent), ['2.5s']);
});

test('a theme change rebuilds command output with the new echo palette and leaves other rows alone', () => {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  let palette = { bg: '#102030', fg: '#aabbcc', prompt: '#445566' };
  const rows = createTranscriptRows(doc, pane, { echoPalette: () => palette });
  const output = { id: 'o1', kind: 'command-output', ts: null, turn: 1, text: '\x1b[48;2;240;240;240m\x1b[38;2;0;0;0m ls \x1b[49m\x1b[39m' };
  rows.render([prompt, output]);
  const turn = pane.childNodes[0];
  const [head, before] = turn.childNodes;
  assert.strictEqual(before.childNodes[0].style.cssText, 'color:rgb(170,187,204);background-color:rgb(16,32,48)');
  palette = { bg: '#000000', fg: '#ffffff', prompt: '#445566' };
  rows.render([prompt, output]);
  assert.strictEqual(turn.childNodes[0], head);
  assert.notStrictEqual(turn.childNodes[1], before);
  assert.strictEqual(turn.childNodes[1].childNodes[0].style.cssText, 'color:rgb(255,255,255);background-color:rgb(0,0,0)');
});
