'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { summaryParts, footerOf, createTranscriptRows } = require('../renderer/transcript-rows');
const { fakeDocument } = require('./lib/fake-dom');

function mount(ctx = {}) {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const rows = createTranscriptRows(doc, pane, ctx);
  return { pane, rows, render: (records) => rows.render(records) };
}

const prompt = { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' };
const prose = { id: 'a1', kind: 'assistant', ts: null, turn: 1, text: 'on it' };
const pending = { id: 't1', kind: 'tool', ts: null, turn: 1, name: 'Bash', arg: 'date', state: 'pending', sum: null };
const done = { ...pending, state: 'ok', sum: { exit: 0, lines: 1, interrupted: false, background: false, persisted: null, only: 'Wed Sep 24 10:42:13 2026' } };
const bash = (sum, state = 'ok') => ({ kind: 'tool', name: 'Bash', state, sum: { exit: 0, lines: 0, interrupted: false, background: false, persisted: null, only: null, ...sum } });
const text = (parts) => parts.map(([t]) => t).join('');
const unbox = (n) => (/\btr-box\b/.test(n.className) ? n.childNodes.find((k) => k.className === 'tr-box-body').childNodes[0] : n);

test('a changed sig replaces only its own element; the turn block and its other rows keep their nodes', () => {
  const m = mount();
  m.render([prompt, prose, pending]);
  const turn = m.pane.childNodes[0];
  const [head, body, block] = turn.childNodes;
  const tool = block.childNodes[0];
  m.render([prompt, prose, done]);
  assert.strictEqual(m.pane.childNodes.length, 1);
  assert.strictEqual(m.pane.childNodes[0], turn);
  assert.strictEqual(turn.childNodes[0], head);
  assert.strictEqual(turn.childNodes[1], body);
  assert.strictEqual(turn.childNodes[2], block);
  assert.notStrictEqual(block.childNodes[0], tool);
  assert.strictEqual(tool.parentNode, null);
  assert.strictEqual(block.childNodes[0].textContent, 'BashdateWed Sep 24 10:42:13 2026');
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
  assert.strictEqual(turn.childNodes[2].childNodes[0].childNodes[2].textContent, evil);
});

test('a tool row is mark, name, argument and summary, with its state in the class', () => {
  const m = mount();
  m.render([pending]);
  const row = m.pane.childNodes[0].childNodes[0].childNodes[0];
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
  const card = unbox(m.pane.childNodes[0].childNodes[0]);
  assert.strictEqual(card.className, 'tr-row tr-head tr-inbound');
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const text = card.childNodes[0];
  assert.deepStrictEqual(text.childNodes.map((n) => n.textContent), ['∿wirescope', '1.5 KB ', 'msg-6.txt']);
  assert.strictEqual(text.childNodes[0].className, 'tr-sender tr-sender-system');
  const link = text.childNodes[2];
  assert.deepStrictEqual([link.tag, link.textContent, link.dataset.path], ['a', 'msg-6.txt', '/r/msg-6.txt']);
});

test('an inbound from a subagent of this seat is marked via subagent and its badge says the CLI attached it', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'nits-coords', via: 'subagent', text: 'hello' }]);
  const card = unbox(m.pane.childNodes[0].childNodes[0]);
  assert.strictEqual(card.className, 'tr-row tr-head tr-inbound');
  assert.strictEqual(card.dataset.via, 'subagent');
  const badge = card.childNodes[0].childNodes[0];
  assert.strictEqual(badge.textContent, 'Nnits-coords');
  assert.strictEqual(badge.title, 'Report from a subagent of this seat — attached by the CLI, not typed');
});

const headText = (m) => unbox(m.pane.childNodes[0].childNodes[0]).childNodes.find((n) => n.className === 'tr-head-text');

test('a prompt capped at its limit ends with a cut marker after its text', () => {
  const m = mount();
  m.render([{ ...prompt, truncated: true }]);
  const kids = headText(m).childNodes;
  const last = kids[kids.length - 1];
  assert.deepStrictEqual([last.className, last.textContent], ['tr-cut', ' … cut at 4 KB']);
});

test('a subagent report capped at its limit ends with the same cut marker', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'nits-coords', via: 'subagent', text: 'hello', truncated: true }]);
  const kids = headText(m).childNodes;
  const last = kids[kids.length - 1];
  assert.deepStrictEqual([last.className, last.textContent], ['tr-cut', ' … cut at 4 KB']);
});

test('a prompt or inbound under its limit carries no cut marker', () => {
  for (const rec of [prompt, { id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'nits-coords', via: 'subagent', text: 'hello' }]) {
    const m = mount();
    m.render([rec]);
    const text = headText(m);
    assert.ok(text && text.textContent.includes(rec.text), 'ENTER: the row rendered');
    assert.strictEqual(text.childNodes.some((n) => n.className === 'tr-cut'), false);
  }
});

test('an inbound from a system sender draws a system badge inline at the head of its text, not the wire\'s "from X" text', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'reminder', text: 'continue: t1 build' }]);
  const card = unbox(m.pane.childNodes[0].childNodes[0]);
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const badge = card.childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-system');
  assert.strictEqual(badge.title, 'reminder');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', '◷'], ['tr-sender-name', 'reminder']]);
  assert.deepStrictEqual(card.childNodes[0].childNodes.map((n) => n.data ?? n.textContent), ['◷reminder', 'continue: t1 build']);
});

test('an inbound from a seat named clodex draws a seat badge, never a system one', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'clodex', text: 'plan attached' }]);
  const badge = unbox(m.pane.childNodes[0].childNodes[0]).childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-seat');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', 'C'], ['tr-sender-name', 'clodex']]);
});

test('an inbound from a seat draws a seat badge inline: role initial, team prefix dropped, full token in the title', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'clodex-hand-1138-r2', text: 'done' }]);
  const card = unbox(m.pane.childNodes[0].childNodes[0]);
  assert.deepStrictEqual(card.childNodes.map((n) => n.className), ['tr-head-text']);
  const badge = card.childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-seat');
  assert.strictEqual(badge.title, 'clodex-hand-1138-r2');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', 'H'], ['tr-sender-name', 'hand-1138-r2']]);
});

test('a two-paragraph inbound renders the badge once, first in the text span, with the prose following in the same span', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'reminder', text: 'first para\n\nsecond para' }]);
  const card = unbox(m.pane.childNodes[0].childNodes[0]);
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
  assert.deepStrictEqual(notice.childNodes.map((n) => n.className), ['tr-mark', 'tr-notice-text']);
  assert.deepStrictEqual(notice.childNodes[1].childNodes.map((n) => n.data ?? n.textContent), ['API Error: 500']);
});

test('a compact boundary carrying elapsedMs ends its label with the elapsed time; without it the label is unchanged', () => {
  const m = mount();
  m.render([
    { ...prompt },
    { id: 'b1', kind: 'boundary', ts: null, turn: 1, what: 'compact', trigger: 'manual', preTokens: 156000, postTokens: 16000, elapsedMs: 27000 },
    { id: 'b2', kind: 'boundary', ts: null, turn: 1, what: 'compact', trigger: 'manual', preTokens: 156000, postTokens: 16000 },
  ]);
  const [, timed, plain] = m.pane.childNodes[0].childNodes;
  assert.strictEqual(timed.textContent, 'compacted · 156k → 16k tokens · manual · 27s');
  assert.strictEqual(plain.textContent, 'compacted · 156k → 16k tokens · manual');
});

test('a notice row links the path in its text, and clicking it resolves the path and opens it in the file peek', async () => {
  const calls = [];
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const ctx = {
    seatName: 'wirescope',
    resolveFile: (p) => { calls.push(['resolveFile', p]); return { ok: true, path: `/abs${p}` }; },
    openFilePeek: (...args) => calls.push(['openFilePeek', ...args]),
  };
  createTranscriptRows(doc, pane, ctx).render([{ id: 'n1', kind: 'notice', ts: null, turn: 1, level: 'info', text: '882 B of prose filed at /Users/b/.clodex/spill/w/3160.md' }]);
  const notice = unbox(pane.childNodes[0].childNodes[0]);
  assert.strictEqual(notice.className, 'tr-row tr-notice tr-notice-info');
  assert.deepStrictEqual(notice.childNodes.map((n) => n.className), ['tr-mark', 'tr-notice-text']);
  const parts = notice.childNodes[1].childNodes;
  assert.deepStrictEqual(parts.map((n) => n.data ?? n.textContent), ['882 B of prose filed at ', '/Users/b/.clodex/spill/w/3160.md']);
  const link = parts[1];
  assert.deepStrictEqual([link.tag, link.className, link.dataset.path], ['a', 'pane-link', '/Users/b/.clodex/spill/w/3160.md']);
  link.listeners.click({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(calls, [
    ['resolveFile', '/Users/b/.clodex/spill/w/3160.md'],
    ['openFilePeek', 'wirescope', '/abs/Users/b/.clodex/spill/w/3160.md', 'file', null],
  ]);
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

const { segmentsOf } = require('../transcript-records');
const { attachedReplies } = require('../renderer/transcript-rows');
const said = (id, turn, text) => ({ id, kind: 'assistant', ts: null, turn, text, segments: segmentsOf(text) });
const replyRec = (id, turn, verb, glyph, label, body) => ({ id, kind: 'reply', ts: null, turn, verb, glyph, label, text: body });
const cls = (n) => n.className;
const FILED = '/Users/x/.clodex/spill/clodex/2c45916d63a7c913.md';

test('consecutive intents form one stack of cards: head of glyph, label, target and chips, no brackets, no state word; prose after the stack is its own block', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:dm bob urgent] hi\n[agent:end]\n\n[agent:task done t4] ok\n[agent:end]\ntail words')]);
  const row = m.pane.childNodes[0].childNodes[0];
  assert.strictEqual(row.className, 'tr-row tr-prose tr-segs');
  assert.deepStrictEqual(row.childNodes.map(cls), ['intent-stack', 'tr-seg-prose']);
  const [dm, done] = row.childNodes[0].childNodes;
  assert.deepStrictEqual(dm.childNodes[0].childNodes.map((n) => [n.className, n.textContent]),
    [['intent-card-glyph', '→'], ['intent-card-label', 'message'], ['intent-card-target', 'bob'], ['intent-card-inline', 'hi'], ['intent-chip', 'urgent']]);
  assert.strictEqual(dm.childNodes.length, 1);
  assert.strictEqual(done.childNodes[0].textContent, '✓t4doneok');
  assert.strictEqual(row.childNodes[1].textContent, 'tail words');
  assert.ok(!row.textContent.includes('[agent:'), row.textContent);
  assert.ok(!/fire|fired/.test(row.textContent));
});

test('an inert line is the only card that shows brackets: ⊘ won\'t fire and the raw line', () => {
  const m = mount();
  m.render([said('a1', 0, 'x\n[agent:task bogus]')]);
  const row = m.pane.childNodes[0].childNodes[0];
  const card = row.childNodes[1].childNodes[0];
  assert.strictEqual(card.className, 'intent-card intent-card-inert');
  assert.deepStrictEqual(card.childNodes.map((n) => [n.className, n.textContent]),
    [['intent-card-head', "⊘ won't fire"], ['intent-card-raw', '[agent:task bogus]']]);
});

test('a filed body becomes a link to the spill, opened through the file peek', async () => {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const opened = [];
  const rows = createTranscriptRows(doc, pane, { seatName: 's', resolveFile: (p) => ({ ok: true, path: p }), openFilePeek: (...a) => opened.push(a) });
  rows.render([said('a1', 0, `[agent:dm clodex] Design saved — 6.2 KB filed at ${FILED}\n[agent:end]`)]);
  const card = pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  assert.strictEqual(card.className, 'intent-card intent-card-filed');
  assert.strictEqual(card.childNodes.length, 1);
  const inline = findCls(card.childNodes[0], 'intent-card-inline')[0];
  assert.strictEqual(inline.textContent, '▢ 6.2 KB filed · Design saved');
  const link = inline.childNodes[0].childNodes[1];
  assert.strictEqual(link.dataset.path, FILED);
  link.listeners.click({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(opened, [['s', FILED, 'file', undefined]]);
});

test('a body over two lines is clamped with a count of the rest, and a click expands it', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:shout] one\ntwo\nthree\nfour\n[agent:end]')]);
  const card = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  const [, body, foot] = card.childNodes;
  assert.strictEqual(body.className, 'intent-card-body intent-card-clamped');
  assert.strictEqual(foot.textContent, '+ 2 more lines');
  foot.listeners.click();
  assert.strictEqual(body.className, 'intent-card-body');
  assert.strictEqual(foot.hidden, true);
});

test('an unclosed body renders open and unclamped, with an unclosed warning chip last in the head', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:remind in 5m] watchdog\n\nUpdate as of 21:44:\n\nline three\nline four\nline five')]);
  const card = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  assert.strictEqual(card.className, 'intent-card intent-card-open');
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head', 'intent-card-body']);
  const head = card.childNodes[0];
  const chip = head.childNodes[head.childNodes.length - 1];
  assert.strictEqual(chip.className, 'intent-chip intent-chip-warn');
  assert.strictEqual(chip.textContent, 'unclosed');
  assert.strictEqual(chip.title, 'no [agent:end]: the rest of the reply was delivered as this body');
});

test('the same body closed with [agent:end] is clamped and carries no unclosed chip', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:remind in 5m] watchdog\n\nUpdate as of 21:44:\n\nline three\nline four\nline five\n[agent:end]')]);
  const card = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  assert.strictEqual(card.className, 'intent-card');
  const [head, body, foot] = card.childNodes;
  assert.strictEqual(body.className, 'intent-card-body intent-card-clamped');
  assert.strictEqual(foot.textContent, '+ 5 more lines');
  assert.ok(!head.childNodes.some((n) => n.textContent === 'unclosed'));
});

test('a two-line body is not clamped; an exec body is monospace; a bodyless intent is its head alone', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:shout] one\ntwo\n[agent:exec clodex-team] {"a":1}\n[agent:who]')]);
  const [shout, exec, who] = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes;
  assert.deepStrictEqual(shout.childNodes.map(cls), ['intent-card-head', 'intent-card-body']);
  assert.deepStrictEqual(exec.childNodes.map(cls), ['intent-card-head', 'intent-card-body intent-card-body-mono']);
  assert.deepStrictEqual(who.childNodes.map(cls), ['intent-card-head']);
});

test('a runtime reply row is the verb glyph and label in an app badge, titled Clodex runtime, with no seat name', () => {
  const m = mount();
  m.render([replyRec('r1', 1, 'task', '⇄', 'task', 'ticket t1 created')]);
  const row = unbox(m.pane.childNodes[0].childNodes[0]);
  assert.strictEqual(row.className, 'tr-row tr-head tr-reply');
  const badge = row.childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-app');
  assert.strictEqual(badge.title, 'Clodex runtime');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', '⇄'], ['tr-sender-name', 'task']]);
  assert.strictEqual(row.childNodes[0].textContent, '⇄taskticket t1 created');
});

test('a reply directly after the turn holding its card is attached with ↳; a reply after something else is not', () => {
  const tool = { id: 't1', kind: 'tool', ts: null, turn: 0, name: 'Bash', arg: 'x', state: 'ok', sum: { lines: 1 } };
  const m = mount();
  m.render([said('a1', 0, '[agent:task done t4] ok'), tool, replyRec('r1', 1, 'task', '⇄', 'task', 'closed')]);
  const reply = unbox(m.pane.childNodes[1].childNodes[0]);
  assert.strictEqual(reply.className, 'tr-row tr-head tr-reply tr-reply-attached');
  assert.strictEqual(reply.childNodes[0].childNodes[0].textContent, '↳');
  assert.strictEqual(reply.parentNode.parentNode.parentNode.parentNode, m.pane);
  const plain = { id: 'a0', kind: 'assistant', ts: null, turn: 0, text: 'no card' };
  m.render([plain, replyRec('r1', 1, 'task', '⇄', 'task', 'closed')]);
  assert.strictEqual(unbox(m.pane.childNodes[1].childNodes[0]).className, 'tr-row tr-head tr-reply');
});

test('attachedReplies pairs by verb within a run and attaches nothing for a verb whose counts disagree', () => {
  const recs = [
    said('a1', 0, '[agent:dm bob] x\n[agent:task add hand start] s\n[agent:task done t4] y'),
    replyRec('r1', 1, 'dm', '→', 'message', 'delivered'),
    replyRec('r2', 2, 'task', '⇄', 'task', 'created'),
    replyRec('r3', 3, 'intent', '⊘', 'bounced', 'nope'),
  ];
  assert.deepStrictEqual([...attachedReplies(recs)], ['r1']);
  recs.push(replyRec('r4', 4, 'task', '⇄', 'task', 'closed'));
  assert.deepStrictEqual([...attachedReplies(recs)], ['r1', 'r2', 'r4']);
  assert.deepStrictEqual([...attachedReplies([{ id: 'p', kind: 'prompt', turn: 1, text: 'hi' }, replyRec('r1', 2, 'dm', '→', 'message', 'x')])], []);
});

const call = (id, name, arg, state = 'ok', extra = {}) => ({ id, kind: 'tool', ts: null, turn: 1, name, arg, state, sum: state === 'pending' ? null : { exit: 0, lines: 0, interrupted: false, background: false, persisted: null, only: null }, ...extra });
const blocksOf = (m) => m.pane.childNodes[0].childNodes.filter((n) => /\btr-tool-block\b/.test(n.className));
const linesOf = (block) => block.childNodes.filter((n) => /\btr-tool-line\b/.test(n.className));
const headOf = (block) => block.childNodes.find((n) => n.className === 'tr-tool-head');

test('three consecutive Bash calls fold into one block headed Bash ×3; expanded it shows three lines of mark, argument and summary', () => {
  const m = mount();
  m.render([prompt, call('b1', 'Bash', 'ls'), call('b2', 'Bash', 'pwd'), call('b3', 'Bash', 'date')]);
  const blocks = blocksOf(m);
  assert.strictEqual(blocks.length, 1);
  headOf(blocks[0]).listeners.click();
  assert.strictEqual(blocks[0].className, 'tr-row tr-tool-block tr-tool-many');
  assert.strictEqual(headOf(blocks[0]).textContent, 'Bash ×3▾');
  assert.deepStrictEqual(linesOf(blocks[0]).map((l) => l.childNodes.map((n) => n.className)), [
    ['tr-mark', 'tr-tool-arg', 'tr-tool-sum'], ['tr-mark', 'tr-tool-arg', 'tr-tool-sum'], ['tr-mark', 'tr-tool-arg', 'tr-tool-sum'],
  ]);
  assert.deepStrictEqual(linesOf(blocks[0]).map((l) => l.childNodes[1].textContent), ['ls', 'pwd', 'date']);
});

test('Bash, Read, Bash are three blocks of one, each today\'s named row with no count', () => {
  const m = mount();
  m.render([prompt, call('b1', 'Bash', 'ls'), call('r1', 'Read', 'a.js'), call('b2', 'Bash', 'pwd')]);
  const blocks = blocksOf(m);
  assert.deepStrictEqual(blocks.map((b) => [b.className, b.childNodes.length, headOf(b)]), [
    ['tr-row tr-tool-block', 1, undefined], ['tr-row tr-tool-block', 1, undefined], ['tr-row tr-tool-block', 1, undefined],
  ]);
  assert.deepStrictEqual(blocks.map((b) => b.childNodes[0].childNodes[1].textContent), ['Bash', 'Read', 'Bash']);
  assert.ok(!/×/.test(m.pane.textContent));
});

test('a pending call joining a block keeps the block node and its dataset.id, and the earlier lines keep theirs', () => {
  const m = mount();
  const b1 = call('b1', 'Bash', 'ls');
  const b2 = call('b2', 'Bash', 'pwd');
  m.render([prompt, b1, b2]);
  const [block] = blocksOf(m);
  const id = block.dataset.id;
  assert.deepStrictEqual(linesOf(block).map((l) => l.childNodes[1].textContent), ['pwd']);
  m.render([prompt, b1, b2, call('b3', 'Bash', 'date', 'pending')]);
  assert.strictEqual(blocksOf(m).length, 1);
  assert.strictEqual(blocksOf(m)[0], block);
  assert.strictEqual(block.dataset.id, id);
  assert.strictEqual(headOf(block).textContent, 'Bash ×3▸');
  assert.deepStrictEqual(linesOf(block).map((l) => l.childNodes[1].textContent), ['date']);
});

test('an expanded block keeps its earlier line nodes when a pending call joins it', () => {
  const m = mount();
  const b1 = call('b1', 'Bash', 'ls');
  const b2 = call('b2', 'Bash', 'pwd');
  m.render([prompt, b1, b2]);
  const [block] = blocksOf(m);
  headOf(block).listeners.click();
  const [l1, l2] = linesOf(block);
  m.render([prompt, b1, b2, call('b3', 'Bash', 'date', 'pending')]);
  assert.strictEqual(blocksOf(m)[0], block);
  const lines = linesOf(block);
  assert.deepStrictEqual([lines.length, lines[0] === l1, lines[1] === l2], [3, true, true]);
});

test('prose between two Bash calls ends the block', () => {
  const m = mount();
  m.render([prompt, call('b1', 'Bash', 'ls'), { ...prose, id: 'a2' }, call('b2', 'Bash', 'pwd')]);
  const kids = m.pane.childNodes[0].childNodes;
  assert.deepStrictEqual(kids.map((n) => n.className), ['tr-row tr-head tr-prompt', 'tr-row tr-tool-block', 'tr-row tr-prose', 'tr-row tr-tool-block']);
});

test('a Bash line shows argShown with the raw command in its title, and a pending call shows its description as the summary', () => {
  const m = mount();
  m.render([prompt, call('b1', 'Bash', 'cd /r; npm test', 'pending', { argShown: 'npm test', desc: 'Run the suite' })]);
  const row = blocksOf(m)[0].childNodes[0];
  assert.deepStrictEqual([row.childNodes[2].textContent, row.childNodes[2].title, row.childNodes[3].textContent], ['npm test', 'cd /r; npm test', 'Run the suite']);
});

test('a prompt with a paste shows the pasted text inline in the head text, with no chip and no paste body', () => {
  const m = mount();
  const body = 'line one\nline two\nline three';
  m.render([{ ...prompt, text: 'see\n[Pasted text #1 +3 lines]', pastes: [{ n: 1, lines: 3, text: body }] }]);
  const row = m.pane.childNodes[0].childNodes[0];
  const find = (node, cls) => (node.className || '').split(' ').includes(cls) ? [node] : (node.childNodes || []).flatMap((k) => find(k, cls));
  assert.strictEqual(find(row, 'tr-paste-chip').length, 0);
  assert.strictEqual(find(row, 'tr-paste-body').length, 0);
  assert.strictEqual(find(row, 'tr-head-text')[0].textContent, 'see\nline one\nline two\nline three');
});

test('a prompt that is only a paste marker shows exactly the pasted text', () => {
  const m = mount();
  m.render([{ ...prompt, text: '[Pasted text #1 +2 lines]', pastes: [{ n: 1, lines: 2, text: 'alpha\nbeta' }] }]);
  const row = m.pane.childNodes[0].childNodes[0];
  const find = (node, cls) => (node.className || '').split(' ').includes(cls) ? [node] : (node.childNodes || []).flatMap((k) => find(k, cls));
  assert.strictEqual(find(row, 'tr-head-text')[0].textContent, 'alpha\nbeta');
});

const findCls = (node, cls) => (node.className || '').split(' ').includes(cls) ? [node] : (node.childNodes || []).flatMap((k) => findCls(k, cls));

test('a prompt with a pasted image shows a thumbnail in place of its marker, followed by the text', () => {
  const m = mount();
  m.render([{ ...prompt, text: '[Image #1]look at this', images: [{ n: 1, mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }]);
  const head = findCls(m.pane.childNodes[0].childNodes[0], 'tr-head-text')[0];
  const [img] = findCls(head, 'tr-image-thumb');
  assert.strictEqual(img.tag, 'img');
  assert.ok(img.src.startsWith('data:image/png;base64,iVBORw0KGgo='));
  assert.strictEqual(head.childNodes[0], img);
  assert.strictEqual(head.textContent, 'look at this');
});

test('a capped image shows a size chip in place of its marker', () => {
  const m = mount();
  m.render([{ ...prompt, text: 'see [Image #2]', images: [{ n: 2, mediaType: 'image/png', bytes: 2.1 * 1024 * 1024 }] }]);
  const head = findCls(m.pane.childNodes[0].childNodes[0], 'tr-head-text')[0];
  assert.strictEqual(findCls(head, 'tr-image-chip')[0].textContent, 'Image #2 · 2.1 MB');
  assert.strictEqual(head.textContent, 'see Image #2 · 2.1 MB');
});

test('a click on the thumbnail opens it full width and a second click closes it', () => {
  const m = mount();
  m.render([{ ...prompt, text: '[Image #1]', images: [{ n: 1, mediaType: 'image/png', data: 'AAAA' }] }]);
  const [img] = findCls(m.pane, 'tr-image-thumb');
  img.listeners.click();
  assert.ok(img.className.split(' ').includes('tr-image-open'));
  img.listeners.click();
  assert.ok(!img.className.split(' ').includes('tr-image-open'));
});

test('an image marker with no matching image stays literal text', () => {
  const m = mount();
  m.render([{ ...prompt, text: '[Image #2] and [Image #1]', images: [{ n: 1, mediaType: 'image/png', data: 'AAAA' }] }]);
  const head = findCls(m.pane.childNodes[0].childNodes[0], 'tr-head-text')[0];
  assert.strictEqual(head.textContent, '[Image #2] and ');
  assert.strictEqual(findCls(head, 'tr-image-thumb').length, 1);
});

test('the prompt row signature carries no image data, and a change in image size rebuilds the row', () => {
  const m = mount();
  const data = 'Q'.repeat(64);
  m.render([{ ...prompt, text: '[Image #1]', images: [{ n: 1, mediaType: 'image/png', data }] }]);
  const first = m.pane.childNodes[0].childNodes[0];
  m.render([{ ...prompt, text: '[Image #1]', images: [{ n: 1, mediaType: 'image/png', data: 'R'.repeat(64) }] }]);
  assert.strictEqual(m.pane.childNodes[0].childNodes[0], first);
  m.render([{ ...prompt, text: '[Image #1]', images: [{ n: 1, mediaType: 'image/png', data: data + 'QQQQ' }] }]);
  assert.notStrictEqual(m.pane.childNodes[0].childNodes[0], first);
});

test('the operator prompt row unclamps its head text while other head rows keep the three-line clamp', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  const start = css.indexOf('.tr-prompt > .tr-head-text {');
  assert.ok(start >= 0);
  const rule = css.slice(start, css.indexOf('}', start));
  assert.ok(rule.includes('-webkit-line-clamp: unset'));
});

function mountWorking() {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const clock = { t: 10000, ticks: [], cleared: [] };
  const rows = createTranscriptRows(doc, pane, {
    now: () => clock.t,
    setInterval: (fn, ms) => { clock.ticks.push({ fn, ms }); return clock.ticks.length; },
    clearInterval: (id) => clock.cleared.push(id),
  });
  const working = () => pane.childNodes.find((n) => String(n.className).includes('tr-working'));
  return { pane, rows, clock, working };
}

test('setWorking thinking draws a pulsing row last in the pane with its text and an elapsed time that ticks once a second', () => {
  const m = mountWorking();
  m.rows.render([prompt, prose]);
  m.rows.setWorking({ state: 'thinking', since: 7000, text: 'Brewing…' });
  const row = m.working();
  assert.strictEqual(m.pane.childNodes[m.pane.childNodes.length - 1], row);
  assert.ok(row.className.includes('tr-working-pulse'));
  assert.deepStrictEqual(row.childNodes.map((n) => [n.className, n.textContent]), [['tr-mark', ''], ['tr-working-text', 'Brewing…'], ['tr-working-elapsed', '3s']]);
  assert.deepStrictEqual(m.clock.ticks.map((x) => x.ms), [1000]);
  m.clock.t = 75000;
  m.clock.ticks[0].fn();
  assert.strictEqual(row.childNodes[2].textContent, '1m 8s');
  m.rows.render([prompt, prose, { ...prompt, id: 'p2', turn: 2 }]);
  assert.strictEqual(m.pane.childNodes[m.pane.childNodes.length - 1], row);
  assert.strictEqual(m.clock.ticks.length, 1);
});

test('setWorking without a text reads "Working" and names the pending tool on a stream seat', () => {
  const m = mountWorking();
  m.rows.render([prompt, pending]);
  m.rows.setWorking({ state: 'thinking', since: 10000 });
  assert.strictEqual(m.working().childNodes[1].textContent, 'Working · Bash');
  m.rows.render([prompt, done]);
  assert.strictEqual(m.working().childNodes[1].textContent, 'Working');
});

test('setWorking attention is a still "Waiting for you" row with no pulse and no ticking; idle removes the row and stops the tick', () => {
  const m = mountWorking();
  m.rows.render([prompt]);
  m.rows.setWorking({ state: 'thinking', since: 9000 });
  m.rows.setWorking({ state: 'attention', since: null });
  const row = m.working();
  assert.ok(row.className.includes('tr-working-still'));
  assert.ok(!row.className.includes('tr-working-pulse'));
  assert.strictEqual(row.childNodes[1].textContent, 'Waiting for you');
  assert.strictEqual(row.childNodes[2].textContent, '');
  assert.deepStrictEqual(m.clock.cleared, [1]);
  m.rows.setWorking({ state: 'thinking', since: 9000 });
  m.rows.setWorking({ state: 'idle' });
  assert.strictEqual(m.working(), undefined);
  assert.deepStrictEqual(m.clock.cleared, [1, 2]);
});

test('a tool left pending in an earlier turn does not label the working row of a later turn', () => {
  const m = mountWorking();
  m.rows.render([prompt, pending, { ...prompt, id: 'p2', turn: 2 }]);
  m.rows.setWorking({ state: 'thinking', since: 10000 });
  assert.strictEqual(m.working().childNodes[1].textContent, 'Working');
});

const boxOf = (m, id) => m.pane.childNodes[0].childNodes.find((n) => n.dataset.id === id);
const boxHeadOf = (box) => box.childNodes.find((n) => n.className === 'tr-box-head');

test('a 30-line task reply folds to a head of badge, first line and chevron; a click opens it and a rebuilt node stays open', () => {
  const m = mount();
  const list = Array.from({ length: 30 }, (_, i) => `t${i + 1} open hand`).join('\n');
  const rec = replyRec('r1', 1, 'task', '⇄', 'task', `tickets on clodex:\n${list}`);
  m.render([rec]);
  const box = boxOf(m, 'r1');
  assert.strictEqual(box.className, 'tr-box tr-box-folded');
  const head = boxHeadOf(box);
  assert.deepStrictEqual(head.childNodes.map((n) => [n.className, n.textContent]), [
    ['tr-sender tr-sender-app', '⇄task'], ['tr-box-preview', 'tickets on clodex:'], ['tr-box-chevron', '▸'],
  ]);
  head.listeners.click();
  assert.strictEqual(box.className, 'tr-box');
  assert.strictEqual(head.childNodes[2].textContent, '▾');
  m.render([{ ...rec, text: `${rec.text}\nt31 open hand` }]);
  const rebuilt = boxOf(m, 'r1');
  assert.notStrictEqual(rebuilt, box);
  assert.strictEqual(rebuilt.className, 'tr-box');
  assert.strictEqual(boxHeadOf(rebuilt).childNodes[2].textContent, '▾');
});

test('a one-line reply renders open, as a box body with no head and no chevron', () => {
  const m = mount();
  m.render([replyRec('r1', 1, 'task', '⇄', 'task', 'ticket t1 created')]);
  const box = boxOf(m, 'r1');
  assert.strictEqual(box.className, 'tr-box');
  assert.deepStrictEqual(box.childNodes.map((n) => n.className), ['tr-box-body']);
  assert.ok(!/[▸▾]/.test(m.pane.textContent));
});

test('a folded head clips a long first line to 120 characters', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'reminder', text: 'x'.repeat(300) }]);
  const preview = boxHeadOf(boxOf(m, 'i1')).childNodes[1];
  assert.strictEqual(preview.textContent, `${'x'.repeat(120)}…`);
});

test('a 13-call Bash block shows its header and only the last call; a click on the header shows all 13 and a re-render keeps them', () => {
  const m = mount();
  const calls = Array.from({ length: 13 }, (_, i) => call(`b${i + 1}`, 'Bash', `cmd${i + 1}`));
  m.render([prompt, ...calls]);
  const [block] = blocksOf(m);
  assert.strictEqual(block.className, 'tr-row tr-tool-block tr-tool-many tr-tool-folded');
  assert.strictEqual(headOf(block).textContent, 'Bash ×13▸');
  assert.deepStrictEqual(linesOf(block).map((l) => l.childNodes[1].textContent), ['cmd13']);
  headOf(block).listeners.click();
  assert.strictEqual(linesOf(block).length, 13);
  assert.strictEqual(headOf(block).textContent, 'Bash ×13▾');
  m.render([prompt, ...calls]);
  assert.strictEqual(linesOf(block).length, 13);
});

const { ticketOf } = require('../transcript-records');
const { segmentSurface } = require('../renderer/lib/transcript-surface');
const inb = (id, turn, from, body) => {
  const ticket = ticketOf(body);
  return { id, kind: 'inbound', ts: null, turn, from, text: body, ...(ticket ? { ticket } : {}) };
};
const taskReply = (id, turn, body) => {
  const ticket = ticketOf(body, 'reply');
  return { ...replyRec(id, turn, 'task', '⇄', 'task', body), ...(ticket ? { ticket } : {}) };
};
const isHidden = (n) => /\btr-hidden\b/.test(n.className);
const shown = (turn) => turn.childNodes.filter((n) => !isHidden(n)).map((n) => n.className);
const rowsOf = (turn) => turn.childNodes.filter((n) => !/\btr-footer\b/.test(n.className));

test('in Conversation mode internal rows and tool blocks carry tr-hidden while prompts, prose and ticket lifecycle rows do not; Internals clears it', () => {
  const m = mount();
  m.render([
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' },
    inb('u1', 1, 'user', 'from the panel'),
    { id: 'a1', kind: 'assistant', ts: null, turn: 1, text: 'on it' },
    taskReply('r1', 1, 'ticket t1 created'),
    inb('i1', 1, 'ticket-loop', '[ticket t1 ACCEPT] review round 2, no must-fixes.'),
    inb('i2', 1, 'ticket-loop', 'ticket t1 accepted'),
    { id: 'n1', kind: 'notice', ts: null, turn: 1, level: 'info', text: 'filed' },
    call('t1', 'Bash', 'ls'),
    call('t2', 'Bash', 'pwd'),
  ]);
  const hidden = () => rowsOf(m.pane.childNodes[0]).map((n) => [n.dataset.id, isHidden(n)]);
  assert.deepStrictEqual(hidden().filter(([, h]) => h), []);
  m.rows.setMode('conversation');
  assert.deepStrictEqual(hidden(), [
    ['p1', false], ['u1', false], ['a1', false], ['r1', false], ['i1', false], ['i2', true], ['n1', true], ['tools:t1', true],
  ]);
  m.rows.setMode('internals');
  assert.deepStrictEqual(hidden().filter(([, h]) => h), []);
});

test('a pane created in Conversation mode hides a markerless ticket-loop inbound on first render and shows a marked one', () => {
  const m = mount({ mode: 'conversation' });
  m.render([prompt, inb('i1', 1, 'ticket-loop', 'ticket t1 accepted'), inb('i2', 1, 'ticket-loop', '[ticket t1 MERGED] merged')]);
  assert.strictEqual(isHidden(boxOf(m, 'i1')), true);
  assert.strictEqual(isHidden(boxOf(m, 'i2')), false);
});

test('in Conversation mode a turn with no conversation row is hidden, and a turn headed by a reminder stays visible, folded, for its prose or API error', () => {
  const m = mount();
  m.render([
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' },
    inb('i0', 1, 'ticket-loop', 'ticket t0 accepted'),
    inb('i1', 2, 'ticket-loop', 'ticket t1 accepted'),
    { id: 'e1', kind: 'turn-end', ts: null, turn: 2, durationMs: 5, messageCount: 1 },
    inb('i2', 3, 'ticket-loop', 'ticket t2 accepted'),
    { id: 'a2', kind: 'assistant', ts: null, turn: 3, text: 'noted' },
    inb('m4', 4, 'reminder', 'continue: t9 build'),
    { id: 'a4', kind: 'assistant', ts: null, turn: 4, text: 'carrying on' },
    inb('m5', 5, 'reminder', 'continue: t9 build'),
    { id: 'a5', kind: 'assistant', ts: null, turn: 5, apiError: true, text: 'API Error: 500' },
  ]);
  const turns = () => m.pane.childNodes.map((n) => [rowsOf(n).map((c) => c.dataset.id || c.className).join(','), isHidden(n)]);
  m.rows.setMode('conversation');
  const fold = 'tr-row tr-turn-fold';
  assert.deepStrictEqual(turns(), [['p1,i0', false], [fold, true], [fold, false], [fold, false], [fold, false]]);
  m.rows.setMode('internals');
  assert.deepStrictEqual(turns().filter(([, h]) => h), []);
});

test('a turn of only tool calls and a turn-end is hidden in Conversation and shown in Internals', () => {
  const m = mount();
  m.render([
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' },
    call('t1', 'Bash', 'ls', 'ok', { turn: 2 }),
    { id: 'e1', kind: 'turn-end', ts: null, turn: 2, durationMs: 5, messageCount: 1 },
  ]);
  const turns = () => m.pane.childNodes.map((n) => [rowsOf(n).map((c) => c.dataset.id).join(','), isHidden(n)]);
  assert.deepStrictEqual(turns(), [['p1', false], ['tools:t1', false]]);
  m.rows.setMode('conversation');
  assert.deepStrictEqual(turns(), [['p1', false], ['tools:t1', true]]);
  m.rows.setMode('internals');
  assert.deepStrictEqual(turns().filter(([, h]) => h), []);
});

test('an exec card inside a visible prose row is absent in Conversation, present after a switch to Internals, absent again after switching back; a pure-prose row keeps its node', () => {
  const mixed = said('a1', 1, 'looking now\n[agent:exec clodex-run-tests] {}\nall green');
  assert.deepStrictEqual(mixed.segments.map((g) => [g.kind, segmentSurface(g)]), [['prose', 'conversation'], ['intent', 'internals'], ['prose', 'conversation']], 'ENTER: the row has an internal segment');
  const plain = { id: 'a2', kind: 'assistant', ts: null, turn: 1, text: 'plain' };
  const m = mount({ mode: 'conversation' });
  m.render([{ id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' }, mixed, plain]);
  const row = () => boxOf(m, 'a1');
  const shape = () => row().childNodes.map((n) => n.className);
  const plainNode = boxOf(m, 'a2');
  assert.strictEqual(isHidden(row()), false);
  assert.deepStrictEqual(shape(), ['tr-seg-prose', 'tr-seg-prose']);
  assert.deepStrictEqual(row().childNodes.map((n) => n.textContent), ['looking now', 'all green']);
  m.rows.setMode('internals');
  assert.deepStrictEqual(shape(), ['tr-seg-prose', 'intent-stack', 'tr-seg-prose']);
  assert.strictEqual(row().childNodes[1].childNodes.filter((n) => /\bintent-card\b/.test(n.className)).length, 1);
  m.rows.setMode('conversation');
  assert.deepStrictEqual(shape(), ['tr-seg-prose', 'tr-seg-prose']);
  assert.strictEqual(boxOf(m, 'a2'), plainNode);
});

test('a ticket lifecycle row carries tr-ticket and a chip reading the id and tag, short or folded', () => {
  const long = `[ticket t8 REJECTED] round 2\n${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')}`;
  const m = mount();
  m.render([inb('i7', 1, 'ticket-loop', '[ticket t7 MERGED] merged into master'), inb('i8', 1, 'ticket-loop', long), taskReply('r1', 1, 'ticket t1 created'), inb('i9', 1, 'ticket-loop', 'plain')]);
  const chip = (box) => [box, boxHeadOf(box)].filter(Boolean).flatMap((n) => n.childNodes).find((n) => n.className === 'tr-ticket-chip');
  assert.strictEqual(boxOf(m, 'i7').className, 'tr-box tr-ticket');
  assert.strictEqual(chip(boxOf(m, 'i7')).textContent, 't7 MERGED');
  assert.strictEqual(chip(boxOf(m, 'i8')).parentNode.className, 'tr-box-head');
  assert.strictEqual(chip(boxOf(m, 'i8')).textContent, 't8 REJECTED');
  assert.strictEqual(chip(boxOf(m, 'r1')).textContent, 't1 created');
  assert.strictEqual(boxOf(m, 'i9').className, 'tr-box');
  assert.strictEqual(chip(boxOf(m, 'i9')), undefined);
});

test('a mode switch keeps a pane that follows the bottom at the bottom, and otherwise re-anchors on the next visible turn when the anchored one hides', () => {
  const m = mount();
  m.render([
    { id: 'p1', kind: 'prompt', ts: null, turn: 1, text: 'run it', source: 'typed' },
    inb('i2', 2, 'reminder', 'continue'),
    { id: 'p3', kind: 'prompt', ts: null, turn: 3, text: 'again', source: 'typed' },
  ]);
  const [t1, t2, t3] = m.pane.childNodes;
  Object.assign(t1, { offsetTop: 0, offsetHeight: 100 });
  Object.assign(t2, { offsetTop: 100, offsetHeight: 50 });
  Object.assign(t3, { offsetTop: 150, offsetHeight: 50 });
  Object.assign(m.pane, { scrollTop: 120, clientHeight: 100, scrollHeight: 1000 });
  m.rows.setMode('conversation');
  assert.strictEqual(isHidden(t2), true);
  assert.strictEqual(m.pane.scrollTop, 170);
  m.rows.setMode('internals');
  Object.assign(m.pane, { scrollTop: 900, scrollHeight: 1000 });
  m.rows.setMode('conversation');
  assert.strictEqual(m.pane.scrollTop, 1000);
});

test('a long attached reply folds to a head led by ↳ and an unattached one does not', () => {
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const m = mount();
  m.render([said('a1', 0, '[agent:task done t4] ok'), replyRec('r1', 1, 'task', '⇄', 'task', long)]);
  const head = boxHeadOf(m.pane.childNodes[1].childNodes[0]);
  assert.strictEqual(head.childNodes[0].className, 'tr-reply-lead');
  assert.strictEqual(head.childNodes[0].textContent, '↳');
  m.render([{ id: 'a0', kind: 'assistant', ts: null, turn: 0, text: 'no card' }, replyRec('r1', 1, 'task', '⇄', 'task', long)]);
  const plain = boxHeadOf(m.pane.childNodes[1].childNodes[0]);
  assert.notStrictEqual(plain.childNodes[0].className, 'tr-reply-lead');
});

test('the pane modules never call array methods on childNodes, which is a NodeList in the browser', () => {
  const read = (f) => require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', f), 'utf8');
  for (const f of ['transcript-rows.js', 'live-split-view.js']) {
    assert.doesNotMatch(read(f), /childNodes\.(find|filter|map|some|every|reduce|flatMap|slice|indexOf|includes)\(/, f);
  }
});

test('a hidden ticket row stays hidden: the ticket layout applies display only when the row is not tr-hidden', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /^\.tr-ticket:not\(\.tr-hidden\) \{[^}]*display: flex/m);
  assert.doesNotMatch(css, /^\.tr-ticket \{[^}]*display:/m);
});

test('a turn separator follows only a visible turn, so a hidden leading turn leaves no line above the first visible one', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(css, /^\.tr-turn:not\(\.tr-hidden\) ~ \.tr-turn \{/mu);
  assert.doesNotMatch(css, /\.tr-turn \+ \.tr-turn/u);
});

const { mergeCompactNotices } = require('../compact-notices');
const ask = (id, turn, text = 'go') => ({ id, kind: 'prompt', ts: null, turn, text, source: 'typed' });
const talk = (id, turn, text = 'ok') => ({ id, kind: 'assistant', ts: null, turn, text });
const ended = (id, turn, durationMs) => ({ id, kind: 'turn-end', ts: null, turn, durationMs, messageCount: 1 });
const togglesOf = (m) => findCls(m.pane, 'tr-run-toggle');
const cardsOf = (m) => findCls(m.pane, 'intent-card');
const turnOf = (m, key) => m.pane.childNodes.find((n) => n.dataset && n.dataset.turn === key);
const rowIn = (m, id) => m.pane.childNodes.flatMap((t) => t.childNodes || []).find((n) => n.dataset && n.dataset.id === id);
const clickToggle = (m, i = 0) => togglesOf(m)[i].listeners.click();
const execSaid = (id, turn) => said(id, turn, 'looking now\n[agent:exec clodex-run-tests] {}\nall green');

test('runs: a run whose only hidden content is one exec segment in a visible prose row gets an expander; a click shows the card, internals→conversation keeps it open, collapse hides it', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), execSaid('a1', 1), ended('e1', 1, 2000)]);
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(cardsOf(m).length, 0, 'ENTER: the exec segment is omitted before the click');
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'false');
  assert.strictEqual(togglesOf(m)[0].tag, 'button');
  clickToggle(m);
  assert.strictEqual(cardsOf(m).length, 1);
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'true');
  m.rows.setMode('internals');
  assert.strictEqual(togglesOf(m).length, 0);
  m.rows.setMode('conversation');
  assert.strictEqual(cardsOf(m).length, 1);
  clickToggle(m);
  assert.strictEqual(cardsOf(m).length, 0);
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'false');
});

test('runs: an expander before any turn-end shows the live tool count and no duration', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), talk('a1', 1), call('t1', 'Bash', 'ls')]);
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(togglesOf(m)[0].textContent, '▸ 1 tool');
});

test('runs: the expander merges stats across the run, summing turn-end durations and counting injected rows', () => {
  const m = mount({ mode: 'conversation' });
  m.render([
    ask('p1', 1), call('t1', 'Bash', 'ls'), ended('e1', 1, 30000),
    inb('m2', 2, 'reminder', 'continue'), call('t2', 'Bash', 'pwd', 'ok', { turn: 2 }), talk('a2', 2), ended('e2', 2, 11000),
  ]);
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(togglesOf(m)[0].textContent, '▸ 41s · 2 tools · 1 injected');
  assert.strictEqual(turnOf(m, 'p1').childNodes[turnOf(m, 'p1').childNodes.length - 1], togglesOf(m)[0]);
  assert.strictEqual(findCls(turnOf(m, 'm2'), 'tr-turn-fold-stats')[0].textContent, '11s · 1 tool · 1 injected');
});

test('runs: reminder→prose and reminder→apiError turns stay visible, each folded to its head, with no run expander', () => {
  const m = mount({ mode: 'conversation' });
  m.render([
    inb('m1', 1, 'reminder', 'continue'), talk('a1', 1, 'carrying on'),
    inb('m2', 2, 'reminder', 'continue'), { id: 'a2', kind: 'assistant', ts: null, turn: 2, apiError: true, text: 'API Error: 500' },
  ]);
  assert.deepStrictEqual(togglesOf(m), []);
  assert.deepStrictEqual([shown(turnOf(m, 'm1')), shown(turnOf(m, 'm2'))], [['tr-row tr-turn-fold'], ['tr-row tr-turn-fold']]);
  assert.deepStrictEqual([isHidden(turnOf(m, 'm1')), isHidden(turnOf(m, 'm2'))], [false, false]);
});

test('runs: an all-internal leading run has no expander', () => {
  const m = mount({ mode: 'conversation' });
  m.render([inb('i1', 1, 'ticket-loop', 'ticket t1 accepted'), call('t1', 'Bash', 'ls'), ask('p2', 2), talk('a2', 2)]);
  assert.strictEqual(isHidden(turnOf(m, 'i1')), true, 'ENTER: the leading run hides a turn');
  assert.strictEqual(togglesOf(m).length, 0);
});

test('runs: a compact notice merged at index 0 does not change the run key, so the open run stays open', () => {
  const records = [ask('p1', 1), execSaid('a1', 1)];
  const m = mount({ mode: 'conversation' });
  m.render(records);
  clickToggle(m);
  assert.strictEqual(cardsOf(m).length, 1, 'ENTER: the run is open');
  const merged = mergeCompactNotices(records, [{ id: 'cn1', ts: 0, text: 'Compact did not report back' }]);
  assert.strictEqual(merged[0].id, 'cn1', 'ENTER: the notice took index 0');
  m.render(merged);
  assert.strictEqual(cardsOf(m).length, 1);
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'true');
});

test('runs: a run whose head is evicted re-keys to the first surviving turn and starts closed', () => {
  const records = [ask('p1', 1), execSaid('a1', 1), call('t2', 'Bash', 'pwd', 'ok', { turn: 2 }), execSaid('a2', 2)];
  const m = mount({ mode: 'conversation' });
  m.render(records);
  clickToggle(m);
  assert.strictEqual(isHidden(rowIn(m, 'tools:t2')), false, 'ENTER: the run is open and shows its tool');
  m.render(records.slice(2));
  assert.strictEqual(isHidden(rowIn(m, 'tools:t2')), true);
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'false');
});

test('runs: a source change with a colliding line:0 leaves the run closed', () => {
  const m = mount({ mode: 'conversation' });
  m.rows.render([ask('line:0', 1), execSaid('line:1', 1)], 'aaaa:0');
  clickToggle(m);
  assert.strictEqual(cardsOf(m).length, 1, 'ENTER: the line:0 run is open');
  m.rows.render([ask('line:0', 1), execSaid('line:1', 1)], 'bbbb:0');
  assert.strictEqual(cardsOf(m).length, 0);
  assert.strictEqual(togglesOf(m)[0].getAttribute('aria-expanded'), 'false');
});

test('runs: the same source, or a null one, keeps an open run open', () => {
  const m = mount({ mode: 'conversation' });
  m.rows.render([ask('line:0', 1), execSaid('line:1', 1)], 'aaaa:0');
  clickToggle(m);
  m.rows.render([ask('line:0', 1), execSaid('line:1', 1), talk('line:2', 1)], 'aaaa:0');
  m.rows.render([ask('line:0', 1), execSaid('line:1', 1), talk('line:2', 1)]);
  assert.strictEqual(cardsOf(m).length, 1);
});

test('runs: a stale run key is pruned, while an opened two-call tool block stays open after an appending re-render', () => {
  const head = [ask('p1', 1), execSaid('a1', 1)];
  const tail = [ask('p2', 2), call('t1', 'Bash', 'ls', 'ok', { turn: 2 }), call('t2', 'Bash', 'pwd', 'ok', { turn: 2 })];
  const m = mount({ mode: 'conversation' });
  m.render([...head, ...tail]);
  clickToggle(m, 0);
  clickToggle(m, 1);
  const block = () => findCls(m.pane, 'tr-tool-block')[0];
  headOf(block()).listeners.click();
  assert.strictEqual(/\btr-tool-folded\b/.test(block().className), false, 'ENTER: the tool block is open');
  assert.strictEqual(cardsOf(m).length, 1, 'ENTER: the p1 run is open');
  m.render([...tail, talk('a3', 2)]);
  assert.strictEqual(/\btr-tool-folded\b/.test(block().className), false);
  assert.strictEqual(isHidden(block()), false);
  m.render([...head, ...tail, talk('a3', 2)]);
  assert.strictEqual(cardsOf(m).length, 0);
});

test('runs: after a source change no old ids or duplicate data-turn remain, the bar stays first and the working row last', () => {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const bar = doc.createElement('div');
  pane.appendChild(bar);
  const rows = createTranscriptRows(doc, pane, { lead: bar, mode: 'conversation', setInterval: () => 1, clearInterval: () => {} });
  rows.render([ask('line:0', 1), talk('line:1', 1), ask('line:5', 2), talk('line:6', 2)], 'aaaa:0');
  rows.setWorking({ state: 'thinking', since: 0 });
  const old = pane.childNodes.find((n) => n.dataset && n.dataset.turn === 'line:0');
  rows.render([ask('line:0', 1), talk('line:1', 1, 'fresh')], 'bbbb:0');
  const turns = pane.childNodes.filter((n) => /\btr-turn\b/.test(n.className)).map((n) => n.dataset.turn);
  assert.deepStrictEqual(turns, ['line:0']);
  assert.notStrictEqual(pane.childNodes.find((n) => n.dataset && n.dataset.turn === 'line:0'), old);
  assert.strictEqual(old.parentNode, null);
  assert.strictEqual(pane.childNodes[0], bar);
  assert.ok(/\btr-working\b/.test(pane.childNodes[pane.childNodes.length - 1].className));
});

test('runs: collapse invariant — for a run with a visible host, the toggle exists iff the closed view suppresses something; after opening it is still present and collapses the run', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), inb('i1', 1, 'reminder', 'continue'), talk('a1', 1), ended('e1', 1, 3000), ask('p2', 2), talk('a2', 2), ended('e2', 2, 4000)]);
  assert.strictEqual(isHidden(rowIn(m, 'i1')), true, 'ENTER: the p1 run hides a row');
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(turnOf(m, 'p1').childNodes.includes(togglesOf(m)[0]), true);
  const plainFoot = turnOf(m, 'p2').childNodes[turnOf(m, 'p2').childNodes.length - 1];
  assert.strictEqual(plainFoot.className, 'tr-row tr-footer');
  assert.strictEqual(plainFoot.textContent, '4.0s');
  clickToggle(m);
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(isHidden(rowIn(m, 'i1')), false);
  clickToggle(m);
  assert.strictEqual(togglesOf(m).length, 1);
  assert.strictEqual(isHidden(rowIn(m, 'i1')), true);
});

test('runs: the non-head turn of a two-turn run carries tr-turn-cont in Conversation', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), talk('a1', 1), inb('m2', 2, 'reminder', 'continue'), talk('a2', 2)]);
  assert.deepStrictEqual(m.pane.childNodes.map((n) => /\btr-turn-cont\b/.test(n.className)), [false, true]);
  m.rows.setMode('internals');
  assert.deepStrictEqual(m.pane.childNodes.map((n) => /\btr-turn-cont\b/.test(n.className)), [false, false]);
});

test('runs: an expander click re-anchors scroll the same as a mode switch', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), talk('a1', 1), ask('p2', 2), inb('i2', 2, 'reminder', 'continue'), talk('a2', 2)]);
  Object.assign(m.pane, { scrollTop: 900, clientHeight: 100, scrollHeight: 1000 });
  clickToggle(m);
  assert.strictEqual(m.pane.scrollTop, 1000);
});

const midAsk = (state) => ({ id: 'q1', kind: 'prompt', ts: new Date(2026, 8, 27, 10, 42).getTime(), turn: 1, text: 'hi', source: 'mid-turn', state });

test('a mid-turn prompt row reads mid-turn, its text, its time and delivered, and carries tr-prompt-mid', () => {
  const m = mount();
  m.render([ask('p1', 1), midAsk('delivered')]);
  const row = rowIn(m, 'q1');
  assert.match(row.className, /\btr-prompt tr-prompt-mid\b/);
  assert.deepStrictEqual(row.childNodes.map((n) => [n.className, n.textContent]), [['tr-mid', 'mid-turn'], ['tr-head-text', 'hi'], ['tr-time', '10:42'], ['tr-mid-state', 'delivered']]);
  assert.strictEqual(row.childNodes[3].dataset.state, 'delivered');
});

test('a mid-turn prompt that turns read rebuilds its row and the state reads ✓ read', () => {
  const m = mount();
  m.render([ask('p1', 1), midAsk('delivered')]);
  const before = rowIn(m, 'q1');
  m.render([ask('p1', 1), midAsk('read')]);
  const after = rowIn(m, 'q1');
  assert.notStrictEqual(after, before);
  const state = after.childNodes[after.childNodes.length - 1];
  assert.deepStrictEqual([state.className, state.textContent, state.dataset.state], ['tr-mid-state', '✓ read', 'read']);
});

const queuedAsk = (state) => ({ id: 'queued:1', kind: 'prompt', ts: new Date(2026, 8, 27, 10, 43).getTime(), turn: 1, text: 'hi', source: 'mid-turn', state });

test('a queued mid-turn prompt row reads mid-turn, its text, its time and queued', () => {
  const m = mount();
  m.render([ask('p1', 1), queuedAsk('queued')]);
  const row = rowIn(m, 'queued:1');
  assert.deepStrictEqual(row.childNodes.map((n) => [n.className, n.textContent]), [['tr-mid', 'mid-turn'], ['tr-head-text', 'hi'], ['tr-time', '10:43'], ['tr-mid-state', 'queued']]);
  assert.strictEqual(row.childNodes[3].dataset.state, 'queued');
});

test('a queued prompt replaced by its delivered attachment leaves only the delivered row', () => {
  const m = mount();
  m.render([ask('p1', 1), queuedAsk('queued')]);
  assert.ok(rowIn(m, 'queued:1'), 'ENTER: the queued row painted');
  m.render([ask('p1', 1), midAsk('delivered')]);
  assert.strictEqual(rowIn(m, 'queued:1'), undefined);
  const state = rowIn(m, 'q1').childNodes[3];
  assert.deepStrictEqual([state.className, state.textContent, state.dataset.state], ['tr-mid-state', 'delivered', 'delivered']);
});

test('runs: a mid-turn prompt inside a closed run is visible in Conversation mode', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), call('t1', 'Bash', 'ls'), midAsk('read'), talk('a1', 1)]);
  assert.deepStrictEqual(togglesOf(m).map((t) => t.getAttribute('aria-expanded')), ['false'], 'ENTER: the run is closed');
  assert.strictEqual(isHidden(rowIn(m, 'q1')), false);
});

function mountFocusable(ctx = {}) {
  const doc = fakeDocument();
  const make = doc.createElement;
  doc.activeElement = null;
  doc.createElement = (tag) => Object.assign(make(tag), { focus(opts) { doc.activeElement = this; doc.focusOpts = opts; } });
  const pane = doc.createElement('div');
  const rows = createTranscriptRows(doc, pane, ctx);
  return { doc, pane, rows, render: (records) => rows.render(records) };
}

const movingRun = () => [ask('p1', 1), talk('a1', 1), call('m2', 'Bash', 'pwd', 'ok', { turn: 2 })];

test('runs: a keyboard-activated expander whose toggle moves to another turn keeps focus on the run\'s new toggle', () => {
  const m = mountFocusable({ mode: 'conversation' });
  m.render(movingRun());
  const before = togglesOf(m)[0];
  assert.strictEqual(before.parentNode, turnOf(m, 'p1'));
  before.focus();
  before.listeners.click();
  const after = togglesOf(m)[0];
  assert.notStrictEqual(after, before);
  assert.strictEqual(after.parentNode, turnOf(m, 'm2'));
  assert.strictEqual(m.doc.activeElement, after);
  assert.deepStrictEqual(m.doc.focusOpts, { preventScroll: true });
});

test('runs: a click on an unfocused expander does not move focus to the rebuilt toggle', () => {
  const m = mountFocusable({ mode: 'conversation' });
  m.render(movingRun());
  const elsewhere = m.doc.createElement('input');
  elsewhere.focus();
  togglesOf(m)[0].listeners.click();
  assert.strictEqual(togglesOf(m)[0].parentNode, turnOf(m, 'm2'));
  assert.strictEqual(m.doc.activeElement, elsewhere);
});

test('runs: the expander glyph is aria-hidden', () => {
  const m = mount({ mode: 'conversation' });
  m.render(movingRun());
  const glyph = findCls(m.pane, 'tr-run-glyph')[0];
  assert.strictEqual(glyph.getAttribute('aria-hidden'), 'true');
});

test('runs: an expander with no footer parts carries an aria-label; one with footer text does not', () => {
  const bare = mount({ mode: 'conversation' });
  bare.render([ask('p1', 1), execSaid('a1', 1)]);
  assert.strictEqual(togglesOf(bare)[0].getAttribute('aria-label'), "Show or hide this run's steps");
  const counted = mount({ mode: 'conversation' });
  counted.render(movingRun());
  assert.strictEqual(togglesOf(counted)[0].getAttribute('aria-label'), null);
});

test('runs: the expander carries its tooltip whether or not it has footer text', () => {
  const counted = mount({ mode: 'conversation' });
  counted.render(movingRun());
  assert.strictEqual(togglesOf(counted)[0].title, 'Show or hide the steps behind this reply');
  const bare = mount({ mode: 'conversation' });
  bare.render([ask('p1', 1), execSaid('a1', 1)]);
  assert.strictEqual(togglesOf(bare)[0].title, 'Show or hide the steps behind this reply');
});

test('a long subagent report folds under a box head whose badge matches the inner row badge in label, glyph and title', () => {
  const m = mount();
  m.render([{ id: 'i9', kind: 'inbound', ts: null, turn: 1, from: 'nits-coords', via: 'subagent', text: Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') }]);
  const box = boxOf(m, 'i9');
  assert.strictEqual(box.className, 'tr-box tr-box-folded');
  const badges = [boxHeadOf(box).childNodes[0], unbox(box).childNodes[0].childNodes[0]];
  const want = ['tr-sender tr-sender-seat', 'Nnits-coords', 'Report from a subagent of this seat — attached by the CLI, not typed'];
  assert.deepStrictEqual(badges.map((b) => [b.className, b.textContent, b.title]), [want, want]);
});

const accepted = () => [
  inb('i1', 1, 'ticket-loop', '[ticket t1272 ACCEPT] t1272-x accepted\nmerged as abc'),
  call('t1', 'Bash', 'git log'), talk('a1', 1, 'noted, moving on'), ended('e1', 1, 15000),
];

test('folds: a machine-driven turn in Conversation mode shows one fold head with sender, chip, first line and stats; a click opens it', () => {
  const m = mount({ mode: 'conversation' });
  m.render(accepted());
  const turn = turnOf(m, 'i1');
  assert.ok(/\btr-turn-folded\b/.test(turn.className));
  assert.deepStrictEqual(shown(turn), ['tr-row tr-turn-fold']);
  const head = turn.childNodes[0];
  assert.strictEqual(findCls(head, 'tr-sender-name')[0].textContent, 'ticket-loop');
  assert.strictEqual(findCls(head, 'tr-ticket-chip')[0].textContent, 't1272 ACCEPT');
  assert.strictEqual(findCls(head, 'tr-turn-fold-text')[0].textContent, '[ticket t1272 ACCEPT] t1272-x accepted');
  assert.strictEqual(findCls(head, 'tr-turn-fold-stats')[0].textContent, '15s · 1 tool · 1 injected');
  assert.strictEqual(head.childNodes[0].textContent, '▸');
  head.listeners.click();
  const open = turnOf(m, 'i1');
  assert.ok(!/\btr-turn-folded\b/.test(open.className));
  assert.deepStrictEqual(shown(open), ['tr-row tr-turn-fold', 'tr-box tr-box-folded tr-ticket', 'tr-row tr-tool-block', 'tr-row tr-prose', 'tr-row tr-footer']);
  assert.strictEqual(open.childNodes[0].childNodes[0].textContent, '▾');
});

test('folds: Internals mode has no fold head, and switching back re-folds a turn the operator has not opened', () => {
  const m = mount({ mode: 'conversation' });
  m.render(accepted());
  m.rows.setMode('internals');
  assert.deepStrictEqual(findCls(m.pane, 'tr-turn-fold'), []);
  assert.deepStrictEqual(shown(turnOf(m, 'i1')), ['tr-box tr-box-folded tr-ticket', 'tr-row tr-tool-block', 'tr-row tr-prose', 'tr-row tr-footer']);
  m.rows.setMode('conversation');
  assert.deepStrictEqual(shown(turnOf(m, 'i1')), ['tr-row tr-turn-fold']);
  turnOf(m, 'i1').childNodes[0].listeners.click();
  m.rows.setMode('internals');
  m.rows.setMode('conversation');
  assert.deepStrictEqual(shown(turnOf(m, 'i1')), ['tr-row tr-turn-fold', 'tr-box tr-box-folded tr-ticket', 'tr-row tr-tool-block', 'tr-row tr-prose', 'tr-row tr-footer']);
  assert.strictEqual(turnOf(m, 'i1').childNodes[0].getAttribute('aria-expanded'), 'true');
});

test('folds: the operator\'s mid-turn prompt inside a ticket-loop turn keeps the turn open and visible', () => {
  const m = mount({ mode: 'conversation' });
  m.render([inb('i1', 1, 'ticket-loop', '[ticket t1 MERGED] merged'), call('t1', 'Bash', 'ls'), midAsk('queued'), talk('a1', 1, 'on it')]);
  assert.deepStrictEqual(findCls(m.pane, 'tr-turn-fold'), []);
  assert.strictEqual(isHidden(rowIn(m, 'q1')), false);
});

test('folds: in a talk turn followed by a reminder turn, the run expander reveals the reminder', () => {
  const m = mount({ mode: 'conversation' });
  m.render([ask('p1', 1), talk('a1', 1), inb('m2', 2, 'reminder', 'continue'), talk('a2', 2, 'carrying on')]);
  assert.deepStrictEqual(shown(turnOf(m, 'm2')), ['tr-row tr-turn-fold']);
  assert.strictEqual(togglesOf(m).length, 1);
  clickToggle(m);
  assert.strictEqual(findCls(turnOf(m, 'm2'), 'tr-turn-fold').length, 0);
  assert.strictEqual(isHidden(rowIn(m, 'm2')), false);
  assert.strictEqual(togglesOf(m)[0].parentNode, turnOf(m, 'm2'));
});

test('folds: an operator-driven turn and a machine-driven turn that shouted never get a fold head', () => {
  const m = mount({ mode: 'conversation' });
  m.render([
    ask('p1', 1), talk('a1', 1, 'done'), ended('e1', 1, 1000),
    inb('i2', 2, 'clodex-hand-12', 'report: branch ready'), said('a2', 2, 'looks good\n[agent:shout] need a decision\n[agent:end]'), ended('e2', 2, 1000),
  ]);
  assert.deepStrictEqual(findCls(m.pane, 'tr-turn-fold'), []);
  assert.deepStrictEqual(shown(turnOf(m, 'p1')), ['tr-row tr-head tr-prompt', 'tr-row tr-prose', 'tr-row tr-footer']);
  assert.deepStrictEqual(shown(turnOf(m, 'i2')), ['tr-box', 'tr-row tr-prose tr-segs', 'tr-row tr-footer']);
});

const headCls = (card) => card.childNodes[0].childNodes.map(cls);
const cardAt = (m) => m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];

test('inline: a one-line remind body sits on the head after the target, with no body block', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:remind in 10m] continue: t1276 awaiting own digest\n[agent:end]')]);
  const card = cardAt(m);
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head']);
  assert.deepStrictEqual(headCls(card), ['intent-card-glyph', 'intent-card-label', 'intent-card-target', 'intent-card-inline']);
  const inline = card.childNodes[0].childNodes[3];
  assert.strictEqual(inline.textContent, 'continue: t1276 awaiting own digest');
  assert.strictEqual(inline.title, 'continue: t1276 awaiting own digest');
  assert.deepStrictEqual(findCls(card, 'intent-card-body'), []);
});

test('inline: a two-line dm body keeps its block under the head', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:dm bob] one\ntwo\n[agent:end]')]);
  const card = cardAt(m);
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head', 'intent-card-body']);
  assert.deepStrictEqual(findCls(card, 'intent-card-inline'), []);
});

test('inline: 120 chars renders inline, 121 renders the block', () => {
  const at = (body) => {
    const m = mount();
    m.render([said('a1', 0, `[agent:dm bob] ${body}\n[agent:end]`)]);
    return cardAt(m).childNodes.map(cls);
  };
  assert.deepStrictEqual(at('x'.repeat(120)), ['intent-card-head']);
  assert.deepStrictEqual(at('x'.repeat(121)), ['intent-card-head', 'intent-card-body']);
});

test('inline: an exec one-liner keeps the mono block', () => {
  const m = mount();
  m.render([said('a1', 0, 'x\n[agent:exec clodex-team] {"a":1}')]);
  const card = m.pane.childNodes[0].childNodes[0].childNodes[1].childNodes[0];
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head', 'intent-card-body intent-card-body-mono']);
  assert.deepStrictEqual(findCls(card, 'intent-card-inline'), []);
});

test('inline: a filed task done carries the filed link inside the inline span', () => {
  const m = mount();
  m.render([said('a1', 0, `[agent:task done t1276] Report — 2.7 KB filed at ${FILED}\n[agent:end]`)]);
  const card = cardAt(m);
  assert.strictEqual(card.className, 'intent-card intent-card-filed');
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head']);
  const inline = findCls(card, 'intent-card-inline')[0];
  assert.strictEqual(inline.textContent, '▢ 2.7 KB filed · Report');
  assert.strictEqual(inline.childNodes[0].childNodes[1].dataset.path, FILED);
  assert.deepStrictEqual(findCls(card, 'intent-card-body'), []);
});

test('inline: an unclosed one-liner keeps the block and the unclosed chip', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:remind in 5m] watchdog')]);
  const card = cardAt(m);
  assert.strictEqual(card.className, 'intent-card intent-card-open');
  assert.deepStrictEqual(card.childNodes.map(cls), ['intent-card-head', 'intent-card-body']);
  assert.deepStrictEqual(findCls(card, 'intent-card-inline'), []);
  const head = card.childNodes[0];
  assert.strictEqual(head.childNodes[head.childNodes.length - 1].textContent, 'unclosed');
});

test('folds: an opened turn that leaves the records does not pre-open a new turn reusing its line:N key', () => {
  const m = mount({ mode: 'conversation' });
  const machine = () => inb('line:5', 2, 'ticket-loop', '[ticket t1 ACCEPT] t1-x accepted');
  m.render([ask('line:0', 1), talk('line:1', 1), machine(), talk('line:6', 2)]);
  turnOf(m, 'line:5').childNodes[0].listeners.click();
  assert.ok(!/\btr-turn-folded\b/.test(turnOf(m, 'line:5').className));
  m.render([ask('line:0', 1), talk('line:1', 1)]);
  m.render([ask('line:0', 1), talk('line:1', 1), machine(), talk('line:6', 2)]);
  assert.ok(/\btr-turn-folded\b/.test(turnOf(m, 'line:5').className));
});

const ATT = '/Users/x/.clodex/messages/clodex-hand-1/msg-1-2.txt';
const withPath = (n) => [...(n.dataset && n.dataset.path ? [n] : []), ...(n.childNodes || []).flatMap(withPath)];
const bodyOf = (box) => box.childNodes.find((n) => n.className === 'tr-box-body');
const ticketCases = [
  { name: 'a one-line inbound notice is the head alone', rec: inb('i1', 1, 'ticket-loop', '[ticket t7 MERGED] merged into master'),
    box: 'tr-box tr-ticket', head: ['tr-ticket-chip', 'tr-sender', 'tr-box-preview'], chip: 't7 MERGED', preview: 'merged into master', body: null },
  { name: 'a three-line inbound notice folds behind the same head', rec: inb('i1', 1, 'ticket-loop', '[ticket t7 MERGED] merged into master\nsha abc\nsuite green'),
    box: 'tr-box tr-box-folded tr-ticket', head: ['tr-ticket-chip', 'tr-sender', 'tr-box-preview', 'tr-box-chevron'], chip: 't7 MERGED', preview: 'merged into master', body: '[ticket t7 MERGED] merged into master\nsha abc\nsuite green' },
  { name: 'a runtime task reply chips its own state word', rec: taskReply('i1', 1, 'ticket t1 accepted — merged into master; 3 files'),
    box: 'tr-box tr-ticket', head: ['tr-ticket-chip', 'tr-sender', 'tr-box-preview'], chip: 't1 accepted', preview: 'merged into master; 3 files', body: null },
  { name: 'an inbound with an attachment folds, the lead text in the head and the link in the body',
    rec: { ...inb('i1', 1, 'clodex', `[ticket t9 RESPEC] close with done Message (2337 bytes) attached: @${ATT}`), attached: { path: ATT, bytes: 2337 } },
    box: 'tr-box tr-box-folded tr-ticket', head: ['tr-ticket-chip', 'tr-sender', 'tr-box-preview', 'tr-box-chevron'], chip: 't9 RESPEC', preview: 'close with done', link: ATT },
];
for (const c of ticketCases) {
  test(`one ticket shape: ${c.name}`, () => {
    const m = mount();
    m.render([c.rec]);
    const box = boxOf(m, 'i1');
    assert.strictEqual(box.className, c.box);
    const head = boxHeadOf(box);
    assert.deepStrictEqual(head.childNodes.map((n) => n.className.split(' ')[0]), c.head);
    assert.strictEqual(head.childNodes[0].textContent, c.chip);
    assert.strictEqual(head.childNodes[2].textContent, c.preview);
    const body = bodyOf(box);
    if (c.body === null) assert.strictEqual(body, undefined);
    if (c.body) assert.ok(body.textContent.endsWith(c.body), body.textContent);
    if (c.link) assert.ok(withPath(body).some((n) => n.dataset.path === c.link));
  });
}

test('one ticket shape: a multi-line task done puts the target before the label, the first line inline and the rest behind + 1 more line', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:task done t4] line one\nline two\n[agent:end]')]);
  const card = cardAt(m);
  assert.deepStrictEqual(headCls(card), ['intent-card-glyph', 'intent-card-target', 'intent-card-label', 'intent-card-inline']);
  assert.strictEqual(card.childNodes[0].childNodes[3].textContent, 'line one');
  const [, body, foot] = card.childNodes;
  assert.strictEqual(body.className, 'intent-card-body intent-card-rest');
  assert.strictEqual(body.textContent, 'line two');
  assert.strictEqual(foot.textContent, '+ 1 more line');
  foot.listeners.click();
  assert.strictEqual(body.className, 'intent-card-body');
});

test('one ticket shape: a bare task head takes its first non-blank line inline and the rest behind the count', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:task done t4]\nline one\nline two\nline three\n[agent:end]')]);
  const card = cardAt(m);
  assert.strictEqual(card.childNodes[0].childNodes[3].textContent, 'line one');
  const [, body, foot] = card.childNodes;
  assert.strictEqual(body.className, 'intent-card-body intent-card-rest');
  assert.strictEqual(body.textContent, 'line two\nline three');
  assert.strictEqual(foot.textContent, '+ 2 more lines');
});

test('one ticket shape: a one-line task body over 240 chars keeps the ordinary clamped block, not the hidden rest', () => {
  const m = mount();
  const long = 'y'.repeat(250);
  m.render([said('a1', 0, `[agent:task add] ${long}\n[agent:end]`)]);
  const card = cardAt(m);
  assert.deepStrictEqual(findCls(card, 'intent-card-inline'), []);
  assert.strictEqual(card.childNodes[1].className, 'intent-card-body intent-card-clamped');
  assert.strictEqual(card.childNodes[1].textContent, long);
});

test('one ticket shape: a one-line reply whose message outruns the preview folds, keeping the full text in the body', () => {
  const m = mount();
  const msg = `merged into master as 9bdf06b5; ${'z'.repeat(120)}`;
  m.render([taskReply('i1', 1, `ticket t1277 accepted — ${msg}`)]);
  const box = boxOf(m, 'i1');
  assert.strictEqual(box.className, 'tr-box tr-box-folded tr-ticket');
  assert.strictEqual(boxHeadOf(box).childNodes[0].textContent, 't1277 accepted');
  assert.ok(bodyOf(box).textContent.endsWith(msg));
});

test('one ticket shape: a colon after the ticket id is not a state word, and a trailing colon is dropped from one', () => {
  const m = mount();
  m.render([taskReply('i1', 1, 'ticket t5: its worktree is held'), taskReply('i2', 1, 'ticket t12 merged: a → b')]);
  assert.deepStrictEqual(['i1', 'i2'].map((id) => boxHeadOf(boxOf(m, id)).childNodes.map((n) => n.textContent).slice(0, 1).concat(boxHeadOf(boxOf(m, id)).childNodes[2].textContent)),
    [['t5', 'its worktree is held'], ['t12 merged', 'a → b']]);
});
