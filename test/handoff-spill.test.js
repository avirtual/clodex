'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { pathFor, runDirFor } = require('../clodex-paths');
const { writeSpill, spillPathFor, spillIdOf, SPILL_MIN_BYTES } = require('../intent-spill');

const BIG = `pick up the thread:\n${'h'.repeat(1000)}\nnext: finish t9`;
const SMALL = 'pick up the thread: finish t9';

function mkH(overrides = {}) {
  const root = mkTmpRoot('clodex-spill-');
  const injected = [];
  const warns = [];
  const m = mk({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    pathFor,
    runDirFor,
    COMPACT_CONTINUATION_DELAY: 0,
    RELOAD_CONTINUATION_DELAY: 0,
    LONG_TEXT_THRESHOLD: 1e9,
    LONG_TEXT_DELAY: 0,
    SHORT_TEXT_DELAY: 0,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    log: { info: () => {}, debug: () => {}, error: () => {}, warn: (...a) => warns.push(a.join(' ')) },
    ...overrides,
  });
  m._injectText = (s, text, opts) => injected.push({ text, opts: opts || null });
  m._broadcast = () => {};
  m._maybeFlushInjectQueue = () => {};
  return { m, root, injected, warns };
}

function seat(h, name = 'a', agentType = 'claude') {
  const s = { name, agentType, type: agentType, workspaceId: 'ws1' };
  h.m.sessions.set(name, s);
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('the compact FIRE method injects a file pointer for a body over the threshold, not the typed body', async () => {
  const h = mkH();
  const s = seat(h);
  s._compactContinuation = BIG;

  h.m._fireCompactContinuation(s);
  await tick();

  const p = spillPathFor(h.root, 'a', spillIdOf(BIG));
  assert.deepStrictEqual(h.injected, [{
    text: `Continue from your handoff: @${p} `,
    opts: { bypassHold: true },
  }], 'one line, the absolute path, and the TRAILING SPACE that closes the CLI @-autocomplete popup');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG, 'the file holds the body exactly');
  assert.ok(h.injected[0].text.endsWith(' '),
    'without that space the deferred Enter selects whatever the popup happened to highlight');
});

test('the compact settle delay is sized on the INJECTED text, not on the original body', async () => {
  const h = mkH({ LONG_TEXT_THRESHOLD: 500, LONG_TEXT_DELAY: 4000, SHORT_TEXT_DELAY: 0 });
  const s = seat(h);
  s._compactContinuation = BIG;
  s._compactGuard = true;
  let released = false;
  h.m._releaseCompactGuard = () => { released = true; };

  h.m._fireCompactContinuation(s);
  await tick();
  assert.strictEqual(h.injected.length, 1, 'ENTER: the continuation fired');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(released, true,
    'the guard released on the SHORT delay: a 1 KB body becomes a ~90-char line, and a delay sized for '
    + 'the body would stall the fresh context for the duration of a paste that no longer happens');
});

test('the post-clear FIRE method takes the same route, still on the normal inject path', async () => {
  const h = mkH();
  const s = seat(h);
  s._postClearContinuation = BIG;

  h.m._firePostClearContinuation(s);
  await tick();

  const p = spillPathFor(h.root, 'a', spillIdOf(BIG));
  assert.deepStrictEqual(h.injected, [{ text: `Continue from your handoff: @${p} `, opts: null }],
    'bypassHold belongs to the bare slash command, not to prose, and the pointer is prose');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG);
});

test('the reload handoff takes the same route, after the boot-symlink gate', async () => {
  const h = mkH();
  const s = seat(h);
  const link = pathFor(h.root, 'a', 'transcript');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(h.root, 'conv.jsonl'), link);

  await h.m._injectReloadHandoff(s, BIG, 1000);

  const p = spillPathFor(h.root, 'a', spillIdOf(BIG));
  assert.deepStrictEqual(h.injected, [{ text: `Continue from your handoff: @${p} `, opts: null }]);
  assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG);
});

test('a body AT or below the threshold is typed verbatim and writes nothing (strict > on the 800 bytes)', async () => {
  assert.ok(Buffer.byteLength(SMALL, 'utf8') <= SPILL_MIN_BYTES, 'ENTER: the short fixture is under the cap');
  const exact = 'x'.repeat(SPILL_MIN_BYTES);

  for (const body of [SMALL, exact]) {
    const h = mkH();
    const s = seat(h);
    s._compactContinuation = body;
    h.m._fireCompactContinuation(s);
    await tick();
    assert.deepStrictEqual(h.injected, [{ text: body, opts: { bypassHold: true } }],
      `typed verbatim at ${Buffer.byteLength(body, 'utf8')} bytes`);
    assert.ok(!fs.existsSync(path.join(h.root, 'spill')), 'and nothing was written to disk');
  }
});

test('a codex seat is never spilled to — its CLI has no @-attachment grammar', async () => {
  const h = mkH();
  const s = seat(h, 'c', 'codex');
  s._compactContinuation = BIG;

  h.m._fireCompactContinuation(s);
  await tick();

  assert.deepStrictEqual(h.injected, [{ text: BIG, opts: { bypassHold: true } }],
    'the whole body is typed, exactly as before this feature');
  assert.ok(!fs.existsSync(path.join(h.root, 'spill')));
});

test('a write failure types the body and warns — a handoff is never lost to a disk that stopped accepting writes', async () => {
  const h = mkH();
  const s = seat(h);
  fs.writeFileSync(path.join(h.root, 'spill'), 'not a directory');
  s._compactContinuation = BIG;

  h.m._fireCompactContinuation(s);
  await tick();

  assert.deepStrictEqual(h.injected, [{ text: BIG, opts: { bypassHold: true } }],
    'falls back to typing the whole body');
  assert.ok(h.warns.some((w) => /handoff spill for a failed/.test(w)),
    'and says so — a silent fallback hides the disk');
});

test('when the tee already spilled the body, the pointer names THAT file and it is left alone', async () => {
  const h = mkH();
  const s = seat(h);
  const id = writeSpill(h.root, 'a', BIG);
  const p = spillPathFor(h.root, 'a', id);
  const before = fs.statSync(p);
  await new Promise((r) => setTimeout(r, 20));

  s._compactContinuation = BIG;
  h.m._fireCompactContinuation(s);
  await tick();

  assert.strictEqual(h.injected[0].text, `Continue from your handoff: @${p} `,
    'same dir, same content-addressed id, one copy and one format across both halves');
  const after = fs.statSync(p);
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'untouched — not rewritten, so no torn-read window');
  assert.strictEqual(after.ino, before.ino, 'and not replaced by a fresh inode either');
});

test('a clear whose body arrived as a TITLED pointer hands off the FILE body, not the pointer line', async () => {
  const h = mkH();
  const s = seat(h);
  const id = writeSpill(h.root, 'a', BIG);
  assert.ok(id, 'ENTER: the tee-written file exists, or the resolve below proves nothing');

  await h.m._handleIntent('a', {
    type: 'context', sub: 'clear', body: `pick up the thread: @spill:${id}`,
  });
  assert.strictEqual(s._postClearContinuation, BIG,
    'the chokepoint resolved before the continuation was stored — nothing downstream re-reads a pointer');

  h.m._firePostClearContinuation(s);
  await tick();

  const p = spillPathFor(h.root, 'a', id);
  assert.deepStrictEqual(h.injected.map((i) => i.text).slice(1),
    [`Continue from your handoff: @${p} `],
    'a clear is amnesiac: the whole briefing is what survives, so the title alone would be the handoff');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG);
});

test('the handoff file survives the run dir, which is the only reason the fresh process can read it', async () => {
  const h = mkH();
  const s = seat(h);
  s._compactContinuation = BIG;
  h.m._fireCompactContinuation(s);
  await tick();

  const p = h.injected[0].text.slice('Continue from your handoff: @'.length).trimEnd();
  fs.rmSync(runDirFor(h.root, 'a'), { recursive: true, force: true });
  assert.strictEqual(fs.readFileSync(p, 'utf8'), BIG,
    'run/<name>/ is rm -rf\'d on the exit that precedes the boot which reads this');
});
