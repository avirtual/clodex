'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('../renderer/lib/testjob-output');
const { winningDeclaration } = require('./lib/css-cascade');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');

function fnSource(name) {
  const m = new RegExp(`\\n(async )?function ${name}\\(`).exec(src);
  assert.ok(m, `${name} not found in renderer.js`);
  const end = src.indexOf('\n}\n', m.index + 1);
  return src.slice(m.index + 1, end + 2);
}

function harness({ follower = null } = {}) {
  const events = [];
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clearTimeout: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  const doc = { activeElement: null };
  function el(id = null, extra = {}) {
    const classes = new Set();
    const listeners = {};
    const node = {
      id, children: [], dataset: {}, style: {}, attrs: {}, textContent: '', title: '', className: '', scrollTop: 0, scrollHeight: 0, checked: false, value: '',
      classList: {
        add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) || node.className.split(' ').includes(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      },
      appendChild(k) { k.parent = node; node.children.push(k); return k; },
      replaceChildren(...kids) { node.children = []; for (const k of kids) node.appendChild(k); },
      setAttribute(k, v) { node.attrs[k] = v; },
      removeAttribute(k) { delete node.attrs[k]; },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      click() { for (const fn of listeners.click || []) fn({ stopPropagation() {} }); },
      focus(opts) { events.push(['focus', node.id || node.className, opts ? structuredClone(opts) : null]); doc.activeElement = node; },
      scrollIntoView(opts) { events.push(['scroll', node.id || node.dataset.jobId, structuredClone(opts)]); },
      closest(sel) { let n = node; while (n && !(sel === '.test-activity-row' && n.className.includes('test-activity-row'))) n = n.parent; return n || null; },
      querySelector(sel) { return node.children.find((k) => `.${k.className}` === sel) || null; },
      querySelectorAll: () => [],
      ...extra,
    };
    return node;
  }
  const radios = ['stdout', 'stderr'].map((value) => el(null, { value, name: 'test-output-stream' }));
  const ids = new Map();
  for (const id of ['test-activity-dialog', 'test-output-pane', 'test-output-title', 'test-output-header', 'test-output-status',
    'test-output-text', 'test-output-follow-wrap', 'test-output-label-stdout', 'test-output-label-stderr',
    'test-activity-summary', 'test-activity-box', 'test-activity-live', 'test-activity-recent']) ids.set(id, el(id));
  ids.set('test-output-follow', el('test-output-follow', { checked: true }));
  ids.get('test-output-pane').classList.add('hidden');
  ids.get('test-output-pane').querySelectorAll = () => radios;
  Object.assign(doc, {
    getElementById: (id) => ids.get(id),
    createElement: () => el(),
    querySelectorAll: () => [...ids.get('test-activity-live').children, ...ids.get('test-activity-recent').children].filter((r) => r.dataset.jobId),
  });
  const reads = [];
  let answer = null;
  const ctx = {
    document: doc,
    window: { api: { suiteRunnerOutput: async (id, opts) => { reads.push([id, opts]); return answer; } } },
    testOutputPane: ids.get('test-output-pane'),
    testOutputChoice: T.createStreamChoice(),
    createOutputFollower: (o) => (follower ? follower(o) : T.createOutputFollower({ ...o, timers })),
    console: { error: (...a) => events.push(['console.error', ...a.map((x) => (x && x.message) || x)]) },
    streamInfo: T.streamInfo, streamLabel: T.streamLabel, otherStream: T.otherStream, autoOpenJob: T.autoOpenJob,
    testActivityView: (state) => ({ summary: '', box: '', running: [], waiting: [], recent: state.snapshot.recent.map((j) => j.title), empty: null }),
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext([
    'let testActivitySnap = null;', 'let testActivityAutoOpen = false;',
    'let testOutputFollower = null;', 'let testOutputJob = null;', 'let testOutputRevealPending = false;',
    ...['testActivityRow', 'testActivityJobRows', 'markTestActivityRows', 'testActivityJob', 'testOutputContext',
      'paintTestOutputStreams', 'paintTestOutput', 'showTestOutputFailure', 'followTestOutput', 'openTestOutput', 'closeTestOutput',
      'closeTestOutputToRow', 'refreshOpenTestOutput', 'paintTestActivity'].map(fnSource),
    'globalThis.ui = { paint: paintTestActivity, closeToRow: closeTestOutputToRow };',
  ].join('\n'), ctx);
  const job = (id, over = {}) => ({ id, title: `job ${id}`, queuedAt: 1000, startedAt: 2000, endedAt: 9000,
    streams: { stdout: { bytes: 34500, lastOutputAt: 8000 }, stderr: { bytes: 0, lastOutputAt: null } }, ...over });
  const fire = async () => { const h = pending.shift(); assert.ok(h, 'ENTER: a read is scheduled'); await h.fn(); };
  const row = (id) => doc.querySelectorAll().find((r) => r.dataset.jobId === id);
  return {
    ctx, ui: ctx.ui, ids, events, doc, reads, fire, row, job, pending,
    setAnswer: (a) => { answer = a; },
    paint: (recent) => ctx.ui.paint({ enabled: true, snapshot: { running: [], waiting: [], recent } }),
  };
}

const page = (over) => ({
  ok: true, id: 'a', stream: 'stdout', phase: 'done', live: false, at: 10000, queuedAt: 1000, startedAt: 2000,
  endedAt: 9000, lastOutputAt: 8000, expired: false, total: 5, offset: 0, next: 5, text: 'hello', ...over,
});

test('opening an output unhides the pane, scrolls the row and the pane into view and focuses the output text', () => {
  const h = harness();
  h.paint([h.job('a'), h.job('b')]);
  h.events.length = 0;
  h.row('b').querySelector('.test-activity-output').click();
  assert.strictEqual(h.ids.get('test-output-pane').classList.contains('hidden'), false);
  assert.strictEqual(h.ids.get('test-activity-dialog').classList.contains('output-open'), true);
  assert.deepStrictEqual(h.events, [
    ['scroll', 'b', { block: 'nearest' }],
    ['scroll', 'test-output-pane', { block: 'nearest' }],
    ['focus', 'test-output-text', { preventScroll: true }],
  ]);
  assert.strictEqual(h.doc.activeElement, h.ids.get('test-output-text'));
  assert.match(html, /<pre id="test-output-text" tabindex="0"><\/pre>/);
});

test('the pane is scrolled into view again once its first text is painted, and not on later paints', async () => {
  const h = harness();
  h.paint([h.job('a')]);
  h.setAnswer(page({ live: true, total: 5, next: 5 }));
  h.row('a').click();
  h.events.length = 0;
  await h.fire();
  assert.strictEqual(h.ids.get('test-output-text').textContent, 'hello');
  assert.deepStrictEqual(h.events, [['scroll', 'test-output-pane', { block: 'nearest' }]]);
  h.setAnswer(page({ live: true, total: 10, offset: 5, next: 10, text: ' more' }));
  await h.fire();
  assert.strictEqual(h.ids.get('test-output-text').textContent, 'hello more');
  assert.deepStrictEqual(h.events, [['scroll', 'test-output-pane', { block: 'nearest' }]]);
});

test('the poll repaint keeps focus on a row button without scrolling the dialog back to it', () => {
  const h = harness();
  h.paint([h.job('a')]);
  h.row('a').querySelector('.test-activity-output').focus();
  h.events.length = 0;
  h.paint([h.job('a')]);
  assert.deepStrictEqual(h.events, [['focus', 'test-activity-output', { preventScroll: true }]]);
});

test('closing the output returns focus to the row Output button', () => {
  const h = harness();
  h.paint([h.job('a'), h.job('b')]);
  h.row('b').click();
  h.events.length = 0;
  h.ui.closeToRow();
  assert.strictEqual(h.ids.get('test-output-pane').classList.contains('hidden'), true);
  assert.strictEqual(h.ids.get('test-activity-dialog').classList.contains('output-open'), false);
  assert.strictEqual(h.doc.activeElement, h.row('b').querySelector('.test-activity-output'));
  assert.match(src, /getElementById\('test-output-close'\)\.addEventListener\('click', closeTestOutputToRow\)/);
});

test('a failed read, an empty stream and a job that did not start each paint their status literal', async () => {
  const rows = [
    ['failed read', { ok: false, error: 'no handler: suiteRunner:output' }, 'could not read the output: no handler: suiteRunner:output'],
    ['thrown read', null, 'could not read the output: no answer'],
    ['empty stdout', page({ total: 0, next: 0, text: '' }), 'stdout is empty'],
    ['did not start', page({ startedAt: null, total: 0, next: 0, text: '', lastOutputAt: null }), 'this job did not start, so it has no output'],
  ];
  for (const [name, answer, want] of rows) {
    const h = harness();
    h.paint([h.job('a', { streams: { stdout: { bytes: 0, lastOutputAt: null }, stderr: { bytes: 0, lastOutputAt: null } } })]);
    h.setAnswer(answer);
    h.row('a').click();
    await h.fire();
    const status = h.ids.get('test-output-status');
    assert.deepStrictEqual([status.textContent, status.style.display], [want, ''], name);
  }
});

test('a did-not-start row keeps its Output button and the pane says why it is empty', () => {
  const h = harness();
  h.paint([h.job('a', { startedAt: null })]);
  assert.ok(h.row('a').querySelector('.test-activity-output'), 'the row has an Output button');
});

test('the dialog is a 900px flex column; the lists scroll and the output pane takes at least half', () => {
  const pick = (id, prop) => { const d = winningDeclaration(css, [{ id: id.slice(1), tag: 'div', classes: [] }], prop); return d ? d.value : null; };
  assert.deepStrictEqual({
    width: pick('#test-activity-dialog', 'width'),
    display: pick('#test-activity-dialog', 'display'),
    direction: pick('#test-activity-dialog', 'flex-direction'),
    listsFlex: pick('#test-activity-lists', 'flex'),
    listsOverflow: pick('#test-activity-lists', 'overflow'),
    paneFlex: pick('#test-output-pane', 'flex'),
    textFlex: pick('#test-output-text', 'flex'),
    textMin: pick('#test-output-text', 'min-height'),
    textMax: pick('#test-output-text', 'max-height'),
  }, {
    width: '900px', display: 'flex', direction: 'column', listsFlex: '0 1 auto', listsOverflow: 'auto',
    paneFlex: '1 0 50%', textFlex: '1 1 auto', textMin: '200px', textMax: null,
  });
  assert.match(css, /#test-activity-dialog \{[^}]*max-height: calc\(100vh - 32px\);\n {2}max-height: calc\(100dvh - 32px\);/);
  assert.match(css, /#test-activity-dialog\.output-open \{ height: calc\(100vh - 32px\); height: calc\(100dvh - 32px\); \}/);
});

test('an ok read with text is painted into the pre', async () => {
  const h = harness();
  h.paint([h.job('a')]);
  h.setAnswer(page({ text: 'hello', total: 5, next: 5 }));
  h.row('a').click();
  await h.fire();
  assert.strictEqual(h.ids.get('test-output-text').textContent, 'hello');
});

test('a follower that throws on start, and a paint that throws, each show the error in the status line and log it', async () => {
  const rows = [
    ['start throws', () => ({ close() {}, setFollow() {}, start() { throw new Error('boom on start'); } }), 'could not show the output: boom on start'],
    ['paint throws', (o) => ({
      close() {}, setFollow() {},
      start() { o.onUpdate({ get text() { throw new Error('boom in paint'); }, header: 'h', status: '', live: false, follow: false }); },
    }), 'could not show the output: boom in paint'],
  ];
  for (const [name, follower, want] of rows) {
    const h = harness({ follower });
    h.paint([h.job('a')]);
    h.row('a').click();
    const status = h.ids.get('test-output-status');
    assert.deepStrictEqual([status.textContent, status.style.display], [want, ''], name);
    assert.ok(h.events.some((e) => e[0] === 'console.error' && e.includes(want.replace('could not show the output: ', ''))), name);
  }
});
