'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { parkDelivery, drainPending, allParkedTexts, parkIdInUse, agentDir, claimsDir, claimTag, CLAIM_STALE_MS } = require('../pending-store');
const { createSessionManager } = require('../session-manager');
const { mkTmpRoot } = require('./lib/tmp-roots');

function age(p, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(p, t, t);
}

test('a live-pid claim older than ten minutes is rehomed and delivered; a one-minute-old one is left alone', () => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  parkDelivery(root, 'a', 'reused pid', '0001');
  fs.mkdirSync(claimsDir(root));
  const claim = path.join(claimsDir(root), `a.draining.${claimTag('idle')}`);
  fs.renameSync(agentDir(root, 'a'), claim);
  age(claim, 60 * 1000);
  assert.deepStrictEqual(drainPending(root, 'a', 'boot.1'), []);
  assert.deepStrictEqual(fs.readdirSync(claim), ['0001.json']);
  age(claim, 11 * 60 * 1000);
  assert.deepStrictEqual(drainPending(root, 'a', 'boot.1'), ['reused pid']);
  assert.deepStrictEqual(fs.readdirSync(claimsDir(root)), []);
});

test('a park sitting in a claim dir counts for allParkedTexts and parkIdInUse', () => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  parkDelivery(root, 'x', 'in .claims', '1736900000000.000000001', 'abc12');
  parkDelivery(root, 'y', 'in legacy root claim', '1736900000000.000000002', 'def34');
  fs.mkdirSync(claimsDir(root));
  fs.renameSync(agentDir(root, 'x'), path.join(claimsDir(root), 'x.draining.idle.999999'));
  fs.renameSync(agentDir(root, 'y'), path.join(root, 'y.draining.idle.999999'));
  assert.deepStrictEqual(allParkedTexts(root).sort(), ['in .claims', 'in legacy root claim']);
  assert.strictEqual(parkIdInUse(root, 'abc12'), true);
  assert.strictEqual(parkIdInUse(root, 'def34'), true);
  assert.strictEqual(parkIdInUse(root, 'zzz99'), false);
});

test("_dropPendingDir removes the seat's pending dir and its claims, and leaves a look-alike seat's", () => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  const claims = claimsDir(root);
  for (const d of ['a', 'ab', '.claims/a.draining.idle.1', '.claims/a.draining.hook.2', '.claims/ab.draining.idle.3', 'a.draining.idle.4']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, d, 'm0.json'), JSON.stringify({ text: d }));
  }
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    PENDING_DIR: root,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    fs,
    path,
    resolveTeam: () => null,
    findProjectRoot: () => null,
  });
  new SessionManager()._dropPendingDir('a');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.claims', 'ab']);
  assert.deepStrictEqual(fs.readdirSync(claims), ['ab.draining.idle.3']);
});

function mkDropManager(root) {
  const SessionManager = createSessionManager({
    knownSkillNames: () => [],
    PENDING_DIR: root,
    getRemoteServer: () => null,
    getUiSettings: () => ({ get: () => ({}) }),
    getPersistence: () => ({ list: () => [], get: () => null }),
    notifyOS: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    fs,
    path,
    resolveTeam: () => null,
    findProjectRoot: () => null,
  });
  return new SessionManager();
}

test("_dropPendingDir leaves a seat named a.draining.idle.5-ab and removes a's legacy root claim and its .claims/ entry", () => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  parkDelivery(root, 'a.draining.idle.5-ab', 'look-alike seat', '0001');
  for (const d of ['a.draining.idle.5', '.claims/a.draining.idle.5-ab']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, d, 'm0.json'), JSON.stringify({ text: d }));
  }
  mkDropManager(root)._dropPendingDir('a');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['.claims', 'a.draining.idle.5-ab']);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'a.draining.idle.5-ab')), ['0001.json']);
  assert.deepStrictEqual(fs.readdirSync(claimsDir(root)), []);
});

test('drainPending freshens a pending dir parked more than CLAIM_STALE_MS ago before renaming it into a claim', (t) => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  parkDelivery(root, 'a', 'old mail', '0001');
  age(agentDir(root, 'a'), CLAIM_STALE_MS + 60 * 1000);
  const ages = [];
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (src === agentDir(root, 'a')) ages.push(Date.now() - fs.statSync(src).mtimeMs);
    return rename(src, dest);
  });
  assert.deepStrictEqual(drainPending(root, 'a', 'boot.1'), ['old mail']);
  assert.strictEqual(ages.length, 1);
  assert.ok(ages[0] < CLAIM_STALE_MS, `source mtime was ${ages[0]}ms old at rename`);
});

test('rehomeOrphans freshens the aged claim it takes before renaming it', (t) => {
  const root = mkTmpRoot('clodex-claims-orphans-');
  fs.mkdirSync(claimsDir(root));
  const orphan = path.join(claimsDir(root), 'a.draining.idle.999999');
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, '0001.json'), JSON.stringify({ text: 'orphaned' }));
  age(orphan, CLAIM_STALE_MS + 60 * 1000);
  const ages = [];
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (src, dest) => {
    if (src === orphan) ages.push(Date.now() - fs.statSync(src).mtimeMs);
    return rename(src, dest);
  });
  assert.deepStrictEqual(drainPending(root, 'a', 'boot.1'), ['orphaned']);
  assert.strictEqual(ages.length, 1);
  assert.ok(ages[0] < CLAIM_STALE_MS, `orphan mtime was ${ages[0]}ms old at rename`);
});
