'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerIpcHandlers } = require('../ipc-handlers');
const { pathFor } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

function writeRollout(home, day, stem, cwd, ts) {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${stem}.jsonl`);
  const meta = { timestamp: ts, type: 'session_meta', payload: { id: stem.slice(-36), cwd } };
  const turn = { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user' } };
  fs.writeFileSync(p, `${JSON.stringify(meta)}\n${JSON.stringify(turn)}\n`);
  return p;
}

function readSessionMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const ts = JSON.parse(raw.split('\n')[0]).timestamp || null;
  return ts ? { title: null, first: ts, last: ts, turns: 0 } : null;
}

test('session:history on a Codex seat never offers a rollout whose session_meta cwd is another project', () => {
  const reg = mkTmpRoot('ipc-hist-reg-');
  const home = mkTmpRoot('ipc-hist-codex-');
  const stem1 = 'rollout-2026-09-28T10-00-00-0199aaaa-0000-7000-8000-000000000001';
  const stem2 = 'rollout-2026-09-28T11-00-00-0199aaaa-0000-7000-8000-000000000002';
  const stem3 = 'rollout-2026-09-20T09-00-00-0199aaaa-0000-7000-8000-000000000003';
  const active = writeRollout(home, '2026/09/28', stem1, '/proj/mine', '2026-09-28T10:00:00.000Z');
  writeRollout(home, '2026/09/28', stem2, '/proj/OTHER', '2026-09-28T11:00:00.000Z');
  writeRollout(home, '2026/09/20', stem3, '/proj/mine', '2026-09-20T09:00:00.000Z');
  const link = pathFor(reg, 'cx', 'transcript');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(active, link);

  const handlers = new Map();
  registerIpcHandlers({
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn),
    log: { info() {}, error() {}, warn() {}, debug() {} },
    REGISTRY_DIR: reg,
    fs, os, path,
    readSessionMeta,
    claudeProjectDir: () => null,
    persistence: { get: (n) => (n === 'cx' ? { type: 'codex', cwd: '/proj/mine', sessionId: stem1, sessionIds: [stem3] } : null) },
  });
  const res = handlers.get('session:history')(null, 'cx');
  assert.ok(res.sessions.some((s) => s.sessionId === stem1 && s.active === true), 'ENTER: the active rollout resolves');
  assert.deepStrictEqual(res.sessions.map((s) => s.sessionId).sort(), [
    'rollout-2026-09-20T09-00-00-0199aaaa-0000-7000-8000-000000000003',
    'rollout-2026-09-28T10-00-00-0199aaaa-0000-7000-8000-000000000001',
  ]);
  const older = res.sessions.find((s) => s.sessionId === stem3);
  assert.strictEqual('missing' in older, false);
});
