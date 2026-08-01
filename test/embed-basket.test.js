// The basket ingestion script's pure parts. The embedding loop itself needs a
// daemon and is exercised for real by running the script; what is testable
// here — and what actually breaks — is the record shaping and the parsing that
// decides WHICH records get embedded at all.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { asRecord, readBasket } = require('../scripts/embed-basket');
const { keyOf } = require('../hint-embed');

function mkBasket(objs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-eb-'));
  const file = path.join(dir, 'operator.jsonl');
  fs.writeFileSync(file, objs.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  return { dir, file };
}

test('embed-basket: the reply is embedded with the message', () => {
  // A question is routinely findable by words that appear only in the answer,
  // which is why the exchange is the unit on the lexical side too. If only the
  // operator half were embedded, "what did you tell me about X" could not match
  // the record where X appears solely in the reply.
  const rec = asRecord({ id: 'a', text: 'how does the helm chart find its values', reply: 'it reads values.yaml at render time' });
  assert.ok(rec.text.includes('values.yaml'), 'the reply must be part of the embedded text');
  assert.ok(rec.text.includes('helm chart'), 'and so must the operator half');
});

test('embed-basket: a record with no reply is still embedded', () => {
  const rec = asRecord({ id: 'b', text: 'never push without asking' });
  assert.strictEqual(rec.text, 'never push without asking');
  assert.ok(!/undefined|null/.test(rec.text), 'a missing reply must not leak into the text');
});

test('embed-basket: cwd rides as scope so confinement has something to read', () => {
  // Confinement is enforced by the retriever, but it can only confine what the
  // record carries. Dropping cwd here would make every basket hit unconfinable.
  const rec = asRecord({ id: 'c', text: 'the trading bot needs a new key', cwd: '/Users/x/crypto-trader' });
  assert.strictEqual(rec.scope, '/Users/x/crypto-trader');
});

test('embed-basket: the key changes when the reply changes', () => {
  // The key is content-addressed, and the reply is part of the content. A
  // record whose reply was later corrected must be re-embedded, or the store
  // serves a vector for text that no longer exists.
  const a = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'first answer' }));
  const b = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'corrected answer' }));
  assert.notStrictEqual(a, b);
  const same = keyOf(asRecord({ id: 'd', text: 'same question', reply: 'first answer' }));
  assert.strictEqual(a, same, 'and an unchanged record keeps its key, or every run re-embeds everything');
});

test('embed-basket: a truncated tail line does not lose the basket', () => {
  const { dir, file } = mkBasket([
    { id: 'a', text: 'first' },
    { id: 'b', text: 'second' },
    '{"id":"c","te',
  ]);
  const { records, bad } = readBasket(file);
  assert.strictEqual(records.length, 2, 'the intact records survive');
  assert.strictEqual(bad, 1, 'and the damage is REPORTED rather than silently absorbed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('embed-basket: a record with no text is skipped', () => {
  const { dir, file } = mkBasket([
    { id: 'a', text: 'real' },
    { id: 'b', reply: 'an answer to nothing' },
    { id: 'c', text: '' },
  ]);
  const { records } = readBasket(file);
  assert.deepStrictEqual(records.map((r) => r.id), ['a'],
    'embedding an empty string produces a vector that matches everything weakly');
  fs.rmSync(dir, { recursive: true, force: true });
});
