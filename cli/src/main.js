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
const U = require('./undeploy');
const UP = require('./upgrade');
const { attach } = require('./attach');
const { portForward } = require('./port-forward');
const { web } = require('./web');
const { help, VERSION } = require('./help');
const { parse } = require('./args');

// Parser option spec shared by all verbs (a verb ignores flags it doesn't use).
const PARSE_OPTS = {
  booleans: ['force', 'fresh', 'fork', 'restart', 'detail', 'verbose', 'dry-run', 'no-enter', 'raw', 'wait', 'pty', 'no-ctx', 'keep-ctx', 'keep-data', 'no-wirescope', 'use-bedrock', 'follow', 'read-only', 'no-open', 'probe-http', 'force-conflicts', 'all-workspaces', 'docker', 'helm', 'fargate', 'help', 'version'],
  multi: ['arg', 'ssh-opt', 'volume', 'env', 'set', 'values', 'param'],
  greedy: ['tunnel'],
  aliases: { h: 'help', V: 'version', f: 'follow', o: 'output', n: 'workspace', A: 'all-workspaces', 'remote-port': 'remotePort' },
};

// Wire verbs and their handler. ctx is dispatched specially (subverbs).
const WIRE_VERBS = {
  info: V.info, get: V.get, describe: V.describe, 'api-resources': V.apiResources,
  version: V.version, logs: V.logs, query: V.query,
  create: V.create, delete: V.delete, patch: V.patch, dm: V.dm, input: V.input,
  exec: V.exec, attach: attach, restart: V.restart,
};

const RENAMED_VERBS = {
  sessions: 'get sessions',
  run: 'exec',
  spawn: 'create session',
  kill: 'delete session',
  'restart-app': 'restart node',
  skills: 'get session <name> --subresource skills',
  args: 'get session … --subresource args / patch session',
  send: 'dm',
};

const RENAMED_SECOND = {
  deploy: {
    ssh: () => 'deploy node <name> --ssh user@host',
    ssm: () => 'deploy node <name> --ssm i-INSTANCE',
    docker: () => 'deploy node <name> --docker',
    helm: () => 'deploy node <name> --helm',
    fargate: () => 'deploy node <name> --fargate',
    '*': (tok) => `deploy node <name> --ssh ${tok}`,
  },
};

const RENAMED_HELP_EXIT = 1;

function renamedLine(old) {
  return `clodexctl ${old} was renamed: use clodexctl ${RENAMED_VERBS[old]}`;
}

function renamedSecondLine(verb, tok) {
  const table = RENAMED_SECOND[verb];
  if (!table) return null;
  if (!tok || tok === 'node') return null;
  const to = table[tok] || table['*'];
  if (!to) return null;
  return `clodexctl ${verb} ${tok} was renamed: use clodexctl ${to(tok)}`;
}

function renamedPointer(flags) {
  const askedHelp = !!flags.help || flags._[0] === 'help';
  const pointed = flags._[0] === 'help' ? flags._[1] : flags._[0];
  if (!pointed || !Object.prototype.hasOwnProperty.call(RENAMED_VERBS, pointed)) return null;
  return { line: renamedLine(pointed), askedHelp, code: askedHelp ? RENAMED_HELP_EXIT : EXIT.USAGE };
}

const PASSTHROUGH_FLAGS = new Set(PARSE_OPTS.multi.map((n) => `--${n}`));

function findDeletedJsonFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') return false;
    if (typeof tok !== 'string') continue;
    if (tok === '--tunnel') return false;
    if (PASSTHROUGH_FLAGS.has(tok)) { i++; continue; }
    if (tok === '--json' || tok.startsWith('--json=')) return true;
  }
  return false;
}

const OUTPUT_FORMATS = ['json', 'yaml', 'wide', 'name'];
const GET_ONLY_FORMATS = ['wide', 'name'];

function applyOutput(flags, verb) {
  if (flags.output == null) return;
  const fmt = String(flags.output);
  if (!OUTPUT_FORMATS.includes(fmt)) {
    throw new CliError(EXIT.USAGE, `unknown output format: ${fmt} (${OUTPUT_FORMATS.join('|')})`);
  }
  if (GET_ONLY_FORMATS.includes(fmt) && verb !== 'get') {
    throw new CliError(EXIT.USAGE, `-o ${fmt} is only valid on get`);
  }
  if (verb === 'describe') {
    throw new CliError(EXIT.USAGE, `describe has no -o ${fmt} (it is a composed human view; use get)`);
  }
  if (fmt === 'json' || fmt === 'yaml') flags.json = true;
}

// Verbs handled OUTSIDE WIRE_VERBS (their own dispatch above). Together with
// WIRE_VERBS' keys this is the canonical set of top-level verbs users type —
// help.js's registry is pinned complete against it (help.test.js), so a new
// verb can't ship without a help entry.
const SPECIAL_VERBS = ['ctx', 'deploy', 'undeploy', 'upgrade', 'port-forward', 'web'];
const TOP_VERBS = [...Object.keys(WIRE_VERBS), ...SPECIAL_VERBS];

async function run(argv, io = {}) {
  const printer = makePrinter(io.stdout || ((s) => process.stdout.write(s)));
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  if (findDeletedJsonFlag(argv)) {
    writeErr('clodexctl: --json was replaced by -o json\n');
    return EXIT.USAGE;
  }
  let flags;
  try {
    flags = parse(argv, PARSE_OPTS);
  } catch (e) {
    writeErr(`clodexctl: ${e.message}\n`);
    return e instanceof CliError ? e.exitCode : EXIT.USAGE;
  }

  const pointer = renamedPointer(flags);
  if (pointer) {
    if (pointer.askedHelp) { printer.line(pointer.line); return pointer.code; }
    writeErr(`clodexctl: ${pointer.line}\n`);
    return pointer.code;
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
    applyOutput(flags, verb);
    printer.format = flags.output === 'yaml' ? 'yaml' : 'json';
    const secondLine = renamedSecondLine(verb, rest[0]);
    if (secondLine) throw new CliError(RENAMED_HELP_EXIT, secondLine);
    if (verb === 'ctx') return await dispatchCtx(rest, flags, printer, io);
    if (verb === 'deploy') return await dispatchDeploy(rest, flags, printer, io);
    if (verb === 'undeploy') return await U.undeployVerb({ printer, flags, args: rest, io });
    // upgrade routes on the context's STORED deploy flavor and delegates to
    // that flavor's deploy verb, so like deploy it owns no WireClient (its own
    // version probe opens and closes a transport itself).
    if (verb === 'upgrade') return await UP.upgradeVerb({ printer, flags, args: rest, io });
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
    V.checkResourceWord(verb, rest);
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
    case 'current': V.ctxCurrent(bundle); return EXIT.OK;
    case 'list': case 'ls': V.ctxList(bundle); return EXIT.OK;
    case 'rm': case 'remove': V.ctxRm(bundle); return EXIT.OK;
    case 'show': V.ctxShow(bundle); return EXIT.OK;
    case 'import': V.ctxImport(bundle); return EXIT.OK;
    case 'test': return await ctxTest(store, flags, printer, io);
    default: throw new CliError(EXIT.USAGE, `unknown ctx subcommand: ${sub || '(none)'} (add/use/current/list/rm/show/import/test)`);
  }
}

const DEPLOY_FLAVORS = [
  { flag: 'ssh', verb: (D2) => D2.deployVerb },
  { flag: 'ssm', verb: (D2) => D2.deploySsmVerb },
  { flag: 'docker', verb: (D2) => D2.deployDockerVerb },
  { flag: 'helm', verb: (D2) => D2.deployHelmVerb },
  { flag: 'fargate', verb: (D2) => D2.deployFargateVerb },
];

const DEPLOY_FLAVOR_USAGE = DEPLOY_FLAVORS.map((f) => `--${f.flag}`).join(' | ');

async function dispatchDeploy(rest, flags, printer, io) {
  V.takeResourceWord(rest, 'deploy', V.DEPLOYABLE);
  const name = rest[1];
  if (!name) throw new CliError(EXIT.USAGE, 'deploy node needs a name (e.g. deploy node mybox --docker)');
  const chosen = DEPLOY_FLAVORS.filter((f) => flags[f.flag]);
  if (chosen.length === 0) throw new CliError(EXIT.USAGE, `deploy node ${name} needs exactly one flavor (${DEPLOY_FLAVOR_USAGE})`);
  if (chosen.length > 1) throw new CliError(EXIT.USAGE, `deploy node ${name}: ${chosen.map((f) => `--${f.flag}`).join(' and ')} are mutually exclusive — pass exactly one (${DEPLOY_FLAVOR_USAGE})`);
  await chosen[0].verb(D)({ printer, flags, args: [name], io });
  return EXIT.OK;
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

// PARSE_OPTS is exported for the in-process REPL (ctl-service.js), which parses
// the same lines this dispatcher does. A second copy of the flag table there
// would drift silently, and the failure mode is invisible: a flag the terminal
// CLI honours parsed as a positional in the REPL.
module.exports = { run, TOP_VERBS, SPECIAL_VERBS, PARSE_OPTS, RENAMED_VERBS, RENAMED_SECOND, renamedLine, renamedSecondLine, renamedPointer, findDeletedJsonFlag, applyOutput, OUTPUT_FORMATS };
