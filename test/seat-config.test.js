'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { mkTmpRoot } = require('./lib/tmp-roots');
const {
  uuidv7, bootstrapSeatConfig, museDataHome, findMuseTranscript, newestMuseTranscript, museRegistryFor, linkTranscript, deepMerge,
} = require('../seat-config');

const deps = { fs, path, os };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('uuidv7: version nibble 7, variant 10, and a non-decreasing ms prefix across two calls', () => {
  const a = uuidv7(crypto);
  const b = uuidv7(crypto);
  assert.match(a, UUID_RE);
  assert.match(b, UUID_RE);
  assert.notStrictEqual(a, b);
  const ms = (u) => parseInt(u.replace(/-/g, '').slice(0, 12), 16);
  assert.ok(ms(a) <= ms(b), 'the 48-bit prefix is the mint time in ms');
  assert.ok(Math.abs(ms(b) - Date.now()) < 5000, 'and it is wall-clock ms, not seconds or µs');
});

function fixtureConfig(root, { settings = { schema_version: 1, provider: 'meta' }, withSettings = true, withAuth = true, withTrust = true } = {}) {
  const source = path.join(root, 'config');
  fs.mkdirSync(path.join(source, 'gh'), { recursive: true });
  fs.writeFileSync(path.join(source, 'gh', 'hosts.yml'), 'github.com: {}\n');
  fs.mkdirSync(path.join(source, 'git'), { recursive: true });
  fs.writeFileSync(path.join(source, 'git', 'config'), '[user]\n');
  fs.mkdirSync(path.join(source, 'muse'), { recursive: true });
  if (withAuth) fs.writeFileSync(path.join(source, 'muse', 'auth.json'), '{"schema_version":2,"storage":"keychain"}\n');
  if (withTrust) fs.writeFileSync(path.join(source, 'muse', 'trust.json'), '{"projects":{}}\n');
  if (withSettings) fs.writeFileSync(path.join(source, 'muse', 'settings.json'), `${JSON.stringify(settings)}\n`);
  return source;
}

const snapshot = (dir) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = [st.mode & 0o777, fs.readFileSync(p, 'utf-8')];
    }
  };
  walk(dir);
  return out;
};

test('bootstrapSeatConfig: gh/git symlinked, muse a real dir with copied 0600 files, settings merged, source untouched', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const source = fixtureConfig(root);
  const before = snapshot(source);
  const seatDir = path.join(root, 'run', 'seat', 'xdg');
  fs.mkdirSync(seatDir, { recursive: true });
  fs.writeFileSync(path.join(seatDir, 'stale'), 'from a previous create');
  const merge = { permissions: { schema_version: 1, profiles: { reviewer: { extends: ':read-only' } } } };

  const out = bootstrapSeatConfig(deps, { source, seatDir, settingsMerge: merge });
  assert.deepStrictEqual(out, { seatDir, museDir: path.join(seatDir, 'muse') });
  assert.deepStrictEqual(fs.readdirSync(seatDir).sort(), ['gh', 'git', 'muse'], 'rebuilt: the stale entry is gone');
  assert.ok(fs.lstatSync(path.join(seatDir, 'gh')).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(seatDir, 'git')).isSymbolicLink());
  assert.strictEqual(fs.readlinkSync(path.join(seatDir, 'gh')), path.join(source, 'gh'));
  const museDir = path.join(seatDir, 'muse');
  assert.ok(fs.lstatSync(museDir).isDirectory() && !fs.lstatSync(museDir).isSymbolicLink());
  assert.deepStrictEqual(fs.readdirSync(museDir).sort(), ['auth.json', 'settings.json', 'trust.json']);
  for (const f of ['auth.json', 'trust.json']) {
    assert.ok(!fs.lstatSync(path.join(museDir, f)).isSymbolicLink(), `${f} is a copy, not a link`);
    assert.strictEqual(fs.statSync(path.join(museDir, f)).mode & 0o777, 0o600);
    assert.strictEqual(fs.readFileSync(path.join(museDir, f), 'utf-8'), fs.readFileSync(path.join(source, 'muse', f), 'utf-8'));
  }
  assert.strictEqual(fs.statSync(path.join(museDir, 'settings.json')).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(museDir, 'settings.json'), 'utf-8')), {
    schema_version: 1,
    provider: 'meta',
    permissions: { schema_version: 1, profiles: { reviewer: { extends: ':read-only' } } },
  });
  assert.deepStrictEqual(snapshot(source), before, 'ENTER: the source config dir is byte-identical before and after');
});

test('bootstrapSeatConfig: no merge copies settings verbatim; a missing settings.json becomes {"schema_version":1}', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const source = fixtureConfig(root, { settings: { schema_version: 1, model: 'x', telemetry: { enabled: false } } });
  const seatDir = path.join(root, 'xdg');
  bootstrapSeatConfig(deps, { source, seatDir, settingsMerge: null });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(seatDir, 'muse', 'settings.json'), 'utf-8')),
    { schema_version: 1, model: 'x', telemetry: { enabled: false } });

  const root2 = mkTmpRoot('clx-seatcfg-');
  const source2 = fixtureConfig(root2, { withSettings: false });
  const seatDir2 = path.join(root2, 'xdg');
  bootstrapSeatConfig(deps, { source: source2, seatDir: seatDir2 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(seatDir2, 'muse', 'settings.json'), 'utf-8')), { schema_version: 1 });
});

test('bootstrapSeatConfig: a missing auth.json or trust.json throws before anything is written', () => {
  for (const missing of ['withAuth', 'withTrust']) {
    const root = mkTmpRoot('clx-seatcfg-');
    const source = fixtureConfig(root, { [missing]: false });
    const seatDir = path.join(root, 'xdg');
    assert.throws(() => bootstrapSeatConfig(deps, { source, seatDir }), /muse is not logged in \/ has no trust file/);
    assert.ok(!fs.existsSync(seatDir), `${missing}=false: the seat dir was never created`);
  }
});

test('deepMerge: nested objects merge, arrays and scalars replace, base is not mutated', () => {
  const base = { a: { b: 1, c: [1] }, d: 'x' };
  const out = deepMerge(base, { a: { c: [2], e: 2 }, d: null });
  assert.deepStrictEqual(out, { a: { b: 1, c: [2], e: 2 }, d: null });
  assert.deepStrictEqual(base, { a: { b: 1, c: [1] }, d: 'x' });
});

test('museDataHome: XDG_DATA_HOME wins, else ~/.local/share', () => {
  assert.strictEqual(museDataHome({ env: { XDG_DATA_HOME: '/x/data' }, os, path }), '/x/data');
  assert.strictEqual(museDataHome({ env: {}, os, path }), path.join(os.homedir(), '.local', 'share'));
});

test('findMuseTranscript: globs the date tree for <sid>/session.jsonl and never computes the date', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const sid = '01a0c97b-13a9-7aab-ab19-6f4f701b254d';
  const dir = path.join(root, 'muse', 'sessions', '2031', '01', '31', sid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), '{"record_type":"session.opened.observed"}\n');
  fs.mkdirSync(path.join(root, 'muse', 'sessions', '2031', '01', '30', 'other'), { recursive: true });
  assert.strictEqual(findMuseTranscript(deps, root, sid), path.join(dir, 'session.jsonl'));
  assert.strictEqual(findMuseTranscript(deps, root, 'ffffffff-0000-7000-8000-000000000000'), null);
  assert.strictEqual(findMuseTranscript(deps, path.join(root, 'nope'), sid), null);
});

test('t1095: newestMuseTranscript picks the newest session.jsonl by mtime at or after sinceMs, skips excluded paths and non-files, and never computes the date', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const at = (y, m, d, sid) => path.join(root, 'muse', 'sessions', y, m, d, sid, 'session.jsonl');
  const write = (p, mtimeMs) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"record_type":"session.opened.observed"}\n');
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  };
  const since = 1_800_000_000_000;
  const old = write(at('2031', '01', '30', 'old'), since - 5000);
  const mid = write(at('2031', '01', '31', 'mid'), since + 1000);
  const newest = write(at('2031', '02', '01', 'newest'), since + 2000);
  const exact = write(at('2031', '02', '01', 'exact'), since);
  fs.mkdirSync(path.join(root, 'muse', 'sessions', '2031', '02', '01', 'dirsid', 'session.jsonl'), { recursive: true });
  fs.utimesSync(path.join(root, 'muse', 'sessions', '2031', '02', '01', 'dirsid', 'session.jsonl'), (since + 9000) / 1000, (since + 9000) / 1000);
  assert.strictEqual(newestMuseTranscript(deps, root, since, []), newest);
  assert.strictEqual(newestMuseTranscript(deps, root, since, [newest]), mid, 'an excluded path is skipped for the next newest');
  assert.strictEqual(newestMuseTranscript(deps, root, since, [newest, mid]), exact, 'mtime equal to sinceMs qualifies');
  assert.strictEqual(newestMuseTranscript(deps, root, since, [newest, mid, exact]), null, `${old} is older than sinceMs: no candidate`);
  assert.strictEqual(newestMuseTranscript(deps, root, since - 10000, [newest, mid, exact]), old);
  assert.strictEqual(newestMuseTranscript(deps, root, since), newest, 'excludePaths is optional');
  assert.strictEqual(newestMuseTranscript(deps, path.join(root, 'nope'), 0, []), null);
});

test('t1104: newestMuseTranscript gives sinceMs 1 s of slack and treats untilMs as an exclusive upper bound', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const at = (sid) => path.join(root, 'muse', 'sessions', '2031', '02', '01', sid, 'session.jsonl');
  const write = (p, mtimeMs) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{"record_type":"session.opened.observed"}\n');
    fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  };
  const since = 1_800_000_000_000;
  const slack = write(at('slack'), 1_799_999_999_500);
  const tooOld = write(at('tooold'), 1_799_999_998_500);
  assert.strictEqual(newestMuseTranscript(deps, root, since, []), slack, 'mtime 500 ms before sinceMs is a candidate');
  assert.strictEqual(newestMuseTranscript(deps, root, since, [slack]), null, 'mtime 1500 ms before sinceMs is not');
  const later = write(at('later'), since + 3000);
  const atUntil = write(at('atuntil'), since + 2000);
  const before = write(at('before'), since + 1999);
  assert.strictEqual(newestMuseTranscript(deps, root, since, []), later, 'no untilMs: the newest wins');
  assert.strictEqual(newestMuseTranscript(deps, root, since, [], since + 2000), before, 'mtime at or after untilMs is excluded');
  assert.strictEqual(newestMuseTranscript(deps, root, since, [before], since + 2000), slack);
  assert.strictEqual(newestMuseTranscript(deps, root, since, [], null), later, 'a null untilMs is no bound');
  assert.notStrictEqual(newestMuseTranscript(deps, root, since, [], since + 2000), atUntil);
  assert.strictEqual(newestMuseTranscript(deps, root, since, [before, slack], since + 2000), null, `${tooOld} is below the slack and ${atUntil} at the bound: nothing left`);
});

test('museRegistryFor: the record whose process_generation_hint names the pid, else one whose pid field does, else null', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const dir = path.join(root, 'muse', 'runtime', 'muse', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const hinted = { schema_version: 1, session_id: 'sid-hint', session_name: null, endpoint_hint: 'ms-1.sock', process_generation_hint: 'pid=4242' };
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ schema_version: 1, session_id: 'sid-other', process_generation_hint: 'pid=1' }));
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(hinted));
  fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ session_id: 'sid-pid', pid: 5150 }));
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
  fs.writeFileSync(path.join(dir, 'null.json'), 'null');
  fs.writeFileSync(path.join(dir, 'README'), 'ignored');
  assert.deepStrictEqual(museRegistryFor(deps, root, 4242), hinted);
  assert.deepStrictEqual(museRegistryFor(deps, root, 5150), { session_id: 'sid-pid', pid: 5150 });
  assert.strictEqual(museRegistryFor(deps, root, 7), null);
  assert.strictEqual(museRegistryFor(deps, path.join(root, 'nope'), 4242), null);
});

test('linkTranscript: writes the symlink through a tmp+rename and repoints an existing link', () => {
  const root = mkTmpRoot('clx-seatcfg-');
  const link = path.join(root, 'transcript.jsonl');
  linkTranscript(deps, link, '/a/session.jsonl');
  assert.strictEqual(fs.readlinkSync(link), '/a/session.jsonl');
  linkTranscript(deps, link, '/b/session.jsonl');
  assert.strictEqual(fs.readlinkSync(link), '/b/session.jsonl');
  assert.deepStrictEqual(fs.readdirSync(root), ['transcript.jsonl'], 'no tmp link left behind');
});
