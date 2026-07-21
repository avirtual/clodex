'use strict';
// import.test.js — `ctx import` from a FIXTURE userData dir (never the real
// one). Covers: env-file parse, userData resolution (flag/env/both-exist mtime),
// peer-row → entry mapping (ssh/url/disabled/tokenless), sandbox registry sweep,
// collision skip vs --force, dry-run writes nothing, and the never-tunnel
// invariant (an argv-shaped store field is refused, never imported).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const imp = require('../src/import');
const { run } = require('../src/main');

// Build a fixture userData dir with a ui-settings.json and optional env files.
function fixture({ ui = {}, remoteToken = null, sandboxTokens = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-ud-'));
  fs.writeFileSync(path.join(dir, 'ui-settings.json'), JSON.stringify(ui));
  if (remoteToken != null) fs.writeFileSync(path.join(dir, 'remote.env'), `CLODEX_REMOTE_TOKEN=${remoteToken}\n`, { mode: 0o600 });
  for (const [subdir, tok] of Object.entries(sandboxTokens)) {
    fs.mkdirSync(path.join(dir, subdir), { recursive: true });
    fs.writeFileSync(path.join(dir, subdir, 'auth.env'), `CLODEX_REMOTE_TOKEN=${tok}\n`, { mode: 0o600 });
  }
  return dir;
}

// ── leaf: env-file parse ─────────────────────────────────────────────────────
test('parseEnvFile: KEY=value, ignores blanks/comments/leading-=, missing→{}', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-env-'));
  const f = path.join(dir, 'x.env');
  fs.writeFileSync(f, 'CLODEX_REMOTE_TOKEN=abc123\n\n=nope\nBARE\nOTHER=v=w\n');
  assert.deepStrictEqual(imp.parseEnvFile(f), { CLODEX_REMOTE_TOKEN: 'abc123', OTHER: 'v=w' });
  assert.deepStrictEqual(imp.parseEnvFile(path.join(dir, 'absent')), {});
});

// ── leaf: userData resolution ────────────────────────────────────────────────
test('resolveDataDir: --data-dir wins; absent → NOTFOUND', () => {
  const dir = fixture({ ui: { remotePort: 7900 } });
  assert.strictEqual(imp.resolveDataDir({ dataDirFlag: dir, env: {} }).dir, dir);
  assert.throws(() => imp.resolveDataDir({ dataDirFlag: '/no/such/dir', env: {} }), (e) => { assert.strictEqual(e.exitCode, 5); return true; });
});

test('resolveDataDir: CLODEX_DATA_DIR between flag and defaults', () => {
  const dir = fixture({ ui: {} });
  const r = imp.resolveDataDir({ env: { CLODEX_DATA_DIR: dir } });
  assert.strictEqual(r.dir, dir);
  assert.strictEqual(r.source, 'CLODEX_DATA_DIR');
});

test('resolveDataDir: both Clodex+clodex exist → newest ui-settings mtime wins, noted', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-home-'));
  const base = path.join(home, 'Library', 'Application Support');
  const packaged = path.join(base, 'Clodex');
  const dev = path.join(base, 'clodex');
  fs.mkdirSync(packaged, { recursive: true }); fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(packaged, 'ui-settings.json'), '{}');
  fs.writeFileSync(path.join(dev, 'ui-settings.json'), '{}');
  // On a case-INSENSITIVE volume (macOS default) `Clodex` and `clodex` are the
  // SAME directory — a real nuance: the packaged/dev userData collapse to one,
  // so there is nothing to tiebreak and the resolver just returns it. The mtime
  // tiebreak only bites on a case-SENSITIVE volume; assert it there.
  const caseSensitive = !fs.existsSync(path.join(base, 'CLODEX-probe')) &&
    (() => { try { fs.mkdirSync(path.join(base, 'CaseProbe')); const collides = fs.existsSync(path.join(base, 'caseprobe')); fs.rmdirSync(path.join(base, 'CaseProbe')); return !collides; } catch { return false; } })();
  if (!caseSensitive) {
    const r = imp.resolveDataDir({ env: {}, platform: 'darwin', home });
    assert.ok(r.dir === packaged || r.dir === dev);
    return;
  }
  // make dev newer by pushing packaged into the past (numeric seconds — the
  // Date form no-ops on some filesystems).
  const olderSec = (Date.now() - 10000) / 1000;
  fs.utimesSync(path.join(packaged, 'ui-settings.json'), olderSec, olderSec);
  const r = imp.resolveDataDir({ env: {}, platform: 'darwin', home });
  assert.strictEqual(r.dir, dev);
  assert.match(r.note, /picked the newest/);
});

test('platformDataDirs: covers both names per platform', () => {
  const home = '/h';
  assert.deepStrictEqual(imp.platformDataDirs({}, 'darwin', home), [
    '/h/Library/Application Support/Clodex', '/h/Library/Application Support/clodex',
  ]);
  assert.deepStrictEqual(imp.platformDataDirs({ XDG_CONFIG_HOME: '/x' }, 'linux', home), ['/x/Clodex', '/x/clodex']);
  // path.join uses the HOST separator (this suite runs on posix), so build the
  // expected the same way rather than hard-coding backslashes.
  assert.deepStrictEqual(imp.platformDataDirs({ APPDATA: 'C:\\d' }, 'win32', home), [path.join('C:\\d', 'Clodex'), path.join('C:\\d', 'clodex')]);
});

// ── leaf: candidate collection ───────────────────────────────────────────────
test('collect: local engine → url+token; wire-off adds a warning reason', () => {
  const dir = fixture({ ui: { remoteEnabled: false, remotePort: 7911 }, remoteToken: 'sek' });
  const cands = imp.collectCandidates(dir);
  const local = cands.find((c) => c.name === 'local');
  assert.deepStrictEqual(local.entry, { url: 'http://127.0.0.1:7911', token: 'sek' });
  assert.strictEqual(local.tokenState, 'set');
  assert.match(local.reason, /wire is OFF/);
});

test('collect: local defaults port 7900 when absent, no token → tokenState none', () => {
  const dir = fixture({ ui: {} });
  const local = imp.collectCandidates(dir).find((c) => c.name === 'local');
  assert.deepStrictEqual(local.entry, { url: 'http://127.0.0.1:7900' });
  assert.strictEqual(local.tokenState, 'none');
});

test('collect: peers → ssh/url mapping; disabled skipped; tokenless imports', () => {
  const dir = fixture({ ui: { peers: [
    { id: 'a', label: 'work', sshHost: 'user@box', remotePort: 7900, token: 'tk' },
    { id: 'b', label: 'lan', url: 'http://10.0.0.5:7900' },
    { id: 'c', label: 'paused', url: 'http://x', disabled: true },
    { id: 'd', label: 'alt', sshHost: 'h2', remotePort: 7950 },
  ] } });
  const cands = imp.collectCandidates(dir);
  const by = (n) => cands.find((c) => c.name === n);
  assert.deepStrictEqual(by('work').entry, { ssh: 'user@box', token: 'tk' }); // 7900 default omitted
  assert.strictEqual(by('work').tokenState, 'set');
  assert.deepStrictEqual(by('lan').entry, { url: 'http://10.0.0.5:7900' });
  assert.strictEqual(by('lan').tokenState, 'none');
  assert.strictEqual(by('paused').action, 'skip');
  assert.match(by('paused').reason, /disabled/);
  assert.deepStrictEqual(by('alt').entry, { ssh: 'h2', remotePort: 7950 }); // non-default port kept
});

test('collect: NEVER-TUNNEL — an argv-shaped transport field is refused, not imported', () => {
  // A hostile/garbled store row whose url is an ARRAY (argv). safeTransport
  // rejects non-strings; neither ssh nor url is usable → skip with a reason.
  const dir = fixture({ ui: { peers: [
    { id: 'evil', label: 'evil', url: ['sh', '-c', 'rm -rf ~'] },
    { id: 'evil2', label: 'evil2', sshHost: ['ssh', 'x'] },
  ] } });
  const cands = imp.collectCandidates(dir);
  for (const n of ['evil', 'evil2']) {
    const c = cands.find((x) => x.name === n);
    assert.strictEqual(c.action, 'skip');
    assert.match(c.reason, /refused/);
    assert.strictEqual(c.entry, undefined);
  }
  // and no candidate anywhere carries a tunnel key
  assert.ok(cands.every((c) => !c.entry || c.entry.tunnel === undefined));
});

test('collect: sandboxes from the boxes registry — per-box wirePort + auth.env token', () => {
  const dir = fixture({
    ui: { boxes: [
      { id: 'sandbox', label: 'sandbox', config: {} },                 // default 7820, subdir 'sandbox'
      { id: 'solo', label: 'solo', config: { wirePort: 7830 } },       // subdir 'sandbox-solo'
      { id: 'notoken', label: 'notoken', config: {} },                 // no auth.env → skip
    ] },
    sandboxTokens: { sandbox: 'boxTokA', 'sandbox-solo': 'boxTokB' },
  });
  const cands = imp.collectCandidates(dir);
  const by = (n) => cands.find((c) => c.name === n);
  assert.deepStrictEqual(by('sandbox').entry, { url: 'http://127.0.0.1:7820', token: 'boxTokA' });
  assert.deepStrictEqual(by('solo').entry, { url: 'http://127.0.0.1:7830', token: 'boxTokB' });
  assert.strictEqual(by('notoken').action, 'skip');
  assert.match(by('notoken').reason, /no auth\.env/);
});

// ── applyImport: collisions, force, current untouched ────────────────────────
test('applyImport: collision skips by default, --force overwrites, current untouched', () => {
  const store = { current: 'local', contexts: { local: { url: 'http://old' }, other: { url: 'http://o' } } };
  const cands = [
    { name: 'local', entry: { url: 'http://new' }, action: 'add', tokenState: 'none' },
    { name: 'fresh', entry: { url: 'http://f' }, action: 'add', tokenState: 'none' },
  ];
  const noForce = imp.applyImport(store, cands, { force: false });
  assert.strictEqual(noForce.store.contexts.local.url, 'http://old'); // kept
  assert.strictEqual(noForce.store.contexts.fresh.url, 'http://f');
  assert.strictEqual(noForce.results.find((r) => r.name === 'local').result, 'skipped');
  assert.strictEqual(noForce.store.current, 'local'); // untouched

  const forced = imp.applyImport(store, cands, { force: true });
  assert.strictEqual(forced.store.contexts.local.url, 'http://new');
  assert.strictEqual(forced.results.find((r) => r.name === 'local').result, 'overwritten');
  assert.strictEqual(forced.store.current, 'local');
});

// ── end-to-end through main.run against a fixture + a tmp contexts file ───────
function tmpCtxFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clx-cf-')), 'contexts.json');
}
async function cli(argv, ctxFile, env = {}) {
  let stdout = '', stderr = '';
  const code = await run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), env, contextsFile: ctxFile });
  return { code, stdout, stderr };
}

test('ctx import (e2e): writes contexts, human report, no token values leak', async () => {
  const dir = fixture({
    ui: { remotePort: 7900, remoteEnabled: true, peers: [{ id: 'a', label: 'work', sshHost: 'user@box', token: 'peerSecret' }] },
    remoteToken: 'localSecret',
  });
  const cf = tmpCtxFile();
  const r = await cli(['ctx', 'import', '--data-dir', dir], cf);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /added\s+local\s+\(token set\)/);
  assert.match(r.stdout, /added\s+work\s+\(token set\)/);
  assert.doesNotMatch(r.stdout, /localSecret|peerSecret/); // tokens never printed
  const saved = JSON.parse(fs.readFileSync(cf, 'utf8'));
  assert.strictEqual(saved.contexts.local.token, 'localSecret');
  assert.strictEqual(saved.contexts.work.ssh, 'user@box');
  assert.strictEqual((fs.statSync(cf).mode & 0o777), 0o600);
});

test('ctx import --dry-run writes nothing', async () => {
  const dir = fixture({ ui: { remotePort: 7900 }, remoteToken: 't' });
  const cf = tmpCtxFile();
  const r = await cli(['ctx', 'import', '--data-dir', dir, '--dry-run'], cf);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /dry-run/);
  assert.strictEqual(fs.existsSync(cf), false); // never created
});

test('ctx import --json: stable array shape, no token values', async () => {
  const dir = fixture({ ui: { peers: [{ id: 'a', label: 'work', url: 'http://h', token: 'sek' }] }, remoteToken: 'x' });
  const cf = tmpCtxFile();
  const r = await cli(['ctx', 'import', '--data-dir', dir, '--json'], cf);
  const out = JSON.parse(r.stdout);
  assert.ok(Array.isArray(out.results));
  const work = out.results.find((x) => x.name === 'work');
  assert.deepStrictEqual(Object.keys(work).sort(), ['name', 'reason', 'result', 'tokenState'].sort());
  assert.strictEqual(work.tokenState, 'set');
  assert.doesNotMatch(r.stdout, /sek/);
});

test('ctx import: collision skipped, --force overwrites (e2e)', async () => {
  const dir = fixture({ ui: { remotePort: 7900 }, remoteToken: 't1' });
  const cf = tmpCtxFile();
  await cli(['ctx', 'import', '--data-dir', dir], cf);
  // second import of the same local → skipped
  let r = await cli(['ctx', 'import', '--data-dir', dir], cf);
  assert.match(r.stdout, /skipped\s+local.*--force to overwrite/);
  // with a changed token and --force → overwritten
  const dir2 = fixture({ ui: { remotePort: 7901 }, remoteToken: 't2' });
  r = await cli(['ctx', 'import', '--data-dir', dir2, '--force'], cf);
  assert.match(r.stdout, /overwritten\s+local/);
  const saved = JSON.parse(fs.readFileSync(cf, 'utf8'));
  assert.strictEqual(saved.contexts.local.url, 'http://127.0.0.1:7901');
  assert.strictEqual(saved.contexts.local.token, 't2');
});

test('ctx import: no userData found → exit 5', async () => {
  const r = await cli(['ctx', 'import', '--data-dir', '/definitely/not/here'], tmpCtxFile());
  assert.strictEqual(r.code, 5);
  assert.match(r.stderr, /not found/);
});
