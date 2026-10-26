'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const iso = require('./lib/engine-isolation');
const { wirescopeEnvGate } = require('../wirescope-supervisor');
const { mkTmpRoot } = require('./lib/tmp-roots');

after(() => { setImmediate(() => process.exit(0)); });

const HELPER = path.join(__dirname, 'lib', 'engine-isolation.js');

const DIRECT_ENGINE_REQUIRE = /^[^'"`\n]*\brequire\(\s*['"](\.\.\/)+engine(\.js)?['"]\s*\)/m;

function testJsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'fixtures' && ent.name !== 'node_modules') out.push(...testJsFiles(full)); }
    else if (ent.name.endsWith('.js') && full !== HELPER) out.push(full);
  }
  return out;
}

test('every test file that builds an engine gets createEngine from test/lib/engine-isolation', () => {
  const builders = testJsFiles(__dirname).filter((f) => /\bcreateEngine\s*\(/.test(fs.readFileSync(f, 'utf8')));
  const names = builders.map((f) => path.relative(__dirname, f));
  assert.ok(names.includes('optimized-late-skills.test.js') && names.includes('statusline.test.js'),
    `ENTER: the scan must select the known engine builders — got ${JSON.stringify(names)}`);
  assert.ok(builders.length >= 47, `ENTER: 47 test files built an engine when this was written; the scan found ${builders.length}`);
  const offenders = [];
  for (const f of builders) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(__dirname, f);
    const helperSpec = path.relative(path.dirname(f), HELPER).replace(/\.js$/, '').replace(/^(?!\.)/, './');
    const viaHelper = new RegExp(`^(const [^=]+= )?require\\('${helperSpec.replace(/[./]/g, '\\$&')}'\\)`, 'm').test(src);
    const direct = DIRECT_ENGINE_REQUIRE.test(src);
    if (!viaHelper || direct) offenders.push(`${rel}${viaHelper ? '' : ' (no top-level helper require)'}${direct ? ' (requires engine directly)' : ''}`);
  }
  assert.deepStrictEqual(offenders, [],
    'a test that builds an engine must require ./lib/engine-isolation at top level and take createEngine from it: a bare engine autostarts '
    + 'wirescope (python3 -m venv + pip install) and preseeds the real ~/.claude.json on every claude spawn');
});

test('the direct-engine-require scanner flags a real require and passes a quoted fixture string', () => {
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test("const { diagLines } = require('../engine');\n"), true);
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test('const engine = require("../engine.js");\n'), true);
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test("  const { x } = require('../../engine');\n"), true);
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test("const iso = require('./lib/engine-isolation');\n"), false);
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test("    'lib/util.js': \"const sib = require('../engine');\",\n"), false);
  assert.strictEqual(DIRECT_ENGINE_REQUIRE.test("const m = require('../engine-args');\n"), false);
});

test('no test file outside the helper requires the engine module directly', () => {
  const files = testJsFiles(__dirname);
  const names = files.map((f) => path.relative(__dirname, f));
  assert.ok(names.includes('seat-layout.test.js') && names.includes('deploy-visible.test.js'),
    `ENTER: the scan must cover every test file — got ${files.length}`);
  const offenders = names.filter((n) => DIRECT_ENGINE_REQUIRE.test(fs.readFileSync(path.join(__dirname, n), 'utf8')));
  assert.deepStrictEqual(offenders, [],
    'take engine exports from ./lib/engine-isolation: a direct require skips its HOME scratch root and wirescope gate');
});

test('the isolation env is in force: wirescope gated off and HOME a scratch root', () => {
  assert.deepStrictEqual(
    { CLODEX_WIRESCOPE: process.env.CLODEX_WIRESCOPE, HOME: process.env.HOME },
    iso.ISOLATED_ENV);
  assert.deepStrictEqual(Object.keys(iso.ISOLATED_ENV), ['CLODEX_WIRESCOPE', 'HOME']);
  assert.strictEqual(iso.ISOLATED_ENV.CLODEX_WIRESCOPE, 'off');
  assert.ok(iso.ISOLATED_ENV.HOME.startsWith(path.join(os.tmpdir(), 'clodex-suite') + path.sep),
    `HOME must be a suite scratch root — got ${iso.ISOLATED_ENV.HOME}`);
  assert.notStrictEqual(iso.ISOLATED_ENV.HOME, iso.REAL_HOME);
  assert.strictEqual(os.homedir(), iso.ISOLATED_ENV.HOME);
  assert.strictEqual(wirescopeEnvGate(process.env), 'disabled by CLODEX_WIRESCOPE');
});

test('an engine built through the helper is tracked and will not autostart wirescope', () => {
  const tmp = mkTmpRoot('clx-eng-iso-');
  const engine = iso.createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir: path.join(tmp, 'clodex-home') },
    log: { info() {}, warn() {}, error() {} },
  });
  assert.deepStrictEqual(iso.built, [engine]);
  assert.strictEqual(engine.wirescope.autoStartWanted(), false);
  iso.shutdownAll();
  assert.deepStrictEqual(iso.built, []);
});

test('shutdownAll shuts down every engine even when one shutdown throws', () => {
  const calls = [];
  iso.built.push(
    { shutdown() { calls.push('a'); throw new Error('boom'); }, manager: {} },
    { shutdown() { calls.push('b'); }, manager: {} });
  iso.shutdownAll();
  assert.deepStrictEqual(calls, ['a', 'b']);
  assert.deepStrictEqual(iso.built, []);
});
