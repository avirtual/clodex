'use strict';
// ctl-service.test.js — the drawer's clodexctl REPL service. What is pinned
// here is the part that is NOT the pane: the allowlist, the block shape the
// tenant renders, and the injected io set that keeps a verb from reaching the
// main process's stdio.
//
// The allowlist is a SLIP GUARD, not a containment boundary, and the tests
// below should not be read as security pins. `exec` is admitted, so
// `exec box "clodexctl delete session x --force"` is typeable — nothing in this table
// contains what the operator can reach.
//
// The wire verbs (info/get/query/subresource reads) are deliberately NOT exercised
// against a live node — that is cli/test's job and it needs a server. Every
// test here runs on paths that stop before the transport opens, which is also
// where every containment decision is made.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCtlService, tokenize, refuse, isNodeLine, ALLOWED, DEFERRED_HINT, NODE_LOCAL_VERBS, MAX_BLOCK_CHARS } = require('../ctl-service');
const { VERB_REGISTRY } = require('../cli/src/help');
const R = require('../cli/src/resources');
const { mkTmpRoot } = require('./lib/tmp-roots');
const { RESOURCES_DOC } = require('../cli/test/fixtures/resources-doc');

function servesResources(req, res) {
  if (req.url.split('?')[0] !== '/api/resources') return false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(RESOURCES_DOC));
  return true;
}

function tmpCtxFile() {
  const dir = mkTmpRoot('clx-ctl-');
  return path.join(dir, 'contexts.json');
}

// A service with an EMPTY env: the real process env may carry CLODEX_URL /
// CLODEX_TOKEN, which would resolve a context out from under the "no context"
// tests and make them pass for the wrong reason (or dial a real node).
function mkService(file = tmpCtxFile()) {
  return { svc: createCtlService({ contextsFile: file, env: {} }), file };
}

test('tokenize: quotes, escapes, and the shell things it is NOT', () => {
  assert.deepStrictEqual(tokenize('sessions'), ['sessions']);
  assert.deepStrictEqual(tokenize('  query   --kind  foo  '), ['query', '--kind', 'foo']);
  assert.deepStrictEqual(tokenize('query "two words" \'and more\''), ['query', 'two words', 'and more']);
  assert.deepStrictEqual(tokenize('a "b\\"c"'), ['a', 'b"c']);
  // An empty quoted string is an ARGUMENT, not nothing — dropping it would
  // silently shift every positional after it left by one.
  assert.deepStrictEqual(tokenize('describe node ""'), ['describe', 'node', '']);
  // No shell: these are literal bytes in one token, never operators. The line
  // never reaches a shell, and this is what says so.
  assert.deepStrictEqual(tokenize('sessions;rm'), ['sessions;rm']);
  assert.deepStrictEqual(tokenize('a|b'), ['a|b']);
  assert.deepStrictEqual(tokenize('$(whoami)'), ['$(whoami)']);
  assert.deepStrictEqual(tokenize('a&&b'), ['a&&b']);
  assert.throws(() => tokenize('query "unbalanced'), /unbalanced/);
});

test('refuse: the allowlist admits the block-shaped verbs and no others', () => {
  // ENTER: the allowed verbs really are allowed — without this row every
  // refusal assertion below would also hold for a service that refuses
  // everything, which is a containment that ships a useless tab.
  for (const argv of [['info'], ['get', 'sessions'], ['describe', 'session', 'a'], ['api-resources'], ['version'],
    ['query', '--kind', 'x'], ['use', 'node', 'p'], ['get', 'nodes'], ['delete', 'node', 'p'],
    ['get', 'session', 'n', '--subresource', 'args'], ['patch', 'session', 'n'], ['exec', 'a', 'ls'], ['dm', 'a', 'hi'],
    ['input', 'a', 'x'], ['create', 'session', 'a'], ['restart', 'session', 'a'], ['logs', 'a']]) {
    assert.strictEqual(refuse(argv), null, `${argv.join(' ')} must be allowed`);
  }
  // The refused set, named one by one rather than by a loop over a list that
  // could itself drift. Each fails the SHAPE test, not a mutation test: a live
  // terminal, a server, a long child, or an irreversible act whose confirmation
  // prompt cannot run in a pane that has no way to ask.
  for (const argv of [['attach', 'a'], ['delete', 'session', 'a'], ['restart', 'node'],
    ['deploy', 'h'], ['undeploy', 'h'], ['upgrade', 'h'], ['port-forward'], ['web']]) {
    assert.match(String(refuse(argv)), /^refused:/, `${argv.join(' ')} must be refused`);
  }
  assert.strictEqual(refuse([]), null, 'an empty line is not a refusal');
  // The table is the contract; a verb silently gaining `true` here widens the
  // runner. Assert the WHOLE object, not a spot check.
  assert.deepStrictEqual({ ...ALLOWED }, {
    info: true, get: true, describe: true, 'api-resources': true, version: true,
    query: true, logs: true,
    dm: true, input: true, exec: true, create: true, patch: true,
    restart: ['session', 'sessions'],
    delete: ['node', 'nodes'],
    use: true,
  });
});

test('every verb in help.js\'s registry is either allowed or named as deferred', () => {
  const registry = VERB_REGISTRY.map((e) => e.name).sort();
  assert.ok(registry.length >= 20,
    `ENTER: help.js's registry read back only ${registry.length} verbs — an empty read would make the equality below vacuous`);

  const allowed = Object.keys(ALLOWED);
  const deferred = DEFERRED_HINT.slice(DEFERRED_HINT.indexOf(':') + 1)
    .split(', ')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
  const covered = [...new Set([...allowed, ...deferred])].sort();

  assert.deepStrictEqual(covered, registry,
    'the ctl tab must account for every CLI verb: each one is either in ALLOWED or named in DEFERRED_HINT. '
    + 'A verb the CLI gained and this tab never mentions is invisible at the prompt — it neither runs nor explains itself.');
});

// The two irreversible engine-side verbs, called out on their own because the
// reason they stay refused is NOT "it mutates" — `restart session` and `create`
// mutate and are allowed. It is that neither can be confirmed here: the injected
// `prompt` rejects, so the only spelling that would reach the wire is the
// --force one, which turns a hard delete (no resume) and a whole-engine relaunch
// into a single unguarded Enter in a 12-line strip. `restart` is the sharp case:
// the SAME verb carries both, so the refusal keys on the resource WORD.
test('delete session and restart node stay refused even with --force', () => {
  for (const argv of [['delete', 'session', 'a'], ['delete', 'session', 'a', '--force'],
    ['restart', 'node'], ['restart', 'node', '--force']]) {
    assert.match(String(refuse(argv)), /^refused:/, `${argv.join(' ')} must be refused`);
  }
  // ENTER, and it is the whole point of this test: the neighbouring mutating
  // verbs DO run, so this is a targeted refusal and not a service that happens
  // to refuse everything with a dangerous-sounding name.
  assert.strictEqual(refuse(['restart', 'session', 'a']), null, 'restart session (resumable) is allowed');
  assert.strictEqual(refuse(['restart', 'sessions', 'a']), null, 'the plural spelling resolves the same way');
  assert.strictEqual(refuse(['create', 'session', 'a']), null, 'create session is allowed');
  assert.strictEqual(refuse(['delete', 'node', 'a']), null, 'delete node forgets a local record');
  assert.strictEqual(refuse(['delete', 'nodes', 'a']), null, 'the plural spelling resolves the same way');
});

test('run: a refused verb is a block, and never opens a transport', async () => {
  // `delete` rather than a read-only verb: the gate must stop it BEFORE
  // wireFor(), and a service that gated after the dial would still produce a
  // refusal block — just one that had already resolved a context and opened a
  // transport on the way. The injected openTransport throws, so a dial fails
  // loudly instead of passing quietly.
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: () => { throw new Error('DIALED — the gate ran after the transport'); },
  });
  const b = await svc.run('delete session somebox --force');
  assert.strictEqual(b.command, 'delete session somebox --force');
  assert.match(b.output, /refused: "delete session"/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

// Removed spellings reach this pane too and the pointer must win AHEAD of the gate,
// which would say "not available in the ctl tab" and hide that the verb is gone.
test('a removed spelling answers with the rename pointer, not the gate refusal', async () => {
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: () => { throw new Error('DIALED — a pointer must run nothing'); },
  });
  for (const [line, to] of [['kill somebox --force', 'delete session'], ['spawn w --type bash', 'create session'],
    ['run a ls', 'exec'], ['send a hi', 'dm'], ['restart-app --force', 'restart node']]) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 2, `${line}: ${b.output}`);
    assert.match(b.output, new RegExp(`was renamed: use clodexctl ${to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), line);
    assert.doesNotMatch(b.output, /refused:/, `${line} must point, not merely refuse`);
  }
  svc.dispose();
});

test('a leading flag moves the verb, and the gate follows it', async () => {
  const { svc } = mkService();
  // Both halves matter and they pull in opposite directions, which is why this
  // is one test. A gate reading the RAW argv sees `-o` in slot 0 for both
  // lines: it would refuse the legitimate one as a verb named "-o", and
  // judge the refusable one on a token that is not its verb.
  const bad = await svc.run('-o json delete session somebox --force');
  assert.match(bad.output, /refused: "delete session"/, 'the PARSED verb is what the gate judges');
  assert.strictEqual(bad.exitCode, 2);

  const ok = await svc.run('get nodes -o json');
  assert.doesNotMatch(ok.output, /refused/, '`-o json get nodes` is just `get nodes` with a flag');
  assert.strictEqual(ok.exitCode, 0);
  svc.dispose();
});

test('a line with no verb at all is refused, not dispatched on undefined', async () => {
  const { svc } = mkService();
  // `--tunnel` is greedy — it eats the rest of the line, leaving zero
  // positionals. Without an explicit check that reaches a handler lookup on
  // `undefined`, which throws somewhere less legible than here.
  const b = await svc.run('--tunnel ssh -L {port}:localhost:7900 host');
  assert.match(b.output, /no verb in that line/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('run: block shape is exactly what the tenant renders', async () => {
  const { svc } = mkService();
  const b = await svc.run('get nodes');
  assert.deepStrictEqual(Object.keys(b).sort(), ['command', 'ctx', 'exitCode', 'output', 'ts'].sort());
  assert.strictEqual(typeof b.output, 'string');
  assert.strictEqual(typeof b.exitCode, 'number');
  assert.ok(Number.isFinite(b.ts) && b.ts > 0, 'ts is a real timestamp');
  svc.dispose();
});

test('run: an empty line is a no-op block, not an error', async () => {
  const { svc } = mkService();
  const b = await svc.run('   ');
  assert.strictEqual(b.output, '');
  assert.strictEqual(b.exitCode, 0);
  svc.dispose();
});

test('run: an unparseable line reports itself instead of throwing', async () => {
  const { svc } = mkService();
  const b = await svc.run('query "unbalanced');
  assert.match(b.output, /unbalanced double quote/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('run: a renamed verb answers with the pointer in BOTH spellings, ahead of help routing', async () => {
  const { svc } = mkService();
  const bare = await svc.run('sessions');
  assert.strictEqual(bare.output, 'clodexctl: clodexctl sessions was renamed: use clodexctl get sessions\n');
  assert.strictEqual(bare.exitCode, 2);
  const helped = await svc.run('help sessions');
  assert.strictEqual(helped.output, 'clodexctl sessions was renamed: use clodexctl get sessions\n');
  assert.strictEqual(helped.exitCode, 1);
  const flagged = await svc.run('sessions --help');
  assert.strictEqual(flagged.output, 'clodexctl sessions was renamed: use clodexctl get sessions\n');
  assert.strictEqual(flagged.exitCode, 1);
  svc.dispose();
});

test('run: no context selected is a usage block, not a crash', async () => {
  const { svc } = mkService();
  const b = await svc.run('get sessions');
  assert.match(b.output, /no context selected/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('use node is STATEFUL across runs — the reason this is a REPL', async () => {
  const { svc, file } = mkService();
  const added = await svc.run('create node alpha --url http://alpha.example');
  assert.strictEqual(added.exitCode, 0, `ENTER: create node succeeded (${added.output})`);
  await svc.run('create node beta --url http://beta.example');
  assert.strictEqual((await svc.run('use node beta')).exitCode, 0);

  // The block's `ctx` is what the pane puts on its prompt line, so a switch
  // that did not reach it would leave the prompt lying about where the next
  // command goes.
  assert.strictEqual(svc.context(), 'beta');
  assert.strictEqual((await svc.run('get nodes')).ctx, 'beta');
  assert.strictEqual((await svc.run('use node alpha')).ctx, 'alpha');
  assert.strictEqual(svc.context(), 'alpha');

  // It really persisted — a service that only mutated memory would satisfy
  // every assertion above.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(onDisk.current, 'alpha');
  svc.dispose();
});

test('get nodes --current runs through the service, and NODE_LOCAL_VERBS is the local family', async () => {
  const { svc } = mkService();
  const none = await svc.run('get nodes --current');
  assert.strictEqual(none.exitCode, 5, 'no current node yet — EXIT.NOTFOUND');
  assert.match(none.output, /no current node/);
  assert.doesNotMatch(none.output, /refused/, 'the gate admits it before the local dispatch');

  await svc.run('create node alpha --url http://alpha.example');
  const b = await svc.run('get nodes --current');
  assert.strictEqual(b.exitCode, 0, `get nodes --current ran (${b.output})`);
  assert.strictEqual(b.output, 'alpha\n', 'the name alone, no refusal and no table');
  svc.dispose();

  assert.deepStrictEqual(NODE_LOCAL_VERBS, ['get', 'describe', 'create', 'delete', 'use']);
});

test('get node <name> --current is a usage error, not a silently ignored name', async () => {
  const { svc } = mkService();
  await svc.run('create node home --url http://home.example');
  await svc.run('create node work --url http://work.example');
  const b = await svc.run('get node home --current');
  assert.strictEqual(b.exitCode, 2, `expected USAGE, got ${b.exitCode}: ${b.output}`);
  assert.match(b.output, /--current prints the current node and takes no name/);
  assert.doesNotMatch(b.output, /^home$/m, 'it must not answer with a node name at all');
  const ok = await svc.run('get nodes --current');
  assert.strictEqual(ok.exitCode, 0, `ENTER: --current alone still prints (${ok.output})`);
  assert.strictEqual(ok.output, 'home\n');
  svc.dispose();
});

test('describe node redacts the token, and the block is scrubbed besides', async () => {
  const { svc } = mkService();
  await svc.run('create node prod --url http://prod.example --token SUPERSECRET');
  const b = await svc.run('describe node prod');
  assert.match(b.output, /name\s+prod/, 'ENTER: the entry really rendered');
  assert.doesNotMatch(b.output, /SUPERSECRET/, 'a token must never reach the renderer');
  svc.dispose();
});

// ---------------------------------------------------------------------------
// Token containment. Every test below failed before its fix (cold review found
// all three shipped green under the previous suite, which is why the passing
// `describe node` test above is not evidence of anything on its own).
// ---------------------------------------------------------------------------

// A transport seam that never dials. `fail` makes the dial throw with the token
// EMBEDDED IN THE MESSAGE — that is not contrived: openTransport relays an ssh
// or tunnel child's stderr verbatim, and the argv it failed on can carry
// `--token`. This is the path where scrubbing has to work by construction.
function fakeTransport({ fail = null } = {}) {
  const opened = [];
  const fn = async (ctx) => {
    opened.push(ctx);
    if (fail) throw new Error(fail(ctx));
    return { baseUrl: 'http://127.0.0.1:65535', close() {} };
  };
  fn.opened = opened;
  return fn;
}

test('MF2: get nodes -o json must not print the tokens it lists', async () => {
  const { svc } = mkService();
  await svc.run('create node prod --url http://prod.example --token SUPERSECRET');
  await svc.run('create node other --url http://other.example --token SECOND_TOKEN');
  const b = await svc.run('get nodes -o json');

  // ENTER: the listing really rendered. Without this the absences below are
  // equally true of a refusal, an empty store, or a crash.
  assert.strictEqual(b.exitCode, 0, `the listing succeeded (${b.output})`);
  const parsed = JSON.parse(b.output);
  assert.deepStrictEqual(parsed.nodes.map((n) => n.name).sort(), ['other', 'prod'], 'both entries present');
  assert.strictEqual(parsed.nodes.find((n) => n.name === 'prod').locator, 'http://prod.example',
    'the useful fields survive the projection');

  assert.doesNotMatch(b.output, /SUPERSECRET/, 'the current token must not reach the renderer');
  assert.doesNotMatch(b.output, /SECOND_TOKEN/, 'nor any OTHER stored token');
  // Dropped, not redacted — but the operator still learns a token is set.
  assert.strictEqual(parsed.nodes.find((n) => n.name === 'prod').tokenSet, true);
  assert.ok(!('token' in parsed.nodes.find((n) => n.name === 'prod')), 'no token key at all');
  svc.dispose();
});

test('MF2: the listing drops the token at the projection, not by scrubbing the output', async () => {
  // Two layers cover the listing: nodeRow's explicit-field projection, and the
  // output fold over every stored token. For a normal-length token they are
  // indistinguishable — both leave no token in the block — so the test above
  // stays green if the projection regresses to a `{token, ...rest}` spread, and
  // an unpinned layer is one a refactor removes as dead code. A token SHORTER
  // than MIN_SCRUBBABLE_TOKEN is the wedge: the fold deliberately skips it
  // (scrubbing a 3-char string would shred every block), which leaves the
  // projection as the only thing standing between it and the renderer.
  const { svc } = mkService();
  await svc.run('create node prod --url http://prod.example --token abc');
  const b = await svc.run('get nodes -o json');

  assert.strictEqual(b.exitCode, 0, `ENTER: the listing succeeded (${b.output})`);
  const parsed = JSON.parse(b.output);
  const row = parsed.nodes.find((n) => n.name === 'prod');
  assert.strictEqual(row.locator, 'http://prod.example', 'ENTER: the entry really rendered');
  assert.strictEqual(row.tokenSet, true, 'ENTER: the entry really carries a token');
  assert.doesNotMatch(b.output, /"abc"/, 'a short token is dropped at the projection or not at all');
  assert.deepStrictEqual(row.transport, { url: 'http://prod.example' }, 'the transport carries no token key');
  svc.dispose();
});

test('MF1: a token in an ERROR message is scrubbed from the block', async () => {
  const file = tmpCtxFile();
  const svc = createCtlService({
    contextsFile: file,
    env: {},
    openTransport: fakeTransport({ fail: (ctx) => `ssh: connect failed running: ssh -o Token=${ctx.token} host` }),
  });
  await svc.run('create node prod --url http://prod.example --token SUPERSECRET');
  const b = await svc.run('get sessions');

  assert.notStrictEqual(b.exitCode, 0, `ENTER: the dial really failed (${b.output})`);
  assert.match(b.output, /connect failed/, 'ENTER: the child message reached the block');
  assert.doesNotMatch(b.output, /SUPERSECRET/, 'a token relayed in a dial error must not reach the renderer');
  assert.match(b.output, /\*\*\*/, 'it was redacted rather than the whole message dropped');
  svc.dispose();
});

test('MF1: the scrub covers tokens the failing line never resolved', async () => {
  // The hole that made the original `finally` scrub dead BY CONSTRUCTION: it
  // read a `token` local that is still null when the dial itself throws, and
  // that the node path never set at all. Folding over the whole store is what
  // makes this case reachable — the leaked token here belongs to a DIFFERENT
  // context than the one being dialed.
  const svc = createCtlService({
    contextsFile: tmpCtxFile(),
    env: {},
    openTransport: fakeTransport({ fail: () => 'dial failed: OTHER_CTX_TOKEN appeared in a relayed argv' }),
  });
  await svc.run('create node other --url http://other.example --token OTHER_CTX_TOKEN');
  await svc.run('create node prod --url http://prod.example --token PROD_TOKEN');
  const b = await svc.run('get sessions --ctx prod');

  assert.match(b.output, /dial failed/, 'ENTER: the error really surfaced');
  assert.doesNotMatch(b.output, /OTHER_CTX_TOKEN/, 'every stored token is scrubbed, not just the resolved one');
  svc.dispose();
});

test('MF1 guard: a short or empty stored token does not redact everything', async () => {
  // A 1-char token folded in naively turns every block into asterisks — the
  // containment would destroy the tab rather than protect it.
  const svc = createCtlService({
    contextsFile: tmpCtxFile(),
    env: {},
    openTransport: fakeTransport({ fail: () => 'dial failed: e' }),
  });
  await svc.run('create node tiny --url http://tiny.example --token e');
  const b = await svc.run('get sessions');
  assert.match(b.output, /dial failed: e/, 'a short token is NOT folded into the scrub');
  svc.dispose();
});

test('MF3: a different token re-dials instead of reusing the warm client', async () => {
  // A real (loopback) node, because the reuse half of this invariant is only
  // observable on the SUCCESS path: the error path deliberately drops the warm
  // slot, so against a transport that cannot answer, every command re-dials and
  // "reuse" is untestable. The server also records the bearer it actually
  // received, which is the claim that matters — a warm client reused across a
  // token change sends the OLD bearer while the block's provenance says the new
  // one, and only the server can tell us which arrived.
  const http = require('node:http');
  const seenAuth = [];
  const server = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const opened = [];
  const transport = async (ctx) => { opened.push(ctx); return { baseUrl: base, close() {} }; };
  const svc = createCtlService({ contextsFile: tmpCtxFile(), env: {}, openTransport: transport });
  try {
    await svc.run('create node prod --url http://prod.example --token TOKEN_ONE_LONG');
    const first = await svc.run('get sessions');
    assert.strictEqual(first.exitCode, 0, `ENTER: the command really succeeded (${first.output})`);

    // Same URL, different bearer. Keying the token as 'set'/'none' made these
    // two keys identical, so the second reused a client bearing TOKEN_ONE.
    await svc.run('get sessions --token TOKEN_TWO_LONG');
    assert.strictEqual(opened.length, 2, 'a token change must force a re-dial');
    assert.strictEqual(opened[0].token, 'TOKEN_ONE_LONG', 'ENTER: the first dial used the stored token');
    assert.strictEqual(opened[1].token, 'TOKEN_TWO_LONG', 'the second dial carries the NEW token');
    assert.deepStrictEqual(seenAuth, ['Bearer TOKEN_ONE_LONG', 'Bearer TOKEN_TWO_LONG'],
      'each request arrived under the identity its line named');

    // The same token must still REUSE — a service that re-dials every command
    // is not a REPL, and would satisfy every assertion above.
    await svc.run('get sessions --token TOKEN_TWO_LONG');
    assert.strictEqual(opened.length, 2, 'an unchanged token reuses the warm transport');
    assert.strictEqual(seenAuth.length, 3, 'ENTER: the third command really went out');
  } finally {
    svc.dispose();
    await new Promise((r) => server.close(r));
  }
});

test('an empty verb is refused, not passed to a handler lookup', async () => {
  // `"" sessions` tokenizes to ['', 'sessions']. A `!verb` guard reads that as
  // an empty line and lets it through to a map lookup that finds nothing,
  // surfacing as "handler is not a function" from three frames down.
  const { svc } = mkService();
  const b = await svc.run('"" get sessions');
  assert.match(b.output, /refused/);
  assert.doesNotMatch(b.output, /is not a function/, 'it must not reach the handler map');
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('dispose latches — a late run cannot spawn a child during shutdown', async () => {
  const transport = fakeTransport();
  const svc = createCtlService({ contextsFile: tmpCtxFile(), env: {}, openTransport: transport });
  await svc.run('create node prod --url http://prod.example --token STORED_TOKEN');
  svc.dispose();

  const b = await svc.run('get sessions');
  assert.match(b.output, /shutting down/);
  // The claim that matters is not the message: it is that no dial happened. A
  // run() slipping past dispose re-dials and leaves an orphaned ssh/tunnel
  // child holding a local port, which is what engine.js's shutdown prevents.
  assert.strictEqual(transport.opened.length, 0, 'no transport may be opened after dispose');
});

test('run: commands serialize — the warm slot has one writer', async () => {
  const { svc } = mkService();
  // Fired without awaiting between them: if these interleaved, the second
  // could close a transport the first is mid-request on. Order out must match
  // order in.
  const [a, b, c] = await Promise.all([svc.run('get nodes'), svc.run('info'), svc.run('get nodes')]);
  assert.deepStrictEqual([a.command, b.command, c.command], ['get nodes', 'info', 'get nodes']);
  svc.dispose();
});

test('the service is electron-free — it must load in a plain node process', () => {
  // Not a require-shape grep: this is the actual load. ctl-service runs inside
  // the Electron main process today, but headless-main.js is a plain node
  // process, and a stray require('electron') there is a hard crash at boot
  // rather than a degraded tab.
  const src = fs.readFileSync(path.join(__dirname, '..', 'ctl-service.js'), 'utf-8');
  assert.doesNotMatch(src, /require\(['"]electron['"]\)/, 'ctl-service must not require electron');
  // The CLI modules it loads must be electron-free too, or the lazy require
  // moves the crash rather than preventing it.
  const svc = createCtlService({ contextsFile: tmpCtxFile(), env: {} });
  return svc.run('get nodes').then((b) => {
    assert.strictEqual(b.exitCode, 0, 'the cli tree loaded and ran');
    svc.dispose();
  });
});

// The construction the HOST uses, which no test above exercises: engine.js
// builds this service with `{}`, and every test here passes an explicit
// contextsFile. That gap shipped a service that reported "no context selected"
// against a present, correct ~/.clodex/cli/contexts.json — the destructuring
// default is `null`, the CLI resolves its default path through a PARAMETER
// default (`load(file = contextsPath())`) that only `undefined` triggers, and
// loadStore's catch turned the resulting throw into an empty store.
//
// Asserted against a REAL HOME rather than the operator's: the property is
// "an absent contextsFile resolves to <home>/.clodex/cli/contexts.json", and
// reading the developer's own store would make the test pass or fail on
// whatever contexts they happen to have.
test('an absent contextsFile falls back to the CLI default path, not null', async () => {
  const home = mkTmpRoot('clx-home-');
  fs.mkdirSync(path.join(home, '.clodex', 'cli'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.clodex', 'cli', 'contexts.json'),
    JSON.stringify({ current: 'fixture', contexts: { fixture: { url: 'http://127.0.0.1:9' } } }),
    { mode: 0o600 },
  );

  const realHome = os.homedir;
  os.homedir = () => home;
  try {
    // No contextsFile key at all — the host's exact shape.
    const svc = createCtlService({ env: {} });
    // ENTER: the fallback must actually have found the fixture store. Without
    // this, the block assertions below would also pass on a service that read
    // nothing and printed an empty table.
    assert.strictEqual(svc.context(), 'fixture', 'ENTER: the default path resolved to the fixture store');

    const b = await svc.run('get nodes');
    assert.strictEqual(b.exitCode, 0);
    assert.strictEqual(b.ctx, 'fixture');
    assert.match(b.output, /fixture/);
    assert.doesNotMatch(b.output, /no context selected/);
    svc.dispose();
  } finally {
    os.homedir = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Help is LOCAL rendering off help.js's registry — no context, no dial. It
// short-circuits ahead of the allowlist gate for the same reason main.js puts
// it ahead of context resolution, and the bug this pins is that the flag was
// simply not read: `get --help` ran the verb and returned live session
// data from whatever context was current.
test('--help short-circuits before the wire, for every help spelling', async () => {
  // openTransport THROWS: any path that reaches a dial fails this test loudly
  // rather than quietly succeeding against a context the developer happens to
  // have. That is the whole assertion — help must never get here.
  const dialed = [];
  const svc = createCtlService({
    contextsFile: tmpCtxFile(),
    env: {},
    openTransport: (ctx) => { dialed.push(ctx); throw new Error('DIALED — help must not open a transport'); },
  });

  for (const line of ['help', '--help', '-h', 'get --help', 'help use']) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 0, `${line} -> exit ${b.exitCode}: ${b.output}`);
    // ENTER: rendered help, not an empty block. An absence assertion below
    // ("never dialed") is equally true of a service that returned nothing.
    assert.match(b.output, /clodexctl|USAGE|^\w+ —/m, `ENTER: ${line} produced no help text`);
  }
  assert.deepStrictEqual(dialed, [], 'help opened a transport');
  svc.dispose();
});

test('help explains a verb the tab refuses to RUN', async () => {
  // The gate must not swallow the explanation: "why is attach refused here" is
  // a question only help answers, and refusing both leaves no way to find out.
  const { svc } = mkService();
  const b = await svc.run('attach --help');
  assert.strictEqual(b.exitCode, 0);
  assert.match(b.output, /^attach —/m);
  assert.doesNotMatch(b.output, /refused/);

  // …while the verb itself stays refused. Without this the test above would
  // pass on a build that dropped the allowlist entirely.
  const run = await svc.run('attach box');
  assert.strictEqual(run.exitCode, 2);
  assert.match(run.output, /refused: "attach" is not available/);
  svc.dispose();
});

// `logs` is allowed but `logs --follow` is not, and the refusal is on the FLAG.
// A verb-keyed gate cannot see it, so this lives past the gate in execute() —
// which is exactly why it needs its own test: nothing about the allowlist
// implies it, and follow would otherwise hold the command chain open forever
// while the pane showed a disabled input and no output.
test('logs --follow is refused, in every spelling, while plain logs is not', async () => {
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: () => { throw new Error('DIALED — follow must be refused before the wire'); },
  });
  // A context must EXIST, or the ENTER below cannot tell "the flag check let it
  // through" from "context resolution refused it first" — both produce a
  // non-follow error message and the test would pass without the check running.
  await svc.run('create node prod --url http://prod.example --token STORED_TOKEN_L');
  for (const line of ['logs bob --follow', 'logs bob -f', '--follow logs bob']) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 2, `${line} -> exit ${b.exitCode}: ${b.output}`);
    assert.match(b.output, /streams and never returns/, `${line} must name the reason`);
  }
  // ENTER, and it carries the test: plain `logs` must get PAST this check. It
  // then fails on the throwing transport, which is what proves the flag check
  // let it through rather than refusing every logs line.
  const plain = await svc.run('logs bob --tail 5');
  assert.doesNotMatch(plain.output, /streams and never returns/, 'plain logs must not hit the follow refusal');
  assert.match(plain.output, /DIALED/, 'ENTER: plain logs reached the transport, so the check is flag-scoped');
  svc.dispose();
});

test('get sessions -o yaml through the drawer prints YAML: the format reaches the printer execute() built before the line was parsed', async () => {
  const http = require('node:http');
  const payload = { ok: true, sessions: [{ name: 'bob', type: 'claude', cwd: '/w/one' }] };
  const server = http.createServer((req, res) => {
    if (servesResources(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: async () => ({ baseUrl: base, close() {} }),
  });
  try {
    await svc.run('create node prod --url http://prod.example --token STORED_TOKEN_L');
    const b = await svc.run('get sessions -o yaml');
    assert.strictEqual(b.exitCode, 0, `ENTER: the read ran (${b.output.slice(0, 200)})`);
    assert.strictEqual(b.output,
      'ok: true\n'
      + 'sessions:\n'
      + '  - name: bob\n'
      + '    type: claude\n'
      + '    cwd: /w/one\n');
    const j = await svc.run('get sessions -o json');
    assert.strictEqual(j.output, `${JSON.stringify(payload)}\n`, 'json on the same path is unchanged');
  } finally {
    svc.dispose();
    await new Promise((r) => server.close(r));
  }
});

// The block cap. Reachable only since the allowlist admitted `exec`/`run`:
// exec accumulates every output frame with no byte limit, so a plausible line
// (`exec box "cat big.log"`) arrives at done() as an unbounded string that then
// gets copied whole by a scrub pass per token, a structured clone over IPC, and
// an escaped DOM node — and retained in the pane's 200-block model. Driven
// through a real socket rather than by calling done() directly, because the
// claim is about what a COMMAND produces.
test('a huge block is capped, and says it was', async () => {
  const http = require('node:http');
  const huge = 'x'.repeat(MAX_BLOCK_CHARS * 2);
  const server = http.createServer((req, res) => {
    if (servesResources(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'bob', extraArgs: [huge] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: async () => ({ baseUrl: base, close() {} }),
  });
  try {
    await svc.run('create node prod --url http://prod.example --token STORED_TOKEN_L');
    const b = await svc.run('get session bob --subresource args');
    // ENTER: the command succeeded and produced the oversize output. Without
    // this, a service that errored early would satisfy the cap trivially.
    assert.strictEqual(b.exitCode, 0, `ENTER: the query ran (${b.output.slice(0, 200)})`);
    assert.ok(b.output.length > 1000, 'ENTER: real output came back, not an empty block');

    assert.ok(b.output.length <= MAX_BLOCK_CHARS + 200,
      `block is ${b.output.length} chars — the cap did not apply`);
    assert.match(b.output, /output truncated at 256KB/, 'a truncated block must say so');
  } finally {
    svc.dispose();
    await new Promise((r) => server.close(r));
  }
});

// The cap and the token scrub interact, and the interaction is the whole risk:
// scrub SHRINKS the string (each hit becomes '***'), so a token sitting past
// the cap before scrubbing can slide under it afterwards — and a cut landing
// mid-token leaves a PREFIX that scrub can no longer match. A cap applied
// naively (slice, then scrub, or scrub, then slice) leaks token bytes into a
// block that is then rendered, retained, and copied.
test('the cap never leaks token material, wherever the token sits', async () => {
  const http = require('node:http');
  const TOKEN = 'SUPERSECRETTOKENVALUE1234567890';

  // A SWEEP, not three chosen offsets, and that is what makes this test able to
  // fail. The leak needs the cut to land strictly inside the final token, a
  // window one token wide — and the payload's own JSON framing shifts every
  // position by an amount this test does not control, so any single guessed
  // offset lands in the window only by luck. Verified against a naive
  // implementation: it leaks 24-27 char prefixes at 4 offsets in this range and
  // is clean at the rest, so a fixture that guessed one offset would have
  // shipped a green test over a live leak.
  //
  // The EARLIER occurrences are the other half. Each scrubs to '***', pulling
  // everything after it left by (TOKEN.length - 3) — which is the only way a
  // token that sat past the cap can slide under it and be cut mid-way. With a
  // single occurrence nothing shifts and the naive version passes.
  const REPEATS = 1;
  const head = (TOKEN + 'w'.repeat(7)).repeat(REPEATS);
  const shrink = REPEATS * (TOKEN.length - 3);

  // The offset rides in the SESSION NAME (`off_m60` / `off_p20`), which lands
  // in the request path — a query string on the base URL would be concatenated
  // ahead of the API path and never reach the server as a query at all.
  const server = http.createServer((req, res) => {
    if (servesResources(req, res)) return;
    const m = /off_([mp])(\d+)/.exec(req.url);
    const off = m ? (m[1] === 'm' ? -Number(m[2]) : Number(m[2])) : 0;
    const at = MAX_BLOCK_CHARS + shrink + off;
    const payload = head + 'y'.repeat(Math.max(0, at - head.length)) + TOKEN + 'z'.repeat(4000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'bob', extraArgs: [payload] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let checked = 0;
  try {
    for (let off = -60; off <= 20; off++) {
      const svc = createCtlService({
        contextsFile: tmpCtxFile(), env: {},
        openTransport: async () => ({ baseUrl: base, close() {} }),
      });
      try {
        await svc.run(`create node prod --url http://prod.example --token ${TOKEN}`);
        const name = `off_${off < 0 ? 'm' : 'p'}${Math.abs(off)}`;
        const b = await svc.run(`get session ${name} --subresource args`);
        // ENTER, inside the loop: an iteration that errored would satisfy every
        // absence assertion below while testing nothing.
        assert.strictEqual(b.exitCode, 0, `ENTER (off=${off}): the command ran — ${b.output.slice(0, 160)}`);
        assert.ok(b.output.length > MAX_BLOCK_CHARS - 1000, `ENTER (off=${off}): a full-size block came back`);
        checked++;

        assert.doesNotMatch(b.output, new RegExp(TOKEN), `off=${off}: the whole token survived the cap`);
        // The sharper claim, and the reason done() cuts back by a token's width
        // AFTER scrubbing: not even a PREFIX may survive, since a prefix is
        // token material that scrub can no longer match.
        for (let n = 8; n < TOKEN.length; n++) {
          assert.ok(!b.output.includes(TOKEN.slice(0, n)),
            `off=${off}: a ${n}-char token prefix survived the cut`);
        }
      } finally {
        svc.dispose();
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  // ENTER on the reduction itself: the sweep really ran its whole range.
  assert.strictEqual(checked, 81, `expected 81 offsets checked, got ${checked}`);
});

// Reading and writing a session's args are now two different VERBS (`get …
// --subresource args` and `patch session`), so nothing routes on a subcommand any
// more. The risk is unchanged: a dispatcher that collapsed the two would turn a
// write into a read, with a plausible success block on screen. Driven against a
// real socket because the claim is about the REQUEST that leaves.
test('patch session and get --subresource args reach different handlers — the method proves it', async () => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
    if (servesResources(req, res)) return;
    seen.push(`${req.method} ${req.url.split('?')[0]}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'bob', extraArgs: [] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: async () => ({ baseUrl: base, close() {} }),
  });
  try {
    await svc.run('create node prod --url http://prod.example --token STORED_TOKEN_L');
    const get = await svc.run('get session bob --subresource args');
    assert.strictEqual(get.exitCode, 0, `ENTER: the read succeeded (${get.output})`);
    const set = await svc.run('patch session bob --proxy p');
    assert.strictEqual(set.exitCode, 0, `ENTER: patch session succeeded (${set.output})`);

    // ENTER on the reduction: both lines really reached the wire. Without this
    // the shape assertion below would hold for a service that sent nothing.
    assert.strictEqual(seen.length, 2, `expected two requests, got ${seen.length}: ${seen.join(', ')}`);
    // The two must not be the same request. Naming the exact methods would pin
    // the wire API rather than the dispatch; what this test owns is that the
    // sub SELECTED something, and a collapsed ternary makes these identical.
    assert.notStrictEqual(seen[0], seen[1],
      `the read and the write issued the same request (${seen[0]}) — the verbs collapsed`);
    assert.match(seen[0], /^GET /, 'get --subresource args reads');
    assert.doesNotMatch(seen[1], /^GET /, 'patch session must not be a read');
  } finally {
    svc.dispose();
    await new Promise((r) => server.close(r));
  }
});

test('get session --subresource transcript -f is a one-shot read that opens no event stream', async () => {
  const http = require('node:http');
  const seen = [];
  const live = new Set();
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    seen.push(`${req.method} ${path}`);
    if (servesResources(req, res)) return;
    if (path === '/api/events') {
      live.add(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': open\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, messages: [{ role: 'assistant', text: 'ONESHOT_LINE' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: async () => ({ baseUrl: base, close() {} }),
  });
  try {
    await svc.run('create node prod --url http://prod.example --token STORED_TOKEN_L');
    let timer = null;
    const b = await Promise.race([
      svc.run('get session bob --subresource transcript -f'),
      new Promise((r) => { timer = setTimeout(() => r(null), 5000); }),
    ]);
    clearTimeout(timer);
    assert.ok(b, 'the block never resolved — the subresource followed the stream, and the ctl chain (one at a time) is wedged with no cancel');
    assert.strictEqual(b.exitCode, 0, `ENTER: the read succeeded (${String(b.output).slice(0, 200)})`);
    assert.match(b.output, /ONESHOT_LINE/, 'ENTER: the transcript really came back, so the block is not empty-by-error');
    assert.ok(seen.includes('GET /api/sessions/bob/transcript'), `ENTER: the transcript endpoint was read — saw ${seen.join(', ')}`);
    assert.ok(!seen.some((r) => r.includes('/api/events')),
      `-f on the transcript subresource opened an event stream (${seen.join(', ')}) — the gate at ctl-service only refuses \`logs --follow\`, so this walks past it`);
  } finally {
    svc.dispose();
    for (const res of live) { try { res.destroy(); } catch {} }
    await new Promise((r) => server.close(r));
  }
});

test('an unknown verb has no help, and says so', async () => {
  const { svc } = mkService();
  const b = await svc.run('help nosuchverb');
  assert.notStrictEqual(b.exitCode, 0);
  assert.match(b.output, /no help for "nosuchverb"/);
  svc.dispose();
});

test('help is not in the allowlist, and does not need to be', () => {
  // The table above is the containment contract, and this feature deliberately
  // did NOT widen it: help short-circuits ahead of refuse(), so an entry would
  // be dead code that reads like a widened runner. Pinned because the obvious
  // "fix" on seeing `help` work without a table entry is to add one.
  assert.ok(!Object.prototype.hasOwnProperty.call(ALLOWED, 'help'),
    'help must stay out of ALLOWED — it never reaches the gate');
  assert.match(String(refuse(['help'])), /^refused:/,
    'the gate itself has no opinion on help; execute() short-circuits first');
});

// The cheat sheet the `?` popover renders. It exists as a DERIVED index rather
// than a list in the renderer because a hand-kept copy is what drifts: the pane
// would keep advertising a verb after the allowlist dropped it, or hide one it
// gained. These tests pin the derivation, not the current contents.
test('helpIndex advertises exactly the verbs the service will run', () => {
  const { svc } = mkService();
  const idx = svc.helpIndex();
  // ENTER: a real index. Every assertion below is about the SHAPE of a set,
  // and an empty set satisfies most of them.
  assert.ok(idx.verbs.length >= 5, `ENTER: expected the allowed verbs, got ${idx.verbs.length}`);

  // The derivation itself: the advertised set IS the allowlist's key set. A
  // literal list here would restate the renderer's bug rather than catch it.
  assert.deepStrictEqual(
    idx.verbs.map((v) => v.verb).sort(),
    Object.keys(ALLOWED).sort(),
    'the cheat sheet and the allowlist must not drift',
  );

  // Nothing REFUSED leaks into the advertised set. Named literally rather than
  // derived from ALLOWED: deriving both sides from the same table would make
  // this the deepStrictEqual above a second time, and what it must catch is a
  // verb reaching the popover without reaching the runner.
  for (const v of idx.verbs) {
    assert.ok(!['attach', 'deploy', 'undeploy', 'upgrade', 'port-forward', 'web'].includes(v.verb),
      `${v.verb} is refused and must not be advertised as runnable`);
  }
  svc.dispose();
});

test('helpIndex names the surviving words of a PARTIALLY allowed family', () => {
  const { svc } = mkService();
  const restart = svc.helpIndex().verbs.find((v) => v.verb === 'restart');
  // `restart` is the ONE family the allowlist spells as a word array, so the only entry
  // that can carry `subs` — and genuinely narrowed: its usage advertises `restart node`.
  assert.deepStrictEqual(restart.subs, ['session', 'sessions']);
  const get = svc.helpIndex().verbs.find((v) => v.verb === 'get');
  assert.strictEqual(get.subs, null, 'a fully-allowed verb carries no subs restriction');
  svc.dispose();
});

test('helpIndex carries summaries and no credential material', () => {
  const { svc } = mkService();
  const idx = svc.helpIndex();
  for (const v of idx.verbs) {
    assert.ok(typeof v.summary === 'string' && v.summary.length > 0,
      `${v.verb} must carry a summary from the help registry`);
  }
  // It is derived from a static registry, never from the contexts store — so
  // there is no path by which a token reaches it. Pinned because the obvious
  // future edit ("show the current context in the popover") would change that.
  assert.doesNotMatch(JSON.stringify(idx), /token/i);
  svc.dispose();
});

test('every node word runs in this tab and opens NO transport', async () => {
  const opened = [];
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: async (ctx) => { opened.push(ctx); throw new Error('DIALED — a node word must never reach the wire'); },
  });
  const lines = [
    'create node x --url http://h.example --token STORED_TOKEN_L',
    'use node x',
    'get nodes',
    'get nodes -o json',
    'describe node x',
    'delete node x --force',
  ];
  for (const line of lines) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 0, `${line} -> ${b.exitCode}: ${b.output}`);
    assert.doesNotMatch(b.output, /refused|LOCAL record/, `${line} must RUN here, not refuse`);
  }
  assert.deepStrictEqual(opened, [], 'a node word opened a transport');
  svc.dispose();
});

test('the node family is stateful on disk, and delete node really forgets', async () => {
  const { svc, file } = mkService();
  await svc.run('create node home --url http://home.example');
  await svc.run('create node work --ssh u@box --remote-port 7911');
  assert.strictEqual((await svc.run('use node work')).ctx, 'work');

  const listed = await svc.run('get nodes');
  assert.match(listed.output, /home/, 'ENTER: both records are listed');
  assert.match(listed.output, /work/);

  const gone = await svc.run('delete node home --force');
  assert.strictEqual(gone.exitCode, 0, `delete node ran (${gone.output})`);
  const after = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.deepStrictEqual(Object.keys(after.contexts), ['work'], 'the record left the FILE, not just the listing');
  assert.strictEqual(after.current, 'work', 'the current node is untouched by deleting another');
  svc.dispose();
});

test('get nodes -o json prints no credential-shaped field at any depth', async () => {
  const file = tmpCtxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    current: 'home',
    contexts: {
      home: {
        url: 'http://home.example',
        token: 'STORED_TOKEN_LONG',
        password: 'PASSWORD_LEAKED',
        secret: 'SECRET_LEAKED',
        auth: { bearer: 'AUTH_LEAKED' },
      },
    },
  }), { mode: 0o600 });
  const svc = createCtlService({ contextsFile: file, env: {} });
  const b = await svc.run('get nodes -o json');
  assert.strictEqual(b.exitCode, 0, `ENTER: the listing ran (${b.output})`);
  const parsed = JSON.parse(b.output);
  const row = parsed.nodes.find((n) => n.name === 'home');
  assert.deepStrictEqual(row.transport, { url: 'http://home.example' });
  assert.strictEqual(row.tokenSet, true, 'the operator still learns a token is set');

  const banned = /^(token|auth|secret|password)$/i;
  (function walk(v, at) {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      assert.ok(!banned.test(k), `${at}.${k} is a credential-shaped key in -o json`);
      walk(val, `${at}.${k}`);
    }
  })(parsed, 'nodes');
  for (const leaked of ['PASSWORD_LEAKED', 'SECRET_LEAKED', 'AUTH_LEAKED', 'STORED_TOKEN_LONG']) {
    assert.doesNotMatch(b.output, new RegExp(leaked), `${leaked} reached the renderer`);
  }
  svc.dispose();
});

test('get nodes -o json prints no credential-shaped field nested INSIDE a kind object', async () => {
  const file = tmpCtxFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    current: 'k8s',
    contexts: {
      k8s: { kubectl: { target: 'svc/x', namespace: 'n', password: 'NESTED_PASSWORD', authToken: 'NESTED_AUTHTOKEN' } },
      box: { ssm: { target: 't', secret: 'NESTED_SECRET' } },
    },
  }), { mode: 0o600 });
  const svc = createCtlService({ contextsFile: file, env: {} });
  const b = await svc.run('get nodes -o json');
  assert.strictEqual(b.exitCode, 0, `ENTER: the listing ran (${b.output})`);
  const parsed = JSON.parse(b.output);
  const byName = Object.fromEntries(parsed.nodes.map((n) => [n.name, n]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['box', 'k8s'], 'ENTER: both entries are really in the payload');

  assert.deepStrictEqual(byName.k8s.transport, { kubectl: { target: 'svc/x', namespace: 'n' } },
    'kubectl.target and .namespace survive; the foreign siblings do not');
  assert.deepStrictEqual(byName.box.transport, { ssm: { target: 't' } });

  const banned = /^(token|auth|secret|password)$/i;
  (function walk(v, at) {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      assert.ok(!banned.test(k), `${at}.${k} is a credential-shaped key in -o json`);
      walk(val, `${at}.${k}`);
    }
  })(parsed, 'nodes');
  for (const leaked of ['NESTED_PASSWORD', 'NESTED_AUTHTOKEN', 'NESTED_SECRET']) {
    assert.doesNotMatch(b.output, new RegExp(leaked), `${leaked} reached the renderer from inside a kind object`);
  }
  svc.dispose();
});

test('describe node --test dials the INJECTED transport, never the real one', async () => {
  const file = tmpCtxFile();
  const openTransport = fakeTransport();
  const svc = createCtlService({ contextsFile: file, env: {}, openTransport });
  await svc.run('create node prod --url http://prod.example --token SUPERSECRET');

  const b = await svc.run('describe node prod --test');
  assert.strictEqual(openTransport.opened.length, 1,
    `the tab's injected transport must be the one dialed (${b.output})`);
  assert.strictEqual(openTransport.opened[0].url, 'http://prod.example',
    'and it was dialed with the resolved node, not some other context');
  assert.doesNotMatch(b.output, /SUPERSECRET/, 'the token must not reach the renderer');
  svc.dispose();
});

test('every ARRAY rule in ALLOWED names a verb the resource-word check re-judges', () => {
  const V = require('../cli/src/verbs');
  const arrayRuled = Object.entries(ALLOWED).filter(([, r]) => Array.isArray(r)).map(([v]) => v);
  assert.ok(arrayRuled.length >= 2, `ENTER: there really are array rules to check (${arrayRuled.length})`);
  for (const verb of arrayRuled) {
    assert.ok(V.RESOURCE_VERBS[verb],
      `ALLOWED.${verb} is a word array, but ${verb} is not in RESOURCE_VERBS — refuse() returns null for a non-resource second token and nothing re-judges it before wireFor`);
  }
});

test('a name where a resource word belongs suggests the command the operator meant', async () => {
  const { svc } = mkService();
  for (const [line, want] of [
    ['use murmurfi', 'use murmurfi: "murmurfi" is not a resource — did you mean: use node murmurfi'],
    ['create murmurfi', 'create murmurfi: "murmurfi" is not a resource — did you mean: create <session|node> murmurfi'],
    ['delete murmurfi', 'delete murmurfi: "murmurfi" is not a resource — did you mean: delete <session|node> murmurfi'],
    ['restart murmurfi', 'restart murmurfi: "murmurfi" is not a resource — did you mean: restart <session|node> murmurfi'],
    ['describe murmurfi', 'describe murmurfi: "murmurfi" is not a resource — did you mean: describe <session|node|workspace|peer|team|ticket|sandbox|agent|worktree|catalogs> murmurfi'],
  ]) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 2, `${line} -> ${b.exitCode}: ${b.output}`);
    assert.strictEqual(b.output, `clodexctl: ${want}\n`, line);
  }
  const real = await svc.run('use session bob');
  assert.match(real.output, /use session is not supported \(node\)/);
  assert.doesNotMatch(real.output, /did you mean/);
  svc.dispose();
});

test('isNodeLine routes on the resource word, and use has no other resource', () => {
  assert.strictEqual(isNodeLine('get', ['nodes'], R), true);
  assert.strictEqual(isNodeLine('get', ['node', 'home'], R), true);
  assert.strictEqual(isNodeLine('describe', ['node/home'], R), true, 'the slash spelling routes too');
  assert.strictEqual(isNodeLine('use', ['anything'], R), true, 'use serves only node');
  assert.strictEqual(isNodeLine('use', [], R), true);
  assert.strictEqual(isNodeLine('get', ['sessions'], R), false);
  assert.strictEqual(isNodeLine('delete', ['session', 'a'], R), false);
  assert.strictEqual(isNodeLine('restart', ['node'], R), false, 'restart is not a local verb');
  assert.strictEqual(isNodeLine('get', ['murmurfi'], R), false, 'a non-resource token is not a node line');
  assert.strictEqual(isNodeLine('exec', ['node'], R), false);
});

test('a ctx spelling answers with the CLI pointer, in the tab as in the terminal', async () => {
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: () => { throw new Error('DIALED — a pointer must run nothing'); },
  });
  for (const [line, to] of [['ctx add p --url http://h', 'create node'], ['ctx use p', 'use node'],
    ['ctx list', 'get nodes'], ['ctx show p', 'describe node'], ['ctx rm p', 'delete node']]) {
    const b = await svc.run(line);
    assert.strictEqual(b.exitCode, 1, `${line} -> ${b.exitCode}: ${b.output}`);
    assert.match(b.output, new RegExp(`was renamed: use clodexctl ${to}`), line);
  }
  const helped = await svc.run('help ctx');
  assert.match(helped.output, /no help for "ctx"/, 'no ctx help entry survives in this tab');
  svc.dispose();
});

test('helpIndex advertises no ctx shorthand — there is none left to advertise', () => {
  const { svc } = mkService();
  const idx = svc.helpIndex();
  assert.ok(!('ctxAliases' in idx), 'the ctx alias list is gone with the family');
  assert.deepStrictEqual(Object.keys(idx).sort(), ['deferred', 'verbs']);
  for (const v of ['get', 'describe', 'create', 'delete', 'use']) {
    assert.ok(idx.verbs.some((r) => r.verb === v), `${v} must be advertised`);
  }
  svc.dispose();
});
