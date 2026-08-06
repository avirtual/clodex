'use strict';
// ctl-service.test.js — the drawer's clodexctl REPL service. What is pinned
// here is the part that is NOT the pane: the allowlist (the containment for a
// token-backed runner), the block shape the tenant renders, and the injected
// io set that keeps a verb from reaching the main process's stdio.
//
// The wire verbs (info/sessions/query/args get) are deliberately NOT exercised
// against a live node — that is cli/test's job and it needs a server. Every
// test here runs on paths that stop before the transport opens, which is also
// where every containment decision is made.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCtlService, tokenize, refuse, ALLOWED } = require('../ctl-service');

function tmpCtxFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-ctl-'));
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
  assert.deepStrictEqual(tokenize('ctx show ""'), ['ctx', 'show', '']);
  // No shell: these are literal bytes in one token, never operators. The line
  // never reaches a shell, and this is what says so.
  assert.deepStrictEqual(tokenize('sessions;rm'), ['sessions;rm']);
  assert.deepStrictEqual(tokenize('a|b'), ['a|b']);
  assert.deepStrictEqual(tokenize('$(whoami)'), ['$(whoami)']);
  assert.deepStrictEqual(tokenize('a&&b'), ['a&&b']);
  assert.throws(() => tokenize('query "unbalanced'), /unbalanced/);
});

test('refuse: the v1 allowlist admits exactly the read-only set', () => {
  // ENTER: the allowed verbs really are allowed — without this row every
  // refusal assertion below would also hold for a service that refuses
  // everything, which is a containment that ships a useless tab.
  for (const argv of [['info'], ['sessions'], ['query', '--kind', 'x'], ['ctx', 'use', 'p'], ['ctx', 'list'], ['args', 'get', 'n']]) {
    assert.strictEqual(refuse(argv), null, `${argv.join(' ')} must be allowed`);
  }
  // The deferred set, named one by one rather than by a loop over a list that
  // could itself drift: each of these is a mutation, an interactive prompt, or
  // a stream the service cannot yet carry.
  for (const argv of [['exec', 'a', 'ls'], ['input', 'a'], ['spawn', 'a'], ['send', 'a', 'hi'], ['run', 'a', 'hi'],
    ['kill', 'a'], ['restart', 'a'], ['restart-app'], ['attach', 'a'], ['logs', 'a'], ['skills'],
    ['deploy', 'h'], ['undeploy', 'h'], ['upgrade', 'h'], ['port-forward'], ['web']]) {
    assert.match(String(refuse(argv)), /^refused:/, `${argv.join(' ')} must be refused`);
  }
  assert.match(String(refuse(['args', 'set', 'k', 'v'])), /^refused:/, 'args set writes — refused');
  assert.strictEqual(refuse([]), null, 'an empty line is not a refusal');
  // The table is the contract; a verb silently gaining `true` here widens the
  // runner. Assert the WHOLE object, not a spot check.
  assert.deepStrictEqual({ ...ALLOWED }, {
    info: true, sessions: true, query: true, ctx: '*', args: ['get'],
  });
});

test('run: a refused verb is a block, and never opens a transport', async () => {
  const { svc } = mkService();
  const b = await svc.run('exec somebox rm -rf /');
  assert.strictEqual(b.command, 'exec somebox rm -rf /');
  assert.match(b.output, /refused: "exec"/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('a leading flag moves the verb, and the gate follows it', async () => {
  const { svc } = mkService();
  // Both halves matter and they pull in opposite directions, which is why this
  // is one test. A gate reading the RAW argv sees `--json` in slot 0 for both
  // lines: it would refuse the legitimate one as a verb named "--json", and
  // judge the refusable one on a token that is not its verb.
  const bad = await svc.run('--json exec somebox ls');
  assert.match(bad.output, /refused: "exec"/, 'the PARSED verb is what the gate judges');
  assert.strictEqual(bad.exitCode, 2);

  const ok = await svc.run('--json ctx list');
  assert.doesNotMatch(ok.output, /refused/, '`--json ctx list` is just `ctx list` with a flag');
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
  const b = await svc.run('ctx list');
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

test('run: no context selected is a usage block, not a crash', async () => {
  const { svc } = mkService();
  const b = await svc.run('sessions');
  assert.match(b.output, /no context selected/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('ctx use is STATEFUL across runs — the reason this is a REPL', async () => {
  const { svc, file } = mkService();
  const added = await svc.run('ctx add alpha --url http://alpha.example');
  assert.strictEqual(added.exitCode, 0, `ENTER: ctx add succeeded (${added.output})`);
  await svc.run('ctx add beta --url http://beta.example');
  assert.strictEqual((await svc.run('ctx use beta')).exitCode, 0);

  // The block's `ctx` is what the pane puts on its prompt line, so a switch
  // that did not reach it would leave the prompt lying about where the next
  // command goes.
  assert.strictEqual(svc.context(), 'beta');
  assert.strictEqual((await svc.run('ctx list')).ctx, 'beta');
  assert.strictEqual((await svc.run('ctx use alpha')).ctx, 'alpha');
  assert.strictEqual(svc.context(), 'alpha');

  // It really persisted — a service that only mutated memory would satisfy
  // every assertion above.
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(onDisk.current, 'alpha');
  svc.dispose();
});

test('ctx show redacts the token, and the block is scrubbed besides', async () => {
  const { svc } = mkService();
  await svc.run('ctx add prod --url http://prod.example --token SUPERSECRET');
  const b = await svc.run('ctx show prod');
  assert.match(b.output, /name\s+prod/, 'ENTER: the entry really rendered');
  assert.doesNotMatch(b.output, /SUPERSECRET/, 'a token must never reach the renderer');
  svc.dispose();
});

// ---------------------------------------------------------------------------
// Token containment. Every test below failed before its fix (cold review found
// all three shipped green under the previous suite, which is why the passing
// `ctx show` test above is not evidence of anything on its own).
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

test('MF2: --json ctx list must not print the tokens it lists', async () => {
  const { svc } = mkService();
  await svc.run('ctx add prod --url http://prod.example --token SUPERSECRET');
  await svc.run('ctx add other --url http://other.example --token SECOND_TOKEN');
  const b = await svc.run('--json ctx list');

  // ENTER: the listing really rendered. Without this the absences below are
  // equally true of a refusal, an empty store, or a crash.
  assert.strictEqual(b.exitCode, 0, `the listing succeeded (${b.output})`);
  const parsed = JSON.parse(b.output);
  assert.deepStrictEqual(Object.keys(parsed.contexts).sort(), ['other', 'prod'], 'both entries present');
  assert.strictEqual(parsed.contexts.prod.url, 'http://prod.example', 'the useful fields survive redaction');

  assert.doesNotMatch(b.output, /SUPERSECRET/, 'the current token must not reach the renderer');
  assert.doesNotMatch(b.output, /SECOND_TOKEN/, 'nor any OTHER stored token');
  // Redacted, not deleted: the operator still needs to see that a token is set.
  assert.strictEqual(parsed.contexts.prod.token, '***');
  svc.dispose();
});

test('MF2: the listing is redacted at the store, not by scrubbing the output', async () => {
  // Two layers cover `ctx list`: `redactStore` before the printer, and the
  // output fold over every stored token. For a normal-length token they are
  // indistinguishable — both leave `'***'` — so the test above stays green if
  // `redactStore` is deleted, and an unpinned layer is one a refactor removes
  // as dead code. A token SHORTER than MIN_SCRUBBABLE_TOKEN is the wedge: the
  // fold deliberately skips it (scrubbing a 3-char string would shred every
  // block), which leaves `redactStore` as the only thing standing between it
  // and the renderer.
  const { svc } = mkService();
  await svc.run('ctx add prod --url http://prod.example --token abc');
  const b = await svc.run('--json ctx list');

  assert.strictEqual(b.exitCode, 0, `ENTER: the listing succeeded (${b.output})`);
  const parsed = JSON.parse(b.output);
  assert.strictEqual(parsed.contexts.prod.url, 'http://prod.example', 'ENTER: the entry really rendered');
  assert.strictEqual(parsed.contexts.prod.token, '***', 'a short token is redacted at the store or not at all');
  svc.dispose();
});

test('MF1: a token in an ERROR message is scrubbed from the block', async () => {
  const file = tmpCtxFile();
  const svc = createCtlService({
    contextsFile: file,
    env: {},
    openTransport: fakeTransport({ fail: (ctx) => `ssh: connect failed running: ssh -o Token=${ctx.token} host` }),
  });
  await svc.run('ctx add prod --url http://prod.example --token SUPERSECRET');
  const b = await svc.run('sessions');

  assert.notStrictEqual(b.exitCode, 0, `ENTER: the dial really failed (${b.output})`);
  assert.match(b.output, /connect failed/, 'ENTER: the child message reached the block');
  assert.doesNotMatch(b.output, /SUPERSECRET/, 'a token relayed in a dial error must not reach the renderer');
  assert.match(b.output, /\*\*\*/, 'it was redacted rather than the whole message dropped');
  svc.dispose();
});

test('MF1: the scrub covers tokens the failing line never resolved', async () => {
  // The hole that made the original `finally` scrub dead BY CONSTRUCTION: it
  // read a `token` local that is still null when the dial itself throws, and
  // that the ctx path never set at all. Folding over the whole store is what
  // makes this case reachable — the leaked token here belongs to a DIFFERENT
  // context than the one being dialed.
  const svc = createCtlService({
    contextsFile: tmpCtxFile(),
    env: {},
    openTransport: fakeTransport({ fail: () => 'dial failed: OTHER_CTX_TOKEN appeared in a relayed argv' }),
  });
  await svc.run('ctx add other --url http://other.example --token OTHER_CTX_TOKEN');
  await svc.run('ctx add prod --url http://prod.example --token PROD_TOKEN');
  const b = await svc.run('sessions --ctx prod');

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
  await svc.run('ctx add tiny --url http://tiny.example --token e');
  const b = await svc.run('sessions');
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
    await svc.run('ctx add prod --url http://prod.example --token TOKEN_ONE_LONG');
    const first = await svc.run('sessions');
    assert.strictEqual(first.exitCode, 0, `ENTER: the command really succeeded (${first.output})`);

    // Same URL, different bearer. Keying the token as 'set'/'none' made these
    // two keys identical, so the second reused a client bearing TOKEN_ONE.
    await svc.run('sessions --token TOKEN_TWO_LONG');
    assert.strictEqual(opened.length, 2, 'a token change must force a re-dial');
    assert.strictEqual(opened[0].token, 'TOKEN_ONE_LONG', 'ENTER: the first dial used the stored token');
    assert.strictEqual(opened[1].token, 'TOKEN_TWO_LONG', 'the second dial carries the NEW token');
    assert.deepStrictEqual(seenAuth, ['Bearer TOKEN_ONE_LONG', 'Bearer TOKEN_TWO_LONG'],
      'each request arrived under the identity its line named');

    // The same token must still REUSE — a service that re-dials every command
    // is not a REPL, and would satisfy every assertion above.
    await svc.run('sessions --token TOKEN_TWO_LONG');
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
  const b = await svc.run('"" sessions');
  assert.match(b.output, /refused/);
  assert.doesNotMatch(b.output, /is not a function/, 'it must not reach the handler map');
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('dispose latches — a late run cannot spawn a child during shutdown', async () => {
  const transport = fakeTransport();
  const svc = createCtlService({ contextsFile: tmpCtxFile(), env: {}, openTransport: transport });
  await svc.run('ctx add prod --url http://prod.example --token STORED_TOKEN');
  svc.dispose();

  const b = await svc.run('sessions');
  assert.match(b.output, /shutting down/);
  // The claim that matters is not the message: it is that no dial happened. A
  // run() slipping past dispose re-dials and leaves an orphaned ssh/tunnel
  // child holding a local port, which is what engine.js's shutdown prevents.
  assert.strictEqual(transport.opened.length, 0, 'no transport may be opened after dispose');
});

test('an unknown ctx subcommand names the ones that exist', async () => {
  const { svc } = mkService();
  const b = await svc.run('ctx nope');
  assert.match(b.output, /unknown ctx subcommand: nope/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('run: commands serialize — the warm slot has one writer', async () => {
  const { svc } = mkService();
  // Fired without awaiting between them: if these interleaved, the second
  // could close a transport the first is mid-request on. Order out must match
  // order in.
  const [a, b, c] = await Promise.all([svc.run('ctx list'), svc.run('info'), svc.run('ctx list')]);
  assert.deepStrictEqual([a.command, b.command, c.command], ['ctx list', 'info', 'ctx list']);
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
  return svc.run('ctx list').then((b) => {
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clx-home-'));
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

    const b = await svc.run('ctx list');
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
