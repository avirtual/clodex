'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createCliHooks } = require('../cli-hooks');
const { pathFor } = require('../clodex-paths');
const {
  bakePrompt, readPromptSnapshot, readPromptSnapshotMemo, restageAtReset, readCache, writeCache, cachePathFor, ipcDelta,
} = require('../ipc-prompt-cache');
const { mkTmpRoot } = require('./lib/tmp-roots');

function tmp() { return mkTmpRoot('clodex-snapshot-'); }

function snapshotRow(blocks, ts, extra = {}) {
  return JSON.stringify({
    type: 'attachment', uuid: `u-${ts}`, timestamp: ts,
    attachment: { type: 'prompt_snapshot', systemPrompt: blocks, ...extra },
  });
}

const NOISE = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-09-21T00:00:00.000Z' }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the row type "prompt_snapshot" is what we scan for' }] } }),
  JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'not one' }, ref: 'prompt_snapshot' }),
];

function writeTranscript(root, lines, name = 'transcript.jsonl') {
  const p = path.join(root, name);
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

test('readPromptSnapshot: returns the LAST snapshot row\'s LAST block, skipping decoys that only mention the marker', () => {
  const root = tmp();
  const a = snapshotRow(['base a', 'CLODEX A — first'], '2026-09-21T01:00:00.000Z');
  const b = snapshotRow(['base b', 'CLODEX B — second'], '2026-09-21T02:00:00.000Z', { tools: [{ name: 'Bash' }] });
  const lines = [NOISE[0], a, NOISE[1], NOISE[2], b, NOISE[0]];
  const p = writeTranscript(root, lines);
  const text = fs.readFileSync(p, 'utf8');
  assert.strictEqual(text.split('\n').filter((l) => l.includes('"prompt_snapshot"')).length, 3,
    'ENTER: the fixture must hold BOTH snapshot candidates plus a decoy carrying the exact substring, or "last" and "filter" are not exercised');

  assert.deepStrictEqual(readPromptSnapshot(p), { clodexBlock: 'CLODEX B — second', ts: '2026-09-21T02:00:00.000Z' });

  const reversed = writeTranscript(root, [NOISE[0], b, NOISE[1], a, NOISE[2]], 'reversed.jsonl');
  assert.deepStrictEqual(readPromptSnapshot(reversed), { clodexBlock: 'CLODEX A — first', ts: '2026-09-21T01:00:00.000Z' },
    'positional, not by timestamp or content: the row nearest the tail is what the model runs');
});

test('readPromptSnapshot: tolerates {type:text,text} blocks and skips rows with no usable block', () => {
  const root = tmp();
  const objRow = snapshotRow([{ type: 'text', text: 'base' }, { type: 'text', text: 'CLODEX OBJ' }], '2026-09-21T01:00:00.000Z');
  const emptyRow = snapshotRow([], '2026-09-21T02:00:00.000Z');
  const junkRow = snapshotRow(['base', { type: 'image', data: 'x' }], '2026-09-21T03:00:00.000Z');
  const p = writeTranscript(root, [objRow, emptyRow, junkRow, NOISE[1]]);
  assert.deepStrictEqual(readPromptSnapshot(p), { clodexBlock: 'CLODEX OBJ', ts: '2026-09-21T01:00:00.000Z' },
    'an empty systemPrompt and a non-text last block are not candidates; the scan continues to the older row');
});

test('readPromptSnapshot: null when no row, when the file is missing, and when the row is malformed', () => {
  const root = tmp();
  assert.strictEqual(readPromptSnapshot(writeTranscript(root, NOISE)), null);
  assert.strictEqual(readPromptSnapshot(path.join(root, 'absent.jsonl')), null);
  assert.strictEqual(readPromptSnapshot(null), null);
  assert.strictEqual(readPromptSnapshot(writeTranscript(root, ['{"attachment":{"type":"prompt_snapshot"', NOISE[0]], 'torn.jsonl')), null,
    'a truncated row parses to nothing rather than throwing');
});

test('readPromptSnapshot: a row that straddles the 1MB tail chunk, with multi-byte text, comes back intact', () => {
  const root = tmp();
  const pad = (n) => JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(n) } });
  const block = 'CLODEX — '.repeat(30000);
  const row = snapshotRow(['base', block], '2026-09-21T01:00:00.000Z');
  const p = writeTranscript(root, [pad(500 * 1024), row, pad(900 * 1024)]);
  const size = fs.statSync(p).size;
  const rowStart = pad(500 * 1024).length + 1;
  const rowBytes = Buffer.byteLength(row);
  assert.ok(size > (1 << 20) && size - (1 << 20) > rowStart && size - (1 << 20) < rowStart + rowBytes,
    `ENTER: the first tail chunk must cut through the snapshot row (size=${size} rowStart=${rowStart} rowBytes=${rowBytes})`);
  const found = readPromptSnapshot(p);
  assert.ok(found, 'the row is found across the chunk boundary');
  assert.strictEqual(found.clodexBlock, block, 'and decoded from complete lines only, so no multi-byte character is torn');
});

test('readPromptSnapshotMemo: a second call scans only the bytes appended since the first, and a repointed path is scanned in full', () => {
  const root = tmp(), name = 'seat';
  const b = snapshotRow(['base', 'CLODEX B — second'], '2026-09-21T02:00:00.000Z');
  const p = writeTranscript(root, [NOISE[0], b, NOISE[1]]);
  assert.deepStrictEqual(readPromptSnapshotMemo(root, name, p), { clodexBlock: 'CLODEX B — second', ts: '2026-09-21T02:00:00.000Z' });
  const memo = JSON.parse(readCache(root, name, 'snapshot'));
  assert.deepStrictEqual(memo, { path: fs.realpathSync(p), offset: fs.statSync(p).size, clodexBlock: 'CLODEX B — second', ts: '2026-09-21T02:00:00.000Z' },
    'the memo remembers the file, where its last complete line ended, and the block');

  const text = fs.readFileSync(p, 'utf8');
  const forged = text.replace('CLODEX B — second', 'CLODEX Z — second');
  assert.strictEqual(Buffer.byteLength(forged), Buffer.byteLength(text), 'ENTER: the in-place forgery keeps every byte offset');
  fs.writeFileSync(p, forged);
  fs.appendFileSync(p, NOISE[2] + '\n');
  assert.strictEqual(readPromptSnapshot(p).clodexBlock, 'CLODEX Z — second', 'ENTER: a full scan sees the forged head');
  assert.strictEqual(readPromptSnapshotMemo(root, name, p).clodexBlock, 'CLODEX B — second',
    'the memoised read never went back past its offset: only the appended noise row was scanned');
  assert.strictEqual(JSON.parse(readCache(root, name, 'snapshot')).offset, fs.statSync(p).size, 'and the offset advanced over it');

  const c = snapshotRow(['base', 'CLODEX C — appended'], '2026-09-21T03:00:00.000Z');
  fs.appendFileSync(p, c + '\n{"type":"user","torn":"');
  assert.deepStrictEqual(readPromptSnapshotMemo(root, name, p), { clodexBlock: 'CLODEX C — appended', ts: '2026-09-21T03:00:00.000Z' },
    'a row appended past the offset is found');
  assert.strictEqual(JSON.parse(readCache(root, name, 'snapshot')).offset, fs.statSync(p).size - '{"type":"user","torn":"'.length,
    'a torn tail line is left in front of the offset so the next scan reads it whole');

  const other = writeTranscript(root, [NOISE[0], snapshotRow(['base', 'CLODEX O — other file'], '2026-09-21T04:00:00.000Z')], 'other.jsonl');
  assert.strictEqual(readPromptSnapshotMemo(root, name, other).clodexBlock, 'CLODEX O — other file', 'a different file is scanned in full');
  const link = path.join(root, 'transcript-link.jsonl');
  fs.symlinkSync(other, link);
  fs.writeFileSync(other, fs.readFileSync(other, 'utf8').replace('CLODEX O', 'CLODEX X'));
  assert.strictEqual(readPromptSnapshotMemo(root, name, link).clodexBlock, 'CLODEX O — other file',
    'a symlink to the memoised file is the same memo: matched on the real path');

  assert.strictEqual(readPromptSnapshotMemo(root, name, path.join(root, 'absent.jsonl')), null);
  assert.strictEqual(readPromptSnapshotMemo(root, name, writeTranscript(root, NOISE, 'none.jsonl')), null, 'no row and no memo for that file: null');
});

const BORN = 'IPC v1\n[agent:dm TARGET] body\n';
const REAL = 'IPC v1\n[agent:dm TARGET] body\n[agent:newverb] shipped since\n';
const SNAP = 'IPC v0\n[agent:dm TARGET] body\n';

function seatWith(root, name, { session = BORN, notified = null } = {}) {
  writeCache(root, name, 'session', session);
  if (notified != null) writeCache(root, name, 'notified', notified);
}

function cacheState(root, name) {
  return {
    session: readCache(root, name, 'session'),
    notified: readCache(root, name, 'notified'),
    delta: readCache(root, name, 'delta'),
    next: readCache(root, name, 'next'),
  };
}

test('bakePrompt(reuse=true): a snapshot that differs from session.md re-baselines BOTH files on it and stages the full snapshot→realIpc gap', () => {
  const root = tmp(), name = 'seat';
  seatWith(root, name, { session: BORN, notified: BORN });
  assert.notStrictEqual(SNAP, BORN, 'ENTER: the snapshot must differ from what the files claim');

  const baked = bakePrompt(root, name, REAL, true, { snapshot: SNAP });

  assert.strictEqual(baked, SNAP, 'the baked text is the snapshot: the file must say what the model runs');
  const st = cacheState(root, name);
  assert.strictEqual(st.session, SNAP, 'session.md follows the transcript, not our earlier bookkeeping');
  assert.strictEqual(st.notified, SNAP, 'notified.md is reset with it: the model has been told nothing beyond what it runs');
  assert.strictEqual(st.next, REAL);
  assert.strictEqual(st.delta, ipcDelta(SNAP, REAL), 'the staged delta is diff(snapshot, realIpc) — the whole gap, not diff(session.md, realIpc)');
  assert.ok(st.delta.includes('-IPC v0') && st.delta.includes('+IPC v1'),
    'specifically it carries the change our files had already marked as delivered');
});

for (const [label, snapshot] of [['snapshot == session.md', BORN], ['no snapshot row', null], ['snapshot undefined', undefined]]) {
  test(`bakePrompt(reuse=true) with ${label}: byte-for-byte today's behaviour`, () => {
    const a = tmp(), b = tmp(), name = 'seat';
    seatWith(a, name, { session: BORN, notified: 'IPC v1\n[agent:dm TARGET] body\n[agent:midverb] told once\n' });
    seatWith(b, name, { session: BORN, notified: 'IPC v1\n[agent:dm TARGET] body\n[agent:midverb] told once\n' });

    const control = bakePrompt(a, name, REAL, true);
    const withOpt = bakePrompt(b, name, REAL, true, { snapshot });

    assert.strictEqual(withOpt, control);
    assert.deepStrictEqual(cacheState(b, name), cacheState(a, name),
      'session.md, the ADVANCED notified.md, delta.md and next.md all identical to a bake without the option');
    assert.strictEqual(cacheState(b, name).notified, 'IPC v1\n[agent:dm TARGET] body\n[agent:midverb] told once\n',
      'ENTER: notified.md had advanced past session.md going in, so "untouched" is a real claim');
  });
}

test('bakePrompt(reuse=true) on a LEAN seat (empty baked prompt) refuses to follow the snapshot: the last block is not ours to claim', () => {
  const root = tmp(), name = 'lean';
  seatWith(root, name, { session: '', notified: '' });
  assert.strictEqual(bakePrompt(root, name, '', true, { snapshot: 'FOREIGN CLI BLOCK' }), '', 'baked stays empty');
  assert.deepStrictEqual(cacheState(root, name), { session: '', notified: '', delta: null, next: null }, 'cache state unchanged, no delta');

  const bare = tmp();
  assert.strictEqual(restageAtReset(bare, name, '', 'FOREIGN CLI BLOCK'), null, 'no cache and nothing to bake: the snapshot is not adopted either');
  assert.strictEqual(readCache(bare, name, 'session'), null);
  assert.strictEqual(bakePrompt(root, name, REAL, true, { snapshot: '' }), '', 'an empty snapshot is never a baseline');
  assert.strictEqual(readCache(root, name, 'delta'), ipcDelta('', REAL), 'the lean seat that gains a prompt is told about it against its own empty baseline');
});

test('bakePrompt(reuse=false) ignores the snapshot: a boundary regenerates', () => {
  const root = tmp(), name = 'seat';
  seatWith(root, name, { session: BORN, notified: BORN });
  assert.strictEqual(bakePrompt(root, name, REAL, false, { snapshot: SNAP }), REAL);
  assert.deepStrictEqual(cacheState(root, name), { session: REAL, notified: REAL, delta: null, next: null });
});

test('restageAtReset: resets notified.md to the baseline and stages the full gap, following the snapshot when it differs', () => {
  const root = tmp(), name = 'seat';
  seatWith(root, name, { session: BORN, notified: REAL });
  const delta = restageAtReset(root, name, REAL, SNAP);
  assert.strictEqual(delta, ipcDelta(SNAP, REAL));
  assert.deepStrictEqual(cacheState(root, name), { session: SNAP, notified: SNAP, delta, next: REAL });

  const same = tmp();
  seatWith(same, name, { session: BORN, notified: REAL });
  assert.strictEqual(restageAtReset(same, name, REAL, null), ipcDelta(BORN, REAL),
    'no snapshot: session.md is the baseline, and an advanced notified.md is still reset to it');
  assert.strictEqual(readCache(same, name, 'notified'), BORN);

  const bare = tmp();
  assert.strictEqual(restageAtReset(bare, name, REAL, null), null, 'no cache and no snapshot: nothing to baseline against');
  assert.strictEqual(readCache(bare, name, 'session'), null);

  const current = tmp();
  seatWith(current, name, { session: REAL, notified: REAL });
  assert.strictEqual(restageAtReset(current, name, REAL, REAL), null, 'nothing owed when truth equals the baseline');
  assert.strictEqual(readCache(current, name, 'delta'), null);
});

function hooks(root) {
  return createCliHooks({
    REGISTRY_DIR: root,
    memoryStore: { list: () => [] },
    getUiSettings: () => ({ get: () => ({ statusline: { claude: [], claudeCommand: '' } }) }),
    nodeInterp: process.execPath,
  });
}

function runSessionStart(root, name, source) {
  const transcript = path.join(root, 'fake-transcript.jsonl');
  fs.writeFileSync(transcript, '');
  const r = require('child_process').spawnSync('/bin/bash', [pathFor(root, name, 'hook')], {
    encoding: 'utf8',
    input: JSON.stringify({ transcript_path: transcript, source }),
  });
  assert.strictEqual(r.status, 0, `SessionStart hook exited ${r.status}: ${r.stderr}`);
}

for (const source of ['clear', 'compact']) {
  test(`SessionStart ${source} reset: a pair staged against session.md itself is KEPT, one staged against an advanced baseline is dropped`, () => {
    const root = tmp(), name = 'seat';
    hooks(root).setupClaudeHook(name);
    seatWith(root, name, { session: BORN, notified: BORN });
    const delta = restageAtReset(root, name, REAL, null);
    assert.ok(delta && fs.existsSync(cachePathFor(root, name, 'delta')), 'ENTER: a full-gap pair is staged going in');

    runSessionStart(root, name, source);
    assert.deepStrictEqual(cacheState(root, name), { session: BORN, notified: BORN, delta, next: REAL },
      'the restage at this same edge ran first (the common ordering): its pair IS the post-reset delta and must survive the hook');

    writeCache(root, name, 'notified', REAL);
    writeCache(root, name, 'delta', 'stale');
    writeCache(root, name, 'next', 'stale');
    runSessionStart(root, name, source);
    assert.deepStrictEqual(cacheState(root, name), { session: BORN, notified: BORN, delta: null, next: null },
      'an advanced notified.md means the pair was computed against bytes the reset just destroyed: dropped, baseline reset');
  });
}

test('source pin: both reset sites call refreshPrompt, and its body neither bakes nor writes the prompt file', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  const compactSite = src.slice(src.indexOf('_fireCompactContinuation(session) {'));
  assert.ok(compactSite.slice(0, compactSite.indexOf('_compactContinuation')).includes("this.refreshPrompt(session.name, 'compact')"),
    'ENTER: the compact handler must still call refreshPrompt before it hands over the continuation');
  assert.ok(src.includes("this.refreshPrompt(name, 'clear', { sid: snapshotSid })"), 'ENTER: and the clear site too, handing over the PRIOR conversation id');
  const start = src.indexOf('    refreshPrompt(name, why, opts = {}) {');
  assert.ok(start > 0, 'ENTER: refreshPrompt must be found');
  const body = src.slice(start, src.indexOf('\n    }\n', start));
  assert.ok(body.includes('restageAtReset('), 'the reset path re-stages the delta');
  assert.ok(!body.includes('bakePrompt('), 'and never advances session.md through a bake');
  assert.ok(!/writeFileSync|renameSync/.test(body), 'and never rewrites append-prompt.md: the CLI would not read it, and session.md would then lie');
});
