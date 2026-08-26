'use strict';
// ctl-service.test.js — the drawer's clodexctl REPL service. What is pinned
// here is the part that is NOT the pane: the allowlist, the block shape the
// tenant renders, and the injected io set that keeps a verb from reaching the
// main process's stdio.
//
// The allowlist is a SLIP GUARD, not a containment boundary, and the tests
// below should not be read as security pins. `exec` is admitted, so
// `exec box "clodexctl kill x --force"` is typeable — nothing in this table
// contains what the operator can reach. The boundary is enableDrawerServices at
// IPC registration (pinned by drawer-services-seam.test.js), which keeps the
// whole `ctl:*` family off the web surface.
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

const { createCtlService, tokenize, refuse, aliasCtx, ALLOWED, MAX_BLOCK_CHARS } = require('../ctl-service');
const { mkTmpRoot } = require('./lib/tmp-roots');

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
  assert.deepStrictEqual(tokenize('ctx show ""'), ['ctx', 'show', '']);
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
  for (const argv of [['info'], ['sessions'], ['query', '--kind', 'x'], ['ctx', 'use', 'p'], ['ctx', 'list'],
    ['args', 'get', 'n'], ['args', 'set', 'n'], ['run', 'a', 'ls'], ['exec', 'a', 'ls'], ['send', 'a', 'hi'],
    ['input', 'a', 'x'], ['spawn', 'a'], ['restart', 'a'], ['logs', 'a'], ['skills', 'a']]) {
    assert.strictEqual(refuse(argv), null, `${argv.join(' ')} must be allowed`);
  }
  // The refused set, named one by one rather than by a loop over a list that
  // could itself drift. Each fails the SHAPE test, not a mutation test: a live
  // terminal, a server, a long child, or an irreversible act whose confirmation
  // prompt cannot run in a pane that has no way to ask.
  for (const argv of [['attach', 'a'], ['kill', 'a'], ['restart-app'],
    ['deploy', 'h'], ['undeploy', 'h'], ['upgrade', 'h'], ['port-forward'], ['web']]) {
    assert.match(String(refuse(argv)), /^refused:/, `${argv.join(' ')} must be refused`);
  }
  assert.strictEqual(refuse([]), null, 'an empty line is not a refusal');
  // The table is the contract; a verb silently gaining `true` here widens the
  // runner. Assert the WHOLE object, not a spot check.
  assert.deepStrictEqual({ ...ALLOWED }, {
    info: true, sessions: true, query: true, logs: true, skills: true,
    send: true, input: true, exec: true, run: true, spawn: true, restart: true,
    ctx: '*', args: ['get', 'set'],
  });
});

// The two irreversible engine-side verbs, called out on their own because the
// reason they stay refused is NOT "it mutates" — `restart` and `spawn` mutate
// and are allowed. It is that neither can be confirmed here: the injected
// `prompt` rejects, so the only spelling that would reach the wire is the
// --force one, which turns a hard delete (kill: no resume) and a whole-engine
// relaunch into a single unguarded Enter in a 12-line strip.
test('kill and restart-app stay refused even with --force', () => {
  for (const argv of [['kill', 'a'], ['kill', 'a', '--force'], ['restart-app'], ['restart-app', '--force']]) {
    assert.match(String(refuse(argv)), /^refused:/, `${argv.join(' ')} must be refused`);
  }
  // ENTER, and it is the whole point of this test: the neighbouring mutating
  // verbs DO run, so this is a targeted refusal and not a service that happens
  // to refuse everything with a dangerous-sounding name.
  assert.strictEqual(refuse(['restart', 'a']), null, 'restart (resumable) is allowed');
  assert.strictEqual(refuse(['spawn', 'a']), null, 'spawn is allowed');
});

test('run: a refused verb is a block, and never opens a transport', async () => {
  // `kill` rather than a read-only verb: the gate must stop it BEFORE
  // wireFor(), and a service that gated after the dial would still produce a
  // refusal block — just one that had already resolved a context and opened a
  // transport on the way. The injected openTransport throws, so a dial fails
  // loudly instead of passing quietly.
  const svc = createCtlService({
    contextsFile: tmpCtxFile(), env: {},
    openTransport: () => { throw new Error('DIALED — the gate ran after the transport'); },
  });
  const b = await svc.run('kill somebox --force');
  assert.strictEqual(b.command, 'kill somebox --force');
  assert.match(b.output, /refused: "kill"/);
  assert.strictEqual(b.exitCode, 2);
  svc.dispose();
});

test('a leading flag moves the verb, and the gate follows it', async () => {
  const { svc } = mkService();
  // Both halves matter and they pull in opposite directions, which is why this
  // is one test. A gate reading the RAW argv sees `--json` in slot 0 for both
  // lines: it would refuse the legitimate one as a verb named "--json", and
  // judge the refusable one on a token that is not its verb.
  const bad = await svc.run('--json kill somebox --force');
  assert.match(bad.output, /refused: "kill"/, 'the PARSED verb is what the gate judges');
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

// Help is LOCAL rendering off help.js's registry — no context, no dial. It
// short-circuits ahead of the allowlist gate for the same reason main.js puts
// it ahead of context resolution, and the bug this pins is that the flag was
// simply not read: `sessions --help` ran the verb and returned live session
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

  for (const line of ['help', '--help', '-h', 'sessions --help', 'help ctx']) {
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
  await svc.run('ctx add prod --url http://prod.example --token STORED_TOKEN_L');
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
    await svc.run('ctx add prod --url http://prod.example --token STORED_TOKEN_L');
    const b = await svc.run('args get bob');
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
        await svc.run(`ctx add prod --url http://prod.example --token ${TOKEN}`);
        const name = `off_${off < 0 ? 'm' : 'p'}${Math.abs(off)}`;
        const b = await svc.run(`args get ${name}`);
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

// The `args` family is the only one whose SUBCOMMAND picks the handler, and
// both subs are now allowed. A dispatcher that ignored the sub would run
// argsGet for `args set` — a write silently becoming a read, with a plausible
// success block on screen. Driven against a real socket because the claim is
// about the REQUEST that leaves: a GET where a PATCH was typed.
test('args set and args get reach different handlers — the method proves it', async () => {
  const http = require('node:http');
  const seen = [];
  const server = http.createServer((req, res) => {
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
    await svc.run('ctx add prod --url http://prod.example --token STORED_TOKEN_L');
    const get = await svc.run('args get bob');
    assert.strictEqual(get.exitCode, 0, `ENTER: args get succeeded (${get.output})`);
    const set = await svc.run('args set bob --proxy p');
    assert.strictEqual(set.exitCode, 0, `ENTER: args set succeeded (${set.output})`);

    // ENTER on the reduction: both lines really reached the wire. Without this
    // the shape assertion below would hold for a service that sent nothing.
    assert.strictEqual(seen.length, 2, `expected two requests, got ${seen.length}: ${seen.join(', ')}`);
    // The two must not be the same request. Naming the exact methods would pin
    // the wire API rather than the dispatch; what this test owns is that the
    // sub SELECTED something, and a collapsed ternary makes these identical.
    assert.notStrictEqual(seen[0], seen[1],
      `args get and args set issued the same request (${seen[0]}) — the subcommand was ignored`);
    assert.match(seen[0], /^GET /, 'args get reads');
    assert.doesNotMatch(seen[1], /^GET /, 'args set must not be a read');
  } finally {
    svc.dispose();
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
    assert.ok(!['attach', 'kill', 'restart-app', 'deploy', 'undeploy', 'upgrade', 'port-forward', 'web'].includes(v.verb),
      `${v.verb} is refused and must not be advertised as runnable`);
  }
  svc.dispose();
});

test('helpIndex names the subcommands of a PARTIALLY allowed family', () => {
  const { svc } = mkService();
  const args = svc.helpIndex().verbs.find((v) => v.verb === 'args');
  // `args` is the ONE family the allowlist spells as a subcommand array, so it
  // is the only verb whose entry can carry `subs` at all. The mechanism has to
  // stay wired even while both subs are admitted: the moment a family is
  // narrowed again, the pane must show the surviving subs rather than the
  // registry's full usage line.
  assert.deepStrictEqual(args.subs, ['get', 'set']);
  const sessions = svc.helpIndex().verbs.find((v) => v.verb === 'sessions');
  assert.strictEqual(sessions.subs, null, 'a fully-allowed verb carries no subs restriction');
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

// ── bare ctx subcommands ─────────────────────────────────────────────────────
// `list` means `ctx list`. The property that needs pinning is not the rewrite —
// it is the GUARD: no ctx sub collides with a registry verb today, so a plain
// alias table passes every test below except the shadowing one, right up until
// someone adds a top-level verb by that name and it silently stops running.

test('aliasCtx rewrites a bare ctx sub, and a real verb always wins', () => {
  const isVerb = (t) => ['sessions', 'info', 'ctx'].includes(t);
  assert.deepStrictEqual(aliasCtx(['list'], isVerb), ['ctx', 'list']);
  assert.deepStrictEqual(aliasCtx(['use', 'prod'], isVerb), ['ctx', 'use', 'prod']);
  assert.deepStrictEqual(aliasCtx(['show'], isVerb), ['ctx', 'show']);
  // Not a ctx sub: untouched, or every unknown verb would become `ctx <junk>`
  // and report an unknown SUBCOMMAND instead of an unknown verb.
  assert.deepStrictEqual(aliasCtx(['sessions'], isVerb), ['sessions']);
  assert.deepStrictEqual(aliasCtx(['deploy', 'host'], isVerb), ['deploy', 'host']);
  assert.deepStrictEqual(aliasCtx([], isVerb), []);
  // Already prefixed: `ctx` is itself a verb, so the guard stops a second pass
  // producing `ctx ctx list`.
  assert.deepStrictEqual(aliasCtx(['ctx', 'list'], isVerb), ['ctx', 'list']);
  // THE GUARD. A future top-level `list` must keep its own dispatch. Nothing
  // else in this file fails if the isVerb check is dropped.
  const withList = (t) => isVerb(t) || t === 'list';
  assert.deepStrictEqual(aliasCtx(['list'], withList), ['list'],
    'a real verb is never shadowed by the alias');
});

test('a bare ctx sub runs the ctx command end to end', async () => {
  const { svc } = mkService();
  await svc.run('ctx add prod --url http://prod.example --token SEKRIT');
  const bare = await svc.run('list');
  // ENTER: the bare form produced a real listing, not a usage error — every
  // comparison below is vacuous against two identical refusals.
  assert.strictEqual(bare.exitCode, 0, `ENTER: bare \`list\` ran (${bare.output})`);
  assert.match(bare.output, /prod/, 'ENTER: the context it added is in the listing');
  const prefixed = await svc.run('ctx list');
  assert.strictEqual(bare.output, prefixed.output, 'the two spellings are the same command');
  // The redaction that `ctx list` gets is not a property of the prefix.
  assert.doesNotMatch(bare.output, /SEKRIT/, 'the bare form redacts too');
  svc.dispose();
});

test('a bare ctx sub is not a way past the allowlist', async () => {
  const { svc } = mkService();
  // `test` is a ctx sub AND the one that dials, so it is the alias most worth
  // checking lands inside the gate rather than around it. It is allowed
  // (ctx: '*'), so what is pinned is that it reaches the ctx runner at all.
  const b = await svc.run('deploy somehost');
  assert.match(b.output, /refused: "deploy"/, 'a deferred verb stays deferred');
  // An unknown word that is not a ctx sub must still read as an unknown VERB.
  const junk = await svc.run('frobnicate');
  assert.match(junk.output, /refused: "frobnicate"/);
  svc.dispose();
});

test('help routing sees the alias — `list --help` explains ctx', async () => {
  const { svc } = mkService();
  // Help short-circuits ahead of the gate, so an alias applied after it would
  // leave the one command someone types to learn the shorthand saying "no help
  // for list". Both spellings of the ask are covered.
  const flag = await svc.run('list --help');
  assert.strictEqual(flag.exitCode, 0, `ENTER: help resolved (${flag.output})`);
  assert.match(flag.output, /ctx/, 'it is the ctx entry that renders');
  assert.doesNotMatch(flag.output, /no help for/);
  const word = await svc.run('help list');
  assert.strictEqual(word.exitCode, 0, `ENTER: \`help list\` resolved (${word.output})`);
  assert.doesNotMatch(word.output, /no help for/, '`help list` needs its own rewrite');
  svc.dispose();
});

test('a leading flag still finds the aliased verb', async () => {
  const { svc } = mkService();
  // The alias reads PARSED positionals for the same reason the gate does:
  // `--json list` has the verb in slot 0 of `_` and nowhere near slot 0 of argv.
  const b = await svc.run('--json list');
  assert.strictEqual(b.exitCode, 0, `ENTER: it ran rather than refusing (${b.output})`);
  svc.dispose();
});

test('helpIndex advertises the aliases it actually computes', () => {
  const { svc } = mkService();
  const idx = svc.helpIndex();
  assert.ok(Array.isArray(idx.ctxAliases) && idx.ctxAliases.length, 'ENTER: aliases are reported');
  assert.ok(idx.ctxAliases.includes('list'), 'list is advertised');
  // Derived through aliasCtx, so a sub shadowed by a future top-level verb
  // leaves the cheat sheet in the same release it stops working.
  for (const s of idx.ctxAliases) {
    assert.ok(!idx.verbs.some((v) => v.verb === s), `${s} is advertised as an alias but is a verb`);
  }
});
