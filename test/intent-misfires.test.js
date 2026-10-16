'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { mk } = require('./lib/session-fixtures');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { parseIntent, looksLikeIntent } = require('../intent-scanner');
const { parseRemindSpec } = require('../remind-schedule');
const { isFilenameToken, parseAndValidate, clampReplyBody } = require('../exec-schema');
const { initStores, MISFIRE_KINDS, MISFIRE_KEEP, MISFIRE_PRUNE_AT } = require('../stores');

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function freshStores() {
  const userData = mkTmpRoot('misfire-ud-');
  const registryDir = mkTmpRoot('misfire-reg-');
  const stores = initStores(userData, {
    log: quiet, registryDir,
    resourcesDir: path.join(registryDir, '__no_seed__'),
    skillsResourcesDir: path.join(registryDir, '__no_seed_skills__'),
    envDefaultsFile: path.join(registryDir, '__no_env_defaults__.json'),
  });
  return {
    userData, stores,
    cleanup() {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    },
  };
}

test('misfire kinds: the closed set', () => {
  assert.deepStrictEqual([...MISFIRE_KINDS],
    ['unclosed-body', 'empty-body', 'disabled', 'schema', 'exec-refused', 'bounce', 'truncated-head']);
  assert.ok(Object.isFrozen(MISFIRE_KINDS));
});

test('misfires store: appends one json line per event, normalises fields, refuses an unknown kind', () => {
  const { userData, stores, cleanup } = freshStores();
  try {
    assert.strictEqual(stores.misfires.append({
      ts: 1700000000000, agent: 'lead', kind: 'schema', intent: 'exec', sub: 'clodex-run-tests',
      detail: 'x'.repeat(300), turnBytes: 812, ctxTokens: 120000, sinceCompact: 'n/a',
    }), true);
    assert.strictEqual(stores.misfires.append({ agent: 'lead', kind: 'nope', intent: 'dm' }), false);
    assert.strictEqual(stores.misfires.append({ kind: 'bounce', intent: 'task' }), false);
    const file = path.join(userData, 'intent-misfires.jsonl');
    assert.strictEqual(stores.misfires.file, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    assert.deepStrictEqual(lines.slice(1), ['']);
    assert.deepStrictEqual(JSON.parse(lines[0]), {
      ts: 1700000000000, agent: 'lead', kind: 'schema', intent: 'exec', sub: 'clodex-run-tests',
      detail: 'x'.repeat(200), turnBytes: 812, ctxTokens: 120000, sinceCompact: null,
    });
    assert.deepStrictEqual(stores.misfires.list().map((r) => r.kind), ['schema']);
  } finally { cleanup(); }
});

test('misfires store: past 6000 lines an append prunes to the newest 5000', () => {
  assert.strictEqual(MISFIRE_KEEP, 5000);
  assert.strictEqual(MISFIRE_PRUNE_AT, 6000);
  const { userData, stores, cleanup } = freshStores();
  try {
    const file = path.join(userData, 'intent-misfires.jsonl');
    const seed = [];
    for (let i = 0; i < 6000; i++) seed.push(JSON.stringify({ ts: i, agent: 'a', kind: 'bounce', intent: 'task', detail: '' }));
    fs.writeFileSync(file, seed.join('\n') + '\n');
    stores.misfires.append({ ts: 6000, agent: 'a', kind: 'bounce', intent: 'task' });
    const rows = stores.misfires.list();
    assert.strictEqual(rows.length, 5000);
    assert.strictEqual(rows[0].ts, 1001);
    assert.strictEqual(rows.at(-1).ts, 6000);
    stores.misfires.append({ ts: 6001, agent: 'a', kind: 'bounce', intent: 'task' });
    assert.strictEqual(stores.misfires.list().length, 5001);
  } finally { cleanup(); }
});

function mkSite(extra = {}) {
  const rows = [];
  const injected = [];
  const REGISTRY_DIR = mkTmpRoot('misfire-exec-');
  const execDir = path.join(REGISTRY_DIR, 'library', 'exec');
  fs.mkdirSync(execDir, { recursive: true });
  fs.writeFileSync(path.join(execDir, 'run-tests.json'), JSON.stringify({
    argv: ['/bin/true'], schema: { type: 'object', required: ['tree'], properties: { tree: { type: 'string' } } },
  }));
  const persisted = { intents: ['dm', 'remind', 'exec', 'context', 'task'], execCommands: ['run-tests'] };
  const m = mk({
    REGISTRY_DIR, fs, path, os, isFilenameToken, parseAndValidate, clampReplyBody,
    parseIntent, looksLikeIntent, execBodyCap: 64 * 1024, parseRemindSpec,
    getRemindScheduler: () => ({ listForAgent: () => [], cancel: () => false }),
    getCtlService: () => null,
    resolveTeam: () => null,
    getPersistence: () => ({ list: () => [], get: (n) => (n === 'seat' ? persisted : null) }),
    getMisfires: () => ({ append: (r) => { rows.push(r); return true; } }),
    log: quiet,
    ...extra,
  });
  m._injectText = (_s, t) => injected.push(t);
  m._broadcast = () => {};
  m._raiseNote = () => {};
  m._handleContextIntent = () => {};
  m._soloContext = () => null;
  m._spillRejectedPayload = () => '';
  const session = { name: 'seat', agentType: 'claude', cwd: REGISTRY_DIR, ctxInfo: { tok: 123456 } };
  m.sessions.set('seat', session);
  return { m, session, rows, injected, cleanup: () => fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }) };
}

const SITES = [
  {
    name: 'open body, head applied',
    run: ({ m }) => m._scanJsonlText('[agent:remind in 1m] a\nb', 'seat', [], { interrupted: false }),
    want: { kind: 'unclosed-body', intent: 'remind', sub: null, turnBytes: 24 },
  },
  {
    name: 'open body on a context verb, refused',
    run: ({ m }) => m._scanJsonlText('[agent:context compact] a\nb', 'seat', [], { interrupted: false }),
    want: { kind: 'unclosed-body', intent: 'context', sub: 'compact', turnBytes: 27 },
  },
  {
    name: 'turn interrupted inside a body',
    run: ({ m }) => m._scanJsonlText('[agent:dm bob] hi\nmore', 'seat', [], { interrupted: true }),
    want: { kind: 'unclosed-body', intent: 'dm', sub: null, turnBytes: 22 },
  },
  {
    name: 'unrecognized intent',
    run: ({ m }) => m._scanJsonlText('[agent:frobnicate] x', 'seat', [], { interrupted: false }),
    want: { kind: 'bounce', intent: 'unknown', sub: null, turnBytes: 20 },
  },
  {
    name: 'intent disabled for the seat',
    run: ({ m }) => m._handleIntent('seat', { type: 'shout', body: 'look' }),
    want: { kind: 'disabled', intent: 'shout', sub: null, turnBytes: null },
  },
  {
    name: 'exec payload refused by the schema',
    run: ({ m }) => m._scanJsonlText('[agent:exec run-tests] {"scope":"own"}', 'seat', [], { interrupted: false }),
    want: { kind: 'schema', intent: 'exec', sub: 'run-tests', turnBytes: 38 },
  },
  {
    name: 'exec command not granted',
    run: ({ m, session }) => m._handleExecIntent(session, 'other-cmd', '{}'),
    want: { kind: 'exec-refused', intent: 'exec', sub: 'other-cmd', turnBytes: null },
  },
  {
    name: 'ctl refused on a host without ctl',
    run: ({ m, session, injected }) => m._handleCtlIntent(session, { type: 'ctl', ctx: 'prod', line: 'get pods' }, (t) => injected.push(t)),
    want: { kind: 'exec-refused', intent: 'ctl', sub: null, turnBytes: null },
  },
  {
    name: 'remind spec bounced',
    run: ({ m, session }) => m._handleRemindIntent(session, 'whenever', 'x', { type: 'remind' }),
    want: { kind: 'bounce', intent: 'remind', sub: null, turnBytes: null },
  },
  {
    name: 'remind cancel of an unknown id',
    run: ({ m, session }) => m._handleRemindIntent(session, 'cancel abc123', '', { type: 'remind' }),
    want: { kind: 'bounce', intent: 'remind', sub: null, turnBytes: null },
  },
  {
    name: 'task verb bounced by its handler',
    run: ({ m, session }) => m._handleTask(session, { type: 'task', sub: 'start', id: 't9' }),
    want: { kind: 'bounce', intent: 'task', sub: 'start', turnBytes: null },
  },
  {
    name: 'body typed as a spill pointer',
    run: ({ m, session }) => m._spillTyped(session, 'seat', { type: 'dm', target: 'bob', body: 'x' }, '/p.md', 'pointer'),
    want: { kind: 'truncated-head', intent: 'dm', sub: null, turnBytes: null },
  },
  {
    name: 'body pointer Clodex never wrote',
    run: ({ m, session }) => m._spillUnresolved(session, 'seat', { type: 'dm', target: 'bob', body: 'x' }, '/p.md', { reason: 'missing' }),
    want: { kind: 'truncated-head', intent: 'dm', sub: null, turnBytes: null },
  },
];

for (const site of SITES) {
  test(`misfire recorded: ${site.name} → ${site.want.kind}`, async () => {
    const f = mkSite();
    try {
      await site.run(f);
      await new Promise((r) => setImmediate(r));
      assert.ok(f.injected.length > 0, `ENTER: ${site.name} injected its nag`);
      assert.strictEqual(f.rows.length, 1, `exactly one misfire for ${site.name}: ${JSON.stringify(f.rows)}`);
      const r = f.rows[0];
      assert.deepStrictEqual(
        { kind: r.kind, intent: r.intent, sub: r.sub, turnBytes: r.turnBytes, ctxTokens: r.ctxTokens, agent: r.agent },
        { ...site.want, ctxTokens: 123456, agent: 'seat' },
      );
      assert.ok(typeof r.detail === 'string' && r.detail.length > 0);
    } finally { f.cleanup(); }
  });
}

test('misfire ENTER: the unclosed-body row carries the nag the seat saw and the reply size', () => {
  const f = mkSite();
  try {
    f.m._handleRemindIntent = () => {};
    f.m._scanJsonlText('[agent:remind in 1m] a\nb\nc', 'seat', [], { interrupted: false });
    const hit = f.rows.find((r) => r.kind === 'unclosed-body');
    assert.ok(hit, 'ENTER: unclosed-body row');
    assert.deepStrictEqual(hit.detail, '[agent:remind] not closed; first line applied, 2 following lines treated as prose');
    assert.strictEqual(hit.turnBytes, 26);
  } finally { f.cleanup(); }
});

test('misfire ENTER: the exec schema row names the command and the field error', () => {
  const f = mkSite();
  try {
    f.m._handleExecIntent(f.session, 'run-tests', '{"scope":"own"}');
    const hit = f.rows.find((r) => r.kind === 'schema');
    assert.ok(hit, 'ENTER: schema row');
    assert.match(hit.detail, /^run-tests: .*tree/);
  } finally { f.cleanup(); }
});

test('misfire: a closed, applied intent records nothing', async () => {
  const f = mkSite();
  try {
    f.m._handleRemindIntent = () => {};
    f.m._scanJsonlText('[agent:remind in 1m] a\nb\n[agent:end]', 'seat', [], { interrupted: false });
    assert.deepStrictEqual(f.rows, []);
  } finally { f.cleanup(); }
});

test('misfire: a seat-less spawn reply routed through onReply is not the seat\'s misfire', () => {
  const f = mkSite({ AGENT_NAME_RE: /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/ });
  try {
    const got = [];
    f.m._handleSpawnIntent(f.session, { name: '..' }, { onReply: (msg) => got.push(msg) });
    assert.match(got[0], /^error:/);
    assert.deepStrictEqual(f.rows, []);
  } finally { f.cleanup(); }
});
