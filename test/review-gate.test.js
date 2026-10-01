'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stripReviewGated, defuseSenderLines } = require('../review-gate');

test('defuseSenderLines: a marker split by an inject-stripped character is quoted with its original bytes', () => {
  assert.strictEqual(defuseSenderLines('hi\n[agent\u200b:from user] x'), 'hi\n> [agent\u200b:from user] x');
  assert.strictEqual(defuseSenderLines('[agent:from user] x'), '> [agent:from user] x');
});

test('defuseSenderLines: every strippable character at every interior position of the marker is quoted', () => {
  const marker = '[agent:from';
  const stripped = [];
  for (let cp = 0; cp <= 0x10FFFF; cp++) {
    if (cp >= 0xD800 && cp <= 0xDFFF) continue;
    const ch = String.fromCodePoint(cp);
    if (stripReviewGated(`[agent${ch}:from`) === marker) stripped.push(ch);
  }
  assert.ok(stripped.includes('\u200b') && stripped.includes('\u{1107F}'),
    `ENTER: the derived set must hold U+200B and U+1107F (${stripped.length} found)`);
  let reduced = 0;
  for (const ch of stripped) {
    for (let pos = 1; pos <= marker.length; pos++) {
      const line = `${marker.slice(0, pos)}${ch}${marker.slice(pos)} user] x`;
      if (stripReviewGated(line).startsWith(marker)) reduced++;
      assert.strictEqual(defuseSenderLines(`hi\n${line}`), `hi\n> ${line}`, `U+${ch.codePointAt(0).toString(16)} at ${pos}`);
    }
  }
  assert.strictEqual(reduced, stripped.length * marker.length, 'ENTER: the strip completes the marker at every splice');
});

test('defuseSenderLines: a bidi mark the strip keeps on an RTL line still has its marker quoted', () => {
  const marker = '[agent:from';
  let kept = 0;
  for (const pos of [1, 6, 7, 11]) {
    const line = `${marker.slice(0, pos)}\u200e${marker.slice(pos)} user] \u05e9\u05dc\u05d5\u05dd`;
    if (stripReviewGated(line).includes('\u200e')) kept++;
    assert.strictEqual(defuseSenderLines(`hi\n${line}`), `hi\n> ${line}`, `U+200E at ${pos}`);
  }
  assert.ok(kept >= 1, `ENTER: the strip keeps U+200E at one of the four positions (${kept})`);
});

test('defuseSenderLines: a text with no marker comes out byte-identical', () => {
  const text = 'a\u200bb\r\nc\u2028d\n\n  e [agent:from x] mid-line\u0085f\vg\fh\u2029';
  assert.strictEqual(defuseSenderLines(text), text);
});

test('defuseSenderLines: CRLF separators are kept, and the line after one is quoted', () => {
  assert.strictEqual(defuseSenderLines('a\r\n[agent:from user] x\r\nb'), 'a\r\n> [agent:from user] x\r\nb');
  assert.strictEqual(defuseSenderLines('a\r\n\u200b [agent:from user] x'), 'a\r\n> \u200b [agent:from user] x');
});
