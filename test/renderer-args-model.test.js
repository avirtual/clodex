// Run: node --test
// Covers renderer/lib/args-model.js — the pure Model <-> extraArgs projection
// used by both session dialogs. splitModelArg pulls the first --model token out;
// withModelArg projects the field back (F3 pass-through: empty model = identity).
const { test } = require('node:test');
const assert = require('node:assert');
const { splitModelArg, withModelArg } = require('../renderer/lib/args-model');

test('splitModelArg: --model X form', () => {
  const { model, rest } = splitModelArg(['--model', 'opus', '--foo', 'bar']);
  assert.strictEqual(model, 'opus');
  assert.deepStrictEqual(rest, ['--foo', 'bar']);
});

test('splitModelArg: -m X short form', () => {
  const { model, rest } = splitModelArg(['-m', 'sonnet', '-x']);
  assert.strictEqual(model, 'sonnet');
  assert.deepStrictEqual(rest, ['-x']);
});

test('splitModelArg: --model=X fused form', () => {
  const { model, rest } = splitModelArg(['--model=haiku', '--foo']);
  assert.strictEqual(model, 'haiku');
  assert.deepStrictEqual(rest, ['--foo']);
});

test('splitModelArg: no model → empty string, rest preserved in order', () => {
  const { model, rest } = splitModelArg(['--foo', 'a', '--bar']);
  assert.strictEqual(model, '');
  assert.deepStrictEqual(rest, ['--foo', 'a', '--bar']);
});

test('splitModelArg: only the FIRST model token is pulled', () => {
  const { model, rest } = splitModelArg(['--model', 'opus', '--model', 'sonnet']);
  assert.strictEqual(model, 'opus');
  assert.deepStrictEqual(rest, ['--model', 'sonnet']);
});

test('splitModelArg: non-array input → empty', () => {
  assert.deepStrictEqual(splitModelArg(undefined), { model: '', rest: [] });
  assert.deepStrictEqual(splitModelArg(null), { model: '', rest: [] });
});

test('splitModelArg: a trailing model flag with no value is dropped, not passed to the CLI', () => {
  assert.deepStrictEqual(splitModelArg(['--foo', '--model']), { model: '', rest: ['--foo'] });
  assert.deepStrictEqual(splitModelArg(['-m']), { model: '', rest: [] });
});

test('withModelArg: non-empty field prepends and strips existing', () => {
  assert.deepStrictEqual(
    withModelArg(['--model', 'opus', '--foo'], 'sonnet'),
    ['--model', 'sonnet', '--foo'],
  );
});

test('withModelArg: non-empty field on model-less argv prepends', () => {
  assert.deepStrictEqual(
    withModelArg(['--foo', 'bar'], 'opus'),
    ['--model', 'opus', '--foo', 'bar'],
  );
});

test('withModelArg: field is authoritative — replaces -m and --model= forms', () => {
  assert.deepStrictEqual(withModelArg(['-m', 'haiku'], 'opus'), ['--model', 'opus']);
  assert.deepStrictEqual(withModelArg(['--model=haiku', '--x'], 'opus'), ['--model', 'opus', '--x']);
});

test('withModelArg: strips ALL existing model tokens, not just the first', () => {
  assert.deepStrictEqual(
    withModelArg(['--model', 'a', '--model', 'b', '-x', '1'], 'z'),
    ['--model', 'z', '-x', '1'],
  );
});

test('withModelArg: strips all model tokens across mixed forms', () => {
  assert.deepStrictEqual(
    withModelArg(['-m', 'a', '--model=b', '-x'], 'z'),
    ['--model', 'z', '-x'],
  );
});

test('withModelArg: an empty-valued model token does not stop the strip, so a later token cannot survive', () => {
  assert.deepStrictEqual(withModelArg(['--model=', '--model', 'b', '--foo'], 'x'), ['--model', 'x', '--foo']);
  assert.deepStrictEqual(withModelArg(['--model', '', '-m', 'b'], 'x'), ['--model', 'x']);
});

test('withModelArg: a model flag whose next token is another model flag leaves no orphaned value', () => {
  assert.deepStrictEqual(withModelArg(['--model', '-m', 'b'], 'x'), ['--model', 'x']);
  assert.deepStrictEqual(withModelArg(['-m', '--model=b', '--foo'], 'x'), ['--model', 'x', '--foo']);
});

test('withModelArg: F3 pass-through — empty field leaves a box --model UNTOUCHED', () => {
  assert.deepStrictEqual(
    withModelArg(['--model', 'opus', '--foo'], ''),
    ['--model', 'opus', '--foo'],
  );
});

test('withModelArg: F3 pass-through — empty field on model-less argv is identity', () => {
  assert.deepStrictEqual(withModelArg(['--foo', 'bar'], ''), ['--foo', 'bar']);
});

test('withModelArg: whitespace-only field treated as empty (pass-through)', () => {
  assert.deepStrictEqual(withModelArg(['--model', 'opus'], '   '), ['--model', 'opus']);
});

test('withModelArg: field value is trimmed before prepending', () => {
  assert.deepStrictEqual(withModelArg(['--foo'], '  opus  '), ['--model', 'opus', '--foo']);
});

test('round-trip: split then re-apply the same model is stable', () => {
  const argv = ['--model', 'opus', '--foo', 'bar'];
  const { model, rest } = splitModelArg(argv);
  assert.deepStrictEqual(withModelArg(rest, model), argv);
});

test('order-preservation: unrelated args keep their order across a model swap', () => {
  const argv = ['--a', '1', '--model', 'x', '--b', '2', '--c'];
  const out = withModelArg(argv, 'y');
  assert.deepStrictEqual(out, ['--model', 'y', '--a', '1', '--b', '2', '--c']);
});
