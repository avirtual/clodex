'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { mk } = require('./lib/session-fixtures');
const { createFiledRing, seedFiledRing, clipHead, filedEntry, spillHead, HEAD_MAX_BYTES, FILED_CAP } = require('../filed-ring');
const { peekFile, utf8CutAt, PEEK_MAX_BYTES } = require('../file-peek');
const { spillPathFor, spillDirFor, writeSpill } = require('../intent-spill');
const { projectDirFor } = require('../clodex-paths');
const { createRemoteWiring } = require('../remote-wiring');
const { RemoteServer } = require('../remote');
const { parseIntent, looksLikeIntent } = require('../intent-scanner');

const PAGE = path.join(__dirname, '..', 'renderer', 'remote.html');

function writeAt(dir, name, body, mtimeMs) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  if (mtimeMs != null) fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
  return p;
}

function sansTs(e) { const { ts, ...rest } = e; return rest; }

test('filed ring: newest first, dedupe by path, cap, and list() drops entries whose file is gone', () => {
  const root = mkTmpRoot('clx-fileview-');
  const ring = createFiledRing(3);
  const a = writeAt(root, 'a.md', 'A');
  const b = writeAt(root, 'b.md', 'B');
  const c = writeAt(root, 'c.md', 'C');
  const d = writeAt(root, 'd.md', 'D');
  ring.note({ path: a, kind: 'intent', head: 'ha', bytes: 1, ts: 1 });
  ring.note({ path: b, kind: 'message', head: 'hb', bytes: 1, ts: 2 });
  ring.note({ path: a, kind: 'intent', head: 'ha2', bytes: 1, ts: 3 });
  assert.deepStrictEqual(ring.list().map((e) => [e.path, e.head]), [[a, 'ha2'], [b, 'hb']], 'dedupe by path moves the entry to the front');
  ring.note({ path: c, kind: 'handoff', head: 'handoff', bytes: 1, ts: 4 });
  ring.note({ path: d, kind: 'intent', head: 'hd', bytes: 1, ts: 5 });
  assert.deepStrictEqual(ring.list().map((e) => e.path), [d, c, a], 'cap 3 drops the oldest (b)');
  assert.strictEqual(ring.has(b), false);
  fs.rmSync(c);
  assert.deepStrictEqual(ring.list().map((e) => e.path), [d, a], 'a removed file is dropped at list time');
  assert.strictEqual(ring.has(c), true, 'but the ring still remembers it so a peek can answer gone');
  assert.deepStrictEqual(ring.list()[0], { path: d, kind: 'intent', head: 'hd', bytes: 1, ts: 5 });
  assert.strictEqual(createFiledRing().cap, FILED_CAP);
  assert.strictEqual(FILED_CAP, 50);
});

test('filed ring: seeding lists the spill dir (intent) and the messages dir (message) by mtime, newest first, capped', () => {
  const root = mkTmpRoot('clx-fileview-');
  const spill = path.join(root, 'spill', 'seat');
  const msgs = path.join(root, 'messages', 'seat');
  const s1 = writeAt(spill, '0000000000000001.md', 'Regenerate the prompt\nbody', 1000);
  const m1 = writeAt(msgs, 'msg-1-1.txt', 'From: lead\nTime: 1\n\nbody', 2000);
  const s2 = writeAt(spill, '0000000000000002.md', '\n  second spill title \nbody', 3000);
  const m2 = writeAt(msgs, 'msg-1-2.txt', 'From: bob\n\nbody', 4000);
  fs.mkdirSync(path.join(spill, 'sub'));
  const ring = createFiledRing(3);
  assert.strictEqual(seedFiledRing(ring, [{ dir: spill, kind: 'intent' }, { dir: msgs, kind: 'message' }, { dir: path.join(root, 'nope'), kind: 'intent' }]), 3);
  assert.deepStrictEqual(ring.list(), [
    { path: m2, kind: 'message', head: 'From: bob', bytes: fs.statSync(m2).size, ts: 4000 },
    { path: s2, kind: 'intent', head: 'second spill title', bytes: fs.statSync(s2).size, ts: 3000 },
    { path: m1, kind: 'message', head: 'From: lead', bytes: fs.statSync(m1).size, ts: 2000 },
  ], 'the oldest (s1) falls off the cap; a subdirectory is not an entry');
  assert.strictEqual(ring.has(s1), false);
});

test('head is at most 120 UTF-8 bytes, cut back to a character boundary, never a replacement character', () => {
  const head = `${'é'.repeat(59)}日本`;
  assert.ok(Buffer.byteLength(head) > HEAD_MAX_BYTES, 'ENTER: the head overflows the cap');
  const clipped = clipHead(head);
  assert.ok(Buffer.byteLength(clipped) <= HEAD_MAX_BYTES);
  assert.ok(!clipped.includes('�'));
  assert.strictEqual(clipped, `${'é'.repeat(59)}`, '118 bytes of é, then 日 (3 bytes) would straddle 120 — dropped whole');
  assert.strictEqual(clipHead('one line\nsecond'), 'one line');
  const ring = createFiledRing();
  const root = mkTmpRoot('clx-fileview-');
  const p = writeAt(root, 'x.md', 'x');
  ring.note({ path: p, kind: 'intent', head, bytes: 1, ts: 1 });
  assert.strictEqual(ring.list()[0].head, clipped, 'the ring applies the same cap on note()');
});

test('spillHead: intent head + first line of the file; prose spills say prose', () => {
  const root = mkTmpRoot('clx-fileview-');
  const p = writeAt(root, 'x.md', 'Regenerate the append prompt\nlong body');
  assert.strictEqual(spillHead(p, { verb: 'task.add', head: 'task add hand' }), '[agent:task add hand] Regenerate the append prompt');
  assert.strictEqual(spillHead(p, { verb: 'prose', head: null }), 'prose');
  assert.deepStrictEqual(sansTs(filedEntry(p, 'handoff', 'handoff')), { path: p, kind: 'handoff', head: 'handoff', bytes: fs.statSync(p).size });
});

function writerFixture() {
  const root = mkTmpRoot('clx-fileview-');
  const notified = [];
  const spilled = [];
  let n = 0;
  const m = mk({
    REGISTRY_DIR: root,
    MSG_DIR: path.join(root, 'messages'),
    PENDING_DIR: path.join(root, 'pending'),
    OUTBOX_DIR: path.join(root, 'outbox'),
    path,
    ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    MSG_MAX_AGE: 1800,
    MSG_SPILL_THRESHOLD: 500,
    spillToFile: (sender, body, recipient) => {
      const dir = path.join(root, 'messages', recipient);
      fs.mkdirSync(dir, { recursive: true });
      const fpath = path.join(dir, `msg-${process.pid}-${++n}.txt`);
      fs.writeFileSync(fpath, `From: ${sender}\nTime: 00:00:00\nSize: ${body.length} bytes\n\n${body}`);
      spilled.push(fpath);
      return fpath;
    },
    getRemoteServer: () => ({ notifyFiled: (name) => notified.push(name) }),
    parseIntent, looksLikeIntent,
    log: { info() {}, debug() {}, warn() {}, error() {} },
  });
  const seat = (name) => {
    const s = { name, agentType: 'claude', workspaceId: 'ws1', filedRing: createFiledRing() };
    m.sessions.set(name, s);
    return s;
  };
  return { m, root, notified, spilled, seat };
}

test('writer: _handoffText notes a handoff entry whose path is byte-identical to the transcript literal it returns', () => {
  const h = writerFixture();
  const s = h.seat('lead');
  const body = `Continue the ticket\n${'x'.repeat(2000)}`;
  const text = h.m._handoffText(s, body, { snapshot: false });
  const m = text.match(/^Continue from your handoff: @(\S+) $/);
  assert.ok(m, `ENTER: the handoff was spilled: ${text.slice(0, 60)}`);
  const entries = s.filedRing.list();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, m[1], 'the literal in the injected text');
  assert.deepStrictEqual(sansTs(entries[0]), {
    path: spillPathFor(h.root, 'lead', path.basename(m[1], '.md')), kind: 'handoff', head: 'handoff', bytes: fs.statSync(m[1]).size,
  });
  assert.ok(path.isAbsolute(entries[0].path) && !entries[0].path.startsWith('~'));
  assert.deepStrictEqual(h.notified, ['lead'], 'notifyFiled fired once for the seat');
});

test('writer: _buildDeliveryText message spill notes a message entry at exactly the spillToFile return, head From: <sender>', () => {
  const h = writerFixture();
  h.seat('lead');
  const bob = h.seat('bob');
  const body = 'y'.repeat(900);
  const text = h.m._buildDeliveryText(bob, 'lead', body, 'dm');
  const m = text.match(/attached: @(\S+) /);
  assert.ok(m, `ENTER: the message was spilled: ${text.slice(0, 80)}`);
  assert.strictEqual(h.spilled.length, 1);
  const [entry] = bob.filedRing.list();
  assert.strictEqual(entry.path, h.spilled[0], 'entry.path === spillToFile(...) return');
  assert.strictEqual(entry.path, m[1], 'and the literal in the delivery text');
  assert.deepStrictEqual(sansTs(entry), { path: h.spilled[0], kind: 'message', head: 'From: lead', bytes: fs.statSync(h.spilled[0]).size });
  assert.deepStrictEqual(h.notified, ['bob']);
});

test('writer: rejected and denied intent bodies are message entries at the spillToFile return', () => {
  const h = writerFixture();
  const s = h.seat('lead');
  const out = h.m._spillRejectedPayload(s, 'dm', 'z'.repeat(50));
  assert.ok(out.includes(h.spilled[0]), 'ENTER: the reply names the file');
  assert.deepStrictEqual(sansTs(s.filedRing.list()[0]), {
    path: h.spilled[0], kind: 'message', head: 'From: dm (rejected)', bytes: fs.statSync(h.spilled[0]).size,
  });
  assert.deepStrictEqual(h.notified, ['lead']);
});

test('writer: the wire spill listener notes an intent entry at spillPathFor(REGISTRY_DIR, agent, id) — the tee pointer literal', async () => {
  const h = writerFixture();
  h.m._publishAgentText = () => {};
  h.m._maybeSpeak = () => {};
  h.m._maybeDeliverDigest = () => {};
  h.m._maybeRearmHold = () => {};
  h.m._maybeFireCompactLatch = () => {};
  h.m._fireScratchClose = () => {};
  h.m._shadowLog = () => {};
  const broadcasts = [];
  h.m._broadcast = (ch, msg) => broadcasts.push(msg);
  const s = h.seat('a');
  const id = writeSpill(h.root, 'a', `Regenerate the append prompt\n${'w'.repeat(1500)}`);
  assert.ok(id, 'ENTER: a spill file exists');
  const wire = await h.m._ensureWire();
  try {
    wire.emit('spill', { agent: 'a', verb: 'task.add', head: 'task add hand', id, bytes: 1529 });
    const expected = spillPathFor(h.root, 'a', id);
    const row = broadcasts.find((b) => b.type === 'spill');
    assert.strictEqual(row.path, expected, 'ENTER: the transcript pointer names this path');
    assert.deepStrictEqual(sansTs(s.filedRing.list()[0]), {
      path: expected, kind: 'intent', head: '[agent:task add hand] Regenerate the append prompt', bytes: fs.statSync(expected).size,
    });
    assert.deepStrictEqual(h.notified, ['a']);
    wire.emit('spill', { agent: 'a', verb: 'prose', head: null, id: 'fedcba9876543210', bytes: 1200 });
    assert.strictEqual(s.filedRing.has(spillPathFor(h.root, 'a', 'fedcba9876543210')), true);
  } finally {
    await wire.close();
    if (h.m._holdKeeper) h.m._holdKeeper.stop();
  }
});

test('create() seeds session.filedRing from the running host\'s REGISTRY_DIR (spill + messages), not a literal ~/.clodex', () => {
  const h = writerFixture();
  const sp = writeAt(path.join(h.root, 'spill', 'seat'), '00000000000000aa.md', 'Old spill title\nbody', 1000);
  const mp = writeAt(path.join(h.root, 'messages', 'seat'), 'msg-9-1.txt', 'From: lead\n\nbody', 2000);
  const ring = h.m._seedFiledRing('seat');
  assert.deepStrictEqual(ring.list().map((e) => [e.path, e.kind, e.head]), [[mp, 'message', 'From: lead'], [sp, 'intent', 'Old spill title']]);
  const src = fs.readFileSync(path.join(__dirname, '..', 'session-manager.js'), 'utf8');
  assert.match(src, /fileTouches: \[\],\n\s*filedRing: this\._seedFiledRing\(name\),/, 'attached in create() beside fileTouches, so resume seeds too');
});

test('peekFile: offset/length echo, clamp to PEEK_MAX_BYTES, truncated, and the default call keeps the old shape', () => {
  const root = mkTmpRoot('clx-fileview-');
  const p = writeAt(root, 'a.txt', 'hello world, this is text');
  const whole = peekFile(p);
  assert.deepStrictEqual(whole, { ok: true, path: p, size: 25, mtime: Math.trunc(fs.statSync(p).mtimeMs), offset: 0, length: 25, truncated: false, binary: false, content: 'hello world, this is text' });
  const part = peekFile(p, { offset: 6, length: 5 });
  assert.deepStrictEqual([part.offset, part.length, part.truncated, part.content], [6, 5, true, 'world']);
  const tail = peekFile(p, { offset: 20, length: 100 });
  assert.deepStrictEqual([tail.offset, tail.length, tail.truncated, tail.content], [20, 5, false, ' text']);
  const past = peekFile(p, { offset: 99 });
  assert.deepStrictEqual([past.length, past.truncated, past.content], [0, false, '']);
  const big = writeAt(root, 'big.txt', 'a'.repeat(PEEK_MAX_BYTES + 10));
  const capped = peekFile(big, { length: PEEK_MAX_BYTES * 4 });
  assert.deepStrictEqual([capped.length, capped.truncated], [PEEK_MAX_BYTES, true], 'length is clamped and echoed');
  assert.strictEqual(peekFile(big).truncated, true, 'old callers: truncated when the file exceeds the cap');
  const junk = peekFile(p, { offset: 'x', length: -4 });
  assert.deepStrictEqual([junk.offset, junk.length], [0, 25], 'garbage opts fall back to the defaults');
});

test('peekFile: a cut inside a multibyte sequence trims back to the boundary and reports the trimmed length', () => {
  const root = mkTmpRoot('clx-fileview-');
  const p = writeAt(root, 'u.txt', 'ab日本語cd');
  const r = peekFile(p, { offset: 0, length: 4 });
  assert.deepStrictEqual([r.length, r.content, r.truncated], [2, 'ab', true], '4 cuts 日 (bytes 2-4) in half: trimmed by 2');
  const r2 = peekFile(p, { offset: 0, length: 6 });
  assert.deepStrictEqual([r2.length, r2.content], [5, 'ab日'], '6 cuts 本 after one byte: trimmed by 1');
  assert.ok(!r.content.includes('�') && !r2.content.includes('�'));
  const r3 = peekFile(p, { offset: 5, length: 3 });
  assert.deepStrictEqual([r3.length, r3.content], [3, '本']);
  const four = writeAt(root, 'e.txt', 'x😀y');
  const r4 = peekFile(four, { length: 3 });
  assert.deepStrictEqual([r4.length, r4.content], [1, 'x'], 'a 4-byte sequence cut at 2 of 4 is dropped whole');
  assert.strictEqual(utf8CutAt(Buffer.from('😀'), 4), 4);
  assert.strictEqual(peekFile(four).content, 'x😀y', 'no trim at EOF');
});

test('peekFile: an offset inside a multibyte sequence moves FORWARD to the next boundary and the moved offset is echoed', () => {
  const root = mkTmpRoot('clx-fileview-');
  const p = writeAt(root, 'e.txt', 'é'.repeat(10));
  const r = peekFile(p, { offset: 5, length: 5 });
  assert.deepStrictEqual([r.offset, r.length, r.content, r.truncated], [6, 4, 'éé', true], 'the contract example: offset 5 length 5 → offset 6 length 4');
  const r2 = peekFile(p, { offset: 19, length: 5 });
  assert.deepStrictEqual([r2.offset, r2.length, r2.content, r2.truncated], [20, 0, '', false], 'a trailing continuation byte moves to EOF');
  const mixed = writeAt(root, 'm.txt', 'a日b😀cé日😀z');
  const bytes = fs.readFileSync(mixed);
  const parts = [];
  let at = 0;
  for (let i = 0; i < 64; i += 1) {
    const step = peekFile(mixed, { offset: at, length: 5 });
    assert.ok(step.ok && !step.content.includes('\uFFFD'), `step ${i} clean`);
    assert.strictEqual(step.offset, at, 'a client resuming from echoed offset + length always lands on a boundary');
    parts.push(step.content);
    at = step.offset + step.length;
    if (!step.truncated) break;
  }
  assert.strictEqual(Buffer.concat(parts.map((c) => Buffer.from(c, 'utf8'))).equals(bytes), true, 'the resume loop reassembles the file byte-identically');
  assert.strictEqual(at, bytes.length);
});

test('peekFile: binary detection and every error code', () => {
  const root = mkTmpRoot('clx-fileview-');
  const bin = writeAt(root, 'b.bin', Buffer.concat([Buffer.from([0x41, 0x00, 0x42]), Buffer.alloc(100, 0x43)]));
  const b = peekFile(bin);
  assert.deepStrictEqual(b, { ok: true, path: bin, size: 103, mtime: Math.trunc(fs.statSync(bin).mtimeMs), offset: 0, length: 0, truncated: false, binary: true, content: null });
  const ranged = peekFile(bin, { offset: 1, length: 4 });
  assert.deepStrictEqual([ranged.offset, ranged.length, ranged.truncated, ranged.binary, ranged.content, ranged.size], [0, 0, false, true, null, 103], 'a binary reply carries no range whatever was asked');
  const nf = peekFile(path.join(root, 'nope.txt'));
  assert.deepStrictEqual([nf.ok, nf.code], [false, 'not-found']);
  const dir = peekFile(root);
  assert.deepStrictEqual([dir.ok, dir.code], [false, 'not-a-file']);
  const target = writeAt(root, 't.txt', 'target');
  fs.symlinkSync(target, path.join(root, 'link.txt'));
  const link = peekFile(path.join(root, 'link.txt'));
  assert.deepStrictEqual([link.ok, link.content], [true, 'target'], 'the desktop viewer follows a symlinked file, as the old statSync peek did');
  const big = writeAt(root, 'late-nul.txt', `${'a'.repeat(9000)}\0`);
  const late = peekFile(big, { offset: 8500 });
  assert.deepStrictEqual([late.binary, late.offset, late.content.length], [false, 8500, 501], 'a NUL past the first 8 KB never flips a text file to binary mid-read');
  assert.strictEqual(peekFile(big, { length: 5 }).binary, false);
  const early = writeAt(root, 'early-nul.txt', `${'b'.repeat(10)}\0${'c'.repeat(200)}`);
  const ranged2 = peekFile(early, { offset: 100 });
  assert.deepStrictEqual([ranged2.binary, ranged2.offset, ranged2.length, ranged2.content], [true, 0, 0, null], 'a NUL in the first 8 KB is binary from any offset');
  assert.strictEqual(peekFile(early, { length: 5 }).binary, true, 'a short range at 0 still sniffs the head');
  const dev = peekFile('/dev/null');
  assert.deepStrictEqual([dev.ok, dev.code], [false, 'not-a-file']);
  const closed = writeAt(root, 'c.txt', 'secret');
  fs.chmodSync(closed, 0o000);
  const un = peekFile(closed);
  fs.chmodSync(closed, 0o600);
  if (process.getuid && process.getuid() !== 0) assert.deepStrictEqual([un.ok, un.code], [false, 'unreadable']);
  assert.ok(typeof nf.error === 'string' && typeof dir.error === 'string');
});

function wiringFixture({ registry, cwd, session, fs: fsDep = fs }) {
  const manager = { sessions: new Map([[session.name, session]]) };
  const peeks = [];
  const diffs = [];
  let srv = null;
  const deps = {
    path, fs: fsDep, os,
    log: { info() {}, error() {}, warn() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: registry, MSG_DIR: path.join(registry, 'messages'), OUTBOX_DIR: path.join(registry, 'outbox'), SELF_LABEL: 'testbox',
    parseCtxFile: () => null, ensureDir: () => {}, homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager, proxyPoller: { snapshot: () => null },
    loadManifest: () => { throw new Error('no team'); },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => ({ ok: true }),
    fetchFilePeek: (p, opts) => { peeks.push([p, opts]); return peekFile(p, opts); },
    fetchFileDiff: (name, p) => { diffs.push([name, p]); return { ok: true, diff: '' }; },
    CLAUDE_TOOLS: [],
    getPromptLibrary: () => ({ list: () => [] }), getAgentLibrary: () => ({ list: () => [] }), getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => ({ get: () => undefined }),
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getRemoteServer: () => srv, setRemoteServer: (v) => { srv = v; }, setRemoteError: () => {},
    readRemoteEnvToken: () => null, resolveRemoteToken: (a, b) => a || b || null,
    appVersion: '9.9.9', isPackaged: () => false,
  };
  const remoteMod = require('../remote');
  const orig = remoteMod.RemoteServer;
  let opts = null;
  remoteMod.RemoteServer = function (o) {
    opts = o;
    return { start: () => Promise.resolve(), stop() {}, port: 0, notifySessions() {}, setWtermCallbacks() {} };
  };
  try { createRemoteWiring(deps).syncRemoteServer(); } finally { remoteMod.RemoteServer = orig; }
  return { query: opts.query, peeks, diffs };
}

test('confinement (remote query only): cwd, spill, messages and task dirs of the RUNNING registry are readable; anything else is outside', () => {
  const registry = mkTmpRoot('clx-fileview-');
  const cwd = mkTmpRoot('clx-fileview-');
  const outsideRoot = mkTmpRoot('clx-fileview-');
  const session = { name: 'seat', agentType: 'claude', cwd, filedRing: createFiledRing() };
  const f = wiringFixture({ registry, cwd, session });
  const inCwd = writeAt(path.join(cwd, 'src'), 'a.js', 'const a = 1;');
  const r = f.query('seat', 'filePeek', { path: inCwd, offset: 6, length: 1 });
  assert.deepStrictEqual([r.ok, r.offset, r.length, r.content], [true, 6, 1, 'a'], 'inside cwd, with the range passed through');
  const spill = writeAt(spillDirFor(registry, 'seat'), '00000000000000ab.md', 'spilled');
  assert.strictEqual(f.query('seat', 'filePeek', { path: spill }).ok, true, 'spill dir of THIS registry');
  const msg = writeAt(path.join(registry, 'messages', 'seat'), 'msg-1-1.txt', 'From: x\n\nbody');
  assert.strictEqual(f.query('seat', 'filePeek', { path: msg }).ok, true, 'messages dir of THIS registry');
  const task = writeAt(path.join(projectDirFor(registry, cwd), 'tasks', 't1'), 'JOURNAL.md', 'journal');
  assert.strictEqual(f.query('seat', 'filePeek', { path: task }).ok, true, 'project task artifacts');
  const homeMsg = path.join(os.homedir(), '.clodex', 'messages', 'seat', 'msg-0-0.txt');
  const home = f.query('seat', 'filePeek', { path: homeMsg });
  assert.strictEqual(home.code, 'outside', 'a ~/.clodex path is never a root of a non-default registry, whether or not it exists');
  assert.strictEqual(f.query('seat', 'filePeek', { path: '/etc/definitely-not-here' }).code, 'outside', 'confinement decides before existence: no existence oracle');
  assert.strictEqual(f.query('seat', 'filePeek', { path: '/etc/hosts' }).code, 'outside');
  assert.strictEqual(f.query('seat', 'filePeek', { path: path.join(outsideRoot, 'nope', 'deeper.txt') }).code, 'outside', 'a missing path under a missing dir is still outside');
  const otherSpill = writeAt(path.join(registry, 'spill', 'other'), '00000000000000ac.md', 'not yours');
  assert.strictEqual(f.query('seat', 'filePeek', { path: otherSpill }).code, 'outside', 'another seat\'s spill dir');
  const out = writeAt(outsideRoot, 'id_rsa', 'secret');
  const dotdot = f.query('seat', 'filePeek', { path: path.join(cwd, 'src', '..', '..', path.basename(outsideRoot), 'id_rsa') });
  assert.deepStrictEqual([dotdot.ok, dotdot.code], [false, 'outside'], '../../ escape');
  assert.strictEqual(f.query('seat', 'filePeek', { path: out }).code, 'outside');
  fs.symlinkSync(out, path.join(cwd, 'link'));
  const link = f.query('seat', 'filePeek', { path: path.join(cwd, 'link') });
  assert.deepStrictEqual([link.ok, link.code], [false, 'outside'], 'a symlink inside cwd to an outside target is outside');
  fs.symlinkSync(inCwd, path.join(cwd, 'inner-link'));
  const inner = f.query('seat', 'filePeek', { path: path.join(cwd, 'inner-link') });
  assert.deepStrictEqual([inner.ok, inner.code], [false, 'not-a-file'], 'a symlink to an inside target is refused over the remote path');
  assert.strictEqual(r.path, inCwd, 'the reply echoes the requested literal, not the realpath');
  assert.strictEqual(f.peeks[0][0], fs.realpathSync(inCwd), 'while the read itself opens the realpath');
  assert.strictEqual(f.query('seat', 'filePeek', { path: 'relative/x' }).code, 'outside');
  const missing = f.query('seat', 'filePeek', { path: path.join(cwd, 'nope.txt') });
  assert.deepStrictEqual([missing.ok, missing.code], [false, 'not-found']);
  session.filedRing.note({ path: path.join(cwd, 'nope.txt'), kind: 'intent', head: 'h', bytes: 1, ts: 1 });
  const gone = f.query('seat', 'filePeek', { path: path.join(cwd, 'nope.txt') });
  assert.deepStrictEqual([gone.ok, gone.code], [false, 'gone'], 'listed in filed, since removed');
  const sweptMsg = path.join(registry, 'messages', 'seat', 'msg-1-1.txt');
  fs.rmSync(path.join(registry, 'messages', 'seat'), { recursive: true });
  session.filedRing.note({ path: sweptMsg, kind: 'message', head: 'From: x', bytes: 1, ts: 1 });
  assert.strictEqual(f.query('seat', 'filePeek', { path: sweptMsg }).code, 'gone', 'a root swept whole still confines, so a listed file under it is gone, not outside');
  assert.strictEqual(f.query('seat', 'filePeek', { path: path.join(registry, 'messages', 'seat', 'other.txt') }).code, 'not-found');
  assert.strictEqual(f.query('seat', 'filePeek', { path: path.join(cwd, 'src') }).code, 'not-a-file', 'a directory inside cwd');
  assert.strictEqual(f.query('seat', 'filePeek', { path: cwd }).code, 'not-a-file', 'the root itself is a directory, not outside');
  assert.deepStrictEqual(f.query('seat', 'fileDiff', { path: out }), { ok: false, code: 'outside', error: 'path is outside what this seat may read over the phone-access server' });
  assert.strictEqual(f.query('seat', 'fileDiff', { path: inCwd }).ok, true);
  assert.deepStrictEqual(f.diffs, [['seat', inCwd]], 'fileDiff still receives the requested path');
  assert.ok(f.peeks.every(([p]) => path.isAbsolute(p)));
  assert.strictEqual(f.query('seat', 'files').ok, true);
});

test('mtime is integral on both filePeek shapes and on a seeded filed[].ts, whatever the filesystem holds', () => {
  const root = mkTmpRoot('clx-fileview-');
  const frac = 1790025439448.5999;
  const text = writeAt(root, 'frac.txt', 'text', frac);
  const bin = writeAt(root, 'frac.bin', Buffer.from([0x41, 0x00, 0x42]), frac);
  assert.strictEqual(Number.isInteger(fs.statSync(text).mtimeMs), false, 'the fixture filesystem really keeps the fraction');
  const t = peekFile(text);
  const b = peekFile(bin);
  assert.deepStrictEqual([t.binary, Number.isInteger(t.mtime), t.mtime], [false, true, 1790025439448]);
  assert.deepStrictEqual([b.binary, Number.isInteger(b.mtime), b.mtime], [true, true, 1790025439448]);
  const ring = createFiledRing();
  assert.strictEqual(seedFiledRing(ring, [{ dir: root, kind: 'intent' }]), 2);
  assert.ok(ring.list().every((e) => Number.isInteger(e.ts)), `filed[].ts: ${ring.list().map((e) => e.ts)}`);
});

test('confinement follow-up: a non-traversable ancestor is outside, a loop is unreadable; a root itself and a dangling link inside cwd are not-a-file', () => {
  const registry = mkTmpRoot('clx-fileview-');
  const cwd = mkTmpRoot('clx-fileview-');
  const outsideRoot = mkTmpRoot('clx-fileview-');
  const session = { name: 'seat', agentType: 'claude', cwd, filedRing: createFiledRing() };
  const guarded = path.join(outsideRoot, 'guarded');
  const sealed = path.join(outsideRoot, 'sealed');
  const looped = path.join(outsideRoot, 'looped');
  const fail = (code) => Object.assign(new Error(`${code}: fixture`), { code });
  const throwsBelow = { [guarded]: 'EACCES', [sealed]: 'EPERM', [looped]: 'ELOOP' };
  const seen = [];
  const fakeFs = Object.create(fs, {
    realpathSync: {
      value: (p) => {
        seen.push(String(p));
        for (const [dir, code] of Object.entries(throwsBelow)) if (String(p) === dir || String(p).startsWith(dir + path.sep)) throw fail(code);
        return fs.realpathSync(p);
      },
    },
  });
  const f = wiringFixture({ registry, cwd, session, fs: fakeFs });
  const eacces = f.query('seat', 'filePeek', { path: path.join(guarded, 'deep', 'x.txt') });
  assert.deepStrictEqual([eacces.ok, eacces.code], [false, 'outside'], 'EACCES walks up and lands in the roots check, not in unreadable');
  assert.ok(seen.includes(outsideRoot), `walked up to ${outsideRoot}: ${seen}`);
  const eperm = f.query('seat', 'filePeek', { path: path.join(sealed, 'x.txt') });
  assert.deepStrictEqual([eperm.ok, eperm.code], [false, 'outside']);
  const eloop = f.query('seat', 'filePeek', { path: path.join(looped, 'x.txt') });
  assert.deepStrictEqual([eloop.ok, eloop.code], [false, 'unreadable'], 'ELOOP does not walk up');
  assert.strictEqual(f.query('seat', 'filePeek', { path: cwd }).code, 'not-a-file', 'the cwd root itself');
  const msgRoot = path.join(registry, 'messages', 'seat');
  fs.mkdirSync(msgRoot, { recursive: true });
  fs.mkdirSync(path.join(registry, 'messages', 'other'), { recursive: true });
  assert.strictEqual(f.query('seat', 'filePeek', { path: msgRoot }).code, 'not-a-file', 'the messages root itself');
  assert.strictEqual(f.query('seat', 'filePeek', { path: path.join(registry, 'messages', 'other') }).code, 'outside', 'a sibling of a root');
  assert.strictEqual(f.query('seat', 'filePeek', { path: `${cwd}2` }).code, 'outside', 'a sibling sharing the root\'s prefix');
  fs.symlinkSync(path.join(cwd, 'missing.txt'), path.join(cwd, 'dangling'));
  const dangling = f.query('seat', 'filePeek', { path: path.join(cwd, 'dangling') });
  assert.deepStrictEqual([dangling.ok, dangling.code], [false, 'not-a-file'], 'a dangling symlink inside cwd');
  fs.symlinkSync(path.join(outsideRoot, 'missing.txt'), path.join(outsideRoot, 'dangling'));
  const outLink = f.query('seat', 'filePeek', { path: path.join(outsideRoot, 'dangling') });
  assert.deepStrictEqual([outLink.ok, outLink.code], [false, 'outside'], 'a dangling symlink outside every root is outside, never not-a-file');
  assert.strictEqual(f.query('seat', 'filePeek', { path: path.join(cwd, 'nope.txt') }).code, 'not-found', 'a plain missing file inside cwd is still not-found');
  assert.strictEqual(f.peeks.length, 2, 'only the two roots reached the peek');
});

test('fetchSessionFiles shape: filed rides beside files (engine source pin)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(src, /files: s\.fileTouches \|\| \[\], filed: s\.filedRing \? s\.filedRing\.list\(\) : \[\] \}/);
  assert.match(src, /function fetchFilePeek\(filePath, opts = \{\}\) \{\n  return peekFile\(filePath, opts\);/);
});

function req(server, method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, path: p, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function collect(server, emit) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: server.port, path: '/api/events' }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        if (!buf.includes('\n\n')) return;
        if (!r._emitted) { r._emitted = true; emit(); return; }
        r.destroy();
        resolve(buf.slice(buf.indexOf('\n\n') + 2));
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
  });
}

test('_handleQuery maps code to status; no such session is codeless; notifyFiled broadcasts filed {name}; hello advertises filed', async () => {
  const cwd = mkTmpRoot('clx-fileview-');
  const wiring = wiringFixture({ registry: mkTmpRoot('clx-fileview-'), cwd, session: { name: 'seat', agentType: 'claude', cwd, filedRing: createFiledRing() } });
  const server = new RemoteServer({
    port: 0, host: '127.0.0.1', pagePath: PAGE,
    getSessions: () => [], getTranscript: () => ({ ok: true, messages: [] }), send: () => ({ ok: true }),
    query: (name, kind, args) => (name !== 's' ? wiring.query(name, kind, args) : args.code ? { ok: false, code: args.code, error: 'e' } : { ok: true, name, kind }),
  });
  await server.start();
  try {
    for (const kind of ['files', 'filePeek']) {
      const none = await req(server, 'POST', '/api/sessions/nope/query', { kind, args: { path: path.join(cwd, 'a.txt') } });
      assert.deepStrictEqual([none.status, none.json], [404, { ok: false, error: 'no such session' }], `${kind}: no such session is a 404 with NO code`);
    }
    for (const [code, status] of [['outside', 403], ['not-found', 404], ['gone', 410], ['not-a-file', 400], ['unreadable', 500], ['whatever', 404]]) {
      const { status: got, json } = await req(server, 'POST', '/api/sessions/s/query', { kind: 'filePeek', args: { code } });
      assert.strictEqual(got, status, `code ${code} → ${status}`);
      assert.strictEqual(json.ok, false);
      assert.strictEqual(got === 200, json.ok, 'ok:false never rides a 2xx');
    }
    const ok = await req(server, 'POST', '/api/sessions/s/query', { kind: 'files', args: {} });
    assert.deepStrictEqual([ok.status, ok.json], [200, { ok: true, name: 's', kind: 'files' }]);
    assert.strictEqual(ok.status === 200, ok.json.ok);
    const frames = await collect(server, () => server.notifyFiled('seat-1'));
    assert.strictEqual(frames, 'event: filed\ndata: {"name":"seat-1"}\n\n');
    const hello = await req(server, 'GET', '/api/peer/hello');
    assert.ok(hello.json.caps.includes('filed'), `caps: ${hello.json.caps}`);
    assert.ok(hello.json.caps.includes('query'));
  } finally {
    server.stop();
  }
});
