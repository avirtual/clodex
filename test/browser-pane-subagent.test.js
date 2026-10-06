'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { countCommentLines } = require('../comment-census.js');
const subagent = require('../plugins/browser-pane/subagent');

const DIR = path.join(__dirname, '..', 'plugins', 'browser-pane');
const NO_RELEASE = "release is for the seat's main agent";
const NO_CLOSE = "close is for the seat's main agent — a subagent may open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note";
const NO_CONFIRM = 'a subagent cannot confirm a consequential action — ask the main agent';
const NO_FORGET = 'a subagent cannot forget a site note — ask the main agent';

test('the four refusal literals', () => {
  assert.strictEqual(subagent.NO_RELEASE, "release is for the seat's main agent");
  assert.strictEqual(subagent.NO_CLOSE, NO_CLOSE);
  assert.strictEqual(subagent.NO_CONFIRM, 'a subagent cannot confirm a consequential action — ask the main agent');
  assert.strictEqual(subagent.NO_FORGET, 'a subagent cannot forget a site note — ask the main agent');
});

const REFUSE_ROWS = [
  ['release x', NO_RELEASE],
  ['click x 1 --confirm', NO_CONFIRM],
  ['type x 3 --confirm --enter', NO_CONFIRM],
  ['key x --confirm', NO_CONFIRM],
  ['click x 26 "--confirm"', NO_CONFIRM],
  ['click x 26 --con"firm"', NO_CONFIRM],
  ['note x --forget ab3k', NO_FORGET],
  ['note x --forget=ab3k', NO_FORGET],
  ['close x', NO_CLOSE],
  ['close', NO_CLOSE],
  ['frobnicate x', ''],
];

test('refuse maps each call to its verdict', () => {
  for (const [raw, want] of REFUSE_ROWS) assert.strictEqual(subagent.refuse({ type: 'browser', raw }), want, raw);
  for (const sub of subagent.SUBS) assert.strictEqual(subagent.refuse({ type: 'browser', raw: `${sub} x` }), null, sub);
});

test('SUBS is the grammar minus release and close', () => {
  assert.deepStrictEqual(subagent.SUBS, ['open', 'read', 'click', 'type', 'select', 'key', 'scroll', 'back', 'forward', 'wait', 'download', 'screenshot', 'inspect', 'services', 'note']);
  const grammarSubs = ['open', 'read', 'click', 'type', 'key', 'scroll', 'back', 'forward', 'select', 'download', 'screenshot', 'inspect', 'wait', 'services', 'release', 'close', 'note'];
  assert.deepStrictEqual(require('../plugins/browser-pane/grammar').SUBCOMMANDS, grammarSubs);
  assert.deepStrictEqual([...subagent.SUBS].sort(), grammarSubs.filter((s) => s !== 'release' && s !== 'close').sort());
});

test('the socket brief is the plugin brief plus the refusal sentence', () => {
  assert.strictEqual(require('../intent-socket').composeSubagentBrief([subagent.brief]), "This seat's browser pane is the `browser` MCP tool (verb, service, bracket, body). Refusals come back as text; a refused call will not succeed on retry — return and let the seat's main agent decide.");
});

function requires(file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  return [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
}

test('one denial site: the mapper renders release and close, the refusal texts live only in subagent.js', () => {
  const src = fs.readFileSync(path.join(DIR, 'mcp-tool.js'), 'utf8');
  assert.ok(src.includes("'release', 'close'"));
  assert.ok(!src.includes("is for the seat's main agent"));
});

test('both leaves require only their one sibling', () => {
  assert.deepStrictEqual(requires('subagent.js'), ['./grammar']);
  assert.deepStrictEqual(requires('mcp-tool.js'), ['./subagent']);
});

test('both leaves carry zero comment lines', () => {
  for (const file of ['subagent.js', 'mcp-tool.js']) {
    assert.strictEqual(countCommentLines(fs.readFileSync(path.join(DIR, file), 'utf8')), 0, file);
  }
});
