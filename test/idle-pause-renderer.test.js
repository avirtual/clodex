'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

function idlePauseBlock() {
  const m = rendererSrc.match(/^const idlePauseOverlay = [\s\S]*?^\}$/m);
  assert.ok(m, 'ENTER: no idle-pause dialog block in renderer.js');
  const block = rendererSrc.slice(m.index, rendererSrc.indexOf('window.api.idlePauseCurrent()', m.index) + 1);
  assert.match(block, /^async function answerIdlePause\(pause, auto = false\) \{$/m, 'ENTER: the block holds the answer path');
  return block;
}

test('the dialog pause path answers main and never goes through the per-archive confirm', () => {
  const block = idlePauseBlock();
  assert.match(block, /window\.api\.idlePauseAnswer\(ask\.id, reply\)/);
  for (const banned of [/guardedArchive/, /requestArchiveRow/, /archiveSessionRow/, /window\.api\.archiveSession/, /\bconfirm\(/]) {
    assert.doesNotMatch(block, banned, `idle-pause block must not use ${banned}`);
  }
});

test('another window answering drops this window\'s dialog', () => {
  const block = idlePauseBlock();
  assert.match(block, /window\.api\.onIdlePauseClosed\(\(msg\) => \{ if \(idlePauseShown && msg && msg\.id === idlePauseShown\.id\) hideIdlePause\(\); \}\);/);
});

test('the dialog copy and the Preferences control', () => {
  assert.ok(htmlSrc.includes("Pausing stops a session's process and keeps its conversation. It stays in the sidebar and resumes when you click it."));
  assert.match(htmlSrc, /<button id="idle-pause-later" class="secondary" type="button">Not now<\/button>/);
  assert.match(htmlSrc, /<input type="number" id="prefs-idle-pause-hours" min="0" max="8760" step="1" value="48"/);
  assert.match(rendererSrc, /idlePauseGo\.textContent = `Pause \$\{n\} session\$\{n === 1 \? '' : 's'\}`;/);
});

function fakeEl(tag) {
  const el = {
    tagName: tag, children: [], listeners: {}, dataset: {}, textContent: '', disabled: false, checked: false,
    classes: new Set(),
    addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
    appendChild(c) { el.children.push(c); return c; },
    replaceChildren(...cs) { el.children = cs; },
    querySelectorAll() {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.tagName === 'input') out.push(c); walk(c); } };
      walk(el);
      return out;
    },
    click() { for (const fn of el.listeners.click || []) fn(); },
  };
  el.classList = {
    add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c),
    toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)),
    contains: (c) => el.classes.has(c),
  };
  return el;
}

function mountIdleDialog(pausable = [{ name: 'a', type: 'claude', idle: '2 days' }, { name: 'b', type: 'claude', idle: '3 days' }]) {
  const start = rendererSrc.indexOf('const idlePauseOverlay = ');
  const end = rendererSrc.indexOf('window.api.onRequestOpenDiscovery(', start);
  assert.ok(start > 0 && end > start, 'ENTER: the idle-pause dialog block is found');
  const els = new Map();
  const document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, fakeEl('div')); return els.get(id); },
    createElement: (tag) => fakeEl(tag),
  };
  const replies = [];
  const handlers = {};
  const window = {
    api: {
      idlePauseAnswer: async (id, reply) => { replies.push([id, reply]); return { ok: true, paused: 0, skipped: 0 }; },
      idlePauseCurrent: () => null,
      onIdlePauseAsk: (fn) => { handlers.ask = fn; },
      onIdlePauseClosed: (fn) => { handlers.closed = fn; },
      onIdlePauseAuto: (fn) => { handlers.auto = fn; },
    },
  };
  const toasts = [];
  const showToast = (msg, opts) => toasts.push([msg, opts]);
  const run = new Function('document', 'window', 'showToast', `${rendererSrc.slice(start, end)}\nreturn { closeIdlePause, idlePauseMem };`);
  const api = run(document, window, showToast);
  const ask = { id: 'idle-1', hours: 48, pausable, exempt: [] };
  handlers.ask(ask);
  const boxes = els.get('idle-pause-list').querySelectorAll();
  assert.deepStrictEqual(boxes.map((b) => b.dataset.name), ['a', 'b'], 'ENTER: two ticked rows rendered');
  return { els, replies, handlers, toasts, boxes, api };
}

const flush = () => new Promise((r) => setImmediate(r));

test('"Pause automatically from now on" sends the ticked rows with auto: true', async () => {
  assert.match(htmlSrc, /<button id="idle-pause-auto" class="secondary" type="button">Pause automatically from now on<\/button>/);
  const { els, replies, boxes } = mountIdleDialog();
  boxes[1].checked = false;
  els.get('idle-pause-auto').click();
  await flush();
  assert.deepStrictEqual(replies, [['idle-1', { pause: ['a'], auto: true }]]);
  assert.strictEqual(els.get('idle-pause-overlay').classList.contains('hidden'), true);
});

test('Escape answers "Not now": its ESCAPE_CLOSES row sends the decline shape', async () => {
  const table = rendererSrc.match(/^const ESCAPE_CLOSES = \[\n([\s\S]*?)^\];$/m);
  assert.ok(table, 'ENTER: ESCAPE_CLOSES found');
  assert.ok(table[1].includes("  ['idle-pause-overlay', () => closeIdlePause()],\n"));
  const { replies, api, els } = mountIdleDialog();
  api.closeIdlePause();
  await flush();
  assert.deepStrictEqual(replies, [['idle-1', { decline: true }]]);
  els.get('idle-pause-later').click();
  await flush();
  assert.strictEqual(replies.length, 1, 'answered once; the dialog is gone');
});

test('idle-pause:auto shows the transient notice; an empty list shows nothing', () => {
  const { handlers, toasts } = mountIdleDialog();
  handlers.auto({ names: [], hours: 48 });
  assert.deepStrictEqual(toasts, []);
  handlers.auto({ names: ['a', 'b'], hours: 48 });
  assert.deepStrictEqual(toasts, [['Paused 2 sessions idle for more than 48 hours. Click a paused row to resume it.', { duration: 15000 }]]);
});

test('a row paused for idleness says so, live and after a restart', () => {
  assert.ok(rendererSrc.includes("entry.archiveCause === 'idle' ? 'paused after being idle — click to resume' : 'archived — click to resume'"));
  assert.ok(rendererSrc.includes("archivingSessions.set(name, { ...archivedRowEntry(name, item), ...(cause === 'idle' ? { archiveCause: 'idle' } : {}) });"));
  const { archivedSnapshotFor } = require('../session-restore');
  const manager = { teamNameFor: () => null };
  assert.strictEqual(archivedSnapshotFor({ manager, entry: { name: 'a', archivedAt: 1, archiveCause: 'idle' } }).archiveCause, 'idle');
  assert.strictEqual('archiveCause' in archivedSnapshotFor({ manager, entry: { name: 'a', archivedAt: 1 } }), false);
});

test('memory figures: MB below 1024 MB with no decimals, GB with one', () => {
  const { api } = mountIdleDialog();
  const MB = 1024 * 1024;
  assert.deepStrictEqual([290 * MB, 1023 * MB, 1024 * MB, 4300 * MB, 1.75 * 1024 * MB].map(api.idlePauseMem),
    ['290 MB', '1023 MB', '1.0 GB', '4.2 GB', '1.8 GB']);
});

test('each row shows its memory; the "frees about" line follows the ticked boxes', () => {
  const MB = 1024 * 1024;
  const { els, boxes } = mountIdleDialog([
    { name: 'a', type: 'claude', idle: '2 days', memBytes: 3000 * MB },
    { name: 'b', type: 'claude', idle: '3 days', memBytes: 290 * MB },
  ]);
  const rowText = (i) => els.get('idle-pause-list').children[i].children.map((c) => c.textContent).filter(Boolean);
  assert.deepStrictEqual(rowText(1), ['b', 'claude', 'idle 3 days', '290 MB']);
  const frees = els.get('idle-pause-frees');
  assert.strictEqual(frees.textContent, 'Pausing all of them frees about 3.2 GB.');
  assert.strictEqual(frees.classList.contains('hidden'), false);
  boxes[0].checked = false;
  for (const fn of boxes[0].listeners.change) fn();
  assert.strictEqual(frees.textContent, 'Pausing all of them frees about 290 MB.');
  boxes[1].checked = false;
  for (const fn of boxes[1].listeners.change) fn();
  assert.strictEqual(frees.classList.contains('hidden'), true);
});

test('every figure null: no memory on the rows and the "frees about" line hidden', () => {
  const { els } = mountIdleDialog([
    { name: 'a', type: 'claude', idle: '2 days', memBytes: null },
    { name: 'b', type: 'claude', idle: '3 days', memBytes: null },
  ]);
  assert.deepStrictEqual(els.get('idle-pause-list').children[0].children.map((c) => c.className), [undefined, 'idle-pause-name', 'idle-pause-type', 'idle-pause-idle']);
  assert.strictEqual(els.get('idle-pause-frees').classList.contains('hidden'), true);
  assert.ok(htmlSrc.includes('<p id="idle-pause-frees" class="hidden"></p>'));
});

test('idle-pause:auto with a known figure names the memory freed', () => {
  const { handlers, toasts } = mountIdleDialog();
  handlers.auto({ names: ['a', 'b', 'c', 'd', 'e', 'f'], hours: 48, memBytes: 1.7 * 1024 * 1024 * 1024 });
  assert.deepStrictEqual(toasts, [['Paused 6 sessions idle for more than 48 hours, freeing about 1.7 GB. Click a paused row to resume it.', { duration: 15000 }]]);
});
