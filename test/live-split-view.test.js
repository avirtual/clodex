'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscript } = require('../transcript-spike');
const { OUTPUT_LINE_CAP, renderTranscript } = require('../renderer/live-split-view');

function fakeDoc() {
  return {
    createTextNode: (text) => ({ text, style: '' }),
    createElement: () => ({
      style: {},
      get text() { return this.textContent; },
      set innerHTML(v) { throw new Error(`innerHTML written: ${v}`); },
    }),
    createDocumentFragment: () => ({ kids: [], appendChild(n) { this.kids.push(n); return n; } }),
  };
}

function render(rows) {
  const pane = { replaceChildren(frag) { this.nodes = frag.kids; } };
  renderTranscript(fakeDoc(), pane, rows);
  return pane.nodes.map((n) => ({ text: n.text, style: n.style.cssText !== undefined ? n.style.cssText : n.style }));
}

const plain = (nodes) => nodes.map((n) => n.text).join('');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'local-command-context.jsonl'), 'utf8');

test('the /context records become a command row then a command-output row rendered with their SGR styles', () => {
  const rows = parseTranscript(FIXTURE);
  assert.deepStrictEqual(rows.map((r) => r.kind), ['command', 'command-output']);
  assert.deepStrictEqual(rows[0], { kind: 'command', name: '/context', args: '' });
  const nodes = render(rows);
  assert.deepStrictEqual(nodes.slice(0, 5), [
    { text: '❯ /context', style: '' },
    { text: '\n', style: '' },
    { text: 'Context Usage', style: 'font-weight:bold' },
    { text: '\n', style: '' },
    { text: '⛁ ⛁ ⛁ ⛁ ⛁ ', style: 'color:rgb(153,153,153)' },
  ]);
  assert.strictEqual(plain(nodes).split('\n')[1], 'Context Usage');
  assert.doesNotMatch(plain(nodes), /\x1b/);
});

test('a command-output record with no command before it still renders after the text rows', () => {
  const rec = (o) => JSON.stringify(o);
  const rows = parseTranscript([
    rec({ type: 'user', message: { content: 'hi' } }),
    rec({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Help dialog dismissed</local-command-stdout>' }),
  ].join('\n'));
  assert.deepStrictEqual(rows, ['❯ hi', { kind: 'command-output', text: 'Help dialog dismissed' }]);
  assert.strictEqual(plain(render(rows)), '❯ hi\nHelp dialog dismissed');
});

test('command args follow the name on the prompt line', () => {
  assert.strictEqual(plain(render([{ kind: 'command', name: '/model', args: 'opus' }])), '❯ /model opus');
});

test(`command output is capped at ${OUTPUT_LINE_CAP} lines per record with a count of the rest`, () => {
  const text = Array.from({ length: OUTPUT_LINE_CAP + 5 }, (_, i) => `\x1b[1mL${i}\x1b[22m`).join('\n');
  const lines = plain(render([{ kind: 'command-output', text }])).split('\n');
  assert.strictEqual(lines.length, OUTPUT_LINE_CAP + 1);
  assert.strictEqual(lines[OUTPUT_LINE_CAP - 1], `L${OUTPUT_LINE_CAP - 1}`);
  assert.strictEqual(lines[OUTPUT_LINE_CAP], '… 5 more lines');
  const exact = Array.from({ length: OUTPUT_LINE_CAP }, (_, i) => `L${i}`).join('\n');
  assert.strictEqual(plain(render([{ kind: 'command-output', text: exact }])).split('\n').length, OUTPUT_LINE_CAP);
});

test('markup characters in command output land as text content, never as HTML', () => {
  const nodes = render([{ kind: 'command-output', text: '\x1b[31m<img src=x onerror=1>&amp;\x1b[39m' }]);
  assert.deepStrictEqual(nodes, [{ text: '<img src=x onerror=1>&amp;', style: 'color:rgb(205,49,49)' }]);
});
