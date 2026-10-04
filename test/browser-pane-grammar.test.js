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
  ['[agent:browser frob utility 4]',
    { error: "unknown subcommand 'frob' — use open, read, click, type, key, select, download, screenshot, wait, services, release" }],
  ['[agent:browser click 4]', { sub: 'click', service: null, n: 4 }],
  ['[agent:browser click utility 4]', { sub: 'click', service: 'utility', n: 4 }],
  ['[agent:browser click utility]', { error: 'click needs an element number from your read — [agent:browser click [service] <n>]' }],
  ['[agent:browser click 0]', { error: 'element number out of range: 0' }],
  ['[agent:browser click 4 5]', { error: "unexpected '4' for click" }],
  ['[agent:browser click utility 4 5]', { error: "unexpected '5' for click" }],
  ['[agent:browser click --text="Lista de plată"]', { sub: 'click', service: null, n: null, text: 'Lista de plată' }],
  ['[agent:browser click ebloc --text="Lista de  plată 08/2026"]', { sub: 'click', service: 'ebloc', n: null, text: 'Lista de  plată 08/2026' }],
  ['[agent:browser click ebloc --text=Avizier]', { sub: 'click', service: 'ebloc', n: null, text: 'Avizier' }],
  ['[agent:browser click ebloc 4 --text=Avizier]', { error: 'click takes an element number or --text, not both' }],
  ['[agent:browser click --text=]', { error: '--text needs the visible text, e.g. --text="Lista de plată"' }],
  ['[agent:browser click --text="  "]', { error: '--text needs the visible text, e.g. --text="Lista de plată"' }],
  ['[agent:browser click --text]', { error: '--text needs a value, e.g. --text=…' }],
  ['[agent:browser type 6] hello world', { sub: 'type', service: null, n: 6, text: 'hello world', enter: false }],
  ['[agent:browser type irs 30 --enter] Form 1040', { sub: 'type', service: 'irs', n: 30, text: 'Form 1040', enter: true }],
  ['[agent:browser type 6 --enter]', { sub: 'type', service: null, n: 6, text: '', enter: true }],
  ['[agent:browser type 6]', { error: 'type needs text after the bracket — [agent:browser type [service] <n> [--enter]] <text>' }],
  ['[agent:browser type 6 --enter=yes] x', { error: '--enter takes no value' }],
  ['[agent:browser key] Enter', { sub: 'key', service: null, key: 'Enter' }],
  ['[agent:browser key irs] ArrowDown', { sub: 'key', service: 'irs', key: 'ArrowDown' }],
  ['[agent:browser key] Space', { sub: 'key', service: null, key: 'Space' }],
  ['[agent:browser key] enter',
    { error: 'key needs one of Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space after the bracket' }],
  ['[agent:browser select 3] August 2026', { sub: 'select', service: null, n: 3, option: 'August 2026' }],
  ['[agent:browser select utility 3]', { error: 'select needs the option after the bracket — [agent:browser select [service] <n>] <option>' }],
  ['[agent:browser wait]', { sub: 'wait', service: null, ms: null, forText: null }],
  ['[agent:browser wait utility --ms=5000 --for="Showing 1"]', { sub: 'wait', service: 'utility', ms: 5000, forText: 'Showing 1' }],
  ['[agent:browser wait --ms=99999999]', { sub: 'wait', service: null, ms: 1800000, forText: null }],
  ['[agent:browser wait --ms=0]', { error: '--ms must be an integer ≥ 1' }],
  ['[agent:browser wait --timeout=5]', { error: 'unknown flag --timeout for wait — valid: --ms --for' }],
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
  ['[agent:browser download 3]', { sub: 'download', service: null, n: 3, url: null, to: null, as: null }],
  ['[agent:browser download utility 3]', { sub: 'download', service: 'utility', n: 3, url: null, to: null, as: null }],
  ['[agent:browser download]', { sub: 'download', service: null, n: null, url: null, to: null, as: null }],
  ['[agent:browser download] https://portal.example.com/bills/2026-08.pdf',
    { sub: 'download', service: null, n: null, url: 'https://portal.example.com/bills/2026-08.pdf', to: null, as: null }],
  ['[agent:browser download 3] https://portal.example.com/bills/2026-08.pdf',
    { error: 'download takes an element number or a URL, not both' }],
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
