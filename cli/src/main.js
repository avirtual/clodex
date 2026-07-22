// main.js — argv → verb dispatch. Owns the orchestration every wire verb
// shares: resolve the context, open its transport, build a WireClient, run the
// verb, and ALWAYS close the transport (reap the tunnel child). ctx verbs are
// local-file only and skip all of that.
//
// run(argv, io) returns an exit code (never calls process.exit itself) so it is
// fully testable; bin/clodexctl.js is the thin process shim around it.
'use strict';

const contexts = require('./contexts');
const { WireClient } = require('./client');
const { openTransport } = require('./transport');
const { makePrinter } = require('./output');
const { CliError, EXIT } = require('./errors');
const V = require('./verbs');
const D = require('./deploy');
const { attach } = require('./attach');
const { portForward } = require('./port-forward');
const { web } = require('./web');
const { help, VERSION } = require('./help');
const { parse } = require('./args');

// Parser option spec shared by all verbs (a verb ignores flags it doesn't use).
const PARSE_OPTS = {
  booleans: ['json', 'force', 'fresh', 'fork', 'restart', 'detail', 'verbose', 'dry-run', 'no-enter', 'raw', 'wait', 'pty', 'no-ctx', 'follow', 'read-only', 'no-open', 'probe-http', 'help', 'version'],
  multi: ['arg', 'ssh-opt', 'volume', 'env'],
  greedy: ['tunnel'],
  aliases: { h: 'help', V: 'version', f: 'follow', 'remote-port': 'remotePort' },
};

// Wire verbs and their handler. ctx/args are dispatched specially (subverbs).
const WIRE_VERBS = {
  info: V.info, sessions: V.sessions, logs: V.logs, query: V.query,
  skills: V.skills, spawn: V.spawn, send: V.send, input: V.input,
  exec: V.exec, run: V.run, attach: attach, kill: V.kill, restart: V.restart, 'restart-app': V.restartApp,
};

// Verbs handled OUTSIDE WIRE_VERBS (their own dispatch above). Together with
// WIRE_VERBS' keys this is the canonical set of top-level verbs users type —
// help.js's registry is pinned complete against it (help.test.js), so a new
// verb can't ship without a help entry.
const SPECIAL_VERBS = ['ctx', 'args', 'deploy', 'port-forward', 'web'];
const TOP_VERBS = [...Object.keys(WIRE_VERBS), ...SPECIAL_VERBS];

async function run(argv, io = {}) {
  const printer = makePrinter(io.stdout || ((s) => process.stdout.write(s)));
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  let flags;
  try {
    flags = parse(argv, PARSE_OPTS);
  } catch (e) {
    writeErr(`clodexctl: ${e.message}\n`);
    return e instanceof CliError ? e.exitCode : EXIT.USAGE;
  }

  // Help routing — CONTEXTUAL (T43). All three of these short-circuit BEFORE any
  // context resolution or wire open, so `<verb> --help` never constructs a
  // WireClient or needs a ctx:
  //   bare `clodexctl` / `--help`         → the grouped index
  //   `clodexctl help [verb…]`            → the index, or a verb's full entry
  //   `clodexctl <verb> --help`           → that verb's full entry
  if (flags.help && flags._.length > 0) {
    const { text, code } = help(flags._);   // route --help THROUGH the present verb
    printer.line(text);
    return code;
  }
  if (flags.help || flags._.length === 0) { printer.line(help([]).text); return EXIT.OK; }
  if (flags._[0] === 'help') { const { text, code } = help(flags._.slice(1)); printer.line(text); return code; }
  if (flags.version) { printer.line(VERSION); return EXIT.OK; }

  const verb = flags._[0];
  const rest = flags._.slice(1); // positionals after the top verb

  try {
    if (verb === 'ctx') return await dispatchCtx(rest, flags, printer, io);
    if (verb === 'args') return await dispatchArgs(rest, flags, printer, io);
    if (verb === 'deploy') return await dispatchDeploy(rest, flags, printer, io);
    // port-forward holds a tunnel in the FOREGROUND and owns no WireClient, so it
    // resolves the ctx + opens the transport itself rather than routing through
    // withWire (which would open a wire-port tunnel and reap it immediately).
    if (verb === 'port-forward') { await portForward({ flags, args: rest, printer, io }); return EXIT.OK; }
    // `web` is the headline browser-GUI verb — a friendly wrapper over the same
    // foreground tunnel machinery (it delegates to portForward), so it routes
    // OUTSIDE withWire for the identical reason.
    if (verb === 'web') { await web({ flags, args: rest, printer, io }); return EXIT.OK; }
    const handler = WIRE_VERBS[verb];
    if (!handler) throw new CliError(EXIT.USAGE, `unknown verb: ${verb} (try --help)`);
    // io.prompt is an injectable confirm seam (tests pass a canned answerer);
    // absent → the verb falls back to its readline-over-stderr default. attach
    // needs the resolved ctx (for its banner) + io (its TTY seam), so withWire
    // threads both — other verbs ignore the extras.
    return await withWire(flags, io, (client, ctx) => handler({ client, ctx, printer, flags, args: rest, prompt: io.prompt, stderr: writeErr, io }));
  } catch (e) {
    if (e instanceof CliError) { writeErr(`clodexctl: ${e.message}\n`); return e.exitCode; }
    writeErr(`clodexctl: unexpected error: ${e.message}\n`);
    return EXIT.SERVER;
  }
}

// ctx subverbs. `test` needs a transport; the rest are pure file ops.
async function dispatchCtx(rest, flags, printer, io) {
  const sub = rest[0];
  const args = rest.slice(1);
  const store = contexts.load(io.contextsFile, { warn: (m) => (io.stderr || ((s) => process.stderr.write(s)))(`clodexctl: warning: ${m}\n`) });
  const saveStore = (s) => contexts.save(s, io.contextsFile);
  const bundle = { store, saveStore, printer, flags, args, env: io.env || process.env };
  switch (sub) {
    case 'add': V.ctxAdd(bundle); return EXIT.OK;
    case 'use': V.ctxUse(bundle); return EXIT.OK;
    case 'list': case 'ls': V.ctxList(bundle); return EXIT.OK;
    case 'rm': case 'remove': V.ctxRm(bundle); return EXIT.OK;
    case 'show': V.ctxShow(bundle); return EXIT.OK;
    case 'import': V.ctxImport(bundle); return EXIT.OK;
    case 'test': return await ctxTest(store, flags, printer, io);
    default: throw new CliError(EXIT.USAGE, `unknown ctx subcommand: ${sub || '(none)'} (add/use/list/rm/show/import/test)`);
  }
}

// deploy dispatch — sniff the first positional on a LITERAL token, not on the
// shape of a dest (a bare hostname / ssh-config alias has no `@`, so an
// `@`-sniff is the fragile one). `docker` → the container flavor; `ssh` → the
// explicit ssh alias (escape hatch for a host literally named `docker`);
// anything else → the ssh flavor as shipped in T36d, argv unchanged.
async function dispatchDeploy(rest, flags, printer, io) {
  if (rest[0] === 'docker') { await D.deployDockerVerb({ printer, flags, args: rest.slice(1), io }); return EXIT.OK; }
  if (rest[0] === 'ssm') { await D.deploySsmVerb({ printer, flags, args: rest.slice(1), io }); return EXIT.OK; }
  if (rest[0] === 'ssh') { await D.deployVerb({ printer, flags, args: rest.slice(1), io }); return EXIT.OK; }
  await D.deployVerb({ printer, flags, args: rest, io });
  return EXIT.OK;
}

async function dispatchArgs(rest, flags, printer, io) {
  const sub = rest[0];
  const args = rest.slice(1);
  if (sub === 'get') return withWire(flags, io, (client) => V.argsGet({ client, printer, flags, args }));
  if (sub === 'set') return withWire(flags, io, (client) => V.argsSet({ client, printer, flags, args }));
  throw new CliError(EXIT.USAGE, `unknown args subcommand: ${sub || '(none)'} (get/set)`);
}

// ctx test — the tunnel-diagnosis surface. Open the transport, GET hello, and
// report identity or the failure with the child's stderr relayed VERBATIM.
async function ctxTest(store, flags, printer, io) {
  const ctx = contexts.resolve(store, { ctxName: flags.ctx || null, env: io.env || process.env, flags });
  if (flags.verbose) {
    printer.line(`transport: ${V.entryKind(ctx)} ${V.entryTarget(ctx)}`);
  }
  let t;
  try {
    t = await openTransport(ctx, { spawnFn: io.spawnFn });
  } catch (e) {
    // openTransport already embeds the child's stderr in the message.
    printer.line(`FAIL — could not open transport`);
    throw e;
  }
  try {
    if (flags.verbose) printer.line(`base: ${t.baseUrl}`);
    const client = new WireClient(t.baseUrl, ctx.token);
    const hello = await client.get('/api/peer/hello', 'ctx test');
    printer.line(`OK — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} caps=[${(hello.caps || []).join(' ')}]`);
    return EXIT.OK;
  } finally {
    try { t.close(); } catch {}
  }
}

// Shared wire-verb wrapper: resolve → open transport → client → run → close.
async function withWire(flags, io, fn) {
  const store = safeLoad(io);
  const ctx = contexts.resolve(store, { ctxName: flags.ctx || null, env: io.env || process.env, flags });
  const t = await openTransport(ctx, { spawnFn: io.spawnFn });
  try {
    const client = new WireClient(t.baseUrl, ctx.token);
    await fn(client, ctx);
    return EXIT.OK;
  } finally {
    try { t.close(); } catch {}
  }
}

// A load that tolerates an absent file (flags/env may fully supply the context).
function safeLoad(io) {
  try { return contexts.load(io.contextsFile, { warn: () => {} }); }
  catch { return { current: null, contexts: {} }; }
}

module.exports = { run, TOP_VERBS, SPECIAL_VERBS };
