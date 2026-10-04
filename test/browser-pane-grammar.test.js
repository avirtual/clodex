'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseLine, toCommand } = require('../plugins/browser-pane/grammar');

const run = (line) => {
  const intent = parseLine(line);
  if (!intent) return null;
  try { return toCommand(intent); } catch (e) { return { error: e.message }; }
};

const READ = { sub: 'read', service: null, mode: 'default', main: false, filter: null, page: 1, max: 2500 };

const ROWS = [
  ['[agent:browser open utility] https://portal.example.com/bills',
    { sub: 'open', service: 'utility', url: 'https://portal.example.com/bills' }],
  ['[agent:browser open utility]   https://portal.example.com/bills?a=1  ',
    { sub: 'open', service: 'utility', url: 'https://portal.example.com/bills?a=1' }],
  ['[agent:browser read]', READ],
  ['[agent:browser read utility]', { ...READ, service: 'utility' }],
  ['[agent:browser read utility --links --filter=.pdf --page=3]',
    { ...READ, service: 'utility', mode: 'links', filter: '.pdf', page: 3 }],
  ['[agent:browser read --text --main]', { ...READ, mode: 'text', main: true }],
  ['[agent:browser read utility --filter="sep 2026"]', { ...READ, service: 'utility', filter: 'sep 2026' }],
  ['[agent:browser read "utility" --max=100]', { ...READ, service: 'utility', max: 500 }],
  ['[agent:browser read --max=99999]', { ...READ, max: 8000 }],
  ['[agent:browser services]', { sub: 'services' }],
  ['[agent:browser release]', { sub: 'release', service: null }],
  ['[agent:browser release irs]', { sub: 'release', service: 'irs' }],
  ['[agent:browser read 5]', { error: "unexpected '5' for read" }],
  ['[agent:browser release 12]', { error: "unexpected '12' for release" }],
  ['[agent:browser read Utility]',
    { error: "bad service name 'Utility' — use a-z, 0-9 and -, starting with a letter, at most 32 chars" }],
  ['[agent:browser read utility --bogus]',
    { error: 'unknown flag --bogus for read — valid: --text --links --main --filter --page --max' }],
  ['[agent:browser open utility --links] https://x.example/',
    { error: 'unknown flag --links for open — valid: none' }],
  ['[agent:browser click utility 4]', { error: "unknown subcommand 'click' — use open, read, services, release" }],
  ['[agent:browser read --text --links]', { error: '--text and --links cannot be combined' }],
  ['[agent:browser read --page=0]', { error: '--page must be an integer ≥ 1' }],
  ['[agent:browser read --page]', { error: '--page needs a value, e.g. --page=…' }],
  ['[agent:browser read --text=yes]', { error: '--text takes no value' }],
  ['[agent:browser read --filter="sep 2026]', { error: 'unbalanced double quote in the bracket' }],
  ['[agent:browser open utility]',
    { error: 'open needs a URL after the bracket — [agent:browser open <service>] <url>' }],
  ['[agent:browser open] https://x.example/',
    { error: 'open needs a service — [agent:browser open <service>] <url>' }],
  ['[agent:browser open utility] https://user:pw@portal.example.com/',
    { error: 'a URL with user:pass@ is refused — credentials never pass through an agent; the operator signs in in the window' }],
  ['[agent:browser open utility] file:///etc/passwd', { error: 'only http: and https: URLs can be opened, not file:' }],
  ['[agent:browser open utility] not a url', { error: 'not a URL: not a url' }],
  ['[agent:browser services extra]', { error: "unexpected 'extra' for services" }],
  ['[agent:browser] ok opened utility', null],
  ['[agent:browser]', null],
  ['[agent:browsers read]', null],
  ['[agent:dm bob] hi', null],
];

for (const [line, want] of ROWS) {
  test(`grammar: ${line}`, () => {
    assert.deepStrictEqual(run(line), want);
  });
}

test('grammar: a URL over 4,096 chars is refused', () => {
  const url = 'https://x.example/' + 'a'.repeat(4096);
  assert.deepStrictEqual(run(`[agent:browser open utility] ${url}`), { error: 'URL too long (max 4,096 chars)' });
});
