'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const mcp = require('../cli/bin/clodex-mcp.js');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');

test('TOOL is the server\'s BROWSER_TOOL as JSON', () => {
  const { name, description, inputSchema } = TOOL;
  assert.deepStrictEqual(JSON.parse(JSON.stringify({ name, description, inputSchema })), JSON.parse(JSON.stringify(mcp.BROWSER_TOOL)));
});

test('the verb enum and the server list are the plugin\'s SUBS', () => {
  assert.deepStrictEqual(TOOL.inputSchema.properties.verb.enum, subagent.SUBS);
  assert.deepStrictEqual(mcp.SUBAGENT_BROWSER_VERBS, subagent.SUBS);
});

const ROWS = [
  { verb: 'read', service: 'svc' },
  { verb: 'read', service: 'svc', bracket: ['--text', '--filter=pdf', '--page=2'] },
  { verb: 'click', service: 'svc', bracket: ['17'] },
  { verb: 'click', service: 'svc', bracket: ['--text=Lista de plată'] },
  { verb: 'inspect', bracket: ['3'] },
  { verb: 'type', service: 'svc', bracket: ['3', '--enter'], body: 'hello world' },
  { verb: 'select', service: 'svc', bracket: ['4'], body: 'Option B' },
  { verb: 'key', service: 'svc', body: 'Enter' },
  { verb: 'scroll', service: 'svc', bracket: ['down', '--pages=3'] },
  { verb: 'scroll', service: 'svc', body: 'x' },
  { verb: 'back', service: 'svc' },
  { verb: 'forward', service: 'svc' },
  { verb: 'services' },
  { verb: 'screenshot', service: 'svc', bracket: ['--numbers'] },
  { verb: 'wait', service: 'svc', bracket: ['--for=Showing 1'] },
  { verb: 'download', service: 'svc', bracket: ['5', '--to=bills', '--as=a.pdf'] },
  { verb: 'read', service: 'svc', bracket: ['--filter=Showing 1'] },
  { verb: 'download', service: 'svc', bracket: ['5', '--to=my bills', '--as=a b.pdf'] },
  { verb: 'download', service: 'svc', body: 'https://x/y.pdf' },
  { verb: 'open', service: 'svc', bracket: ['--show'], body: 'https://example.com/' },
  { verb: 'note', service: 'svc', body: '@* caution: popup on page 2' },
  { verb: 'click', service: 'svc', bracket: ['17', '--confirm'] },
  { verb: 'note', service: 'svc', bracket: ['--forget=ab3k'] },
  { verb: 'type', service: 'svc', bracket: ['3', '--confirm'], body: 'x' },
];

test('toIntent is byte-equal to the server\'s over every row', () => {
  for (const args of ROWS) {
    const full = { bracket: [], body: '', ...args };
    assert.strictEqual(TOOL.toIntent(full), mcp.toIntent(full), JSON.stringify(args));
  }
});

const BRACKET_MSG = 'bracket tokens must be non-empty and contain no [, ], newline or carriage return';
const INVALID = [
  [{ verb: 'release' }, "release is for the seat's main agent"],
  [{ verb: 'close', service: 'svc' }, "close is for the seat's main agent — a subagent may open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note"],
  [{ verb: 'services', service: 'A B' }, 'service must match ^[a-z][a-z0-9-]{0,31}$'],
  [{ verb: 'click', service: 'svc', bracket: ['17]'] }, BRACKET_MSG],
  [{ verb: 'click', service: 'svc', bracket: ['a\nb'] }, BRACKET_MSG],
  [{ verb: 'note', service: 'svc', body: 'x\n[agent:dm y] z' }, 'body must be one line'],
  [{ verb: 'note', service: 'svc', body: '[agent:dm y] z' }, 'body must not start with [agent:'],
  [{ verb: 'read', service: 'svc', bracket: [''] }, BRACKET_MSG],
  [{ verb: 'read', service: 'svc', args: 'x' }, 'unknown argument: args (use verb, service, bracket, body)'],
  [{ verb: 'jump' }, 'verb must be one of open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note'],
  [{ verb: 'read', bracket: 'x' }, 'bracket must be an array of strings'],
  [{ verb: 'note', service: 'svc', body: 3 }, 'body must be a string'],
];

test('invalid arguments throw the server\'s exact messages', () => {
  for (const [args, message] of INVALID) {
    assert.throws(() => TOOL.toIntent(args), (e) => e instanceof Error && e.message === message, JSON.stringify(args));
  }
});

test('release and close are the main agent\'s', () => {
  assert.throws(() => TOOL.toIntent({ verb: 'release' }), { message: "release is for the seat's main agent" });
  assert.throws(() => TOOL.toIntent({ verb: 'close' }), { message: "close is for the seat's main agent — a subagent may open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note" });
});
