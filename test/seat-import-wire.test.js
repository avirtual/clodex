'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { RemoteServer, IMPORT_CHUNK_MAX } = require('../remote');
const { createRemoteWiring } = require('../remote-wiring');
const { PeerConnection } = require('../peer-client');
const { claudeProjectSlug } = require('../clodex-paths');
const { drainPending } = require('../pending-store');
const { mkTmpRoot } = require('./lib/tmp-roots');

const SID = '11111111-2222-3333-4444-555555555555';
const DEFAULT_CAPS = [
  'transcript', 'transcript-since', 'transcript-after', 'send', 'filed', 'resources',
];

function waitFor(pred, what, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = pred(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

function call(port, method, pathname, { body = null, headers = {}, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const buf = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(buf ? { 'Content-Length': buf.length } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: out });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, raw: '', error: e.message }));
    req.on('timeout', () => reject(new Error('request timeout')));
    if (buf) req.write(buf);
    req.end();
  });
}

async function withServer(opts, fn) {
  const s = new RemoteServer({ port: 0, host: '127.0.0.1', ...opts });
  await s.start();
  try { return await fn(s); } finally { s.stop(); }
}

function record(over = {}) {
  return {
    type: 'claude', sessionId: SID, cwd: over.cwd || '/tmp/does-not-matter',
    ...over,
  };
}

function stubSeatImport(over = {}) {
  return {
    begin: () => ({ ok: true, id: '0123456789abcdef', dropped: [] }),
    putFile: () => ({ ok: true, size: 1 }),
    abort: () => ({ ok: true }),
    commit: () => ({ ok: true, name: 'x', record: record(), installed: {}, dropped: [] }),
    sweep: () => [],
    maxBytes: 1,
    ...over,
  };
}


test('hello carries the import cap only when a seatImport is injected', async () => {
  await withServer({}, async (bare) => {
    const off = await call(bare.port, 'GET', '/api/peer/hello');
    assert.deepStrictEqual(off.body.caps, DEFAULT_CAPS);
  });
  await withServer({ seatImport: stubSeatImport() }, async (half) => {
    const on = await call(half.port, 'GET', '/api/peer/hello');
    assert.deepStrictEqual(on.body.caps, DEFAULT_CAPS);
  });
  await withServer({ seatImport: stubSeatImport(), importCreate: () => ({ ok: true }) }, async (wired) => {
    const on = await call(wired.port, 'GET', '/api/peer/hello');
    assert.deepStrictEqual(on.body.caps, [
      'transcript', 'transcript-since', 'transcript-after', 'send', 'filed', 'import', 'resources',
    ]);
  });
});


test('every import route answers 501 unless BOTH halves are wired', async () => {
  const seen = [];
  const half = stubSeatImport({
    begin: () => { seen.push('begin'); return { ok: true, id: '0123456789abcdef', dropped: [] }; },
    putFile: () => { seen.push('putFile'); return { ok: true, size: 1 }; },
    abort: () => { seen.push('abort'); return { ok: true }; },
  });
  for (const opts of [{}, { seatImport: half }, { importCreate: () => ({ ok: true }) }]) {
    await withServer(opts, async (s) => {
      const id = '0123456789abcdef';
      const rows = [
        await call(s.port, 'POST', '/api/import/begin', { body: { name: 'a', record: record() } }),
        await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`, { body: Buffer.from('x') }),
        await call(s.port, 'POST', `/api/import/${id}/commit`),
        await call(s.port, 'DELETE', `/api/import/${id}`),
      ];
      assert.deepStrictEqual(rows.map((r) => r.status), [501, 501, 501, 501]);
      assert.deepStrictEqual(rows.map((r) => r.body.error), [
        'import not supported', 'import not supported', 'import not supported', 'import not supported',
      ]);
    });
  }
  assert.deepStrictEqual(seen, [],
    'a half-wired box never stages bytes it could not then commit');
});


test('every import route refuses an untokened request, the file route included', async () => {
  const seen = [];
  const seatImport = stubSeatImport({
    begin: () => { seen.push('begin'); return { ok: true, id: '0123456789abcdef', dropped: [] }; },
    putFile: () => { seen.push('putFile'); return { ok: true, size: 1 }; },
    commit: () => { seen.push('commit'); return { ok: false, error: 'no' }; },
    abort: () => { seen.push('abort'); return { ok: true }; },
  });
  await withServer({ seatImport, importCreate: () => ({ ok: true }), token: 'sekret' }, async (s) => {
    const id = '0123456789abcdef';
    const bare = [
      await call(s.port, 'POST', '/api/import/begin', { body: { name: 'a', record: record() } }),
      await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`, { body: Buffer.from('x') }),
      await call(s.port, 'POST', `/api/import/${id}/commit`),
      await call(s.port, 'DELETE', `/api/import/${id}`),
    ];
    assert.deepStrictEqual(bare.map((r) => r.status), [401, 401, 401, 401]);
    assert.deepStrictEqual(seen, [], 'nothing reached the module behind the gate');

    const ok = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`,
      { body: Buffer.from('x'), token: 'sekret' });
    assert.strictEqual(ok.status, 200, 'ENTER: the same PUT with the token lands');
    assert.deepStrictEqual(seen, ['putFile']);
  });
});


function mkStaging() {
  const root = mkTmpRoot('clodex-impwire-');
  const files = path.join(root, 'files');
  fs.mkdirSync(files, { recursive: true });
  return { root, files };
}

test('a body past the chunk cap is 413 and leaves the staged file untouched', async () => {
  const { files } = mkStaging();
  const target = path.join(files, 'transcript.jsonl');
  const seatImport = stubSeatImport({
    putFile: ({ relPath, bytes, offset }) => {
      if (offset === 0) fs.writeFileSync(target, bytes);
      else fs.appendFileSync(target, bytes);
      return { ok: true, size: fs.statSync(target).size, relPath };
    },
  });
  await withServer({ seatImport, importCreate: () => ({ ok: true }) }, async (s) => {
    const id = '0123456789abcdef';
    const first = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`,
      { body: Buffer.from('seed') });
    assert.strictEqual(first.status, 200);
    assert.strictEqual(fs.statSync(target).size, 4);

    const over = Buffer.alloc(IMPORT_CHUNK_MAX + 1, 0x61);
    const res = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`, {
      body: over, headers: { 'Content-Range': 'bytes 4-4194308/*' },
    });
    assert.strictEqual(res.status, 413, 'the oversize chunk is refused, not staged');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'seed',
      'the staging file is byte-identical to what the accepted chunk left');
  });
});

test('two Content-Range chunks land as one file, and a header-less PUT is offset 0', async () => {
  const { files } = mkStaging();
  const target = path.join(files, 'transcript.jsonl');
  const calls = [];
  const seatImport = stubSeatImport({
    putFile: ({ relPath, bytes, offset }) => {
      calls.push({ relPath, offset, len: bytes.length });
      if (offset === 0) fs.writeFileSync(target, bytes);
      else fs.appendFileSync(target, bytes);
      return { ok: true, size: fs.statSync(target).size };
    },
  });
  const source = Buffer.concat([Buffer.alloc(1000, 0x41), Buffer.alloc(1500, 0x42)]);
  await withServer({ seatImport, importCreate: () => ({ ok: true }) }, async (s) => {
    const id = '0123456789abcdef';
    const a = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`, {
      body: source.subarray(0, 1000), headers: { 'Content-Range': 'bytes 0-999/*' },
    });
    const b = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`, {
      body: source.subarray(1000), headers: { 'Content-Range': 'bytes 1000-2499/*' },
    });
    assert.deepStrictEqual([a.status, b.status], [200, 200]);
    assert.deepStrictEqual([a.body.size, b.body.size], [1000, 2500]);
    assert.ok(fs.readFileSync(target).equals(source), 'the reassembled file is byte-identical');

    fs.rmSync(target);
    const bare = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`,
      { body: Buffer.from('nohdr') });
    assert.strictEqual(bare.status, 200);
    assert.deepStrictEqual(calls.map((c) => c.offset), [0, 1000, 0],
      'an absent Content-Range is offset 0, never a guess');
  });
});

test('a malformed Content-Range is a 400 and never reaches the module', async () => {
  let reached = 0;
  const seatImport = stubSeatImport({ putFile: () => { reached += 1; return { ok: true, size: 1 }; } });
  await withServer({ seatImport, importCreate: () => ({ ok: true }) }, async (s) => {
    const res = await call(s.port, 'PUT', '/api/import/0123456789abcdef/file/transcript.jsonl', {
      body: Buffer.from('x'), headers: { 'Content-Range': 'chunks 0-1/7' },
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(reached, 0);
  });
});

test('a staging id off the 16-hex grammar is refused at the route layer', async () => {
  let reached = 0;
  const seatImport = stubSeatImport({
    putFile: () => { reached += 1; return { ok: true, size: 1 }; },
    abort: () => { reached += 1; return { ok: true }; },
  });
  await withServer({ seatImport, importCreate: () => ({ ok: true }) }, async (s) => {
    const bad = await call(s.port, 'PUT', '/api/import/..%2F..%2Fetc/file/transcript.jsonl',
      { body: Buffer.from('x') });
    const badAbort = await call(s.port, 'DELETE', '/api/import/zzzz');
    assert.deepStrictEqual([bad.status, badAbort.status], [400, 400]);
    assert.strictEqual(reached, 0, 'both layers refuse; the module is never asked');
  });
});


function mkWiring(over = {}) {
  const root = mkTmpRoot('clodex-impwire-reg-');
  const home = mkTmpRoot('clodex-impwire-home-');
  fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', '.migrated'),
    `${JSON.stringify({ kinds: { messages: 'x', notices: 'x', promptcache: 'x', memory: 'x', spill: 'x', monitors: 'x', run: 'x' } })}\n`);

  const createCalls = [];
  const bornBaked = [];
  const persisted = new Map();
  const reminderRows = [];
  const persistence = {
    get: (name) => persisted.get(name) || null,
    upsert: (e) => { persisted.set(e.name, { ...(persisted.get(e.name) || {}), ...e }); },
    setLabel: (name, label) => { persisted.set(name, { ...(persisted.get(name) || {}), label }); },
    setStripLevel: (name, lvl) => { persisted.set(name, { ...(persisted.get(name) || {}), stripLevel: lvl }); },
  };
  const manager = {
    sessions: new Map(),
    create: async function create(...args) {
      createCalls.push(args);
      const existingEntry = persisted.get(args[0]) || null;
      bornBaked.push((existingEntry && existingEntry.createdAt) || Date.now());
      if (over.createThrows) throw new Error(over.createThrows);
      return { name: args[0], type: args[1], pid: 4242 };
    },
  };
  let srv = null;
  const deps = {
    path, fs,
    os: { homedir: () => home },
    log: { info() {}, warn() {}, error() {} },
    DEFAULT_WORKSPACE_ID: 'default',
    AGENT_NAME_RE: /^[a-zA-Z0-9._-]{1,64}$/,
    REGISTRY_DIR: root, OUTBOX_DIR: path.join(root, 'outbox'), SELF_LABEL: 'testbox',
    parseCtxFile: () => null, ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
    homeRelativize: (x) => x,
    claimOutbox: () => [], listOutboxOrigins: () => [],
    manager,
    proxyPoller: { snapshot: () => null },
    gitWorktree: { listWorktrees: async () => ({ ok: true, repo: '/repo', worktrees: [] }) },
    restartClodex: () => {}, restartSession: () => {}, peerProxyView: () => null,
    readSessionArgs: () => ({ ok: false }), applySessionArgs: () => ({ ok: true }),
    readSkillCatalog: () => ({ ok: false }), applySessionSkills: () => ({ ok: false }),
    fetchProxyContext: () => {}, fetchProxyReport: () => {}, fetchProxyBust: () => {},
    fetchSessionFiles: () => {}, fetchFilePeek: () => {}, fetchFileDiff: () => {},
    CLAUDE_TOOLS: ['Bash'],
    getPromptLibrary: () => ({ list: () => [] }),
    getAgentLibrary: () => ({ list: () => [] }),
    getSkillLibrary: () => ({ list: () => [] }),
    getPersistence: () => persistence,
    getUiSettings: () => ({ get: () => ({ remoteEnabled: true, remotePort: 0 }) }),
    getWorkspaces: () => ({ get: () => ({}) }),
    getReminders: () => ({ add: (row) => { reminderRows.push(row); return { id: `r${reminderRows.length}` }; } }),
    getAccounts: () => ({ configDirFor: (label) => (over.accounts || {})[label] || null }),
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
  try { createRemoteWiring(deps).syncRemoteServer(); }
  finally { remoteMod.RemoteServer = orig; }
  assert.ok(opts && opts.seatImport && opts.importCreate, 'ENTER: the wire carries both halves');
  return {
    root, home, opts, createCalls, bornBaked, persisted, reminderRows, manager,
    claudeProjects: path.join(home, '.claude', 'projects'),
  };
}


test('account mapping: a label hit rewrites the dir, a miss deletes the key and is reported', async () => {
  const rows = [
    {
      what: 'label hit → far dir',
      accounts: { opsguru: '/far/config/opsguru' },
      env: { CLAUDE_CONFIG_DIR: '/src/box/opsguru', FOO: 'bar' },
      accountLabel: 'opsguru',
      wantEnv: { CLAUDE_CONFIG_DIR: '/far/config/opsguru', FOO: 'bar' },
      wantDropped: [],
    },
    {
      what: 'label miss → key deleted, dropped names it',
      accounts: {},
      env: { CLAUDE_CONFIG_DIR: '/src/box/opsguru', FOO: 'bar' },
      accountLabel: 'opsguru',
      wantEnv: { FOO: 'bar' },
      wantDropped: ['account:opsguru'],
    },
    {
      what: 'no env → untouched, nothing dropped',
      accounts: { opsguru: '/far/config/opsguru' },
      env: undefined,
      accountLabel: 'opsguru',
      wantEnv: null,
      wantDropped: [],
    },
  ];
  for (const row of rows) {
    const w = mkWiring({ accounts: row.accounts });
    const out = await w.opts.importCreate({
      name: 'ana',
      record: record({ cwd: path.join(w.home, 'proj'), env: row.env, accountLabel: row.accountLabel }),
      installed: {},
      dropped: ['account'],
    });
    assert.strictEqual(out.ok, true, `${row.what}: create ran`);
    assert.deepStrictEqual(w.createCalls[0][18], row.wantEnv, `${row.what}: env positional`);
    assert.deepStrictEqual(out.dropped, row.wantDropped, `${row.what}: dropped`);
  }
});

test('a source-box CLAUDE_CONFIG_DIR never survives when the record names no label', async () => {
  const w = mkWiring({ accounts: { opsguru: '/far/config/opsguru' } });
  const out = await w.opts.importCreate({
    name: 'ana',
    record: record({ cwd: path.join(w.home, 'proj'), env: { CLAUDE_CONFIG_DIR: '/src/box/opsguru' } }),
    installed: {},
    dropped: ['account'],
  });
  assert.deepStrictEqual(w.createCalls[0][18], null, 'no path from the source box reaches create()');
  assert.deepStrictEqual(out.dropped, ['account:unknown']);
});


test('begin refuses a name that is live or persisted here, before any staging dir exists', async () => {
  for (const seat of ['live', 'persisted']) {
    const w = mkWiring();
    if (seat === 'live') w.manager.sessions.set('ana', {});
    else w.persisted.set('ana', { name: 'ana' });
    await withServer({ seatImport: w.opts.seatImport, importCreate: w.opts.importCreate }, async (s) => {
      const res = await call(s.port, 'POST', '/api/import/begin',
        { body: { name: 'ana', record: record({ cwd: path.join(w.home, 'proj') }) } });
      assert.strictEqual(res.status, 400, `${seat}: refused`);
      assert.match(res.body.error, /name taken "ana"/);
    });
    assert.ok(!fs.existsSync(path.join(w.root, 'import')),
      `${seat}: no staging directory was created for a doomed transfer`);
  }
});


test('begin returns the far-cwd refusal as a 400 and stages nothing for it', async () => {
  const w = mkWiring();
  const missingParent = path.join(w.root, 'no-such-home', 'projects');
  const rows = [
    {
      why: 'a path whose parent does not exist on this box',
      cwd: path.join(missingParent, 'agentic-crypto'),
      error: `far folder's parent does not exist: ${missingParent} — on testbox the project lives somewhere else`,
    },
    {
      why: "a path inside this box's own registry",
      cwd: path.join(w.root, 'sessions', 'ana'),
      error: `far path is inside Clodex's own data: ${path.join(w.root, 'sessions', 'ana')}`,
    },
  ];
  await withServer({
    seatImport: w.opts.seatImport, importCreate: w.opts.importCreate, getSessions: () => [],
  }, async (s) => {
    for (const row of rows) {
      const res = await call(s.port, 'POST', '/api/import/begin',
        { body: { name: 'ana', record: record({ cwd: row.cwd }) } });
      assert.strictEqual(res.status, 400, `${row.why}: ${res.raw}`);
      assert.strictEqual(res.body.error, row.error, row.why);
      assert.deepStrictEqual(
        fs.existsSync(path.join(w.root, 'import')) ? fs.readdirSync(path.join(w.root, 'import')) : [],
        [], `${row.why}: not one staging dir was opened`,
      );
    }
    const ok = await call(s.port, 'POST', '/api/import/begin',
      { body: { name: 'ana', record: record({ cwd: path.join(w.home, 'proj') }) } });
    assert.strictEqual(ok.status, 200, `ENTER: a good cwd is accepted (${ok.raw})`);
    assert.deepStrictEqual(fs.readdirSync(path.join(w.root, 'import')), [ok.body.id],
      'ENTER: and THAT one does open a staging dir — so the empty readdir above means something');
  });
});


const PARKED = JSON.stringify({ text: 'a message that rode with the seat', born: 1700000000000 });

test('importSeat ships a 9 MiB transcript in three chunks and the far create is a RESTORE', async () => {
  const w = mkWiring();
  const cwd = path.join(w.home, 'proj');
  const src = mkTmpRoot('clodex-impwire-src-');
  const transcript = path.join(src, 'transcript.jsonl');
  const big = Buffer.alloc(9 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32BE(i >>> 0, i);
  fs.writeFileSync(transcript, big);

  const rec = record({
    cwd,
    extraArgs: ['--model', 'opus'],
    systemPrompt: 'be brief',
    agents: ['scout'],
    denyBuiltins: ['WebFetch'],
    disabledTools: ['Bash'],
    disabledSkills: ['grok'],
    injectSkills: ['deploy'],
    systemPromptFile: 'lead',
    appendPromptFiles: ['tail'],
    intents: ['dm', 'reboot'],
    plugins: ['p1'],
    shellDeny: ['rm'],
    noWire: false,
    execCommands: [{ name: 'evil', command: 'rm -rf /' }],
    label: 'the mover',
    createdAt: 1700000000000,
    sessionIds: ['aaaa', SID],
    keepWarmAlways: true,
    autoCompact: false,
    digested: ['aaaa'],
    stripLevel: 2,
    importedFrom: { peer: 'sourcebox' },
  });

  await withServer({
    seatImport: w.opts.seatImport,
    importCreate: w.opts.importCreate,
    getSessions: () => [],
  }, async (s) => {
    const conn = new PeerConnection({
      id: 'box', label: 'boxy', url: `http://127.0.0.1:${s.port}`,
      emit: () => {}, helloIntervalMs: 10000,
    });
    conn.start();
    const progress = [];
    let out;
    try {
      await waitFor(() => conn.status().canImport === true, 'the import cap in status()');
      out = await conn.importSeat({
        name: 'ana',
        record: rec,
        files: [
          { relPath: 'transcript.jsonl', path: transcript },
          { relPath: 'seat/memory/unit.md', bytes: Buffer.from('# a memory unit\n') },
          { relPath: 'pending/1700000000001.1.json', bytes: Buffer.from(PARKED) },
          { relPath: 'reminders.json', bytes: Buffer.from(JSON.stringify([
            { kind: 'every', spec: '30m', body: 'stretch' },
            { kind: 'in', spec: '40m', body: 'chase t7', ticket: 't7' },
          ])) },
        ],
        onProgress: (p) => progress.push(p),
      });
      assert.strictEqual(out.ok, true, out.error);
      assert.strictEqual(out.name, 'ana');
      assert.strictEqual(out.pid, 4242);
      assert.strictEqual(out.sessionId, SID);
    } finally { conn.stop(); }

    assert.strictEqual(progress.filter((p) => p.relPath === 'transcript.jsonl').length, 3,
      'a 9 MiB transcript is three 4 MiB-capped chunks, never one body');

    const landed = path.join(w.claudeProjects, claudeProjectSlug(cwd), `${SID}.jsonl`);
    assert.ok(fs.readFileSync(landed).equals(big), 'the installed transcript is byte-identical');

    assert.strictEqual(w.createCalls.length, 1, 'the far create ran exactly once');
    assert.deepStrictEqual(w.createCalls[0], [
      'ana', 'claude', cwd,
      ['--model', 'opus'],
      SID,
      'default',
      'be brief',
      false,
      null,
      ['scout'],
      ['WebFetch'],
      ['Bash'],
      ['grok'],
      ['deploy'],
      'lead',
      ['tail'],
      [],
      ['dm'],
      null,
      false,
      false,
      ['p1'],
      ['rm'],
    ]);
    assert.strictEqual(w.createCalls[0][19], false,
      'mint=false: an imported seat is a RESTORE over the shipped promptcache');
    assert.deepStrictEqual(w.createCalls[0][16], [], 'exec grants never cross the wire');

    assert.deepStrictEqual(w.bornBaked, [1700000000000],
      'the shipped createdAt is in persistence BEFORE create(), which bakes it into the drain hook');
    assert.deepStrictEqual(
      drainPending(path.join(w.root, 'pending'), 'ana', 'tag', w.bornBaked[0]),
      ['a message that rode with the seat'],
      'mail parked on the source box survives the move instead of being discarded as born < expected',
    );

    const entry = w.persisted.get('ana');
    assert.strictEqual(entry.createdAt, 1700000000000);
    assert.deepStrictEqual(entry.sessionIds, ['aaaa', SID]);
    assert.strictEqual(entry.keepWarmAlways, true);
    assert.strictEqual(entry.autoCompact, false);
    assert.deepStrictEqual(entry.digested, ['aaaa']);
    assert.strictEqual(entry.label, 'the mover');
    assert.strictEqual(entry.stripLevel, 2);
    assert.strictEqual(entry.importedFrom.peer, 'sourcebox');
    assert.strictEqual(typeof entry.importedFrom.at, 'number');

    assert.deepStrictEqual(w.reminderRows.map((r) => [r.agent, r.spec, r.ticket]),
      [['ana', '30m', null], ['ana', '40m', null]]);
    assert.deepStrictEqual(out.dropped, ['reminders.ticket-bound:1'],
      'seat-import\'s own dropped rows ride the reply out; only "account" is replaced');
    assert.deepStrictEqual(fs.readdirSync(path.join(w.root, 'import')), [],
      'the staging is gone once the install committed');
  });
});


test('a commit that installs but cannot create answers 500 naming what is on disk', async () => {
  const w = mkWiring({ createThrows: 'spawn exploded' });
  const cwd = path.join(w.home, 'proj');
  await withServer({
    seatImport: w.opts.seatImport, importCreate: w.opts.importCreate, getSessions: () => [],
  }, async (s) => {
    const begun = await call(s.port, 'POST', '/api/import/begin',
      { body: { name: 'ana', record: record({ cwd }) } });
    assert.strictEqual(begun.status, 200, begun.raw);
    const id = begun.body.id;
    const put = await call(s.port, 'PUT', `/api/import/${id}/file/transcript.jsonl`,
      { body: Buffer.from('{"t":1}\n') });
    assert.strictEqual(put.status, 200);

    const res = await call(s.port, 'POST', `/api/import/${id}/commit`);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /spawn exploded/);

    const landed = path.join(w.claudeProjects, claudeProjectSlug(cwd), `${SID}.jsonl`);
    assert.strictEqual(res.body.installed.transcript, landed,
      'the reply names the installed transcript so the client can retry the create alone');
    assert.strictEqual(fs.readFileSync(landed, 'utf8'), '{"t":1}\n',
      'the files stay installed — a second commit would refuse on collision');
    assert.deepStrictEqual(fs.readdirSync(path.join(w.root, 'import')), [],
      'the staging is gone: commit consumed it before create was asked');
  });
});

test('abort removes the staging and the id it names cannot be committed after', async () => {
  const w = mkWiring();
  await withServer({
    seatImport: w.opts.seatImport, importCreate: w.opts.importCreate, getSessions: () => [],
  }, async (s) => {
    const begun = await call(s.port, 'POST', '/api/import/begin',
      { body: { name: 'ana', record: record({ cwd: path.join(w.home, 'proj') }) } });
    const id = begun.body.id;
    assert.ok(fs.existsSync(path.join(w.root, 'import', id)));
    const gone = await call(s.port, 'DELETE', `/api/import/${id}`);
    assert.strictEqual(gone.status, 200);
    assert.ok(!fs.existsSync(path.join(w.root, 'import', id)));
    const after = await call(s.port, 'POST', `/api/import/${id}/commit`);
    assert.strictEqual(after.status, 400);
    assert.match(after.body.error, /unknown staging/);
    assert.strictEqual(w.createCalls.length, 0);
  });
});
