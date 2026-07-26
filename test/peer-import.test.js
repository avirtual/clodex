// Run: node --test
// Covers peer-import.js — the contexts→peers direction (t32 step 4), the mirror
// of cli/src/import.js. Two things it pins that nothing else can:
//
//   * the REFUSALS, each of which exists for a reason the message has to carry
//     (a tunnel argv is code; an ECS family needs two awaited aws calls the
//     synchronous tunnel supervisor cannot make);
//   * that an imported record actually SURVIVES the peer store. az has no
//     destination-field syntax in the Peers dialog, so this path is its only
//     route into a peer record — an az block that the store silently dropped
//     would leave the kind stored-but-unreachable with no test to say so. The az
//     case here therefore goes through a REAL initStores round-trip, not a
//     mocked one.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { initStores } = require('../stores');
const {
  classifyEntry, sameDestination, collectCandidates, loadContexts, applyCandidates,
} = require('../peer-import');

// Deterministic ids so a candidate can be located by id in a read-back.
function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function storeOf(contexts) { return { current: null, contexts }; }

function byName(cands, name) {
  const c = cands.find((x) => x.name === name);
  assert.ok(c, `no candidate named ${name} (got ${cands.map((x) => x.name).join(', ')})`);
  return c;
}

test('peer-import: a tunnel argv is refused, never imported (never-tunnel, the other direction)', () => {
  const c = byName(collectCandidates(storeOf({
    box: { tunnel: ['ssh', '-L', '{port}:127.0.0.1:7900', 'host'], token: 't' },
  }), []), 'box');
  assert.strictEqual(c.action, 'skip');
  assert.strictEqual(c.peer, undefined, 'a refused entry must produce no peer record at all');
  assert.ok(c.reason, 'a refusal must carry a reason');
  assert.match(c.reason, /tunnel/i);
});

test('peer-import: an ssm ECS family is refused, and the message names clodexctl + a concrete target', () => {
  const c = byName(collectCandidates(storeOf({
    fleet: { ssm: { ecs: 'my-cluster/my-family', region: 'eu-west-1' } },
  }), []), 'fleet');
  assert.strictEqual(c.action, 'skip');
  assert.ok(c.reason, 'a refusal must carry a reason');
  // Both halves matter: WHY it cannot be a peer, and WHAT does support it.
  assert.match(c.reason, /concrete .*target/i);
  assert.match(c.reason, /clodexctl/);
});

test('peer-import: an ssm entry with a concrete target IS imported', () => {
  const c = byName(collectCandidates(storeOf({
    prod: { ssm: { target: 'i-0abc123', region: 'eu-west-1' } },
  }), [], { makeId: ids() }), 'prod');
  assert.strictEqual(c.action, 'add', c.reason || '');
  assert.deepStrictEqual(c.peer.ssm, { target: 'i-0abc123', region: 'eu-west-1' });
});

test('peer-import: an ssh host outside the peer charset is refused', () => {
  const cands = collectCandidates(storeOf({
    good: { ssh: 'user@laptop2' },
    bad: { ssh: 'host with spaces' },
  }), [], { makeId: ids() });
  assert.strictEqual(byName(cands, 'good').action, 'add');
  const bad = byName(cands, 'bad');
  assert.strictEqual(bad.action, 'skip');
  assert.ok(bad.reason);
  assert.match(bad.reason, /ssh host/i);
});

test('peer-import: a url that is not http(s) is refused', () => {
  const c = byName(collectCandidates(storeOf({
    weird: { url: 'ftp://example.invalid/' },
  }), []), 'weird');
  assert.strictEqual(c.action, 'skip');
  assert.ok(c.reason);
  assert.match(c.reason, /http/i);
});

// az's ONLY route into a peer record. A block that the store dropped would leave
// the kind accepted-but-unreachable, so this asserts survival through the real
// sanitizePeers, not just the shape peer-import produced.
test('peer-import: an az context imports WHOLE and survives a real ui-settings round-trip', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'peerimp-ud-'));
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerimp-reg-'));
  try {
    const { uiSettings } = initStores(userData, {
      log: console, registryDir, resourcesDir: path.join(registryDir, '__no_seed__'),
    });
    const az = {
      bastion: 'bastion-1',
      resourceGroup: 'rg-prod',
      target: '/subscriptions/abc/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm1',
    };
    const c = byName(collectCandidates(storeOf({ azbox: { az, token: 'sekrit' } }), [], { makeId: ids() }), 'azbox');
    assert.strictEqual(c.action, 'add', c.reason || '');

    uiSettings.set({ peers: applyCandidates([], [c]) });
    const saved = (uiSettings.get().peers || []).find((p) => p.label === 'azbox');
    assert.ok(saved, 'the imported az peer must survive sanitizePeers');
    assert.deepStrictEqual(saved.az, az, 'every az field must survive the store round-trip');
    assert.strictEqual(saved.token, 'sekrit', 'the imported token must persist');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(registryDir, { recursive: true, force: true });
  }
});

test('peer-import: a context pointing at an EXISTING peer skips as "already a peer"', () => {
  const cands = collectCandidates(
    storeOf({ prod: { ssh: 'box1' } }),
    [{ id: 'p1', label: 'My Box', sshHost: 'box1' }],
  );
  const c = byName(cands, 'prod');
  assert.strictEqual(c.action, 'skip');
  assert.ok(c.reason);
  assert.match(c.reason, /already a peer/);
  assert.match(c.reason, /My Box/, 'name the peer it collides with, so the operator can tell which');
});

// Not just collisions with EXISTING peers: two contexts can name one box, and
// importing both in a single pass would make a duplicate no later run could
// tell apart (both would then be "already a peer" against each other).
test('peer-import: two contexts naming the same box → the second skips (staged collision)', () => {
  const cands = collectCandidates(storeOf({
    aaa: { ssm: { target: 'i-0abc', region: 'eu-west-1' } },
    bbb: { ssm: { target: 'i-0abc', region: 'eu-west-1' } },
  }), [], { makeId: ids() });
  assert.strictEqual(byName(cands, 'aaa').action, 'add');
  const second = byName(cands, 'bbb');
  assert.strictEqual(second.action, 'skip', 'the second context for one box must not import a duplicate');
  assert.ok(second.reason);
  assert.match(second.reason, /already a peer/);
});

test('peer-import: a differing cloud field is a DIFFERENT destination', () => {
  const cands = collectCandidates(storeOf({
    aaa: { ssm: { target: 'i-0abc', region: 'eu-west-1' } },
    bbb: { ssm: { target: 'i-0abc', region: 'us-east-1' } },
  }), [], { makeId: ids() });
  assert.strictEqual(byName(cands, 'aaa').action, 'add');
  assert.strictEqual(byName(cands, 'bbb').action, 'add', 'a different region is a different box');
});

test('peer-import: a url peer and an ssh peer are not the same destination', () => {
  assert.strictEqual(sameDestination({ url: 'http://x/' }, { sshHost: 'x' }), false);
  assert.strictEqual(sameDestination({ url: 'http://x/' }, { url: 'http://x/' }), true);
  assert.strictEqual(sameDestination({ sshHost: 'x' }, { sshHost: 'y' }), false);
});

// The token is the reason this whole path runs main-side. The candidate the
// renderer sees is derived from this shape by dropping `peer` — so the value
// must live ONLY there, and tokenState must carry the fact without it.
test('peer-import: the token rides on `peer` only; the candidate itself reports state', () => {
  const c = byName(collectCandidates(storeOf({
    prod: { url: 'https://box.example/', token: 'sekrit' },
  }), [], { makeId: ids() }), 'prod');
  assert.strictEqual(c.tokenState, 'set');
  assert.strictEqual('token' in c, false, 'the candidate must not carry a token value');
  assert.strictEqual(c.peer.token, 'sekrit');
  // What the IPC preview actually sends: the same object minus `peer`.
  const { peer, ...wire } = c;
  assert.strictEqual(JSON.stringify(wire).includes('sekrit'), false, 'no token value may cross to the renderer');
});

test('peer-import: no token → tokenState none and no token key on the peer', () => {
  const c = byName(collectCandidates(storeOf({
    prod: { url: 'https://box.example/' },
  }), [], { makeId: ids() }), 'prod');
  assert.strictEqual(c.tokenState, 'none');
  assert.strictEqual('token' in c.peer, false);
});

test('peer-import: an integer remotePort is carried; a junk one is not', () => {
  const cands = collectCandidates(storeOf({
    a: { ssh: 'box1', remotePort: 7999 },
    b: { ssh: 'box2', remotePort: 'nope' },
  }), [], { makeId: ids() });
  assert.strictEqual(byName(cands, 'a').peer.remotePort, 7999);
  assert.strictEqual('remotePort' in byName(cands, 'b').peer, false);
});

test('peer-import: the context NAME becomes the peer label', () => {
  const c = byName(collectCandidates(storeOf({
    'prod-eu': { ssh: 'box1' },
  }), [], { makeId: ids() }), 'prod-eu');
  assert.strictEqual(c.peer.label, 'prod-eu');
});

test('peer-import: classifyEntry names the kind for each importable transport', () => {
  assert.strictEqual(classifyEntry({ url: 'https://x/' }).kind, 'url');
  assert.strictEqual(classifyEntry({ ssh: 'x' }).kind, 'ssh');
  assert.strictEqual(classifyEntry({ kubectl: { target: 'svc/x' } }).kind, 'kubectl');
  assert.strictEqual(classifyEntry({ gcloud: { instance: 'vm1' } }).kind, 'gcloud');
  const none = classifyEntry({});
  assert.strictEqual(none.kind, null);
  assert.ok(none.reason);
});

test('peer-import: a cloud block missing a required field is refused, naming the field', () => {
  const c = byName(collectCandidates(storeOf({
    half: { az: { bastion: 'b1' } },
  }), []), 'half');
  assert.strictEqual(c.action, 'skip');
  assert.ok(c.reason);
  assert.match(c.reason, /resourceGroup/);
  assert.match(c.reason, /target/);
});

test('peer-import: applyCandidates appends only the named adds, leaving existing peers untouched', () => {
  const existing = [{ id: 'p1', label: 'kept', sshHost: 'box9' }];
  const cands = collectCandidates(storeOf({
    a: { ssh: 'box1' }, b: { ssh: 'box2' },
  }), existing, { makeId: ids() });
  const next = applyCandidates(existing, cands, { names: ['b'] });
  assert.deepStrictEqual(next.map((p) => p.label), ['kept', 'b']);
  // And with no filter, every add lands.
  assert.deepStrictEqual(applyCandidates(existing, cands).map((p) => p.label), ['kept', 'a', 'b']);
});

test('peer-import: loadContexts on a missing file is an empty store, not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerimp-ctx-'));
  try {
    const res = loadContexts({ file: path.join(dir, 'nope.json') });
    assert.strictEqual(res.error, undefined);
    assert.deepStrictEqual(res.store.contexts, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('peer-import: loadContexts surfaces the CLI loader warning rather than swallowing it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerimp-ctx-'));
  const file = path.join(dir, 'contexts.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ current: null, contexts: { a: { url: 'https://x/' } } }));
    fs.chmodSync(file, 0o644);
    const warnings = [];
    const res = loadContexts({ file, warn: (m) => warnings.push(m) });
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(warnings.length, 1, 'a group/world-readable token file must warn');
    assert.match(warnings[0], /chmod 600/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('peer-import: malformed JSON is reported as an error, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peerimp-ctx-'));
  const file = path.join(dir, 'contexts.json');
  try {
    fs.writeFileSync(file, '{not json');
    const res = loadContexts({ file });
    assert.ok(res.error, 'a malformed contexts file must report an error');
    assert.match(res.error, /JSON/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
