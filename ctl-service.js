// ctl-service.js — an in-process clodexctl REPL for the drawer's `ctl` tab.
// Loads the CLI's own modules (contexts/verbs/transport/client) and runs a
// typed command line against ONE warm resolved context, returning a BLOCK:
// { command, output, exitCode, ctx, ts }.
//
// MAIN-PROCESS, and that is the security property, not a layering preference:
// ~/.clodex/cli/contexts.json holds TOKENS. A renderer-side client would pull
// token material into the renderer to gain nothing — the renderer sends a
// command string and receives rendered text. The other half of the boundary is
// at IPC REGISTRATION (ipc-handlers' enableDrawerServices gate), because
// web-host dispatches any registered channel by name.
//
// Electron-free by construction — no electron import anywhere in this file or
// the CLI modules it loads, so the service is unit-testable and survives being
// required from a plain node host. Pinned by ctl-service.test.js.
'use strict';

const crypto = require('crypto');

// The CLI tree is required LAZILY (first run()) — it pulls deploy/upgrade/cloud
// modules that a Clodex launch which never opens the ctl tab should not pay for.
let cli = null;
function loadCli() {
  if (cli) return cli;
  cli = {
    contexts: require('./cli/src/contexts'),
    V: require('./cli/src/verbs'),
    errors: require('./cli/src/errors'),
    output: require('./cli/src/output'),
    client: require('./cli/src/client'),
    transport: require('./cli/src/transport'),
    args: require('./cli/src/args'),
    help: require('./cli/src/help'),
    // PARSE_OPTS comes from the CLI's own dispatcher rather than a copy here:
    // a second flag table would drift silently, and the failure mode is a flag
    // the terminal CLI honours being parsed as a positional in the REPL.
    main: require('./cli/src/main'),
  };
  return cli;
}

// The allowlist. ENFORCED HERE, never in the pane: the renderer's copy of this
// list would be a UI affordance, and the pane is not the boundary.
//
// THIS TABLE IS NOT A SECURITY BOUNDARY, and reasoning about it as one leads
// straight to a wrong edit. `exec` is admitted, so `exec box "clodexctl kill x
// --force"` is typeable: nothing here contains what the operator can reach. The
// boundary is enableDrawerServices at IPC registration (ipc-handlers.js), which
// keeps this whole family off the web surface. What this table is, is a guard
// against a SLIP at a live prompt with ↑-history.
//
// "It mutates" was the earlier criterion and it was wrong on its own terms:
// the console is desktop-only, dials a context the operator configured, and
// sits one tab away from a shell running the same binary unrestricted, so
// refusing `run` bought nothing and cost the tab its point.
//
// Two prongs decide the line, and BOTH are needed — prong 1 alone would admit
// `kill --force`, which is perfectly block-shaped:
//
// 1. SHAPE. A block is a value that resolves once, carries its own output, and
//    cannot be interrupted from inside. Excluded:
//      attach          — a live terminal, not a value; the term tab is for this
//      logs --follow   — streams until interrupted (refused by flag, below)
//      deploy/undeploy/upgrade/port-forward/web
//                      — long children, interactive prompts, or servers that
//                        never return
//
// 2. UNRECOVERABLE *and* unconfirmable here. The injected `prompt` rejects, so
//    admitting these would admit the --force spelling ONLY — the CLI's
//    deliberate scripted path, offered at a prompt where ↑+Enter re-runs it.
//      kill            — hard delete on the engine, no resume
//      restart-app     — relaunches the engine and every session on it
//    The line is session-survives-and-transcript-survives, not
//    "mutates": `restart --fresh` IS admitted and unconfirmed, and it does lose
//    conversation continuity — but the session and its transcript are still
//    there afterwards, and `spawn`/`send`/`input` are likewise recoverable.
const ALLOWED = Object.freeze({
  info: true,
  sessions: true,
  query: true,
  logs: true,          // `--follow` refused separately — the flag is the problem
  skills: true,
  send: true,
  input: true,
  exec: true,
  run: true,
  spawn: true,
  restart: true,
  ctx: '*',            // every subcommand (`use` is the stateful payoff)
  args: ['get', 'set'],
});
const DEFERRED_HINT = 'not available here: attach, kill, restart-app, deploy, undeploy, upgrade, port-forward, web';

// `help` is deliberately ABSENT from that table and is not an omission. Help
// short-circuits in execute() ahead of the gate, so it never reaches refuse()
// and an entry here would be dead code — worse, it would read as though the
// runner had been widened by a verb. It is pure local rendering off help.js's
// registry: no context resolution, no dial, nothing to contain. Adding it back
// changes no behaviour and makes the allowlist overstate what runs.

// Verbs that run against the local contexts file and need NO wire client.
const CTX_SUBS = ['add', 'use', 'list', 'ls', 'rm', 'remove', 'show', 'import', 'test'];

// Split a typed line into argv. Honours single/double quotes and backslash
// escapes so `query --kind foo "two words"` arrives as the CLI would see it.
// Deliberately NOT a shell: no globbing, no substitution, no operators — the
// line never reaches a shell, so there is nothing here to inject into.
function tokenize(line) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) throw new Error(`unbalanced ${quote === '"' ? 'double' : 'single'} quote`);
  if (has) out.push(cur);
  return out;
}

// Is this argv allowed? Returns null when fine, else the refusal message.
function refuse(argv) {
  const verb = argv[0];
  // An EMPTY verb is not an empty line: `"" sessions` tokenizes to ['', …], and
  // a `!verb` test treats it as "nothing typed" and lets it through to a
  // handler lookup that finds nothing. Only a genuinely absent slot is a
  // no-command line.
  if (verb == null) return null;
  if (verb === '') return `refused: "" is not a verb (${DEFERRED_HINT})`;
  const rule = Object.prototype.hasOwnProperty.call(ALLOWED, verb) ? ALLOWED[verb] : undefined;
  if (rule === undefined) return `refused: "${verb}" is not available in the ctl tab (${DEFERRED_HINT})`;
  if (rule === '*') return null;
  if (rule === true) return null;
  const sub = argv[1];
  if (!Array.isArray(rule)) return null;
  if (!sub) return `refused: "${verb}" needs a subcommand (${rule.join('/')} here)`;
  if (!rule.includes(sub)) return `refused: "${verb} ${sub}" is not available in the ctl tab (${DEFERRED_HINT})`;
  return null;
}

// The identity of a resolved context for warm-connection purposes. Two commands
// share a transport only when every field that shapes the dial matches AND the
// bearer is the same token — a `ctx use`, a `--ctx`, or a bare `--token` between
// them changes this string and forces a re-dial.
//
// The token is HASHED, not compared raw and not reduced to "set": reduced to a
// boolean, `sessions --token T2` at the same URL keys identically to T1 and
// reuses a client bearing the OLD bearer, sending a request under one identity
// while the block's provenance claims the other. Hashed rather than embedded so
// the key never becomes a token carrier if it is ever logged or serialized.
function ctxKey(ctx) {
  const { name, token, ...dial } = ctx;
  const id = token ? crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16) : 'none';
  return JSON.stringify({ dial, token: id });
}

// Tokens shorter than this are NOT folded into the scrub. A 1-char (or empty)
// token in the store would otherwise match nearly every character of every
// block and redact the whole pane — containment that destroys the output it is
// protecting. A token that short is not a credential worth the tradeoff.
const MIN_SCRUBBABLE_TOKEN = 8;

// The block cap, in characters. Every stage past done() copies the block whole
// — a scrub pass per stored token, a structured clone over IPC, an escaped DOM
// node — and the pane then RETAINS up to MAX_BLOCKS of them and re-concatenates
// the lot on Copy. 256K is roughly a screenful of `logs --tail` an order of
// magnitude over, which is the largest output worth reading in a drawer strip.
const MAX_BLOCK_CHARS = 256 * 1024;
const TRUNCATION_NOTE = '\n… output truncated at 256KB — run it from the Terminal tab for the whole stream\n';

// A copy of the store with every token replaced by the same marker `ctx show`
// uses. A COPY: mutating the loaded store in place would hand a redacted entry
// to a later `ctx add`, which persists the store — writing `'***'` over a real
// token in ~/.clodex/cli/contexts.json.
function redactStore(store) {
  const contexts = {};
  for (const [name, entry] of Object.entries((store && store.contexts) || {})) {
    contexts[name] = entry && entry.token ? { ...entry, token: '***' } : entry;
  }
  return { current: store ? store.current : null, contexts };
}

// `openTransport` is a seam so the warm-connection invariants are testable
// without an ssh child or a live node — the dial is the one thing a unit test
// cannot stand up, and it is exactly where the token-identity rule lives.
function createCtlService({ contextsFile = null, env = process.env, openTransport = null } = {}) {
  // NULLISH → undefined, and this is load-bearing rather than tidiness. The CLI
  // resolves the default path through a PARAMETER DEFAULT
  // (`contexts.load(file = contextsPath())`), which `undefined` triggers and
  // `null` does not: a null argument reaches fs.readFileSync and throws, and
  // loadStore's catch turns that into an empty store, so every command reports
  // "no context selected" against a contexts.json that is present and correct.
  // The host constructs this service with `{}`, so the null default IS the
  // production path — and every test passes an explicit file, which is why the
  // suite never saw it.
  const ctxFile = contextsFile == null ? undefined : contextsFile;
  // ONE warm connection: { key, ctx, transport, client }. The whole point of a
  // REPL over the CLI is not re-resolving and re-dialing per command.
  let warm = null;
  // Commands are serialized: two overlapping runs would race the warm slot and
  // could close a transport the other is mid-request on.
  let chain = Promise.resolve();
  // dispose() LATCHES. Without it a run() arriving after shutdown re-dials and
  // spawns a fresh ssh/tunnel child while the app is quitting — precisely the
  // orphaned child holding a local port that engine.js's shutdown call exists
  // to prevent.
  let disposed = false;

  function closeWarm() {
    if (!warm) return;
    try { warm.transport.close(); } catch {}
    warm = null;
  }

  function loadStore() {
    const { contexts } = loadCli();
    try { return contexts.load(ctxFile, { warn: () => {} }); }
    catch { return { current: null, contexts: {} }; }
  }

  // The name shown on the block's prompt line. Best-effort: a broken or absent
  // contexts file must not stop a command from reporting its own failure.
  function currentName() {
    try { return loadStore().current || null; } catch { return null; }
  }

  // Every token this LINE could have put on screen, not merely the one it
  // resolved. Two paths made a resolved-token-only scrub dead by construction:
  // the dial can throw BEFORE a token is in hand (relaying a child's stderr,
  // which may quote the argv it failed on), and the ctx path never resolves one
  // at all while printing the store. So the fold covers the store as well.
  function scrubbableTokens(resolved) {
    const seen = new Set();
    const add = (t) => {
      if (typeof t === 'string' && t.length >= MIN_SCRUBBABLE_TOKEN) seen.add(t);
    };
    add(resolved);
    try { for (const e of Object.values(loadStore().contexts || {})) add(e && e.token); } catch {}
    return [...seen];
  }

  // THE ONLY EXIT from execute(). It scrubs the VALUE being returned — the
  // previous shape scrubbed in a `finally`, which runs after the return
  // expression is evaluated, so the block had already captured the unscrubbed
  // string and rebinding the local changed nothing (JS strings are values).
  // Anything that returns a block around this helper reintroduces that bug.
  //
  // It also CAPS the block, and that is not defensive tidiness: `exec` (and
  // `run` against a bash session, which routes into it) accumulates every
  // output frame with no byte limit — its only ceiling is a 30s timer the
  // operator can raise with --timeout. `exec box "cat big.log"` therefore
  // arrives here as hundreds of MB, and every stage downstream copies it whole:
  // a scrub pass per stored token, a structured clone across IPC, an escaped
  // DOM node, then retention in the pane's 200-block model. The Terminal tab
  // survives the same command because xterm has a scrollback cap and
  // backpressure; a block has neither, which is exactly why the cap belongs
  // here rather than being argued away as "a shell is one tab away".
  function done(text, exitCode, ctxLabel, resolvedToken) {
    const { client: C } = loadCli();
    let out = String(text == null ? '' : text);
    const tokens = scrubbableTokens(resolvedToken);
    const over = out.length > MAX_BLOCK_CHARS;
    // Pre-slice bounds the WORK, not just the value: scrub is a split/join per
    // token, so capping afterwards would still pay a full-length copy per token
    // on a string that may be hundreds of MB. The +margin keeps an occurrence
    // that straddles the cap intact so scrub can still match it, rather than
    // shredding it into an unmatchable prefix.
    //
    // The FINAL cut-back is the actual guarantee, and it is not redundant with
    // the margin above (verified: removing it leaks, removing the margin does
    // not). Scrub SHRINKS the string — every hit becomes '***' — so a token
    // that sat safely past the cap slides under it, and the cut lands
    // mid-token, leaving a PREFIX that scrub can no longer match. Discarding
    // the last `margin` characters removes it by construction: a partial is at
    // most margin-1 long and always ends at the string's end. Cheap, because by
    // then the string is already short.
    const margin = tokens.reduce((m, t) => Math.max(m, t.length), 0);
    if (over) out = out.slice(0, MAX_BLOCK_CHARS + margin);
    for (const t of tokens) out = C.scrub(out, t);
    if (over) {
      out = out.slice(0, Math.min(MAX_BLOCK_CHARS, Math.max(0, out.length - margin))) + TRUNCATION_NOTE;
    }
    return { output: out, exitCode, ctx: ctxLabel };
  }

  async function wireFor(flags) {
    const { contexts, client: C, transport: T } = loadCli();
    const ctx = contexts.resolve(loadStore(), { ctxName: flags.ctx || null, env, flags });
    const key = ctxKey(ctx);
    if (warm && warm.key === key) return warm;
    closeWarm();
    const t = await (openTransport || T.openTransport)(ctx);
    warm = { key, ctx, transport: t, client: new C.WireClient(t.baseUrl, ctx.token) };
    return warm;
  }

  async function execute(line) {
    const { V, errors, output, args: A, main, help: H } = loadCli();
    const { CliError, EXIT } = errors;
    let buf = '';
    const write = (s) => { buf += s; };
    const printer = output.makePrinter(write);
    // `stderr` is injected for the same reason the design named verbs.js's
    // `warn` fallback: a verb that writes diagnostics must land them in THIS
    // block, not on the Electron main process's stderr where nobody sees them.
    const stderr = write;
    // `prompt` is injected so that a verb reaching for an interactive answer
    // fails loudly instead of falling back to defaultPrompt, which opens
    // readline on the main process's stdin — a hang with no UI to break it.
    const prompt = () => Promise.reject(new CliError(EXIT.USAGE, 'this command wants an interactive answer; the ctl tab cannot prompt'));
    const io = { env, contextsFile: ctxFile, stderr, prompt };

    let argv;
    try { argv = tokenize(line); }
    catch (e) { return done(`clodexctl: ${e.message}\n`, EXIT.USAGE, currentName()); }
    if (argv.length === 0) return done('', EXIT.OK, currentName());

    let flags;
    try { flags = A.parse(argv, main.PARSE_OPTS); }
    catch (e) {
      return done(`clodexctl: ${e.message}\n`, e instanceof CliError ? e.exitCode : EXIT.USAGE, currentName());
    }
    // Help routing, BEFORE the allowlist gate and before any context
    // resolution or dial — the same short-circuit main.js does. Ahead of the
    // gate because `exec --help` must EXPLAIN the verb this tab refuses to
    // run; refusing the explanation too leaves no way to learn why. Ahead of
    // the flags-only refusal because bare `--help` is the index, not an empty
    // line. Without it the flag is ignored entirely and `sessions --help`
    // opens a WireClient and returns live session data.
    if (flags.help || flags._[0] === 'help') {
      const tokens = flags._[0] === 'help' ? flags._.slice(1) : flags._;
      const { text, code } = H.help(tokens);
      return done(`${text}\n`, code, currentName());
    }

    // The gate reads PARSED POSITIONALS, never the raw argv. `--json sessions`
    // and `sessions` are the same command and only the parsed form says so; a
    // raw-argv gate refuses the first as a verb named "--json". A flag that
    // consumes a token (`--url exec`) likewise moves the real verb, and the
    // positionals are what track it.
    const denied = refuse(flags._);
    if (denied) return done(`clodexctl: ${denied}\n`, EXIT.USAGE, currentName());
    // `logs` is allowed; `logs --follow` is not, and the flag is the whole
    // reason. A block resolves ONCE — follow streams until interrupted, so it
    // would hold the chain open forever and print nothing until it was
    // cancelled. Refused here rather than in ALLOWED because the gate keys on
    // verbs and this is a flag on an otherwise fine one.
    if (flags._[0] === 'logs' && flags.follow) {
      return done('clodexctl: `logs --follow` streams and never returns — a block resolves once. Use `logs <name> --tail N` here, or follow it from the Terminal tab.\n', EXIT.USAGE, currentName());
    }
    // A line that is all flags (`--tunnel …` eats the rest greedily) leaves no
    // verb at all. Say so, rather than falling through to a handler lookup on
    // `undefined`.
    if (flags._.length === 0) {
      return done(`clodexctl: no verb in that line (flags only)\n`, EXIT.USAGE, currentName());
    }

    const verb = flags._[0];
    const rest = flags._.slice(1);
    let token = null;
    try {
      if (verb === 'ctx') {
        const out = await runCtx(rest, { flags, printer, io, V, errors });
        return done(buf, out, currentName());
      }
      const w = await wireFor(flags);
      token = w.ctx.token || null;
      // `args` is the one family whose SUBCOMMAND picks the handler, and the
      // sub is dropped from args before the verb sees it (the CLI's dispatcher
      // does the same) — argsGet/argsSet both read args[0] as the session name.
      //
      // A LOOKUP rather than a `set ? … : argsGet` ternary, deliberately: the
      // ternary's default arm turns a sub added to ALLOWED.args into a silent
      // READ, which is the failure that shows a plausible success block for a
      // write that never happened. An unmapped sub lands on the
      // `typeof handler !== 'function'` guard below and says so.
      const argsSubs = { get: V.argsGet, set: V.argsSet };
      const handler = verb === 'args'
        ? (argsSubs[rest[0]] && (({ client, ...b }) => argsSubs[rest[0]]({ client, ...b, args: rest.slice(1) })))
        : {
          info: V.info, sessions: V.sessions, query: V.query, logs: V.logs,
          skills: V.skills, send: V.send, input: V.input, exec: V.exec,
          run: V.run, spawn: V.spawn, restart: V.restart,
        }[verb];
      // A verb name that survived the allowlist but has no handler is a
      // programming error, not operator input — say so instead of dying with
      // "handler is not a function" three frames down.
      if (typeof handler !== 'function') {
        return done(`clodexctl: no handler for "${verb}"\n`, EXIT.USAGE, currentName(), token);
      }
      await handler({ client: w.client, ctx: w.ctx, printer, flags, args: rest, prompt, stderr, io });
      return done(buf, EXIT.OK, w.ctx.name || currentName(), token);
    } catch (e) {
      // A failed command may have left the transport broken (a dead tunnel
      // child); drop the warm slot so the next command re-dials rather than
      // inheriting the corpse.
      closeWarm();
      buf += `clodexctl: ${e.message}\n`;
      return done(buf, e instanceof CliError ? e.exitCode : EXIT.SERVER, currentName(), token);
    }
  }

  // ctx subverbs are local-file only — no client, no transport. `test` is the
  // one that dials, and it owns that itself.
  async function runCtx(rest, { flags, printer, io, V, errors }) {
    const { CliError, EXIT } = errors;
    const { contexts } = loadCli();
    const sub = rest[0];
    const args = rest.slice(1);
    if (!CTX_SUBS.includes(sub || '')) {
      throw new CliError(EXIT.USAGE, `unknown ctx subcommand: ${sub || '(none)'} (${CTX_SUBS.join('/')})`);
    }
    const store = loadStore();
    const saveStore = (s) => contexts.save(s, ctxFile);
    const bundle = { store, saveStore, printer, flags, args, env };
    switch (sub) {
      case 'add': V.ctxAdd(bundle); break;
      case 'use': V.ctxUse(bundle); break;
      // `ctx list --json` prints entries VERBATIM (cli/src/verbs.js's ctxList),
      // tokens included, while `ctx show` redacts — an asymmetry that is
      // harmless writing to your own tty and is not harmless writing into
      // renderer DOM and the Copy payload. So this arm gets a redacted COPY of
      // the store. Redacted, not refused: the listing is what the operator
      // asked for, and `'***'` still answers "is a token set?".
      //
      // Here rather than in cli/src/verbs.js on purpose: the terminal CLI
      // printing your own tokens to your own terminal is a different threat
      // model, and changing shared CLI output is a wider blast radius than this
      // tab owns. MF1's fold is a second layer under this, not a substitute.
      case 'list': case 'ls': V.ctxList({ ...bundle, store: redactStore(store) }); break;
      case 'rm': case 'remove': V.ctxRm(bundle); break;
      case 'show': V.ctxShow(bundle); break;
      case 'import': V.ctxImport(bundle); break;
      case 'test': return await ctxTest(store, { flags, printer, io });
    }
    // Any ctx write can change what `current` resolves to, so the warm
    // connection is no longer known-good for the next command. Dropping it is
    // the cheap correct move; wireFor re-dials only if the key really changed.
    if (sub !== 'list' && sub !== 'ls' && sub !== 'show') closeWarm();
    return EXIT.OK;
  }

  async function ctxTest(store, { flags, printer }) {
    const { contexts, client: C, transport: T, errors, V } = loadCli();
    const ctx = contexts.resolve(store, { ctxName: flags.ctx || null, env, flags });
    if (flags.verbose) printer.line(`transport: ${V.entryKind(ctx)} ${V.entryTarget(ctx)}`);
    let t;
    try { t = await (openTransport || T.openTransport)(ctx); }
    catch (e) { printer.line('FAIL — could not open transport'); throw e; }
    try {
      if (flags.verbose) printer.line(`base: ${t.baseUrl}`);
      const client = new C.WireClient(t.baseUrl, ctx.token);
      const hello = await client.get('/api/peer/hello', 'ctx test');
      printer.line(`OK — ${hello.app || 'clodex'} host=${hello.host || '?'} version=${hello.version || '?'} caps=[${(hello.caps || []).join(' ')}]`);
      return errors.EXIT.OK;
    } finally {
      try { t.close(); } catch {}
    }
  }

  return {
    // One block per line. Serialized through `chain` so the warm slot has a
    // single writer; a rejected run must not poison the chain for the next.
    run(line) {
      const cmd = String(line == null ? '' : line);
      if (disposed) {
        return Promise.resolve({ command: cmd, output: 'clodexctl: the ctl service is shutting down\n', exitCode: 2, ctx: null, ts: Date.now() });
      }
      const next = chain.then(() => execute(cmd));
      chain = next.catch(() => {});
      return next.then((r) => ({
        command: String(line == null ? '' : line),
        output: r.output,
        exitCode: r.exitCode,
        ctx: r.ctx,
        ts: Date.now(),
      }));
    },
    // The prompt line's context name, without running a command.
    context() { return currentName(); },

    // The tab's own cheat sheet: the verbs this service will RUN, joined to
    // help.js's registry for their summaries. DERIVED from ALLOWED rather than
    // written out, because a hand-kept list in the renderer is the thing that
    // drifts — the pane would keep advertising a verb after the allowlist
    // dropped it, or hide one it gained. The CLI's own index is the wrong thing
    // to show here for the same reason in reverse: it lists verbs this console
    // refuses, without saying which.
    //
    // Data, not markup: the renderer escapes and lays it out. Carries no token
    // and no context, so it needs no scrub.
    helpIndex() {
      const { help: H } = loadCli();
      const byName = new Map(H.VERB_REGISTRY.map((e) => [e.name, e]));
      const rows = [];
      for (const [verb, rule] of Object.entries(ALLOWED)) {
        const entry = byName.get(verb);
        // `subs` is what the pane shows for a family the allowlist spells as a
        // subcommand array — today `args`, with both subs admitted. The
        // mechanism stays wired while nothing is narrowed so that a future
        // narrowing shows the surviving subs rather than the registry's full
        // usage line, which would advertise a sub that no longer runs.
        const subs = Array.isArray(rule) ? rule.slice() : null;
        rows.push({
          verb,
          subs,
          usage: entry ? entry.usage : null,
          summary: entry ? entry.summary : '',
        });
      }
      rows.sort((a, b) => a.verb.localeCompare(b.verb));
      return { verbs: rows, deferred: DEFERRED_HINT };
    },
    dispose() { disposed = true; closeWarm(); },
  };
}

module.exports = { createCtlService, tokenize, refuse, ALLOWED, CTX_SUBS, MAX_BLOCK_CHARS };
