'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { registerIpcHandlers } = require('../ipc-handlers');

const PAGE = {
  name: 'how-to',
  title: 'How to',
  section: 'Guides',
  content: '# How to\n\nbody text\n',
};

function mkHandlers(getHelpCorpus) {
  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {} },
    ...(getHelpCorpus ? { getHelpCorpus } : {}),
  });
  return handlers;
}

function corpusOf({ onGet } = {}) {
  return {
    index: () => ({ sections: [{ title: 'Guides', pages: [{ name: 'how-to', title: 'How to', headings: [] }] }] }),
    get: (name) => {
      if (onGet) onGet(name);
      return name === 'how-to' ? { ...PAGE } : null;
    },
  };
}

test('help:page of a known name projects exactly ok/name/title/content — no section, no spread', () => {
  const handlers = mkHandlers(() => corpusOf());
  const page = handlers.get('help:page');
  assert.strictEqual(typeof page, 'function', 'ENTER: help:page registered, or every assertion below is vacuous');

  const res = page(null, 'how-to');
  assert.deepStrictEqual(Object.keys(res).sort(), ['content', 'name', 'ok', 'title']);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.name, 'how-to');
  assert.strictEqual(res.title, 'How to');
  assert.strictEqual(res.content, PAGE.content);
  assert.ok(!('section' in res),
    'the corpus record carries `section`; a spread would leak it onto the wire');
});

test('help:page of an unknown name answers { ok: false } and never throws', () => {
  const handlers = mkHandlers(() => corpusOf());
  const page = handlers.get('help:page');
  for (const bad of ['nope', '', null, undefined, '../../etc/passwd', 42]) {
    const res = page(null, bad);
    assert.deepStrictEqual(res, { ok: false }, `${JSON.stringify(bad)} → { ok: false }`);
  }
});

test('help:page passes the name through as a STRING — no path is ever built from it', () => {
  const seen = [];
  const handlers = mkHandlers(() => corpusOf({ onGet: (n) => seen.push(n) }));
  handlers.get('help:page')(null, 42);
  handlers.get('help:page')(null, null);
  handlers.get('help:page')(null, { evil: true });
  assert.deepStrictEqual(seen, ['42', '', '[object Object]']);
  for (const s of seen) assert.strictEqual(typeof s, 'string');
});

test('help:index answers ok plus the corpus sections', () => {
  const handlers = mkHandlers(() => corpusOf());
  const index = handlers.get('help:index');
  assert.strictEqual(typeof index, 'function', 'ENTER: help:index registered');

  const res = index();
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.sections, [
    { title: 'Guides', pages: [{ name: 'how-to', title: 'How to', headings: [] }] },
  ]);
});

test('the corpus is read through the getter per call — the handlers hold no captured object', () => {
  let calls = 0;
  const corpus = corpusOf();
  const handlers = mkHandlers(() => {
    calls += 1;
    return corpus;
  });
  handlers.get('help:index')();
  handlers.get('help:page')(null, 'how-to');
  assert.strictEqual(calls, 2, 'each invocation reads the getter, so a late-built corpus is still seen');
});

test('with NO getHelpCorpus dep both handlers register and answer { ok: false }', () => {
  const handlers = mkHandlers(null);
  assert.strictEqual(typeof handlers.get('help:index'), 'function',
    'registration must not throw on a missing dep — a host that never builds a corpus still loads this module');
  assert.strictEqual(typeof handlers.get('help:page'), 'function', 'help:page registered without the dep');
  assert.deepStrictEqual(handlers.get('help:index')(), { ok: false });
  assert.deepStrictEqual(handlers.get('help:page')(null, 'how-to'), { ok: false });
});

test('a getter that returns null answers { ok: false } rather than throwing', () => {
  const handlers = mkHandlers(() => null);
  assert.deepStrictEqual(handlers.get('help:index')(), { ok: false });
  assert.deepStrictEqual(handlers.get('help:page')(null, 'how-to'), { ok: false });
});
