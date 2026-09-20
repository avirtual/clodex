'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsReal = require('node:fs');
const pathReal = require('node:path');

const { createSessionManager } = require('../session-manager');
const { seatPathFor, claudeProjectSlug, SEAT_KINDS } = require('../clodex-paths');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SRC_CWD = '/old';
const FAR_CWD = '/far/crypto-app';

const BASE = {
  name: 'seat', type: 'claude', cwd: SRC_CWD, workspaceId: 'ws1',
  sessionId: SESSION_ID, createdAt: 111, extraArgs: ['--model', 'opus'],
  agents: ['a'], disabledTools: ['Bash'], env: { CLAUDE_CONFIG_DIR: '/acct/opsguru', K: 'V' },
  plugins: ['p'], intents: ['dm'], execCommands: ['e'],
  stripLevel: 2, label: 'My Seat', sessionIds: [SESSION_ID],
  ephemeral: true, reviewFor: 'x', reviewTicket: 't1', reviewerTemplate: 'r',
  pluginGrants: ['g'], wireLabel: 'w', ticketId: 't1', holdUntil: 9, rosterSentAt: 8,
  worktree: null, archivedAt: null, failed: null,
};

function seedSeat(root, name) {
  for (const kind of Object.keys(SEAT_KINDS)) {
    if (kind === 'run') continue;
    fsReal.mkdirSync(seatPathFor(root, name, kind), { recursive: true });
  }
  fsReal.writeFileSync(pathReal.join(seatPathFor(root, name, 'memory'), 'mem-1.md'), 'unit one');
  fsReal.writeFileSync(pathReal.join(seatPathFor(root, name, 'messages'), 'msg-1.txt'), 'dm one');
  const pending = pathReal.join(root, 'pending', name);
  fsReal.mkdirSync(pending, { recursive: true });
  fsReal.writeFileSync(pathReal.join(pending, 'p1'), 'parked');
  const loadlogDir = pathReal.join(root, 'library', 'memory-loadlog');
  fsReal.mkdirSync(loadlogDir, { recursive: true });
  fsReal.writeFileSync(pathReal.join(loadlogDir, `${name}.jsonl`), '{"unit":"mem-1"}\n');
}

function seedTranscript(claudeDir, cwd, sessionId) {
  const dir = pathReal.join(claudeDir, 'projects', claudeProjectSlug(cwd));
  fsReal.mkdirSync(dir, { recursive: true });
  const file = pathReal.join(dir, `${sessionId}.jsonl`);
  fsReal.writeFileSync(file, '{"type":"user"}\n');
  return file;
}

function mkMove({
  entries = [BASE], reply = { ok: true, dropped: ['account:opsguru'] },
  caps = ['dm', 'import'], needsUpgrade = false, peer = true,
  reminderRows = [{ id: 'r1', agent: 'seat', kind: 'in', spec: 'in 1h', body: 'ping' }],
  createThrows = null, seed = true,
} = {}) {
  const root = mkTmpRoot('clodex-movepeer-');
  const claudeDir = mkTmpRoot('clodex-movepeer-claude-');
  const store = entries.map((e) => ({ ...e }));
  const persistence = {
    list: () => store,
    get: (n) => { const e = store.find((x) => x.name === n); return e ? { ...e } : null; },
    upsert: (e) => {
      const i = store.findIndex((x) => x.name === e.name);
      if (i >= 0) store[i] = { ...store[i], ...e }; else store.push({ ...e });
    },
    remove: (n) => { const i = store.findIndex((x) => x.name === n); if (i >= 0) store.splice(i, 1); },
    setCwd: (n, cwd) => { const e = store.find((x) => x.name === n); if (e && cwd) e.cwd = cwd; },
    setLabel: (n, label) => { const e = store.find((x) => x.name === n); if (e) e.label = label; },
    setArchived: (n, on) => {
      const e = store.find((x) => x.name === n);
      if (!e) return;
      if (on) e.archivedAt = 4242; else delete e.archivedAt;
    },
  };

  const shipped = [];
  const conn = {
    status: () => ({ id: 'p1', label: 'murmurfi', caps, needsUpgrade }),
    importSeat: async (arg) => {
      shipped.push(arg);
      for (const f of arg.files) {
        const total = f.bytes ? f.bytes.length : fsReal.statSync(f.path).size;
        if (typeof arg.onProgress === 'function') arg.onProgress({ relPath: f.relPath, sent: total, total });
      }
      return reply;
    },
  };

  if (seed) {
    seedSeat(root, 'seat');
    seedTranscript(claudeDir, SRC_CWD, SESSION_ID);
  }

  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    REGISTRY_DIR: root,
    claudeHome: () => claudeDir,
    getPersistence: () => persistence,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPeerManager: () => ({ get: (id) => (peer && id === 'p1' ? conn : null) }),
    getAccounts: () => ({ labelFor: (dir) => (dir === '/acct/opsguru' ? 'opsguru' : null) }),
    getReminders: () => ({ listForAgent: (n) => reminderRows.filter((r) => r.agent === n) }),
    fs: fsReal,
    path: pathReal,
    DEFAULT_WORKSPACE_ID: 'default',
    resolveTeam: () => null,
    findProjectRoot: () => null,
    stripLevelOf: (e) => (e && e.stripLevel) || 0,
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    notifyOS: () => {},
  });
  const m = new SessionManager();
  const created = [];
  m.create = async (...args) => {
    created.push(args);
    if (createThrows) throw new Error(createThrows);
    const type = args[1];
    const spawned = args[0];
    m.sessions.set(spawned, {
      name: spawned, cwd: args[2], backend: null,
      agentType: (type === 'claude' || type === 'codex') ? type : null,
      pty: { pid: 2, kill() { m.sessions.delete(spawned); } },
    });
  };

  const events = [];
  m.windows.set('default', {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => events.push({ channel, payload }) },
  });

  const kills = [];
  const realMoveToPeer = m.moveToPeer.bind(m);
  m.moveToPeer = async (...args) => {
    const realKill = process.kill;
    const realSetTimeout = global.setTimeout;
    process.kill = (pid, sig) => { kills.push({ pid, sig }); };
    global.setTimeout = (cb, ms) => {
      if (ms === 5000) return { unref() {}, close() {} };
      return realSetTimeout(cb, ms);
    };
    try { return await realMoveToPeer(...args); } finally {
      process.kill = realKill;
      global.setTimeout = realSetTimeout;
    }
  };

  return { m, root, claudeDir, store, persistence, created, shipped, events, kills };
}

function seedLive(m, name) {
  const killed = [];
  const s = {
    name,
    agentType: 'claude',
    cwd: SRC_CWD,
    pty: { pid: 4242, kill() { killed.push(true); m.sessions.delete(name); } },
    killed,
  };
  m.sessions.set(name, s);
  return s;
}

const REFUSALS = [
  {
    why: 'unknown name',
    build: () => mkMove({ entries: [] }),
    args: ['nobody', 'p1', {}],
    error: 'Session not found: nobody',
  },
  {
    why: 'worktree seat — the loop owns that checkout',
    build: () => mkMove({ entries: [{ ...BASE, worktree: { path: '/tree/t9' } }] }),
    args: ['seat', 'p1', {}],
    error: 'seat runs in a ticket worktree (/tree/t9) — that checkout belongs to the ticket loop, so it cannot be moved.',
  },
  {
    why: 'codex seat',
    build: () => mkMove({ entries: [{ ...BASE, type: 'codex' }] }),
    args: ['seat', 'p1', {}],
    error: 'only Claude seats can be moved to a peer',
  },
  {
    why: 'bash seat',
    build: () => mkMove({ entries: [{ ...BASE, type: 'bash' }] }),
    args: ['seat', 'p1', {}],
    error: 'only Claude seats can be moved to a peer',
  },
  {
    why: 'no conversation to carry',
    build: () => mkMove({ entries: [{ ...BASE, sessionId: null }] }),
    args: ['seat', 'p1', {}],
    error: 'seat has no conversation to move — start it once, or move it locally instead',
  },
  {
    why: 'unknown peer',
    build: () => mkMove({ peer: false }),
    args: ['seat', 'p1', {}],
    error: 'unknown peer',
  },
  {
    why: 'peer predates seat import',
    build: () => mkMove({ needsUpgrade: true }),
    args: ['seat', 'p1', {}],
    error: 'peer murmurfi runs an older Clodex — upgrade it first',
  },
  {
    why: 'peer lacks the import cap',
    build: () => mkMove({ caps: ['dm'] }),
    args: ['seat', 'p1', {}],
    error: 'peer murmurfi does not accept moved sessions',
  },
  {
    why: 'a relative far cwd',
    build: () => mkMove(),
    args: ['seat', 'p1', { farCwd: 'relative/path' }],
    error: 'Destination must be an absolute path',
  },
];

for (const r of REFUSALS) {
  test(`refusal (${r.why}) returns before the seat is quiesced`, async () => {
    const { m, shipped } = r.build();
    const s = seedLive(m, 'seat');
    const out = await m.moveToPeer(...r.args);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.error, r.error);
    assert.deepStrictEqual(s.killed, [],
      'the pty was never killed — a refusal reached after quiescing has destroyed what it refused to move');
    assert.ok(m.sessions.has('seat'), 'the live seat is still in the map');
    assert.deepStrictEqual(shipped, [], 'nothing was shipped');
  });
}

test('a missing transcript is refused BEFORE the seat is quiesced', async () => {
  const { m, claudeDir, shipped } = mkMove({ seed: false });
  const s = seedLive(m, 'seat');
  const expected = pathReal.join(claudeDir, 'projects', claudeProjectSlug(SRC_CWD), `${SESSION_ID}.jsonl`);
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.error, `transcript not found at ${expected}`);
  assert.deepStrictEqual(s.killed, [],
    'the pty was never killed — the conversation is still resumable here');
  assert.deepStrictEqual(shipped, []);
});

test('a second moveToPeer while one is in flight is refused off _movingNames', async () => {
  const { m } = mkMove();
  m._movingNames.add('seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.deepStrictEqual(out, { ok: false, error: 'move already in progress' });
});

test('the success arm ships exactly the seeded files, archives the source and stamps movedTo', async () => {
  const { m, root, claudeDir, store, shipped, kills } = mkMove();
  const s = seedLive(m, 'seat');
  assert.ok(fsReal.statSync(pathReal.join(seatPathFor(root, 'seat', 'memory'), 'mem-1.md')).isFile(),
    'ENTER: sessions/seat/memory/mem-1.md is a real file at the SEAT spelling, not the legacy link');

  const out = await m.moveToPeer('seat', 'p1', { farCwd: FAR_CWD });

  assert.strictEqual(out.ok, true, `expected ok (got: ${out.error})`);
  assert.deepStrictEqual(out, {
    ok: true, name: 'seat', peer: 'murmurfi', farCwd: FAR_CWD,
    sessionId: SESSION_ID, dropped: ['account:opsguru'],
  });
  assert.deepStrictEqual(s.killed, [true], 'the seat was quiesced exactly once');
  assert.deepStrictEqual(kills, [], 'the 5s SIGKILL backstop never fired');

  assert.strictEqual(shipped.length, 1, 'importSeat was called once');
  assert.deepStrictEqual(shipped[0].files.map((f) => f.relPath), [
    'transcript.jsonl',
    'seat/memory/mem-1.md',
    'seat/messages/msg-1.txt',
    'pending/p1',
    'loadlog.jsonl',
    'reminders.json',
  ], 'every relPath is its own wire request, so a kind the walk forgets simply does not travel; '
    + 'the empty kinds (monitors, notices, promptcache, spill) contribute nothing');

  const rec = shipped[0].record;
  assert.strictEqual(shipped[0].name, 'seat');
  assert.strictEqual(rec.cwd, FAR_CWD, 'the record names the FAR cwd, not this box\'s');
  assert.strictEqual(rec.accountLabel, 'opsguru', 'the account travels by LABEL, never by path');
  assert.strictEqual(rec.execCommands, undefined, 'exec grants never ride the wire');
  assert.deepStrictEqual(rec.intents, ['dm'],
    'intents are NOT stripped here — the far side strips the privileged ones and reports them');
  for (const k of ['worktree', 'archivedAt', 'failed', 'ephemeral', 'reviewFor', 'reviewTicket',
    'reviewerTemplate', 'pluginGrants', 'wireLabel', 'ticketId', 'holdUntil', 'rosterSentAt']) {
    assert.strictEqual(rec[k], undefined, `${k} is omitted — the far create cannot re-seed it`);
  }
  assert.deepStrictEqual(rec.extraArgs, ['--model', 'opus'], 'everything else travels whole');

  const reminders = shipped[0].files.find((f) => f.relPath === 'reminders.json');
  assert.deepStrictEqual(JSON.parse(reminders.bytes.toString()),
    [{ id: 'r1', agent: 'seat', kind: 'in', spec: 'in 1h', body: 'ping' }]);

  assert.deepStrictEqual(store[0].movedTo, {
    peer: 'p1', peerLabel: 'murmurfi', farCwd: FAR_CWD, at: store[0].movedTo.at, sessionId: SESSION_ID,
  });
  assert.strictEqual(typeof store[0].movedTo.at, 'number');
  assert.strictEqual(store[0].archivedAt, 4242, 'the source record is archived as the backup, never dropped');
  assert.strictEqual(store[0].cwd, SRC_CWD, 'the SOURCE record keeps its own cwd');

  assert.strictEqual(
    fsReal.readFileSync(pathReal.join(seatPathFor(root, 'seat', 'memory'), 'mem-1.md'), 'utf8'), 'unit one',
    'the source is the backup — nothing the shipment read was moved or deleted');
  assert.strictEqual(fsReal.readFileSync(pathReal.join(root, 'pending', 'seat', 'p1'), 'utf8'), 'parked');
  assert.strictEqual(
    fsReal.readFileSync(pathReal.join(claudeDir, 'projects', claudeProjectSlug(SRC_CWD), `${SESSION_ID}.jsonl`), 'utf8'),
    '{"type":"user"}\n', 'the transcript is read-only — it stays byte-identical here');
});

test('farCwd defaults to the seat\'s own cwd — the same path on the far box', async () => {
  const { m, shipped } = mkMove();
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.farCwd, SRC_CWD);
  assert.strictEqual(shipped[0].record.cwd, SRC_CWD);
});

test('the far cwd is path.resolved — the far begin REFUSES a cwd resolve would change', async () => {
  const { m, shipped } = mkMove();
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', { farCwd: '/far/crypto-app/sub/..' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(shipped[0].record.cwd, FAR_CWD);
  assert.strictEqual(out.farCwd, FAR_CWD);
});

test('a record with no CLAUDE_CONFIG_DIR ships no accountLabel at all', async () => {
  const { m, shipped } = mkMove({ entries: [{ ...BASE, env: { K: 'V' } }] });
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, true);
  assert.ok(!('accountLabel' in shipped[0].record), 'the key is absent, not null');
});

test('a seat with no reminder rows ships no reminders.json', async () => {
  const { m, shipped } = mkMove({ reminderRows: [] });
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(shipped[0].files.map((f) => f.relPath), [
    'transcript.jsonl', 'seat/memory/mem-1.md', 'seat/messages/msg-1.txt', 'pending/p1', 'loadlog.jsonl',
  ]);
});

test('a memory unit nested several levels deep keeps its path relative to the KIND dir', async () => {
  const { m, root, shipped } = mkMove();
  const deep = pathReal.join(seatPathFor(root, 'seat', 'memory'), 'proj', 'sub');
  fsReal.mkdirSync(deep, { recursive: true });
  fsReal.writeFileSync(pathReal.join(deep, 'deep.md'), 'nested');
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, true);
  assert.ok(shipped[0].files.some((f) => f.relPath === 'seat/memory/proj/sub/deep.md'),
    'the relPath is joined with /, several levels deep');
});

test('a far refusal respawns locally and leaves the record byte-identical', async () => {
  const { m, store, created, persistence } = mkMove({ reply: { ok: false, error: 'far: name taken' } });
  seedLive(m, 'seat');
  const before = persistence.get('seat');

  const out = await m.moveToPeer('seat', 'p1', { farCwd: FAR_CWD });

  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.kept, true);
  assert.strictEqual(out.error, 'far: name taken');
  assert.strictEqual(out.cwd, SRC_CWD, 'the seat came back where it was');
  assert.strictEqual(out.type, 'claude');
  assert.deepStrictEqual(persistence.get('seat'), before,
    'nothing about the record was touched — a record stamped for a move that never landed is the silent failure here');
  assert.strictEqual(store[0].movedTo, undefined);
  assert.strictEqual(store[0].archivedAt, null, 'the seat is NOT archived on the failure arm');

  assert.strictEqual(created.length, 1, 'the seat was respawned exactly once');
  assert.deepStrictEqual(created[0], [
    'seat', 'claude', SRC_CWD, ['--model', 'opus'], SESSION_ID, 'ws1',
    null, false, null, ['a'],
    [], ['Bash'], [], [],
    null, [],
    ['e'],
    ['dm'],
    { CLAUDE_CONFIG_DIR: '/acct/opsguru', K: 'V' },
    false,
    false,
    ['p'],
    null,
    null,
  ], 'the same positional list a failed local move would use, mint=false');
});

test('a respawn that throws returns the kept ghost row', async () => {
  const { m, created } = mkMove({
    reply: { ok: false, error: 'far: name taken' },
    createThrows: 'spawn exploded',
  });
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', {});
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.kept, true);
  assert.strictEqual(out.error, 'spawn exploded — session kept; retry from the sidebar row, or forget it.');
  assert.strictEqual(out.cwd, SRC_CWD);
  assert.strictEqual(created.length, 1);
});

test('the exit-TIMEOUT arm mirrors move(): kept, at the OLD cwd, nothing shipped', async () => {
  const { m, store, created, shipped } = mkMove();
  const s = seedLive(m, 'seat');
  s.pty.kill = () => {};
  m._waitForExit = async () => false;

  const out = await m.moveToPeer('seat', 'p1', { farCwd: FAR_CWD });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.kept, true);
  assert.strictEqual(out.error, 'old process did not exit in time — session not moved');
  assert.strictEqual(out.cwd, SRC_CWD);
  assert.strictEqual(out.type, 'claude');
  assert.deepStrictEqual(shipped, [],
    'the transcript is complete only once the CLI exits, so nothing ships');
  assert.deepStrictEqual(created, [], 'nothing was respawned');
  assert.strictEqual(store[0].movedTo, undefined);
});

test('progress events arrive on session:move-progress in phase order', async () => {
  const { m, events } = mkMove();
  seedLive(m, 'seat');
  const out = await m.moveToPeer('seat', 'p1', { farCwd: FAR_CWD });
  assert.strictEqual(out.ok, true);

  const mine = events.filter((e) => e.channel === 'session:move-progress');
  assert.deepStrictEqual(mine.map((e) => e.payload.phase), [
    'begin', 'transcript', 'seat', 'seat', 'seat', 'seat', 'seat', 'commit',
  ]);
  for (const e of mine) assert.strictEqual(e.payload.name, 'seat');
  assert.deepStrictEqual(mine[0].payload, { name: 'seat', phase: 'begin', bytes: 0, total: 6 });
});

test('no progress is emitted when the move is refused', async () => {
  const { m, events } = mkMove({ caps: ['dm'] });
  seedLive(m, 'seat');
  await m.moveToPeer('seat', 'p1', {});
  assert.deepStrictEqual(events.filter((e) => e.channel === 'session:move-progress'), []);
});
