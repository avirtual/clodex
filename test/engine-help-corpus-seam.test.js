'use strict';
// engine-help-corpus-seam.test.js — the `getHelpCorpus` engine seam (t983 / S3).
//
// The shape is the point. The corpus is the ONE object the whole app reads help
// from: ipc-handlers answers help:index/help:page through it, app-menus builds
// its section submenus from it on every rebuild, and S5's remote-wiring takes
// the same getter. It is a GETTER on the bag rather than an eager field because
// loading it reads every page off disk, and a desktop launch that never opens
// Help must not pay for that. So two things are pinned here: the bag exposes it
// as a function, and the object it hands back is MEMOIZED — a per-call load
// would re-read the whole corpus on every menu rebuild.

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createEngine } = require('../engine');
const { mkTmpRoot } = require('./lib/tmp-roots');

// One engine for the file: standing one up is the expensive part, and the seam
// under test is a pure read off the bag. The memo assertion below needs the same
// engine across two reads anyway.
let engine = null;
function theEngine() {
  if (!engine) {
    const tmp = mkTmpRoot('clx-eng-help-');
    // registryDir or the engine seeds the operator's live ~/.clodex (t359).
    engine = createEngine({
      userDataPath: tmp,
      seams: { registryDir: path.join(tmp, 'clodex-home') },
      log: { info() {}, warn() {}, error() {} },
    });
  }
  return engine;
}

// A live engine holds timers and a registry watcher, so the runner would sit on
// an idle event loop after the last assertion. Same exit as the sibling engine
// seam tests (engine-web-info-seam.test.js:177).
after(() => { setImmediate(() => process.exit(0)); });

test('the engine bag exposes getHelpCorpus as a function', () => {
  const engine = theEngine();
  assert.strictEqual(typeof engine.getHelpCorpus, 'function',
    'ipc-handlers, app-menus and S5 remote-wiring all read the corpus through this one getter');
});

test('getHelpCorpus hands back the corpus surface the readers call', () => {
  const engine = theEngine();
  const corpus = engine.getHelpCorpus();
  assert.ok(corpus, 'a corpus is built from the app root');
  // The three the S3 readers use: index() for help:index and the menu, get() for
  // help:page. search()/section() are S5's, and are part of the same object.
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
