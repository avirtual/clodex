'use strict';
// plugin-api-doc-snippets.test.js — the CODE in plugins/plugin-api.md, executed.
//
// WHY THIS FILE EXISTS (t91). `plugins/plugin-api.md` is a one-way door: an
// out-of-tree author reads it and cannot read this repo. When it states a
// constraint it must also show how to discharge one, and the showing has to be
// correct — three clean-room trials all UNDERSTOOD the no-newline rule at §
// "inject is typing, not messaging" and two of three then botched the regex
// implementing it, one of them silently (parsed clean, wrong semantics).
//
// WHAT THIS FILE IS, AND IS NOT. It is not a "the doc mentions oneLine" check.
// A test that asserts a document CONTAINS a string cannot distinguish its two
// outcomes in any way an author would care about: the snippet can be present
// and wrong. So this file EXTRACTS the fenced block, EVALUATES it, and asserts
// what it DOES. If someone edits the snippet into something that no longer
// strips newlines, these tests go red — which is the only property that makes
// them worth their runtime.
//
// The one source-shape assertion here (no raw control bytes in the snippet) is
// deliberate and is not a containment check either: it holds the exact property
// the string form was chosen for, and a raw byte pasted into the doc flips it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DOCS = path.join(__dirname, '..', 'plugins', 'plugin-api.md');

// Pull the fenced ```js block that defines oneLine out of the document, then
// evaluate it and hand back the function. Anchored on the DEFINITION, not on a
// line number or ordinal, so the block may move within the doc freely.
function loadOneLineFromDocs() {
  const doc = fs.readFileSync(DOCS, 'utf8');
  const blocks = doc.match(/```js\n[\s\S]*?\n```/g) || [];
  const hits = blocks.filter((b) => /function\s+oneLine\s*\(/.test(b));
  assert.strictEqual(hits.length, 1,
    'plugins/plugin-api.md must define oneLine() in exactly one fenced js block');
  const src = hits[0].replace(/^```js\n/, '').replace(/\n```$/, '');
  // new Function, not require: the snippet is documentation, has no module
  // wrapper, and must run exactly as an author would paste it.
  return { fn: new Function(`${src}\nreturn oneLine;`)(), src };
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

test('docs oneLine(): strips newlines, the rule the surrounding prose states', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  assert.strictEqual(oneLine('a\nb'), 'a b', 'LF must not survive');
  assert.strictEqual(oneLine('a\r\nb'), 'a b', 'CRLF must collapse to ONE space, not two');
  assert.strictEqual(oneLine('a\rb'), 'a b', 'bare CR must not survive');
  assert.ok(!oneLine('one\ntwo\nthree').includes('\n'),
    'the whole point: no newline reaches inject()');
});

test('docs oneLine(): strips the full C0 range and DEL, not just the newlines', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  // Every C0 byte plus DEL, individually, between two letters. Any one of them
  // surviving would mean a plugin can still split a turn or corrupt a pane.
  for (let code = 0x00; code <= 0x1f; code += 1) {
    const out = oneLine(`a${String.fromCharCode(code)}b`);
    assert.strictEqual(out, 'a b', `control byte 0x${code.toString(16)} survived as ${JSON.stringify(out)}`);
  }
  assert.strictEqual(oneLine(`a${String.fromCharCode(0x7f)}b`), 'a b', 'DEL survived');
});

test('docs oneLine(): strips ANSI sequences whole, leaving no bracket residue', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  // The failure this pins is stripping the ESC but keeping "[31m" as text.
  assert.strictEqual(oneLine(`x${ESC}[31mRED${ESC}[0m y`), 'xRED y');
  assert.strictEqual(oneLine(`${ESC}]0;title${BEL}body`), 'body', 'OSC sequence');
  // Exact, not a "does not contain [" probe: residue can be any prefix of the
  // sequence, and only pinning the whole output catches all of them.
  assert.strictEqual(oneLine(`${ESC}[1;33mwarn${ESC}[0m`), 'warn');
});

test('docs oneLine(): collapses runs and trims, but does not fuse the words either side', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  assert.strictEqual(oneLine('a  \t \n b'), 'a b', 'a mixed run becomes ONE space');
  assert.strictEqual(oneLine('  padded  '), 'padded', 'leading/trailing whitespace goes');
  assert.strictEqual(oneLine('a\n\n\nb'), 'a b', 'a run of newlines is one space, not three');
  // The interesting half: control chars become a SPACE, not nothing. Dropping
  // them outright would silently weld two words into one.
  assert.strictEqual(oneLine('word\nword'), 'word word', 'words must not fuse');
});

test('docs oneLine(): leaves ordinary text untouched', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  const plain = 'Ordinary text, with punctuation: 100% fine (really) - unchanged.';
  assert.strictEqual(oneLine(plain), plain, 'a clean string must round-trip identically');
  assert.strictEqual(oneLine('unicode: café emoji-free ünïcödé'), 'unicode: café emoji-free ünïcödé',
    'non-ASCII is not a control character and must survive');
});

test('docs oneLine(): max is optional and OFF by default, matching the no-length-cap promise', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  const long = 'x'.repeat(5000);
  assert.strictEqual(oneLine(long).length, 5000,
    'default must not truncate — the doc promises inject has no length cap');
  const cut = oneLine('abcdefghij', 8);
  assert.ok(cut.length <= 8, `max must be respected, got length ${cut.length}`);
  assert.ok(cut.endsWith('...'), `truncation must be visible, got ${JSON.stringify(cut)}`);
  assert.strictEqual(oneLine('abcdefghij', 0).length, 10, 'max=0 means off, not "truncate to nothing"');
  assert.strictEqual(oneLine('short', 100), 'short', 'a string under max is untouched');
});

test('docs oneLine(): coerces non-strings rather than throwing, per inject rule 3', () => {
  const { fn: oneLine } = loadOneLineFromDocs();
  // The doc says the host calls String(text) and never rejects; a helper that
  // threw here would contradict the page it lives on.
  assert.strictEqual(oneLine(null), 'null');
  assert.strictEqual(oneLine(undefined), 'undefined');
  assert.strictEqual(oneLine(42), '42');
  assert.strictEqual(oneLine({ a: 1 }), '[object Object]');
});

test('docs oneLine(): the snippet itself contains no raw control byte', () => {
  const { src } = loadOneLineFromDocs();
  // This is the hazard the string form was chosen to make unrepresentable, so
  // it is worth holding directly: a raw control character pasted into the
  // snippet may parse clean and behave wrong, and `node --check` will not say
  // so. Tabs and the newlines that separate the snippet's own lines are the
  // only exemptions.
  const offenders = [];
  for (let i = 0; i < src.length; i += 1) {
    const code = src.charCodeAt(i);
    const raw = code <= 0x1f || code === 0x7f;
    if (raw && code !== 0x0a && code !== 0x09) offenders.push(`0x${code.toString(16)} at ${i}`);
  }
  assert.deepStrictEqual(offenders, [], 'raw control bytes in the documented snippet');
  assert.ok(/new RegExp\(/.test(src),
    'the snippet must build its patterns from strings, not regex literals');
});
