'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

let engine = null;
function theEngine() {
  if (!engine) {
    const tmp = mkTmpRoot('clx-eng-help-');
    engine = createEngine({
      userDataPath: tmp,
      seams: { registryDir: path.join(tmp, 'clodex-home') },
      log: { info() {}, warn() {}, error() {} },
    });
  }
  return engine;
}

after(function exitOnceTheLiveEngineHasNothingLeftToAssert() {
  setImmediate(() => process.exit(0));
});

test('the engine bag exposes getHelpCorpus as a function', () => {
  const engine = theEngine();
  assert.strictEqual(typeof engine.getHelpCorpus, 'function',
    'ipc-handlers, app-menus and S5 remote-wiring all read the corpus through this one getter');
});

test('getHelpCorpus hands back the corpus surface the readers call', () => {
  const engine = theEngine();
  const corpus = engine.getHelpCorpus();
  assert.ok(corpus, 'a corpus is built from the app root');
  for (const fn of ['index', 'get', 'list', 'search', 'section']) {
    assert.strictEqual(typeof corpus[fn], 'function', `corpus.${fn} is a function`);
  }
});

test('the corpus is MEMOIZED — a second read is the same object, not a second load', () => {
  const engine = theEngine();
  const a = engine.getHelpCorpus();
  const b = engine.getHelpCorpus();
  assert.strictEqual(a, b,
    'the menu rebuilds on every workspace change; a per-call load would re-read all 17 pages each time');
});

test('the corpus reads the REAL shipped manifest — how-to is present with its content', () => {
  const engine = theEngine();
  const corpus = engine.getHelpCorpus();
  const index = corpus.index();
  assert.ok(Array.isArray(index.sections) && index.sections.length, 'the manifest yields sections');

  const names = index.sections.flatMap((s) => s.pages.map((p) => p.name));
  assert.ok(names.includes('how-to'), `how-to is in the corpus (got: ${names.join(', ')})`);

  const doc = corpus.get('how-to');
  assert.ok(doc && doc.content.length, 'how-to has content, so the root the engine passes resolves');
  assert.strictEqual(corpus.get('no-such-page'), null, 'an unknown name is refused by the corpus itself');
});
