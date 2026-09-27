'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { MAX_ENTRIES, CHANGE_DEBOUNCE_MS, parseTranscript, createTranscriptSpikeReader } = require('../transcript-spike');

const rec = (o) => JSON.stringify(o);
const LINES = [
  rec({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'run the tests' } }),
  rec({ type: 'assistant', uuid: 'u2', message: { content: [{ type: 'text', text: 'Running them now.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
];
const texts = (records) => records.map((r) => r.text || `${r.name}(${r.arg})`);

test('parseTranscript returns the typed records of the transcript', () => {
  assert.deepStrictEqual(parseTranscript(LINES.join('\n')), [
    { id: 'u1', kind: 'prompt', ts: null, turn: 1, text: 'run the tests', source: 'typed' },
    { id: 'u2', kind: 'assistant', ts: null, turn: 1, text: 'Running them now.' },
    { id: 't1', kind: 'tool', ts: null, turn: 1, name: 'Bash', arg: 'npm test', state: 'pending', sum: null },
  ]);
});

test('MAX_ENTRIES is the record cap, and the cut lands on a turn boundary', () => {
  assert.strictEqual(MAX_ENTRIES, 400);
  const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => rec({ type: 'user', uuid: `m${i}`, message: { content: `m${i}` } }));
  const out = parseTranscript(many.join('\n'));
  assert.strictEqual(out.length, MAX_ENTRIES);
  assert.strictEqual(out[0].text, 'm5');
});

test('pull reads through the link, re-reads only after the watcher fires, and follows a repoint', (t) => {
  const root = mkTmpRoot('clodex-tspike-');
  const a = path.join(root, 'a.jsonl');
  const b = path.join(root, 'b.jsonl');
  const link = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(a, `${LINES[0]}\n`);
  fs.writeFileSync(b, `${rec({ type: 'user', message: { content: 'after clear' } })}\n`);
  fs.symlinkSync(a, link);
  const fires = new Map();
  const watch = (p, cb) => { fires.set(p, cb); return { close() { fires.delete(p); }, on() {} }; };
  const reader = createTranscriptSpikeReader({ linkPathFor: () => link, watch });
  t.after(() => reader.dispose());
  const first = reader.pull('s');
  assert.deepStrictEqual([first.ok, first.rev, texts(first.records)], [true, 1, ['run the tests']]);
  fires.get(fs.realpathSync(a))();
  assert.strictEqual(reader.pull('s').rev, 1);
  fs.appendFileSync(a, `${LINES[1]}\n`);
  assert.strictEqual(reader.pull('s').rev, 1);
  fires.get(fs.realpathSync(a))();
  const second = reader.pull('s');
  assert.strictEqual(second.rev, 2);
  assert.deepStrictEqual(texts(second.records), ['run the tests', 'Running them now.', 'Bash(npm test)']);
  fs.unlinkSync(link);
  fs.symlinkSync(b, link);
  const third = reader.pull('s');
  assert.ok(third.rev > second.rev, `rev after repoint ${third.rev} > ${second.rev}`);
  assert.deepStrictEqual(texts(third.records), ['after clear']);
  assert.strictEqual(fires.has(fs.realpathSync(a)), false);
  fs.unlinkSync(link);
  assert.deepStrictEqual(reader.pull('s'), { ok: false, reason: 'unavailable' });
});

function debounceRig() {
  const root = mkTmpRoot('clodex-tspike-');
  const file = path.join(root, 'a.jsonl');
  const link = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(file, `${LINES[0]}\n`);
  fs.symlinkSync(file, link);
  let fire = null;
  const watch = (p, cb) => { fire = cb; return { close() {}, on() {} }; };
  const timers = new Map();
  let seq = 0;
  const setTimer = (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq; };
  const clearTimer = (id) => { timers.delete(id); };
  const flush = () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } };
  const changes = [];
  const reader = createTranscriptSpikeReader({ linkPathFor: () => link, watch, onChange: (n) => changes.push(n), setTimer, clearTimer });
  reader.pull('s');
  return { reader, changes, timers, flush, fire: () => fire() };
}

test('watcher callbacks inside the debounce window coalesce into one onChange', (t) => {
  const r = debounceRig();
  t.after(() => r.reader.dispose());
  r.fire();
  r.fire();
  assert.strictEqual(r.timers.size, 1);
  assert.strictEqual([...r.timers.values()][0].ms, CHANGE_DEBOUNCE_MS);
  assert.deepStrictEqual(r.changes, []);
  r.flush();
  assert.deepStrictEqual(r.changes, ['s']);
  r.fire();
  r.flush();
  assert.deepStrictEqual(r.changes, ['s', 's']);
});

test('drop cancels a pending onChange', () => {
  const r = debounceRig();
  r.fire();
  assert.strictEqual(r.timers.size, 1);
  r.reader.drop('s');
  assert.strictEqual(r.timers.size, 0);
  r.flush();
  assert.deepStrictEqual(r.changes, []);
});

test('a reader with no watcher keeps its rev until the file changes', (t) => {
  const root = mkTmpRoot('clodex-tspike-');
  const file = path.join(root, 'a.jsonl');
  fs.writeFileSync(file, `${LINES[0]}\n`);
  const watch = () => { throw new Error('no watch'); };
  const reader = createTranscriptSpikeReader({ linkPathFor: () => file, watch });
  t.after(() => reader.dispose());
  assert.strictEqual(reader.pull('s').rev, 1);
  assert.strictEqual(reader.pull('s').rev, 1);
  fs.appendFileSync(file, `${LINES[1]}\n`);
  const next = reader.pull('s');
  assert.strictEqual(next.rev, 2);
  assert.deepStrictEqual(texts(next.records), ['run the tests', 'Running them now.', 'Bash(npm test)']);
  assert.strictEqual(reader.pull('s').rev, 2);
});

const { fakeDocument } = require('./lib/fake-dom');
const { createTranscriptRows } = require('../renderer/transcript-rows');
const RUN = [
  rec({ type: 'user', message: { content: 'run the tests' } }),
  rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
];
function sourceFixture(t, text) {
  const root = mkTmpRoot('clodex-tspike-');
  const file = path.join(root, 'session.jsonl');
  const link = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(file, text);
  fs.symlinkSync(file, link);
  const reader = createTranscriptSpikeReader({ linkPathFor: () => link, watch: () => null });
  t.after(() => reader.dispose());
  return { file, reader };
}
function runPane() {
  const doc = fakeDocument();
  const pane = doc.createElement('div');
  const rows = createTranscriptRows(doc, pane, { mode: 'conversation' });
  const toggle = () => pane.childNodes.flatMap((n) => n.childNodes).find((n) => /\btr-run-toggle\b/.test(n.className));
  return { rows, toggle, open: () => toggle().getAttribute('aria-expanded') === 'true' };
}

test('source: identical across two ordinary appends', (t) => {
  const f = sourceFixture(t, `${RUN[0]}\n`);
  const a = f.reader.pull('s');
  fs.appendFileSync(f.file, `${RUN[1]}\n`);
  const b = f.reader.pull('s');
  fs.appendFileSync(f.file, `${rec({ type: 'user', message: { content: 'more' } })}\n`);
  const c = f.reader.pull('s');
  assert.deepStrictEqual([a.rev < b.rev, b.rev < c.rev], [true, true], 'ENTER: each append was re-read');
  assert.match(a.source, /^[0-9a-f]{16}:0$/);
  assert.strictEqual(b.source, a.source);
  assert.strictEqual(c.source, a.source);
});

test('source: an observed shrink of the same path bumps the epoch', (t) => {
  const f = sourceFixture(t, `${RUN.join('\n')}\n`);
  const a = f.reader.pull('s');
  fs.writeFileSync(f.file, `${RUN[0]}\n`);
  const b = f.reader.pull('s');
  assert.notStrictEqual(b.source, a.source);
  assert.strictEqual(b.source, a.source.replace(/:0$/, ':1'));
});

test('source: a transient unreadable drop at epoch 1 restarts the epoch, so source changes and the open run closes', (t) => {
  const two = `${RUN.join('\n')}\n`;
  const f = sourceFixture(t, `${two}${rec({ type: 'user', message: { content: 'gone soon' } })}\n`);
  const p = runPane();
  const zero = f.reader.pull('s');
  fs.writeFileSync(f.file, two);
  const one = f.reader.pull('s');
  assert.strictEqual(one.source, zero.source.replace(/:0$/, ':1'), 'ENTER: epoch 1');
  p.rows.render(one.records, one.source);
  p.toggle().listeners.click();
  assert.strictEqual(p.open(), true, 'ENTER: the run is open at epoch 1');
  fs.rmSync(f.file);
  fs.mkdirSync(f.file);
  const drop = f.reader.pull('s');
  assert.deepStrictEqual([drop.ok, drop.reason], [false, 'unreadable']);
  fs.rmdirSync(f.file);
  fs.writeFileSync(f.file, two);
  const back = f.reader.pull('s');
  assert.strictEqual(back.ok, true);
  assert.notStrictEqual(back.source, one.source);
  assert.strictEqual(back.source, zero.source);
  p.rows.render(back.records, back.source);
  assert.strictEqual(p.open(), false);
});

test('source: KNOWN LIMITATION — a same-size rewrite between reads is not detected, so source is unchanged', (t) => {
  const f = sourceFixture(t, `${rec({ type: 'user', message: { content: 'aaaa' } })}\n`);
  const a = f.reader.pull('s');
  fs.writeFileSync(f.file, `${rec({ type: 'user', message: { content: 'bbbb' } })}\n`);
  const later = new Date(Date.now() + 10000);
  fs.utimesSync(f.file, later, later);
  const b = f.reader.pull('s');
  assert.deepStrictEqual([a.records[0].text, b.records[0].text], ['aaaa', 'bbbb'], 'ENTER: the rewrite was re-read');
  assert.strictEqual(b.source, a.source);
});
