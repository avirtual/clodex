'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { createEngine, sweepSeatMessages } = require('../engine');
const { createFiledRing } = require('../filed-ring');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SEAT = 'hand-one';
const PAST_SWEEP = Date.now() + 2 * 3600 * 1000;

function mkEngine() {
  const tmp = mkTmpRoot('clodex-spill-');
  const registryDir = path.join(tmp, 'clodex-home');
  const cwd = path.join(tmp, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const engine = createEngine({
    userDataPath: tmp,
    seams: { noSeed: true, registryDir },
    log: { info() {}, warn() {}, error() {} },
  });
  const session = { name: SEAT, agentType: 'claude', cwd, fileTouches: [], filedRing: createFiledRing() };
  engine.manager.sessions.set(SEAT, session);
  const sweep = () => sweepSeatMessages(path.join(registryDir, 'messages'), path.join(registryDir, 'pending'), PAST_SWEEP);
  return { engine, registryDir, session, sweep };
}

function sansTs(e) { const { ts, ...rest } = e; return rest; }

test('a spilled dm lands in messages/<seat>/ AND spill/<seat>/messages/ under the same basename; the sweep removes only the messages/ copy', () => {
  const { engine, registryDir, session, sweep } = mkEngine();
  const body = 'durable-dm-body '.repeat(60);
  const text = engine.manager._buildDeliveryText(session, 'lead', body, 'dm');
  const m = text.match(/attached: @(\S+) /);
  assert.ok(m, `ENTER: the body spilled: ${text.slice(0, 80)}`);
  const handOff = m[1];
  const name = path.basename(handOff);
  assert.strictEqual(handOff, path.join(registryDir, 'messages', SEAT, name), 'the seat still reads the messages/ copy');
  const durable = path.join(registryDir, 'spill', SEAT, 'messages', name);
  assert.strictEqual(fs.readFileSync(durable, 'utf8'), fs.readFileSync(handOff, 'utf8'), 'both copies carry the same bytes');

  sweep();
  assert.strictEqual(fs.existsSync(handOff), false, 'ENTER: the 30-minute sweep still collects the hand-off copy');
  assert.strictEqual(fs.existsSync(durable), true, 'the durable copy is never swept');
  assert.match(fs.readFileSync(durable, 'utf8'), /^From: lead\n[\s\S]*durable-dm-body/);
});

test('the filed-ring entry for a spilled dm is the durable copy and survives the sweep', () => {
  const { engine, registryDir, session, sweep } = mkEngine();
  const text = engine.manager._buildDeliveryText(session, 'lead', 'ring-entry-body '.repeat(60), 'dm');
  const name = path.basename(text.match(/attached: @(\S+) /)[1]);
  const durable = path.join(registryDir, 'spill', SEAT, 'messages', name);
  sweep();
  assert.deepStrictEqual(session.filedRing.list().map(sansTs), [
    { path: durable, kind: 'message', head: 'From: lead', bytes: fs.statSync(durable).size },
  ]);
});

test('a click on the swept messages/ path resolves to the durable copy through the engine resolver', () => {
  const { engine, registryDir, session, sweep } = mkEngine();
  const text = engine.manager._buildDeliveryText(session, 'lead', 'click-body '.repeat(80), 'dm');
  const handOff = text.match(/attached: @(\S+) /)[1];
  sweep();
  const res = engine.resolveFilePath(SEAT, `@${handOff}`, null);
  assert.deepStrictEqual(res, {
    ok: true,
    path: path.join(registryDir, 'spill', SEAT, 'messages', path.basename(handOff)),
    via: 'durable copy of a swept message spill',
  });
});

test('a rejected ticket body names its durable copy, with no sweep deadline, and the ring holds that path', () => {
  const { engine, registryDir, session } = mkEngine();
  const body = 'rejected-spec '.repeat(10);
  const suffix = engine.manager._spillRejectedPayload(session, 'task add', body);
  const [entry] = session.filedRing.list();
  assert.match(entry.path, new RegExp(`^${path.join(registryDir, 'spill', SEAT, 'messages')}/msg-\\d+-\\d+\\.txt$`));
  assert.strictEqual(suffix, ` — your task add body (${Buffer.byteLength(body)} bytes) is saved at ${entry.path}`);
  assert.match(fs.readFileSync(entry.path, 'utf8'), /rejected-spec/);
});

test('a denied dm body names its durable copy, with no sweep deadline', () => {
  const { engine, registryDir, session } = mkEngine();
  const body = 'denied-dm-body';
  const suffix = engine.manager._deniedIntentPayload(session, { type: 'dm', body });
  const [entry] = session.filedRing.list();
  assert.strictEqual(path.dirname(entry.path), path.join(registryDir, 'spill', SEAT, 'messages'));
  assert.ok(suffix.endsWith(`. Your dm body (${Buffer.byteLength(body)} bytes) is saved at ${entry.path}`), suffix);
  assert.doesNotMatch(suffix, /swept|minutes/);
});

test('a durable copy left by an earlier launch with the same pid is never overwritten: the spill takes the next free name', () => {
  const { engine, registryDir, session } = mkEngine();
  const durDir = path.join(registryDir, 'spill', SEAT, 'messages');
  fs.mkdirSync(durDir, { recursive: true });
  const stale = path.join(durDir, `msg-${process.pid}-1.txt`);
  fs.writeFileSync(stale, 'OLD');
  const text = engine.manager._buildDeliveryText(session, 'lead', 'fresh-body '.repeat(80), 'dm');
  const name = path.basename(text.match(/attached: @(\S+) /)[1]);
  assert.strictEqual(fs.readFileSync(stale, 'utf8'), 'OLD');
  assert.strictEqual(name, `msg-${process.pid}-2.txt`);
  assert.deepStrictEqual(session.filedRing.list().map((e) => e.path), [path.join(durDir, name)]);
  assert.match(fs.readFileSync(path.join(durDir, name), 'utf8'), /fresh-body/);
});

test('a ring seeded at startup lists message spills at their durable copies, older ones included, and they survive the sweep', () => {
  const { engine, registryDir } = mkEngine();
  const msgDir = path.join(registryDir, 'messages', SEAT);
  const durDir = path.join(registryDir, 'spill', SEAT, 'messages');
  fs.mkdirSync(msgDir, { recursive: true });
  fs.mkdirSync(durDir, { recursive: true });
  const write = (file, text, sec) => { fs.writeFileSync(file, text); fs.utimesSync(file, sec, sec); };
  write(path.join(durDir, 'msg-7-1.txt'), 'From: older\n\nold', 1700000000);
  write(path.join(msgDir, 'msg-7-2.txt'), 'From: newer\n\nnew', 1700000100);
  write(path.join(durDir, 'msg-7-2.txt'), 'From: newer\n\nnew', 1700000100);
  const ring = engine.manager._seedFiledRing(SEAT);
  fs.unlinkSync(path.join(msgDir, 'msg-7-2.txt'));
  assert.deepStrictEqual(ring.list(), [
    { path: path.join(durDir, 'msg-7-2.txt'), kind: 'message', head: 'From: newer', bytes: 16, ts: 1700000100000 },
    { path: path.join(durDir, 'msg-7-1.txt'), kind: 'message', head: 'From: older', bytes: 16, ts: 1700000000000 },
  ]);
});

after(() => { setImmediate(() => process.exit(0)); });
