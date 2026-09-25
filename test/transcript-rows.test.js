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

test('an inbound from a seat named clodex draws a seat badge, never a system one', () => {
  const m = mount();
  m.render([{ id: 'i1', kind: 'inbound', ts: null, turn: 1, from: 'clodex', text: 'plan attached' }]);
  const badge = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  assert.strictEqual(badge.className, 'tr-sender tr-sender-seat');
  assert.deepStrictEqual(badge.childNodes.map((n) => [n.className, n.textContent]), [['tr-sender-glyph', 'C'], ['tr-sender-name', 'clodex']]);
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
  assert.deepStrictEqual(notice.childNodes.map((n) => n.className), ['tr-mark', 'tr-notice-text']);
  assert.deepStrictEqual(notice.childNodes[1].childNodes.map((n) => n.data ?? n.textContent), ['API Error: 500']);
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
  const notice = pane.childNodes[0].childNodes[0];
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
    [['intent-card-glyph', '→'], ['intent-card-label', 'message'], ['intent-card-target', 'bob'], ['intent-chip', 'urgent']]);
  assert.strictEqual(dm.childNodes[1].textContent, 'hi');
  assert.strictEqual(done.childNodes[0].textContent, '✓donet4');
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
  assert.strictEqual(card.childNodes[1].textContent, '▢ 6.2 KB filed · Design saved');
  const link = card.childNodes[1].childNodes[0].childNodes[1];
  assert.strictEqual(link.dataset.path, FILED);
  link.listeners.click({ preventDefault() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(opened, [['s', FILED, 'file', undefined]]);
});

test('a body over two lines is clamped with a count of the rest, and a click expands it', () => {
  const m = mount();
  m.render([said('a1', 0, '[agent:shout] one\ntwo\nthree\nfour')]);
  const card = m.pane.childNodes[0].childNodes[0].childNodes[0].childNodes[0];
  const [, body, foot] = card.childNodes;
  assert.strictEqual(body.className, 'intent-card-body intent-card-clamped');
  assert.strictEqual(foot.textContent, '+ 2 more lines');
  foot.listeners.click();
  assert.strictEqual(body.className, 'intent-card-body');
  assert.strictEqual(foot.hidden, true);
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
  const row = m.pane.childNodes[0].childNodes[0];
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
  const reply = m.pane.childNodes[1].childNodes[0];
  assert.strictEqual(reply.className, 'tr-row tr-head tr-reply tr-reply-attached');
  assert.strictEqual(reply.childNodes[0].childNodes[0].textContent, '↳');
  assert.strictEqual(reply.parentNode.parentNode, m.pane);
  const plain = { id: 'a0', kind: 'assistant', ts: null, turn: 0, text: 'no card' };
  m.render([plain, replyRec('r1', 1, 'task', '⇄', 'task', 'closed')]);
  assert.strictEqual(m.pane.childNodes[1].childNodes[0].className, 'tr-row tr-head tr-reply');
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

test('three consecutive Bash calls fold into one block headed Bash ×3 with three lines of mark, argument and summary', () => {
  const m = mount();
  m.render([prompt, call('b1', 'Bash', 'ls'), call('b2', 'Bash', 'pwd'), call('b3', 'Bash', 'date')]);
  const blocks = blocksOf(m);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].className, 'tr-row tr-tool-block tr-tool-many');
  assert.strictEqual(headOf(blocks[0]).textContent, 'Bash ×3');
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
  const [l1, l2] = linesOf(block);
  m.render([prompt, b1, b2, call('b3', 'Bash', 'date', 'pending')]);
  assert.strictEqual(blocksOf(m).length, 1);
  assert.strictEqual(blocksOf(m)[0], block);
  assert.strictEqual(block.dataset.id, id);
  assert.strictEqual(headOf(block).textContent, 'Bash ×3');
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
