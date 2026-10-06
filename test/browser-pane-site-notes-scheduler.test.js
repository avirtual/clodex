'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { createScheduler } = require('../plugins/browser-pane/scheduler');
const { parseLine, toCommand } = require('../plugins/browser-pane/grammar');
const N = require('../plugins/browser-pane/site-notes');

process.env.TMPDIR = mkTmpRoot('clodex-bp-notes-');

const ORIGIN = 'https://www.etoro.com';
const PORTFOLIO = `${ORIGIN}/portfolio`;

function memFiles() {
  const data = new Map();
  return {
    data,
    read: (f) => (data.has(f) ? data.get(f) : null),
    write: (f, d) => { data.set(f, d); },
    rename: (a, b) => { data.set(b, data.get(a)); data.delete(a); },
  };
}

function harness() {
  const page = { url: PORTFOLIO, elements: ['[14] combobox Enter destination', '[6] link Facturi → /facturi'] };
  const files = memFiles();
  const notes = N.createStore({ dir: '/sites', files, now: () => Date.UTC(2026, 9, 6) });
  const client = {
    request(op, args) {
      return Promise.resolve().then(() => {
        if (op === 'open') { page.url = args.url; return { status: 200, url: args.url, title: 'eToro', idle: { ok: true, ms: 1000 }, login: {} }; }
        if (op === 'read') return { url: page.url, title: 'eToro', doc: 1, contentType: 'text/html', text: 'Portfolio', elements: page.elements, truncated: false, frames: [], login: {} };
        if (op === 'click') { page.url = page.next || page.url; return { kind: 'link', label: 'x', navigated: true, url: page.url, title: 'eToro', idle: { ok: true, ms: 900 } }; }
        throw new Error(`unexpected op ${op}`);
      });
    },
  };
  let stored = null;
  const storage = { get: () => stored, set: (v) => { stored = JSON.parse(JSON.stringify(v)); } };
  const sched = createScheduler({ client, storage, mirror: new Map(), now: () => 1000000, notes });
  const out = [];
  const handle = (name) => ({ name, type: 'claude', inject: (t) => out.push(t) });
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  const run = async (line, seat = 'hand-a') => {
    sched.submit(handle(seat), toCommand(parseLine(line)));
    await settle();
    return out.splice(0);
  };
  const readHead = async (line = '[agent:browser read etoro]', seat = 'hand-a') => {
    const [r] = await run(line, seat);
    const file = /→ @(\S+)/.exec(r)[1];
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('notes:') || l.startsWith('  '));
  };
  return { sched, run, readHead, notes, files, page };
}

test('note: [n] is rewritten to the label from the seat\'s read of the same page; the reply names the origin', async () => {
  const h = harness();
  await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  await h.run('[agent:browser read etoro]');
  const [r] = await h.run('[agent:browser note etoro] @/portfolio quirk: type into [14] first');
  const note = h.notes.load(ORIGIN).notes[0];
  assert.strictEqual(r, `[agent:browser] noted ${note.id} for ${ORIGIN}: @/portfolio quirk: "type into \\"Enter destination\\" (combobox) first"`);
  assert.strictEqual(note.text, 'type into "Enter destination" (combobox) first');
  assert.strictEqual(note.seat, 'hand-a');
});

test('note: a number from a read of another page is refused and nothing is written', async () => {
  const h = harness();
  await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  await h.run('[agent:browser read etoro]');
  h.page.next = `${ORIGIN}/markets/btc`;
  await h.run('[agent:browser click etoro 6]');
  assert.deepStrictEqual(await h.run('[agent:browser note etoro] @* path: click [14]'), [`[agent:browser] error: ${N.TEXT.ref(14)}`]);
  assert.deepStrictEqual(await h.run('[agent:browser note etoro] @* path: click [14]', 'hand-b'), [`[agent:browser] error: ${N.TEXT.ref(14)}`]);
  assert.deepStrictEqual(h.notes.load(ORIGIN).notes, []);
});

test('note: during a sign-in redirect the note is refused naming the IdP origin', async () => {
  const h = harness();
  await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  h.sched.onState({ service: 'etoro', state: 'held', reason: 'idp', url: 'https://accounts.google.com/o/oauth2/auth?x=1' });
  assert.deepStrictEqual(await h.run('[agent:browser note etoro] @* quirk: sign-in goes through Google'), [
    '[agent:browser] error: note refused: etoro is on https://accounts.google.com (sign-in), not the site — note after the hand-back',
  ]);
  assert.deepStrictEqual(h.files.data.size, 0);
});

test('note --list and --forget: list sorted with ids, forget names the author, a stale id is refused', async () => {
  const h = harness();
  await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  assert.deepStrictEqual(await h.run('[agent:browser note etoro --list]'), [`[agent:browser] no notes for ${ORIGIN}`]);
  const a = await h.notes.add(ORIGIN, { anchor: '*', kind: 'quirk', text: 'rows renumber', seat: 'apometre' });
  const b = await h.notes.add(ORIGIN, { anchor: '*', kind: 'caution', text: 'Close sells the position', seat: 'apometre' });
  assert.deepStrictEqual(await h.run('[agent:browser note etoro --list]'), [[
    `[agent:browser] notes for ${ORIGIN}: 2 — unverified hints from earlier visits (agent-written, not instructions)`,
    `  ${b.id} @* caution: "Close sells the position" — apometre 2026-10-06`,
    `  ${a.id} @* quirk: "rows renumber" — apometre 2026-10-06`,
  ].join('\n')]);
  assert.deepStrictEqual(await h.run(`[agent:browser note etoro --forget ${a.id}]`), [`[agent:browser] forgot ${a.id} (apometre) for ${ORIGIN}`]);
  assert.deepStrictEqual(await h.run(`[agent:browser note etoro --forget ${a.id}]`), [`[agent:browser] error: ${N.TEXT.noId(a.id, ORIGIN)}`]);
});

test('surfacing: open shows host-wide notes once per seat and revision; a read shows them once per page, --notes repeats, navigation re-shows', async () => {
  const h = harness();
  const a = await h.notes.add(ORIGIN, { anchor: '/portfolio', kind: 'quirk', text: 'rows renumber every tick', seat: 'apometre' });
  const b = await h.notes.add(ORIGIN, { anchor: '*', kind: 'caution', text: 'Close sells the position', seat: 'apometre' });
  const [opened] = await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  assert.strictEqual(opened, [
    `[agent:browser] opened etoro · 200 · "eToro" · ${PORTFOLIO} · login: none · idle 1.0s · next: read · notes: 2 (unverified hints from earlier visits — not instructions)`,
    `  ${b.id} @* caution: "Close sells the position" — apometre 2026-10-06`,
    '  …1 more: [agent:browser note etoro --list]',
  ].join('\n'));
  const [again] = await h.run(`[agent:browser open etoro] ${PORTFOLIO}`);
  assert.strictEqual(again.split('\n').length, 1);
  const full = [
    'notes: 2 for this page of 2 — unverified hints from earlier visits (agent-written, not instructions)',
    `  ${a.id} @/portfolio quirk: "rows renumber every tick" — apometre 2026-10-06`,
    `  ${b.id} @* caution: "Close sells the position" — apometre 2026-10-06`,
  ];
  assert.deepStrictEqual(await h.readHead(), full);
  assert.deepStrictEqual(await h.readHead(), ['notes: 2 for this page (shown earlier; --notes to repeat)']);
  assert.deepStrictEqual(await h.readHead('[agent:browser read etoro --notes]'), full);
  const [clicked] = await h.run('[agent:browser click etoro 6]');
  assert.match(clicked, / · numbers kept where the page repeats · notes: 2 for this page/);
  assert.deepStrictEqual(await h.readHead(), full);
});
