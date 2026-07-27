'use strict';
// contexts.test.js — the contexts store: parse/validate, 0600 create + mode
// warn, and the file<env<flags resolution precedence (incl. url-switches-to-
// direct and independent token overlay).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/contexts');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  return path.join(d, 'contexts.json');
}

test('load of an absent file returns an empty store', () => {
  const store = C.load(path.join(os.tmpdir(), 'does-not-exist-xyz', 'c.json'));
  assert.deepStrictEqual(store, { current: null, contexts: {} });
});

test('save writes 0600 and round-trips', () => {
  const f = tmpFile();
  C.save({ current: 'home', contexts: { home: { url: 'http://h', token: 't' } } }, f);
  const mode = fs.statSync(f).mode & 0o777;
  assert.strictEqual(mode, 0o600);
  const back = C.load(f, { warn: () => {} });
  assert.strictEqual(back.current, 'home');
  assert.strictEqual(back.contexts.home.url, 'http://h');
});

test('loose mode triggers a warning', () => {
  const f = tmpFile();
  C.save({ current: null, contexts: {} }, f);
  fs.chmodSync(f, 0o644);
  let warned = '';
  C.load(f, { warn: (m) => { warned = m; } });
  assert.match(warned, /group\/world-readable/);
});

test('invalid JSON is a usage error', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not json');
  assert.throws(() => C.load(f, { warn: () => {} }), /not valid JSON/);
});

test('validateEntry: exactly one transport, {port} required for tunnel', () => {
  assert.throws(() => C.validateEntry({}), /needs one transport/);
  assert.throws(() => C.validateEntry({ url: 'http://h', ssh: 'x' }), /conflicting transports/);
  assert.throws(() => C.validateEntry({ tunnel: ['kubectl'] }), /\{port\} placeholder/);
  assert.throws(() => C.validateEntry({ tunnel: [] }), /non-empty argv/);
  C.validateEntry({ url: 'http://h' });
  C.validateEntry({ tunnel: ['x', '{port}:7900'] });
});

const STORE = { current: 'home', contexts: {
  home: { url: 'http://127.0.0.1:7900', token: 'homeTok' },
  work: { ssh: 'user@box', remotePort: 7900, token: 'workTok' },
} };

test('resolve: current context, no env/flags', () => {
  const r = C.resolve(STORE, { env: {} });
  assert.strictEqual(r.url, 'http://127.0.0.1:7900');
  assert.strictEqual(r.token, 'homeTok');
  assert.strictEqual(r.name, 'home');
});

test('resolve: --ctx overrides current', () => {
  const r = C.resolve(STORE, { ctxName: 'work', env: {} });
  assert.strictEqual(r.ssh, 'user@box');
  assert.strictEqual(r.token, 'workTok');
});

test('resolve: unknown --ctx is a usage error', () => {
  assert.throws(() => C.resolve(STORE, { ctxName: 'nope', env: {} }), /no such context/);
});

test('resolve: env URL switches transport to direct, drops file ssh', () => {
  const r = C.resolve(STORE, { ctxName: 'work', env: { CLODEX_URL: 'http://env-host:1' } });
  assert.strictEqual(r.url, 'http://env-host:1');
  assert.strictEqual(r.ssh, undefined);
  // token still comes from the file entry? No — env URL replaced the entry.
});

test('resolve: env token overlays without changing transport', () => {
  const r = C.resolve(STORE, { env: { CLODEX_TOKEN: 'envTok' } });
  assert.strictEqual(r.url, 'http://127.0.0.1:7900');
  assert.strictEqual(r.token, 'envTok');
});

test('resolve: flags beat env and file; --url forces direct', () => {
  const r = C.resolve(STORE, {
    env: { CLODEX_URL: 'http://env', CLODEX_TOKEN: 'envTok' },
    flags: { url: 'http://flag', token: 'flagTok' },
  });
  assert.strictEqual(r.url, 'http://flag');
  assert.strictEqual(r.token, 'flagTok');
  assert.strictEqual(r.name, '(flags)');
});

test('resolve: no context anywhere is a usage error', () => {
  assert.throws(() => C.resolve({ current: null, contexts: {} }, { env: {} }), /no context selected/);
});

test('resolve: --url and --ssh together is rejected, not silently ordered', () => {
  assert.throws(
    () => C.resolve(STORE, { env: {}, flags: { url: 'http://flag', ssh: 'user@box' } }),
    /either --url or --ssh, not both/);
});

// ── t54: the deploy-flavor record ────────────────────────────────────────────
//
// `upgrade <ctx>` cannot route without knowing which flavor built the node, and
// the transport cannot answer it: the ssh flavor and a REMOTE-DOCKER deploy
// both save `{ssh: user@host}`. Ambiguous by construction — hence a field.

test('validateEntry: a deploy record is accepted, and is OPTIONAL (old ctxs need no migration)', () => {
  // The no-migration property, stated as a test: every context written before
  // this field existed still validates. A consumer that needs the flavor must
  // say what it cannot determine rather than guess.
  assert.doesNotThrow(() => C.validateEntry({ ssh: 'user@box' }));
  assert.doesNotThrow(() => C.validateEntry({ ssh: 'user@box', deploy: { flavor: 'ssh', host: 'user@box' } }));
  assert.doesNotThrow(() => C.validateEntry({
    kubectl: { target: 'svc/n', namespace: 'clodex' },
    deploy: { flavor: 'helm', release: 'n', namespace: 'clodex', kubeContext: 'docker-desktop' },
  }));
  // Every case here goes through validateEntry, never a direct validateDeploy:
  // the per-kind validators are private by rule (test/stores.test.js pins the
  // export list), and reaching past the one door in a test is how the next
  // person justifies exporting it in product code.
});

test('validateDeploy: an UNKNOWN flavor is carried, not rejected (t55) — but a malformed one is', () => {
  // t55 reversed t54's enum check, on blast radius. validateEntry gates EVERY
  // verb, so rejecting a flavor string this build doesn't know would make a
  // context written by a NEWER clodexctl unusable for `sessions`, `web`,
  // `ctx test` — against a node that is up and whose TRANSPORT this build
  // understands perfectly. A working context killed by an advisory field only
  // one verb reads. The refusal belongs at `upgrade` (which does dispatch on
  // it), and cli/test/upgrade.test.js pins that it happens there.
  assert.doesNotThrow(() => C.validateEntry({ ssh: 'h', deploy: { flavor: 'kubernetes' } }),
    'a flavor this build cannot route must still be STORED and carried — refusing it here would take down every verb that never reads the field, against a node that is perfectly reachable');
  // SHAPE stays strict — that is the half that makes DATA-not-CODE mechanical.
  assert.throws(() => C.validateEntry({ ssh: 'h', deploy: { release: 'n' } }),
    /"deploy" needs a non-empty string flavor/,
    'a deploy record with no flavor at all must be rejected — the names are meaningless without the flavor that interprets them, so it is malformed rather than forward-compatible');
  assert.throws(() => C.validateEntry({ ssh: 'h', deploy: { flavor: '' } }),
    /"deploy" needs a non-empty string flavor/,
    'an EMPTY flavor is the missing case wearing a different shape, and must be rejected the same way');
  assert.throws(() => C.validateEntry({ ssh: 'h', deploy: { flavor: 7 } }),
    /"deploy" needs a non-empty string flavor/,
    'a non-string flavor must be rejected before the scalar loop accepts it as a legal number — a consumer would compare it against flavor names and silently match nothing');
  assert.throws(() => C.validateEntry({ ssh: 'h', deploy: 'helm' }),
    /"deploy" must be an object/,
    'a bare string must be rejected rather than treated as a flavor by convention');
});

test('validateDeploy: an argv CANNOT fit through the shape — arrays and blobs are rejected', () => {
  // The constraint is "store DATA, not CODE", and the scalar rule is what makes
  // that mechanical rather than a convention someone has to remember: an argv is
  // an ARRAY and a flag blob is an OBJECT, so both are refused by the shape
  // itself. This file is user-editable, and a persisted argv is a command line
  // the tool would later execute.
  assert.throws(
    () => C.validateEntry({ ssh: 'h', deploy: { flavor: 'helm', argv: ['helm', 'upgrade', '--install', 'n'] } }),
    /"deploy\.argv" must be a scalar .*got an array — "deploy" records identifying NAMES, never an argv/,
    'a persisted ARGV was accepted — that is a command line the tool would later execute, sitting in a user-editable file; the scalar rule is what makes "data, not code" mechanical instead of a convention');
  assert.throws(
    () => C.validateEntry({ ssh: 'h', deploy: { flavor: 'helm', flags: { set: 'image.tag=4.5.0' } } }),
    /"deploy\.flags" must be a scalar .*got object/,
    'an opaque blob of flags-to-re-run was accepted — same defect as an argv, one indirection away');
  // scalars of every stripe are fine, and a null field is simply absent.
  assert.doesNotThrow(() => C.validateEntry({
    ssh: 'h', deploy: { flavor: 'ssm', target: 'i-1', port: 7900, persistent: true, region: null },
  }));
});

test('validateDeploy: an ssh-flavor and a docker-flavor context are DISTINGUISHABLE (the whole point)', () => {
  // Byte-identical transports. Before this field the only difference was
  // nothing — which is why an upgrade would have had to guess between re-running
  // the installer and pulling a new container image.
  const sshCtx = { ssh: 'user@box', webPort: 7901, deploy: { flavor: 'ssh', host: 'user@box' } };
  const dockerCtx = { ssh: 'user@box', deploy: { flavor: 'docker', container: 'clodexctl-edge', dockerHost: 'ssh://user@box' } };
  assert.strictEqual(sshCtx.ssh, dockerCtx.ssh, 'premise: the transports really are identical');
  assert.doesNotThrow(() => C.validateEntry(sshCtx));
  assert.doesNotThrow(() => C.validateEntry(dockerCtx));
  assert.notStrictEqual(sshCtx.deploy.flavor, dockerCtx.deploy.flavor,
    'the flavor is the only thing that tells these two apart — if this ever fails, upgrade routing is guessing again');
  assert.strictEqual(dockerCtx.deploy.container, 'clodexctl-edge',
    'and the docker record carries the container name, which the ctx key alone does not give you');
});
