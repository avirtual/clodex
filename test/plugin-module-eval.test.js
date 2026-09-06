'use strict';
// plugin-module-eval.test.js — the CommonJS shim a non-shipped renderer half is
// evaluated through in the browser. The shipped halves reach the page through the
// build-generated registry; everything else arrives as source text over
// `renderer.info` and runs here, so this is the whole trust-and-failure surface
// of that path.

const test = require('node:test');
const assert = require('node:assert');

const { evalRendererModule } = require('../renderer/lib/plugin-module-eval');

test('a source exporting activate evaluates to a module with that function', () => {
  const mod = evalRendererModule("exports.activate = function (rhost) { return rhost; };\n", 'demo');
  assert.strictEqual(typeof mod.activate, 'function');
  assert.strictEqual(mod.activate('rhost'), 'rhost', 'and it is the plugin\'s own function, not a stub');
});

test('both CommonJS export shapes work — module.exports = and exports.x =', () => {
  const whole = evalRendererModule("module.exports = { activate: () => 7, id: 'w' };\n", 'demo');
  assert.strictEqual(whole.activate(), 7);
  assert.strictEqual(whole.id, 'w');
  const partial = evalRendererModule('exports.a = 1; exports.b = 2;\n', 'demo');
  assert.deepStrictEqual(partial, { a: 1, b: 2 });
});

test('require() inside a renderer half throws, naming the plugin', () => {
  assert.throws(
    () => evalRendererModule("const fs = require('fs');\nexports.activate = () => fs;\n", 'crypto-research'),
    (e) => {
      assert.match(e.message, /crypto-research/, 'the id is in the message or the operator cannot tell which plugin');
      assert.match(e.message, /cannot require\(\) in the browser/);
      return true;
    });
});

test('a syntax error in the source throws rather than yielding a half-built module', () => {
  assert.throws(() => evalRendererModule('exports.activate = () => {\n', 'demo'), SyntaxError);
});

test('a throw during evaluation propagates to the caller', () => {
  // The activation strike path: the renderer reports it exactly as it reports a
  // throwing activate(), so swallowing it here would show a plugin as activated.
  assert.throws(() => evalRendererModule("throw new Error('kaboom');\n", 'demo'), /kaboom/);
});

test('the evaluated source cannot see the caller\'s locals', () => {
  // new Function compiles in global scope; a `vm`-less eval() here would close
  // over this file's scope and hand a plugin the renderer's internals.
  const aLocalOnlyInThisTest = 42;
  assert.strictEqual(aLocalOnlyInThisTest, 42, 'ENTER: the local really exists in the calling scope');
  assert.throws(
    () => evalRendererModule('exports.v = aLocalOnlyInThisTest;\n', 'demo'),
    ReferenceError);
});
