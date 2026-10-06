'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseLine, toCommand, profileOf, tabOf } = require('../plugins/browser-pane/grammar');

const run = (line) => {
  const intent = parseLine(line);
  if (!intent) return null;
  try { return toCommand(intent); } catch (e) { return { error: e.message }; }
};

const READ = { sub: 'read', service: null, mode: 'default', main: false, all: false, compact: false, filter: null, page: 1, max: 2500 };

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
  ['[agent:browser read utility --all]', { ...READ, service: 'utility', all: true }],
  ['[agent:browser read utility --filter="sep 2026"]', { ...READ, service: 'utility', filter: 'sep 2026' }],
  ['[agent:browser read "utility" --max=100]', { ...READ, service: 'utility', max: 500 }],
  ['[agent:browser read --max=99999]', { ...READ, max: 8000 }],
  ['[agent:browser read x --compact]', { ...READ, service: 'x', compact: true }],
  ['[agent:browser read x --compact --filter=@a]', { ...READ, service: 'x', compact: true, filter: '@a' }],
  ['[agent:browser read --compact --text]', { error: '--compact is a mode of the default read; drop --text/--links' }],
  ['[agent:browser read x --links --compact]', { error: '--compact is a mode of the default read; drop --text/--links' }],
  ['[agent:browser services]', { sub: 'services' }],
  ['[agent:browser release]', { sub: 'release', service: null }],
  ['[agent:browser release irs]', { sub: 'release', service: 'irs' }],
  ['[agent:browser close]', { sub: 'close', service: null }],
  ['[agent:browser close t31]', { sub: 'close', service: 't31' }],
  ['[agent:browser read 5]', { error: "unexpected '5' for read" }],
  ['[agent:browser release 12]', { error: "unexpected '12' for release" }],
  ['[agent:browser read Utility]',
    { error: "bad service name 'Utility' — use a-z, 0-9 and -, starting with a letter, at most 32 chars, optionally :<tab> (a-z, 0-9 and -, at most 16)" }],
  ['[agent:browser open x:riot] https://x.example/a', { sub: 'open', service: 'x:riot', url: 'https://x.example/a' }],
  ['[agent:browser read x:riot]', { ...READ, service: 'x:riot' }],
  ...['x:', 'x:Riot', 'x:a-very-long-tab-1', 'x:riot:2', 'x::riot'].map((n) => [`[agent:browser open ${n}] https://x.example/`,
    { error: `bad service name '${n}' — use a-z, 0-9 and -, starting with a letter, at most 32 chars, optionally :<tab> (a-z, 0-9 and -, at most 16)` }]),
  ['[agent:browser read utility --bogus]',
    { error: 'unknown flag --bogus for read — valid: --text --links --compact --main --all --notes --filter --page --max --attach --path-only' }],
  ['[agent:browser open utility --links] https://x.example/',
    { error: 'unknown flag --links for open — valid: --show' }],
  ['[agent:browser open utility --show] https://x.example/',
    { sub: 'open', service: 'utility', url: 'https://x.example/', show: true }],
  ['[agent:browser frob utility 4]',
    { error: "unknown subcommand 'frob' — use open, read, click, type, key, scroll, back, forward, select, download, screenshot, inspect, wait, services, release, close, note" }],
  ['[agent:browser click 4]', { sub: 'click', service: null, n: 4 }],
  ['[agent:browser click utility 4]', { sub: 'click', service: 'utility', n: 4 }],
  ['[agent:browser click utility]', { error: 'click needs an element number from your read — [agent:browser click [service] <n>]' }],
  ['[agent:browser click 0]', { error: 'element number out of range: 0' }],
  ['[agent:browser click 4 5]', { error: "unexpected '4' for click" }],
  ['[agent:browser click utility 4 5]', { error: "unexpected '5' for click" }],
  ['[agent:browser click --text="Lista de plată"]', { sub: 'click', service: null, n: null, text: 'Lista de plată' }],
  ['[agent:browser click ebloc --text="Lista de  plată 08/2026"]', { sub: 'click', service: 'ebloc', n: null, text: 'Lista de  plată 08/2026' }],
  ['[agent:browser click ebloc --text=Avizier]', { sub: 'click', service: 'ebloc', n: null, text: 'Avizier' }],
  ['[agent:browser click ebloc --text=Lista de plată 08/2026]', { sub: 'click', service: 'ebloc', n: null, text: 'Lista de plată 08/2026' }],
  ['[agent:browser inspect --text=Lista onclick]', { sub: 'inspect', service: null, n: null, text: 'Lista onclick' }],
  ['[agent:browser click --text=Factura PDF --to=bills]', { sub: 'click', service: null, n: null, text: 'Factura PDF', to: 'bills' }],
  ['[agent:browser click --text=Factura --to=bills ebloc]', { error: "unexpected 'ebloc' for click — quote the text or put it last" }],
  ['[agent:browser click --text="Factura" ebloc extra]', { error: "unexpected 'extra' for click — quote the text or put it last" }],
  ['[agent:browser screenshot ebloc --numbers]', { sub: 'screenshot', service: 'ebloc', numbers: true }],
  ['[agent:browser screenshot]', { sub: 'screenshot', service: null }],
  ['[agent:browser read --attach]', { ...READ, attach: true }],
  ['[agent:browser read ebloc --path-only --page=2]', { ...READ, service: 'ebloc', page: 2, attach: false }],
  ['[agent:browser read --attach --path-only]', { error: '--attach and --path-only cannot be combined' }],
  ['[agent:browser screenshot ebloc --path-only]', { sub: 'screenshot', service: 'ebloc', attach: false }],
  ['[agent:browser screenshot --numbers --attach]', { sub: 'screenshot', service: null, numbers: true, attach: true }],
  ['[agent:browser screenshot --path-only --attach]', { error: '--attach and --path-only cannot be combined' }],
  ['[agent:browser read --path-only=yes]', { error: '--path-only takes no value' }],
  ['[agent:browser click 4 --attach]', { error: 'unknown flag --attach for click — valid: --text --to --confirm' }],
  ['[agent:browser inspect 4 --path-only]', { error: 'unknown flag --path-only for inspect — valid: --text' }],
  ['[agent:browser click ebloc 4 --text=Avizier]', { error: 'click takes an element number or --text, not both' }],
  ['[agent:browser click --text=]', { error: '--text needs the visible text, e.g. --text="Lista de plată"' }],
  ['[agent:browser click --text="  "]', { error: '--text needs the visible text, e.g. --text="Lista de plată"' }],
  ['[agent:browser click --text]', { error: '--text needs a value, e.g. --text=…' }],
  ['[agent:browser click ebloc 4 --to=bills]', { sub: 'click', service: 'ebloc', n: 4, to: 'bills' }],
  ['[agent:browser click --text=PDF --to="facturi 2026"]', { sub: 'click', service: null, n: null, text: 'PDF', to: 'facturi 2026' }],
  ['[agent:browser click 4 --to=../outside]', { sub: 'click', service: null, n: 4, to: '../outside' }],
  ['[agent:browser click 4 --to=]', { error: '--to needs a folder, e.g. --to=bills' }],
  ['[agent:browser inspect 7]', { sub: 'inspect', service: null, n: 7 }],
  ['[agent:browser inspect ebloc 7]', { sub: 'inspect', service: 'ebloc', n: 7 }],
  ['[agent:browser inspect ebloc --text="Lista de plată"]', { sub: 'inspect', service: 'ebloc', n: null, text: 'Lista de plată' }],
  ['[agent:browser inspect 7 --text=Lista]', { error: 'inspect takes an element number or --text, not both' }],
  ['[agent:browser inspect]', { error: 'inspect needs an element number from your read — [agent:browser inspect [service] <n>]' }],
  ['[agent:browser inspect 7 --to=x]', { error: 'unknown flag --to for inspect — valid: --text' }],
  ['[agent:browser type 6] hello world', { sub: 'type', service: null, n: 6, text: 'hello world', enter: false }],
  ['[agent:browser type irs 30 --enter] Form 1040', { sub: 'type', service: 'irs', n: 30, text: 'Form 1040', enter: true }],
  ['[agent:browser type 6 --enter]', { sub: 'type', service: null, n: 6, text: '', enter: true }],
  ['[agent:browser type 6]', { error: 'type needs text after the bracket — [agent:browser type [service] <n> [--enter] [--confirm]] <text>' }],
  ['[agent:browser type 6 --enter=yes] x', { error: '--enter takes no value' }],
  ['[agent:browser key] Enter', { sub: 'key', service: null, key: 'Enter' }],
  ['[agent:browser key irs] ArrowDown', { sub: 'key', service: 'irs', key: 'ArrowDown' }],
  ['[agent:browser key] Space', { sub: 'key', service: null, key: 'Space' }],
  ['[agent:browser key] enter',
    { error: 'key needs one of Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight PageUp PageDown Home End Space after the bracket' }],
  ['[agent:browser scroll]', { sub: 'scroll', service: null, dir: 'down', pages: 1 }],
  ['[agent:browser scroll x up --pages=3]', { sub: 'scroll', service: 'x', dir: 'up', pages: 3 }],
  ['[agent:browser scroll x bottom]', { sub: 'scroll', service: 'x', dir: 'bottom' }],
  ['[agent:browser scroll x bottom --pages=2]', { error: '--pages only applies to up or down' }],
  ['[agent:browser scroll x sideways]', { error: 'scroll direction must be one of down up top bottom' }],
  ['[agent:browser scroll down x]', { error: "unexpected 'x' for scroll" }],
  ['[agent:browser scroll down up]', { error: 'scroll takes one direction: down, up, top or bottom' }],
  ['[agent:browser scroll x down up]', { error: 'scroll takes one direction: down, up, top or bottom' }],
  ['[agent:browser scroll --pages=21]', { error: '--pages must be at most 20' }],
  ['[agent:browser scroll] more', { error: 'scroll takes no text after the bracket' }],
  ['[agent:browser back]', { sub: 'back', service: null }],
  ['[agent:browser forward x]', { sub: 'forward', service: 'x' }],
  ['[agent:browser back x 2]', { error: 'back takes no count' }],
  ['[agent:browser forward 2]', { error: 'forward takes no count' }],
  ['[agent:browser back x] more', { error: 'back takes no text after the bracket' }],
  ['[agent:browser select 3] August 2026', { sub: 'select', service: null, n: 3, option: 'August 2026' }],
  ['[agent:browser select utility 3]', { error: 'select needs the option after the bracket — [agent:browser select [service] <n>] <option>' }],
  ['[agent:browser wait]', { sub: 'wait', service: null, ms: null, forText: null }],
  ['[agent:browser wait utility --ms=5000 --for="Showing 1"]', { sub: 'wait', service: 'utility', ms: 5000, forText: 'Showing 1' }],
  ['[agent:browser wait utility --for=Interactive Brokers]', { error: "unexpected 'Brokers' for wait — quote multi-word text: --for=\"Interactive Brokers\"" }],
  ['[agent:browser scroll utility --for=a b]', { error: 'unknown flag --for for scroll — valid: --pages' }],
  ['[agent:browser read utility --text=yes foo]', { error: '--text takes no value' }],
  ['[agent:browser read utility --filter=heat meter]', { error: "unexpected 'meter' for read — quote multi-word text: --filter=\"heat meter\"" }],
  ['[agent:browser read --filter=pdf t56]', { error: "unexpected 't56' for read — put the service first: read t56 --filter=pdf" }],
  ['[agent:browser wait --for=Done utility]', { error: "unexpected 'utility' for wait — put the service first: wait utility --for=Done" }],
  ['[agent:browser wait --ms=99999999]', { sub: 'wait', service: null, ms: 1800000, forText: null, sleep: true }],
  ['[agent:browser wait utility --ms=2000]', { sub: 'wait', service: 'utility', ms: 2000, forText: null, sleep: true }],
  ['[agent:browser wait --idle --ms=2000]', { sub: 'wait', service: null, ms: 2000, forText: null }],
  ['[agent:browser wait --idle]', { sub: 'wait', service: null, ms: null, forText: null }],
  ['[agent:browser wait --ms=0]', { error: '--ms must be an integer ≥ 1' }],
  ['[agent:browser wait --timeout=5]', { error: 'unknown flag --timeout for wait — valid: --ms --for --idle' }],
  ['[agent:browser read --text --links]', { error: '--text and --links cannot be combined' }],
  ['[agent:browser read --page=0]', { error: '--page must be an integer ≥ 1' }],
  ['[agent:browser read --page]', { error: '--page needs a value, e.g. --page=…' }],
  ['[agent:browser read --text=yes]', { error: '--text takes no value' }],
  ['[agent:browser read --filter="sep 2026]', { error: 'unbalanced double quote in the bracket' }],
  ['[agent:browser open utility]',
    { error: 'open needs a URL after the bracket — [agent:browser open <service>] <url>' }],
  ['[agent:browser open etoro https://www.etoro.com/markets/btc]',
    { error: "unexpected 'https://www.etoro.com/markets/btc' for open — the URL goes after the closing bracket: [agent:browser open etoro] https://www.etoro.com/markets/btc" }],
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
  ['[agent:browser note etoro] @/portfolio/* quirk: rows renumber — click --text=<asset>',
    { sub: 'note', service: 'etoro', text: '@/portfolio/* quirk: rows renumber — click --text=<asset>' }],
  ['[agent:browser note] @* path: Facturi first', { sub: 'note', service: null, text: '@* path: Facturi first' }],
  ['[agent:browser note etoro --list]', { sub: 'note', service: 'etoro', list: true }],
  ['[agent:browser note etoro --forget ab3k]', { sub: 'note', service: 'etoro', forget: 'ab3k' }],
  ['[agent:browser note etoro --forget=AB3K]', { sub: 'note', service: 'etoro', forget: 'ab3k' }],
  ['[agent:browser note etoro --forget ab1k]', { error: '--forget needs a note id from note --list, e.g. --forget ab3k' }],
  ['[agent:browser note etoro --list] x', { error: 'note --list takes no text after the bracket' }],
  ['[agent:browser note etoro --list --forget ab3k]', { error: '--list and --forget cannot be combined' }],
  ['[agent:browser note etoro]', { error: 'note needs "@<anchor> <kind>: <text>" — anchor * or a path (a ?key=value query is allowed), kind path|quirk|caution' }],
  ['[agent:browser read --notes]', { ...READ, notes: true }],
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

test('grammar: click and select take --confirm; other subcommands refuse it', () => {
  assert.deepStrictEqual(run('[agent:browser click utility 27 --confirm]'), { sub: 'click', service: 'utility', n: 27, confirm: true });
  assert.strictEqual(run('[agent:browser click utility 27]').confirm, undefined);
  assert.strictEqual(run('[agent:browser click utility --text="Plătește" --confirm]').confirm, true);
  assert.strictEqual(run('[agent:browser select utility 4 --confirm] Card').confirm, true);
  assert.match(run('[agent:browser scroll utility --confirm]').error, /unknown flag --confirm for scroll/);
});

test('grammar: type and key take --confirm', () => {
  assert.deepStrictEqual(run('[agent:browser type utility 26 --enter --confirm] 100'), { sub: 'type', service: 'utility', n: 26, text: '100', enter: true, confirm: true });
  assert.strictEqual(run('[agent:browser type utility 26 --enter] 100').confirm, undefined);
  assert.deepStrictEqual(run('[agent:browser key utility --confirm] Enter'), { sub: 'key', service: 'utility', key: 'Enter', confirm: true });
  assert.strictEqual(run('[agent:browser key utility] Enter').confirm, undefined);
  assert.match(run('[agent:browser type utility 4 --bogus] x').error, /unknown flag --bogus for type — valid: .*--confirm/);
  assert.strictEqual(run('[agent:browser key x Enter]').error, 'the key goes after the bracket: [agent:browser key [service]] Enter');
  assert.strictEqual(run('[agent:browser key Space]').error, 'the key goes after the bracket: [agent:browser key [service]] Space');
  assert.match(run('[agent:browser key utility --bogus] Enter').error, /unknown flag --bogus for key — valid: .*--confirm/);
});

test('grammar: profileOf and tabOf split <profile>[:<tab>]', () => {
  assert.deepStrictEqual([profileOf('x:riot'), tabOf('x:riot'), profileOf('x'), tabOf('x')], ['x', 'riot', 'x', '']);
});
