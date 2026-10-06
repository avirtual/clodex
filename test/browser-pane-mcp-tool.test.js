'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const subagent = require('../plugins/browser-pane/subagent');
const { TOOL } = require('../plugins/browser-pane/mcp-tool');

test('the verb enum is the plugin\'s SUBS', () => {
  assert.deepStrictEqual(TOOL.inputSchema.properties.verb.enum, subagent.SUBS);
});

const ROWS = [
  [{ verb: 'read', service: 'svc' }, '[agent:browser read svc]'],
  [{ verb: 'read', service: 'svc', bracket: ['--text', '--filter=pdf', '--page=2'] }, '[agent:browser read svc --text --filter=pdf --page=2]'],
  [{ verb: 'click', service: 'svc', bracket: ['17'] }, '[agent:browser click svc 17]'],
  [{ verb: 'click', service: 'svc', bracket: ['--text=Lista de plată'] }, '[agent:browser click svc --text="Lista de plată"]'],
  [{ verb: 'inspect', bracket: ['3'] }, '[agent:browser inspect 3]'],
  [{ verb: 'type', service: 'svc', bracket: ['3', '--enter'], body: 'hello world' }, '[agent:browser type svc 3 --enter] hello world'],
  [{ verb: 'select', service: 'svc', bracket: ['4'], body: 'Option B' }, '[agent:browser select svc 4] Option B'],
  [{ verb: 'key', service: 'svc', body: 'Enter' }, '[agent:browser key svc] Enter'],
  [{ verb: 'scroll', service: 'svc', bracket: ['down', '--pages=3'] }, '[agent:browser scroll svc down --pages=3]'],
  [{ verb: 'scroll', service: 'svc', body: 'x' }, '[agent:browser scroll svc] x'],
  [{ verb: 'back', service: 'svc' }, '[agent:browser back svc]'],
  [{ verb: 'forward', service: 'svc' }, '[agent:browser forward svc]'],
  [{ verb: 'services' }, '[agent:browser services]'],
  [{ verb: 'screenshot', service: 'svc', bracket: ['--numbers'] }, '[agent:browser screenshot svc --numbers]'],
  [{ verb: 'wait', service: 'svc', bracket: ['--for=Showing 1'] }, '[agent:browser wait svc --for="Showing 1"]'],
  [{ verb: 'download', service: 'svc', bracket: ['5', '--to=bills', '--as=a.pdf'] }, '[agent:browser download svc 5 --to=bills --as=a.pdf]'],
  [{ verb: 'read', service: 'svc', bracket: ['--filter=Showing 1'] }, '[agent:browser read svc --filter="Showing 1"]'],
  [{ verb: 'download', service: 'svc', bracket: ['5', '--to=my bills', '--as=a b.pdf'] }, '[agent:browser download svc 5 --to="my bills" --as="a b.pdf"]'],
  [{ verb: 'download', service: 'svc', body: 'https://x/y.pdf' }, '[agent:browser download svc] https://x/y.pdf'],
  [{ verb: 'open', service: 'svc', bracket: ['--show'], body: 'https://example.com/' }, '[agent:browser open svc --show] https://example.com/'],
  [{ verb: 'note', service: 'svc', body: '@* caution: popup on page 2' }, '[agent:browser note svc] @* caution: popup on page 2'],
  [{ verb: 'click', service: 'svc', bracket: ['17', '--confirm'] }, '[agent:browser click svc 17 --confirm]'],
  [{ verb: 'note', service: 'svc', bracket: ['--forget=ab3k'] }, '[agent:browser note svc --forget=ab3k]'],
  [{ verb: 'type', service: 'svc', bracket: ['3', '--confirm'], body: 'x' }, '[agent:browser type svc 3 --confirm] x'],
];

test('toIntent renders the CLI line over every row', () => {
  for (const [args, line] of ROWS) {
    const full = { bracket: [], body: '', ...args };
    assert.strictEqual(TOOL.toIntent(full), `${line}\n[agent:end]`, JSON.stringify(args));
  }
});

const BRACKET_MSG = 'bracket tokens must be non-empty and contain no [, ], newline or carriage return';
const INVALID = [
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

test('release and close render (policy refuses them downstream)', () => {
  assert.strictEqual(TOOL.toIntent({ verb: 'release', service: 'svc' }), '[agent:browser release svc]\n[agent:end]');
  assert.strictEqual(TOOL.toIntent({ verb: 'close', service: 'svc' }), '[agent:browser close svc]\n[agent:end]');
  assert.deepStrictEqual(TOOL.inputSchema.properties.verb.enum, require('../plugins/browser-pane/subagent').SUBS);
});
  assert.throws(() => TOOL.toIntent({ verb: 'close' }), { message: "close is for the seat's main agent — a subagent may open, read, click, type, select, key, scroll, back, forward, wait, download, screenshot, inspect, services, note" });
});
