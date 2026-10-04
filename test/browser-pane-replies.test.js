'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const R = require('../plugins/browser-pane/replies');

const ESC = String.fromCharCode(27);

test('replies: oneLine collapses newlines, tabs, control runs and ANSI', () => {
  assert.strictEqual(R.oneLine('a\nb'), 'a b');
  assert.strictEqual(R.oneLine('a\r\n\tb'), 'a b');
  assert.strictEqual(R.oneLine(`${ESC}[31mred${ESC}[0m text`), 'red text');
  assert.strictEqual(R.oneLine(`x${String.fromCharCode(0)}${String.fromCharCode(127)}y`), 'x y');
  assert.strictEqual(R.oneLine('  spaced   out  '), 'spaced out');
  assert.strictEqual(R.oneLine('abcdefghij', 8), 'abcde...');
  assert.strictEqual(R.oneLine(null), 'null');
});

test('replies: claude gets @path with a trailing space, codex gets the Read-tool phrasing', () => {
  const info = { page: 1, pages: 2, elements: 87, tokens: 2400 };
  const file = '/var/folders/xy/T/clodex-browser-pane/clodex-hand/r-0007.txt';
  assert.strictEqual(R.readReply('utility', info, file, 'claude'),
    '[agent:browser] read utility · page 1/2 · 87 elements · ≈2.4k tok → @/var/folders/xy/T/clodex-browser-pane/clodex-hand/r-0007.txt ');
  assert.strictEqual(R.readReply('utility', info, file, 'codex'),
    '[agent:browser] read utility · page 1/2 · 87 elements · ≈2.4k tok → saved to /var/folders/xy/T/clodex-browser-pane/clodex-hand/r-0007.txt — read it with your Read tool.');
  assert.strictEqual(R.readReply('utility', info, '/tmp/a b/r-1.txt', 'claude').endsWith(' → @"/tmp/a b/r-1.txt" '), true);
});

test('replies: a long reply is capped at 600 chars but the path is never cut', () => {
  const file = '/t/' + 'p'.repeat(700) + '.txt';
  const out = R.readReply('utility', { page: 1, pages: 1, elements: 1, tokens: 10 }, file, 'claude');
  assert.ok(out.endsWith(`@${file} `));
  const open = R.openReply('utility', { status: 200, title: 't'.repeat(900), url: 'https://x.example/', login: {}, idle: { ok: true, ms: 1900 } });
  assert.strictEqual(open.length, 600);
});

test('replies: open reply shape', () => {
  assert.strictEqual(
    R.openReply('utility', { status: 200, title: 'My Bills — Example Utility', url: 'https://portal.example.com/bills?x=1', login: { password: false }, idle: { ok: true, ms: 1900 } }),
    '[agent:browser] opened utility · 200 · "My Bills — Example Utility" · https://portal.example.com/bills?x=1 · login: none · idle 1.9s · next: read');
  assert.match(
    R.openReply('utility', { status: 200, title: 'L', url: 'https://x/', login: { password: true }, idle: { ok: false, ms: 15000, inflight: ['/api/poll'] } }),
    / · login: password field · still busy after 15s \(1 requests in flight: \/api\/poll\) · next: read$/);
});

test('replies: services line from storage plus mirror', () => {
  const at = new Date(2026, 9, 4, 15, 40).getTime();
  const services = {
    irs: { lastUsedAt: 1, login: { state: 'unknown' } },
    utility: { lastUsedAt: 2, login: { state: 'logged-in', at } },
  };
  assert.strictEqual(R.servicesReply(services, new Map([['utility', 'idle']])),
    '[agent:browser] services: utility — signed in (10-04 15:40) · window open · idle │ irs — unknown · closed');
  assert.strictEqual(R.servicesReply({}, new Map()), '[agent:browser] no services yet — [agent:browser open <service>] <url>');
});

function withTmp(fn) {
  const root = mkTmpRoot('clodex-bp-replies-');
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try { return fn(root); } finally {
    if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('replies: the reply file lands under $TMPDIR with 0700/0600 modes', () => withTmp((root) => {
  const file = R.writeReplyFile('clodex-hand', 'hello\n');
  assert.strictEqual(path.dirname(file), path.join(root, 'clodex-browser-pane', 'clodex-hand'));
  assert.strictEqual(path.basename(file), 'r-0001.txt');
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'hello\n');
  assert.throws(() => R.writeReplyFile('..', 'x'), /bad seat name/);
  assert.throws(() => R.writeReplyFile('a/b', 'x'), /bad seat name/);
}));

test('replies: writing 55 keeps the 50 newest, and a file older than 24 h is pruned', () => withTmp(() => {
  let last;
  for (let i = 0; i < 55; i++) last = R.writeReplyFile('seat', `n${i}`);
  const dir = path.dirname(last);
  const names = fs.readdirSync(dir).sort();
  assert.strictEqual(names.length, 50);
  assert.strictEqual(names[0], 'r-0006.txt');
  assert.strictEqual(names[49], 'r-0055.txt');
  const old = path.join(dir, 'r-0010.txt');
  const past = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, past, past);
  R.writeReplyFile('seat', 'fresh');
  assert.strictEqual(fs.existsSync(old), false);
  assert.strictEqual(fs.readdirSync(dir).length, 50);
  assert.ok(fs.existsSync(path.join(dir, 'r-0006.txt')), 'the age prune made room, so the oldest young file stays');
}));

test('replies: the T3 refusal texts, verbatim', () => {
  assert.strictEqual(R.TEXT.staleDoc('utility', 'https://portal.example.com/x'),
    'utility navigated since your last read (now https://portal.example.com/x) — numbers from that read are void; read again.');
  assert.strictEqual(R.TEXT.noElement('utility', 12), 'no element [12] on utility any more (the page changed) — read again.');
  assert.strictEqual(R.TEXT.held('utility', 'login'),
    'the operator has control of utility (sign-in). Emit [agent:browser wait utility] and end your turn.');
  assert.strictEqual(R.TEXT.operatorBusy('utility'),
    'the operator has been using the utility window for the last 60s; try again in a minute or emit [agent:browser wait utility].');
  assert.strictEqual(R.TEXT.passwordField('utility', 7),
    '[7] is a password field — credentials never pass through agents. The operator has been asked to sign in; emit [agent:browser wait utility] and end your turn. Do not ask anyone for the password.');
  assert.strictEqual(R.TEXT.lease('utility', 'clodex-hand', 40000),
    'utility is in use by clodex-hand (last command 40s ago). It frees after 5 min without commands, when they emit [agent:browser release utility], or when their session ends.');
  assert.strictEqual(R.dropSuffix(['click 4', 'download 5']), ' — dropped 2 queued commands after it: click 4, download 5');
});

test('replies: the sign-in reply and notification, password and Google, verbatim', () => {
  assert.strictEqual(R.signinReply('utility', { password: true }, 'https://portal.example.com/login'),
    '[agent:browser] sign-in needed on utility (password field at https://portal.example.com/login). The operator has been notified and signs in themselves in the browser window. Do not ask anyone for a password or code and do not type one. Emit [agent:browser wait utility] and end your turn; the reply comes when the operator hands the window back.');
  assert.strictEqual(R.signinReply('utility', { idp: 'google' }, 'https://accounts.google.com/v3/signin'),
    "[agent:browser] sign-in on utility goes through Google (accounts.google.com), which refuses sign-in inside embedded browsers, so the operator probably cannot log in here. Tell the operator in one line and stop: they can try the portal's own email/password login, or download the files by hand. Do not ask for credentials.");
  assert.deepStrictEqual(R.signinNotice('utility', 'clodex-hand', 'https://portal.example.com/login', { password: true }), {
    title: 'Browser: sign in to utility',
    body: 'clodex-hand opened https://portal.example.com/login and hit a sign-in page. Click "browser: needs you" in the status bar (or find the "utility — Clodex Browser" window), sign in, then press "Hand back to agent". The agent never sees what you type.',
  });
  assert.deepStrictEqual(R.signinNotice('utility', 'clodex-hand', 'https://accounts.google.com/v3/signin/rejected', { googleRejected: true }), {
    title: 'Browser: utility uses Google sign-in',
    body: 'Google refuses sign-in inside embedded browsers ("This browser or app may not be secure"). If the portal has its own email/password login, use it in the window and press Hand back; otherwise this service cannot be automated yet.',
  });
});

test('replies: a stopped stalled load says so instead of still busy', () => {
  assert.strictEqual(R.openReply('stall', { status: 200, title: 'Stall', url: 'http://x/stall', login: {}, idle: { ok: false, stopped: true, ms: 15200, inflight: ['http://x/hang'] } }),
    '[agent:browser] opened stall · 200 · "Stall" · http://x/stall · login: none · stopped a stalled load after 15s · next: read');
});

test('replies: click --text with no match or several matches names the text and up to five numbered candidates', () => {
  assert.strictEqual(R.TEXT.noText('ebloc', 'Lista de plată'),
    'no visible element with the text "Lista de plată" on ebloc — read ebloc, or try a shorter part of the text');
  const hits = [31, 32, 33, 34, 35].map((n) => ({ n, text: `Lista de plată 0${n - 30}/2026` }));
  assert.strictEqual(R.TEXT.manyText('ebloc', 'lista', 7, hits),
    '"lista" matches 7 visible elements on ebloc: [31] "Lista de plată 01/2026", [32] "Lista de plată 02/2026", [33] "Lista de plată 03/2026", [34] "Lista de plată 04/2026", [35] "Lista de plată 05/2026", …(+2 more) — click one by number');
  assert.strictEqual(R.TEXT.manyText('ebloc', 'PDF', 2, hits.slice(0, 2)),
    '"PDF" matches 2 visible elements on ebloc: [31] "Lista de plată 01/2026", [32] "Lista de plată 02/2026" — click one by number');
});

test('replies: a click names the element the text resolved to and what the click opened', () => {
  const base = { kind: 'clickable', label: 'Lista de plată', navigated: false, idle: { ok: true, ms: 800 } };
  const cmd = { sub: 'click', n: null, text: 'Lista de plată' };
  assert.strictEqual(R.actReply('click', 'ebloc', cmd, { ...base, n: 31 }),
    '[agent:browser] clicked ebloc [31] clickable "Lista de plată" · same page · idle 0.8s');
  const dl = { file: '/Users/me/Library/Clodex/downloads/ebloc/lista-08.pdf', bytes: 48213, mime: 'application/pdf', url: 'https://www.e-bloc.ro/lista?id=8' };
  assert.strictEqual(R.actReply('click', 'ebloc', cmd, { ...base, n: 31, download: dl }),
    '[agent:browser] clicked ebloc [31] clickable "Lista de plată" · same page · idle 0.8s · → download /Users/me/Library/Clodex/downloads/ebloc/lista-08.pdf · 48,213 B · application/pdf · from https://www.e-bloc.ro/lista?id=8');
  assert.strictEqual(R.actReply('click', 'ebloc', cmd, { ...base, n: 31, download: { ...dl, file: '/tmp/my bills/big.pdf', bytes: null } }),
    '[agent:browser] clicked ebloc [31] clickable "Lista de plată" · same page · idle 0.8s · → download "/tmp/my bills/big.pdf" still downloading');
  assert.strictEqual(R.actReply('click', 'ebloc', cmd, { ...base, n: 31, download: { file: '/tmp/big.pdf', bytes: null, failed: 'larger than 500 MB' } }),
    '[agent:browser] clicked ebloc [31] clickable "Lista de plată" · same page · idle 0.8s · → download /tmp/big.pdf failed: larger than 500 MB');
  assert.strictEqual(R.actReply('click', 'ebloc', cmd, { ...base, n: 31, download: { ...dl, same: true } }),
    '[agent:browser] clicked ebloc [31] clickable "Lista de plată" · same page · idle 0.8s · → download same as /Users/me/Library/Clodex/downloads/ebloc/lista-08.pdf · 48,213 B');
  assert.strictEqual(R.actReply('click', 'ebloc', { sub: 'click', n: 4 },
    { ...base, popup: true, popupUrl: 'https://www.e-bloc.ro/x.pdf', download: { file: '/tmp/x.pdf', bytes: 120, mime: 'application/pdf', url: 'https://www.e-bloc.ro/x.pdf' } }),
  '[agent:browser] clicked ebloc [4] clickable "Lista de plată" · same page · idle 0.8s · → download /tmp/x.pdf · 120 B · application/pdf · from https://www.e-bloc.ro/x.pdf (PDF popup)');
  assert.strictEqual(R.actReply('click', 'ebloc', { sub: 'click', n: 4 }, { ...base, popup: true, popupUrl: 'https://www.e-bloc.ro/print' }),
    '[agent:browser] clicked ebloc [4] clickable "Lista de plată" · same page · idle 0.8s · → popup https://www.e-bloc.ro/print');
});

test('replies: an act that stays on the page says what text changed, or that nothing visible changed', () => {
  const idle = { ok: true, ms: 800 };
  assert.strictEqual(R.actReply('select', 'ebloc', { sub: 'select', n: 3, option: 'iulie' }, { text: 'Iulie 2026', navigated: false, idle, changed: 'Apă rece | | 19,486 / Total | 120 lei' }),
    '[agent:browser] selected ebloc [3] = "Iulie 2026" · same page · idle 0.8s · changed: "Apă rece | | 19,486 / Total | 120 lei"');
  assert.strictEqual(R.actReply('key', 'ebloc', { sub: 'key', key: 'Tab' }, { navigated: false, idle, changed: '' }),
    '[agent:browser] pressed Tab on ebloc · same page · idle 0.8s · no visible change');
  assert.strictEqual(R.actReply('type', 'ebloc', { sub: 'type', n: 2, text: 'ab' }, { navigated: false, idle, changed: 'text removed' }),
    '[agent:browser] typed ebloc [2] (2 chars) · same page · idle 0.8s · changed: "text removed"');
  assert.strictEqual(R.actReply('click', 'ebloc', { sub: 'click', n: 2 }, { kind: 'link', label: 'Next', navigated: true, url: 'https://x/2', title: 'Two', idle, changed: 'x' }),
    '[agent:browser] clicked ebloc [2] link "Next" · navigated → https://x/2 ("Two") · numbers reset, read again · idle 0.8s');
  const long = 'x'.repeat(599) + '…';
  assert.ok(R.actReply('click', 'ebloc', { sub: 'click', n: 2 }, { kind: 'link', label: 'More', navigated: false, idle, changed: long }).endsWith(`changed: "${long}"`));
});

test('replies: the download verb names a repeat as the same as an existing file', () => {
  assert.strictEqual(R.downloadReply('ebloc', { n: 4 }, { file: '/w/bills/lista.pdf', bytes: 120, mime: 'application/pdf', magic: 'pdf', ms: 400, same: true }),
    '[agent:browser] downloaded ebloc [4] → /w/bills/lista.pdf · same as an existing file · 120 B · application/pdf · %PDF ok · 0.4s');
});

test('replies: inspect is six lines with the prefix on the first, attrs none and listeners unknown when missing', () => {
  const base = {
    n: 12, tag: 'div', id: 'prow', classes: ['row', 'pay'], kind: 'clickable', label: 'Factura iulie', attrs: [], listeners: null,
    cursor: 'pointer', rect: { x: 10, y: 220, w: 300, h: 24 }, visible: true, ancestors: ['td', 'tr#r1.odd', 'tbody', 'table.list', 'main'],
    html: '<div id="prow" class="row pay">Factura iulie</div>',
  };
  assert.strictEqual(R.inspectReply('ebloc', base), [
    '[agent:browser] inspect ebloc [12]: div#prow.row.pay · clickable "Factura iulie"',
    '  attrs: none',
    '  listeners: unknown',
    '  cursor: pointer · at 10,220 size 300×24 · visible',
    '  in: main > table.list > tbody > tr#r1.odd > td',
    '  html: <div id="prow" class="row pay">Factura iulie</div>',
  ].join('\n'));
  const lines = (r) => R.inspectReply('ebloc', { ...base, ...r }).split('\n');
  assert.strictEqual(lines({ attrs: [['onclick', 'go(1)'], ['title', 'Plată lunară']] })[1], '  attrs: onclick=go(1) title="Plată lunară"');
  assert.strictEqual(lines({ listeners: { types: [] } })[2], '  listeners: none');
  assert.strictEqual(lines({ listeners: { types: ['click', 'mouseover'] } })[2], '  listeners: click, mouseover');
  assert.strictEqual(lines({ listeners: { types: [], ancestor: 'tr#r1.odd', ancestorType: 'click' } })[2], '  listeners: none here · click on ancestor tr#r1.odd');
  assert.strictEqual(lines({ visible: false })[3], '  cursor: pointer · at 10,220 size 300×24 · hidden');
  assert.strictEqual(R.TEXT.manyText('ebloc', 'PDF', 2, [{ n: 1, text: 'PDF' }, { n: 2, text: 'PDF' }], 'inspect'),
    '"PDF" matches 2 visible elements on ebloc: [1] "PDF", [2] "PDF" — inspect one by number');
});
