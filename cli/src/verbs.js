// verbs.js — one function per verb. Two families:
//
//   ctx*   — local contexts-file operations (no wire). Take a { store, save,
//            printer, ... } bundle.
//   wire*  — HTTP verbs. Take a { client, printer, flags, args } bundle where
//            `client` is a ready WireClient (transport already opened by main).
//
// Read verbs honor --json: print the raw wire payload verbatim so it stays a
// stable machine binding. Human output is compact, emoji-free.
'use strict';

const readline = require('readline');
const { CliError, EXIT } = require('./errors');
const out = require('./output');
const imp = require('./import');
const { validateEntry } = require('./contexts');
const { openGuarded } = require('./sse-guard');

// ── read verbs ────────────────────────────────────────────────────────────

async function info({ client, printer, flags }) {
  const hello = await client.get('/api/peer/hello', 'info');
  if (flags.json) printer.json(hello);
  else printer.line(out.renderInfo(hello));
}

async function sessions({ client, printer, flags }) {
  const body = await client.get('/api/sessions', 'sessions');
  if (flags.json) printer.json(body);
  else printer.line(out.renderSessions(body.sessions || []));
}

async function logs({ client, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'logs');
  const q = flags.tail ? `?limit=${encodeURIComponent(parseIntOr(flags.tail, 'tail'))}` : '';
  const body = await client.get(`/api/transcript/${encodeURIComponent(name)}${q}`, 'logs');
  const messages = body.messages || [];
  if (flags.follow) return logsFollow({ client, printer, flags, name, initial: body, messages, io });
  if (flags.json) printer.json(body);
  else printer.line(out.renderTranscript(messages));
}

// logs --follow — kubectl-parity follow. Print the current tail, then subscribe
// to /api/events; on an `activity` frame for NAME, refetch the transcript and
// print only the entries newer than our snapshot (the same delta machinery
// sendWait uses — deltaFrom). --json streams NDJSON (one object per new entry),
// not a growing array. Shares the 60s staleness watchdog + bounded reconnect
// with attach (sse-guard). Ctrl-C exits 0 — it's a pager, not a failure; a
// non-TTY stdout is fine (piping into grep is the point).
async function logsFollow({ client, printer, flags, name, initial, messages, io }) {
  // Emit the tail first, same shape as a one-shot logs. In --json each ENTRY is
  // its own NDJSON object (a stream can't be one growing array).
  if (flags.json) { for (const m of messages) printer.json(m); }
  else if (messages.length) printer.line(out.renderTranscript(messages));

  let snapshot = messages.length;   // running entry-count watermark
  let refetching = false;           // coalesce overlapping activity frames
  let pending = false;

  const emit = (fresh) => {
    if (!fresh.length) return;
    if (flags.json) { for (const m of fresh) printer.json(m); }
    else printer.line(out.renderTranscript(fresh));
  };

  const refetch = async () => {
    if (refetching) { pending = true; return; }
    refetching = true;
    try {
      const after = await client.get(`/api/transcript/${encodeURIComponent(name)}?limit=500`, 'logs -f (refetch)');
      const all = after.messages || [];
      const fresh = deltaFrom(all, snapshot);
      snapshot = all.length;
      emit(fresh);
    } finally {
      refetching = false;
      if (pending) { pending = false; refetch(); }
    }
  };

  return new Promise((resolve, reject) => {
    let done = false;
    const term = io.tty || null;
    let offSignal = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      try { if (offSignal) offSignal(); } catch {}
      try { guard.close(); } catch {}
      if (err) reject(err); else resolve();
    };
    const onSig = () => finish(null);   // Ctrl-C / SIGTERM → clean exit 0
    if (term && term.onSignal) offSignal = term.onSignal(onSig);
    else { process.on('SIGINT', onSig); process.on('SIGTERM', onSig); offSignal = () => { process.off('SIGINT', onSig); process.off('SIGTERM', onSig); }; }

    const guard = openGuarded(client, '/api/events', 'logs -f (events)', {
      // On (re)connect, silently re-snapshot to the current length so a
      // reconnect never re-prints old lines (no gap markers in v1).
      onOpen: async () => {
        const snap = await client.get(`/api/transcript/${encodeURIComponent(name)}?limit=500`, 'logs -f (resnapshot)');
        snapshot = (snap.messages || []).length;
      },
      onEvent: (event, data) => {
        if (event !== 'activity' || !data || data.name !== name) return;
        refetch();
      },
      onGiveUp: (err) => finish(err),
    });
  });
}

// The transcript entries newer than a count watermark. Shared by sendWait
// (which then skips to the first assistant) and logs -f (which prints all).
function deltaFrom(msgs, snapshot) {
  return (msgs || []).slice(snapshot);
}

const QUERY_KINDS = new Set(['ctx', 'report', 'bust', 'files', 'filePeek', 'fileDiff']);
async function query({ client, printer, flags, args }) {
  const name = requireName(args[0], 'query');
  const kind = args[1];
  if (!QUERY_KINDS.has(kind)) {
    throw new CliError(EXIT.USAGE, `query kind must be one of: ${[...QUERY_KINDS].join(', ')}`);
  }
  const qargs = {};
  if (flags.path) qargs.path = String(flags.path);
  if (flags.detail) qargs.detail = true;
  const body = await client.post(`/api/query/${encodeURIComponent(name)}`, 'query', { kind, args: qargs });
  // Always JSON — the query payloads are structured telemetry with no compact
  // human form worth inventing; --json is documented as the shape.
  printer.json(body);
}

async function argsGet({ client, printer, flags, args }) {
  const name = requireName(args[0], 'args get');
  const body = await client.get(`/api/session-args/${encodeURIComponent(name)}`, 'args get');
  printer.json(body);
}

async function skills({ client, printer, args }) {
  const name = requireName(args[0], 'skills');
  const body = await client.get(`/api/skill-catalog/${encodeURIComponent(name)}`, 'skills');
  printer.json(body);
}

// ── write verbs ─────────────────────────────────────────────────────────────

async function spawn({ client, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'spawn');
  const body = { name };
  if (flags.cwd) body.cwd = String(flags.cwd);
  if (flags.type) body.type = String(flags.type);
  // Model is not a wire create field — it rides extraArgs, same as any raw CLI
  // flag. --arg is a repeatable raw passthrough (accumulated by the parser).
  const extra = [];
  if (flags.model) extra.push('--model', String(flags.model));
  if (Array.isArray(flags.arg)) extra.push(...flags.arg);
  else if (flags.arg) extra.push(String(flags.arg));
  if (extra.length) body.extraArgs = extra;
  if (flags.fork) body.fork = true;
  const res = await client.post('/api/sessions', 'spawn', body);
  // Post-spawn liveness (the silent-death fix): a child that dies on execvp —
  // e.g. its CLI isn't on the node's PATH (a fresh OS-flavor deploy) — STILL
  // returns a pid, then the session vanishes from the engine with no hint. Wait a
  // beat, then look for the name in the live list: gone → it was dead-on-arrival,
  // so say WHY instead of reporting a pid the caller can't use. A read failure
  // leaves `alive` unknown (null) — never turn a transient blip into a scary lie.
  const type = res.type || flags.type || null;
  const alive = await spawnAlive(client, res.name || name, io.sleepFn);
  if (flags.json) { printer.json({ ...res, alive }); return; }
  if (alive === false) {
    printer.line(`spawned ${res.name || name} (${type || '?'})${res.pid ? ` pid=${res.pid}` : ''} — but it exited immediately (gone from the engine).`);
    if (type && type !== 'bash') {
      printer.line(`  likely the \`${type}\` CLI isn't installed on the node — a native OS-flavor deploy provisions the engine only. Check with \`clodexctl sessions\`; re-run \`clodexctl deploy …\` to (re)install the agent CLIs.`);
    }
    return;
  }
  printer.line(`spawned ${res.name || name} (${type || '?'})${res.pid ? ` pid=${res.pid}` : ''}${res.warnings && res.warnings.length ? `\nwarnings: ${res.warnings.join('; ')}` : ''}`);
}

// Is the just-spawned session still alive a beat later? Returns true (present),
// false (absent — dead on arrival), or null (couldn't tell — a read error, so
// the caller stays optimistic). A single short-delayed check keeps the added
// latency bounded; sleepFn is the test seam (a no-op skips the wall-clock wait).
const SPAWN_LIVENESS_DELAY_MS = 600;
async function spawnAlive(client, name, sleepFn) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    await sleep(SPAWN_LIVENESS_DELAY_MS);
    const body = await client.get('/api/sessions', 'spawn liveness');
    const list = body.sessions || [];
    return list.some((s) => s && s.name === name);
  } catch { return null; }
}

async function send({ client, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'send');
  const text = args.slice(1).join(' ').trim();
  if (!text) throw new CliError(EXIT.USAGE, 'send needs message text');
  if (flags.wait) return sendWait({ client, printer, flags, args, name, text, io });
  const res = await client.post('/api/send', 'send', { name, text });
  if (flags.json) printer.json(res);
  else printer.line(`sent to ${name} (fire-and-forget)`);
}

// Look up a session's AUTHORITATIVE type from the engine (one GET /api/sessions).
// Never guess from the name — the engine's session list is ground truth (a bash
// session named like an agent, or vice versa, can't confuse us). A miss →
// NOTFOUND, listing the running names as a cheap near-miss aid.
async function sessionType(client, name) {
  const body = await client.get('/api/sessions', 'session lookup');
  const list = body.sessions || [];
  const found = list.find((s) => s && s.name === name);
  if (!found) {
    const names = list.map((s) => s && s.name).filter(Boolean);
    const hint = names.length ? ` — running: ${names.join(', ')}` : '';
    throw new CliError(EXIT.NOTFOUND, `no such session: ${name}${hint}`);
  }
  return found.type || '';
}

// run — THE verb for "make this session do something and show me the result".
// It looks up the destination's authoritative type and ROUTES: a bash session →
// the exec (PTY) path (keystrokes + Enter, collect screen output); any agent
// (claude/codex/anything not bash) → the send --wait path (DM in, await the
// turn's end, print the transcript delta). "Run" ALWAYS executes — a bash
// command runs, an agent prompt is sent and awaited — so --no-enter is not run's
// to choose (use `input` for raw partial keystrokes). --json carries
// `mode:"agent"|"pty"` so a script can tell which path ran. Routing is binary
// on `type === 'bash'`, not a claude/codex whitelist: a future agent type still
// routes to the safe send-wait path, never accidentally into raw TUI typing.
async function run({ client, printer, flags, args, stderr, io = {} }) {
  const name = requireName(args[0], 'run');
  const text = args.slice(1).join(' ').trim();
  if (!text) throw new CliError(EXIT.USAGE, 'run needs text — a prompt for an agent, or a command for a bash session');
  const type = await sessionType(client, name);
  if (type === 'bash') {
    // Reuse exec's PTY path verbatim; knownType skips its own lookup + guardrail.
    return exec({ client, printer, flags, args, mode: 'pty', knownType: 'bash', stderr });
  }
  return sendWait({ client, printer, flags, name, text, mode: 'agent', io });
}

// send --wait — deliver, then block until the agent goes IDLE (a matching
// `activity` frame with turnEnd:true on the global events feed) and print the
// transcript entries that landed after our message. HONESTY: --wait means "the
// agent's turn ended", NOT "the agent declared the work done" — a long task
// that parks mid-work still ends its turn. The formal completion contract is
// T38. Watermark = transcript ENTRY COUNT snapshotted before the send; we print
// entries newer than that, starting from the first assistant entry (our own
// echoed user message is excluded). Count-watermark is exact until the
// transcript exceeds the 500-entry fetch cap — acceptable for v1.
async function sendWait({ client, printer, flags, name, text, mode = null, io = {} }) {
  const timeoutMs = (flags.timeout != null ? parseIntOr(flags.timeout, 'timeout') : 300) * 1000;
  // --timeout is a HARD ceiling on the WHOLE verb, not just the wait: the wait
  // phase is capped at timeoutMs and the post-wait refetch at an extra `grace`,
  // so on EVERY transport the process returns by ~timeout+grace even when the
  // engine never emits a turnEnd and even when a fetch wedges on a dead tunnel
  // (a wedged fetch would otherwise hold a socket open AND keep sendWait from
  // returning, so main.js's `finally { t.close() }` never reaps the tunnel
  // child — the twin causes of the live 6-minute hang). io.refetchGraceMs is
  // the test seam (keeps repro tests sub-second).
  const graceMs = io.refetchGraceMs != null ? io.refetchGraceMs : 8000;

  // 1. Open the global events feed and wait until it is live (subscribed).
  let stream = null;
  let settled = false;
  let hardTimer = null;
  let snapshot = 0;
  // Cuts a hung snapshot GET / send POST when the ceiling fires — an aborted
  // fetch rejects and releases its socket, which is what lets node exit.
  const waitAc = new AbortController();
  const waitResult = await new Promise((resolve, reject) => {
    const finish = (fn, v) => { if (settled) return; settled = true; if (hardTimer) clearTimeout(hardTimer); fn(v); };
    // Arm the ceiling BEFORE opening the stream and INDEPENDENT of onOpen — if
    // the stream never reaches 200, or the snapshot/send await hangs, onOpen
    // never reaches a timer of its own, so the ceiling must live out here. On
    // fire: abort the in-flight wait-phase request and settle as a timeout.
    hardTimer = setTimeout(() => { try { waitAc.abort(); } catch {} finish(resolve, { timedOut: true }); }, timeoutMs);
    stream = client.openEventStream('/api/events', 'send --wait (events)', {
      onOpen: async () => {
        try {
          // 2. Snapshot the transcript length BEFORE sending.
          const before = await client.get(`/api/transcript/${encodeURIComponent(name)}?limit=500`, 'send --wait (snapshot)', { signal: waitAc.signal });
          snapshot = (before.messages || []).length;
          // 3. Send.
          await client.post('/api/send', 'send', { name, text }, { signal: waitAc.signal });
        } catch (e) { finish(reject, e); } // a ceiling abort lands here too — finish is then a no-op (already settled)
      },
      // 4. Await a turn-end activity for OUR session; ignore all others.
      onEvent: (event, data) => {
        if (event !== 'activity' || !data || data.name !== name || !data.turnEnd) return;
        finish(resolve, { timedOut: false });
      },
      onError: (e) => finish(reject, e),
    });
  }).catch((e) => { try { if (stream) stream.close(); } catch {} waitAc.abort(); throw e; });
  try { if (stream) stream.close(); } catch {}
  // The wait can settle via onError/turnEnd while a snapshot/send fetch is
  // still wedged in flight; abort it unconditionally or its socket keeps node
  // alive (bin sets exitCode, never exit()). Idempotent, harmless when spent.
  waitAc.abort();

  // 5. Refetch and print entries newer than the snapshot, from the first
  //    assistant entry on (drops our echoed user message + any leading users).
  //    The transcript FLUSH can lag the turnEnd frame slightly (the activity
  //    signal fires before the last assistant text is persisted), so if the
  //    delta has no assistant entry yet, retry a few times with a short backoff
  //    before giving up — we print from the first assistant on, never a bare
  //    echoed-user row. The whole loop is bounded by `grace`: a wedged engine
  //    can hang a single refetch forever, and until sendWait returns the tunnel
  //    child is never reaped, so the deadline aborts the in-flight fetch and we
  //    stop retrying (this is the half of the ceiling the live hang tripped).
  const freshFrom = (msgs) => {
    const delta = deltaFrom(msgs, snapshot);
    const i = delta.findIndex((m) => m.role === 'assistant');
    return i === -1 ? [] : delta.slice(i);
  };
  const refetchAc = new AbortController();
  let graceExpired = false;
  const refetchDeadline = setTimeout(() => { graceExpired = true; try { refetchAc.abort(); } catch {} }, graceMs);
  let fresh = [];
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      let after;
      try {
        after = await client.get(`/api/transcript/${encodeURIComponent(name)}?limit=500`, 'send --wait (refetch)', { signal: refetchAc.signal });
      } catch (e) {
        // Swallow ONLY our own ceiling abort (client rethrows AbortError
        // unwrapped) — a real transport error that merely RACED the deadline
        // still propagates with its honest exit code.
        if (graceExpired && e && e.name === 'AbortError') break;
        throw e;
      }
      fresh = freshFrom(after.messages);
      if (fresh.length || waitResult.timedOut) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally { clearTimeout(refetchDeadline); }

  if (flags.json) {
    printer.json({ ok: !waitResult.timedOut, name, ...(mode ? { mode } : {}), entries: fresh, timedOut: !!waitResult.timedOut });
  } else if (fresh.length) {
    printer.line(out.renderTranscript(fresh));
  }

  if (waitResult.timedOut) {
    throw new CliError(EXIT.SERVER, `send --wait: no end-of-turn within ${Math.round(timeoutMs / 1000)}s — the agent may still be working; check \`logs ${name}\``);
  }
}

// input — keystrokes, wrapped in a control acquire/release so the wire's token
// gate is satisfied (read-only viewers can't type). Best-effort release even if
// the input POST fails. /api/input is a RAW keystroke channel (the GUI xterm
// sends its own \r), so by DEFAULT we append \r — "send a command" means run it.
// --no-enter posts the text verbatim (partial input / key sequences).
async function input({ client, printer, flags, args }) {
  const name = requireName(args[0], 'input');
  const text = args.slice(1).join(' ');
  if (!text) throw new CliError(EXIT.USAGE, 'input needs text to send');
  const data = flags['no-enter'] ? text : text + '\r';
  const acq = await client.post(`/api/control/${encodeURIComponent(name)}`, 'input (acquire control)', { action: 'acquire', client: 'clodexctl' });
  const token = acq.token;
  try {
    const res = await client.post(`/api/input/${encodeURIComponent(name)}`, 'input', { token, data });
    if (flags.json) printer.json(res);
    else printer.line(`input sent to ${name}`);
  } finally {
    try { await client.post(`/api/control/${encodeURIComponent(name)}`, 'input (release control)', { action: 'release', token }); } catch {}
  }
}

// exec — kubectl-exec-for-Clodex: run ONE command in a session's PTY and print
// what the terminal produced. Open the attach SSE FIRST (it registers us as an
// attacher server-side, and holds control alive — the last stream closing
// auto-releases control), acquire control, type cmd+\r, then collect decoded
// `output` frames until the stream goes QUIET (no bytes for --quiet-ms after at
// least one arrived) or --timeout caps the wait. ANSI is stripped by default
// (--raw keeps it). The remote command's EXIT STATUS is unknowable from screen
// bytes — exit 0 means "delivered and went quiet", nothing about the command.
async function exec({ client, printer, flags, args, mode = null, knownType = null, stderr = null }) {
  const name = requireName(args[0], 'exec');
  const cmd = args.slice(1).join(' ');
  if (!cmd) throw new CliError(EXIT.USAGE, 'exec needs a command to run');

  // Guardrail: exec types into the session's RAW TUI screen. On a bash session
  // that's the whole point; on an AGENT it repaints its TUI (Bogdan's "scary"
  // report). So exec on an agent WARNS and refuses unless --pty was chosen —
  // typing into an agent's TUI is legitimate (answering a permission dialog!)
  // but must be deliberate, not stumbled into. `run` reaches exec only for bash
  // (knownType='bash'), skipping this lookup entirely.
  if (knownType !== 'bash' && !flags.pty) {
    const type = knownType != null ? knownType : await sessionType(client, name);
    if (type && type !== 'bash') {
      const warn = stderr || ((s) => process.stderr.write(s));
      warn(`clodexctl: ${name} is a ${type} agent — \`run ${name} …\` sends a prompt and waits; exec types into its TUI screen. Pass --pty to type into it anyway (e.g. to answer a dialog).\n`);
      throw new CliError(EXIT.USAGE, `exec refused on agent "${name}" without --pty`);
    }
  }

  const quietMs = flags['quiet-ms'] != null ? parseIntOr(flags['quiet-ms'], 'quiet-ms') : 750;
  const timeoutMs = (flags.timeout != null ? parseIntOr(flags.timeout, 'timeout') : 30) * 1000;

  let chunks = [];            // decoded output Buffers, in arrival order
  let inputSent = false;      // quiet-gate arms only after the command lands
  let quietTimer = null;
  let hardTimer = null;
  let stream = null;
  let token = null;
  let settled = false;

  const clearTimers = () => { if (quietTimer) clearTimeout(quietTimer); if (hardTimer) clearTimeout(hardTimer); quietTimer = null; hardTimer = null; };

  const outcome = await new Promise((resolve) => {
    const finish = (o) => { if (settled) return; settled = true; clearTimers(); resolve(o); };
    const armQuiet = () => {
      if (!inputSent) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish({ ok: true }), quietMs);
    };

    stream = client.openEventStream(`/api/attach/${encodeURIComponent(name)}`, 'exec (attach)', {
      onOpen: async () => {
        // The whole-wait hard cap starts as soon as the stream is live.
        hardTimer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
        try {
          const acq = await client.post(`/api/control/${encodeURIComponent(name)}`, 'exec (acquire control)', { action: 'acquire', client: 'clodexctl' });
          token = acq.token;
          await client.post(`/api/input/${encodeURIComponent(name)}`, 'exec (input)', { token, data: cmd + '\r' });
          inputSent = true;
          armQuiet(); // in case output already arrived before the input resolved
        } catch (e) { finish({ ok: false, error: e }); }
      },
      onEvent: (event, data) => {
        if (event === 'replay') return;             // scrollback history, not our output
        if (event !== 'output' || !data || typeof data.b64 !== 'string') return;
        chunks.push(Buffer.from(data.b64, 'base64'));
        armQuiet();
      },
      onError: (e) => finish({ ok: false, error: e }),
    });
  });

  // Teardown ALWAYS: release our control token (best-effort), close the stream.
  // The transport (tunnel child) stays alive until main.js's finally close().
  try { if (token) await client.post(`/api/control/${encodeURIComponent(name)}`, 'exec (release control)', { action: 'release', token }); } catch {}
  try { if (stream) stream.close(); } catch {}

  const raw = Buffer.concat(chunks).toString('utf8');
  const text = flags.raw ? raw : out.stripAnsi(raw);
  const timedOut = !!outcome.timedOut;

  if (flags.json) {
    printer.json({ ok: outcome.ok, name, ...(mode ? { mode } : {}), output: text, truncated: timedOut });
  } else if (text) {
    // Print exactly what the terminal produced (echoed command + prompt
    // included — that's honest terminal truth, we don't heuristically strip it).
    printer.line(text.replace(/\n$/, ''));
  }

  // A transport/control failure surfaced as a coded error — propagate it.
  if (outcome.error) throw outcome.error;
  if (timedOut) {
    throw new CliError(EXIT.SERVER, `exec: no quiet within ${Math.round(timeoutMs / 1000)}s — printed partial output (exit reflects delivery, not the remote command's status)`);
  }
  // ok:true — went quiet. Exit reflects delivery, NOT the remote command status.
}

// kill — wire kill is a HARD DELETE (no resume). Say so loudly; confirm unless
// --force. The confirm reads from stdin (a TTY prompt); --json implies scripted
// use, so require --force there rather than block on a prompt.
async function kill({ client, printer, flags, args, prompt = defaultPrompt }) {
  const name = requireName(args[0], 'kill');
  if (!flags.force) {
    if (flags.json) throw new CliError(EXIT.USAGE, 'kill needs --force in --json/non-interactive mode (wire kill is a hard delete, no resume)');
    const ok = await prompt(`kill "${name}"? This is a HARD DELETE on the engine — no resume. Type the name to confirm: `);
    if (String(ok).trim() !== name) throw new CliError(EXIT.USAGE, 'aborted — confirmation did not match');
  }
  const res = await client.post(`/api/kill/${encodeURIComponent(name)}`, 'kill', {});
  if (flags.json) printer.json(res);
  else printer.line(`killed ${res.name || name} (hard delete — not resumable)`);
}

async function restart({ client, printer, flags, args }) {
  const name = requireName(args[0], 'restart');
  const res = await client.post(`/api/restart-session/${encodeURIComponent(name)}`, 'restart', { fresh: !!flags.fresh });
  if (flags.json) printer.json(res);
  else printer.line(`restarted ${name}${flags.fresh ? ' (fresh)' : ' (resume)'}`);
}

// args set — apply a session-args patch. Flags map to the patch keys the owner
// accepts; only provided keys are sent (undefined = untouched, owner-side).
async function argsSet({ client, printer, flags, args }) {
  const name = requireName(args[0], 'args set');
  const patch = {};
  if (Array.isArray(flags.arg)) patch.extraArgs = flags.arg;
  else if (flags.arg) patch.extraArgs = [String(flags.arg)];
  if (flags.proxy != null) patch.proxy = String(flags.proxy);
  if (flags.restart) patch.restart = true;
  if (Object.keys(patch).length === 0) throw new CliError(EXIT.USAGE, 'args set needs at least one of --arg / --proxy / --restart');
  const res = await client.post(`/api/session-args/${encodeURIComponent(name)}`, 'args set', patch);
  if (flags.json) printer.json(res);
  else printer.line(`args applied to ${name}${res.restarted ? ' (respawned)' : ''}`);
}

// restart-app — whole-engine relaunch. Confirm unless --force (it drops the
// wire out from under every client).
async function restartApp({ client, printer, flags, prompt = defaultPrompt }) {
  if (!flags.force) {
    if (flags.json) throw new CliError(EXIT.USAGE, 'restart-app needs --force in --json/non-interactive mode');
    const ok = await prompt('restart the WHOLE engine? All sessions relaunch. [y/N]: ');
    if (!/^y(es)?$/i.test(String(ok).trim())) throw new CliError(EXIT.USAGE, 'aborted');
  }
  const res = await client.post('/api/restart', 'restart-app', {});
  if (flags.json) printer.json(res);
  else printer.line('engine restart requested');
}

// ── ctx verbs (local file) ───────────────────────────────────────────────────

function ctxAdd({ store, saveStore, printer, flags, args }) {
  const name = requireName(args[0], 'ctx add');
  const entry = {};
  if (flags.url) entry.url = String(flags.url);
  if (flags.ssh) entry.ssh = String(flags.ssh);
  if (flags.tunnel) entry.tunnel = Array.isArray(flags.tunnel) ? flags.tunnel : [String(flags.tunnel)];
  // Cloud transport kinds — typed objects (DATA, importable/shareable). Each is
  // exactly one flag family; validateEntry enforces the one-transport rule and
  // the per-kind field requirements.
  if (flags.ssm != null && flags['ssm-ecs'] != null) throw new CliError(EXIT.USAGE, '--ssm and --ssm-ecs are mutually exclusive — pick one');
  if (flags.ssm != null || flags['ssm-ecs'] != null) {
    entry.ssm = {
      ...(flags.ssm != null ? { target: String(flags.ssm) } : { ecs: String(flags['ssm-ecs']) }),
      ...(flags.region ? { region: String(flags.region) } : {}),
      ...(flags.profile ? { profile: String(flags.profile) } : {}),
    };
  }
  if (flags.kubectl != null) {
    entry.kubectl = {
      target: String(flags.kubectl),
      ...(flags.namespace ? { namespace: String(flags.namespace) } : {}),
      ...(flags['kube-context'] ? { context: String(flags['kube-context']) } : {}),
    };
  }
  if (flags['gcloud-iap'] != null) {
    entry.gcloud = {
      instance: String(flags['gcloud-iap']),
      ...(flags.zone ? { zone: String(flags.zone) } : {}),
      ...(flags.project ? { project: String(flags.project) } : {}),
    };
  }
  if (flags['az-bastion'] != null || flags['az-resource-group'] != null || flags['az-target'] != null) {
    entry.az = {
      ...(flags['az-bastion'] != null ? { bastion: String(flags['az-bastion']) } : {}),
      ...(flags['az-resource-group'] != null ? { resourceGroup: String(flags['az-resource-group']) } : {}),
      ...(flags['az-target'] != null ? { target: String(flags['az-target']) } : {}),
    };
  }
  if (flags.remotePort) entry.remotePort = parseIntOr(flags.remotePort, 'remote-port');
  if (flags.token) entry.token = String(flags.token);
  validateEntry(entry);
  store.contexts[name] = entry;
  if (!store.current) store.current = name;
  saveStore(store);
  printer.line(`context "${name}" added${store.current === name ? ' (current)' : ''}`);
}

function ctxUse({ store, saveStore, printer, args }) {
  const name = requireName(args[0], 'ctx use');
  if (!store.contexts[name]) throw new CliError(EXIT.USAGE, `no such context: ${name}`);
  store.current = name;
  saveStore(store);
  printer.line(`current context: ${name}`);
}

function ctxList({ store, printer, flags }) {
  const names = Object.keys(store.contexts);
  if (flags.json) { printer.json({ current: store.current, contexts: store.contexts }); return; }
  if (names.length === 0) { printer.line('(no contexts — add one with `clodexctl ctx add`)'); return; }
  const rows = names.map((n) => {
    const e = store.contexts[n];
    return [n === store.current ? '*' : '', n, entryKind(e), entryTarget(e)];
  });
  printer.line(out.table(['', 'NAME', 'KIND', 'TARGET'], rows));
}

function ctxRm({ store, saveStore, printer, args }) {
  const name = requireName(args[0], 'ctx rm');
  if (!store.contexts[name]) throw new CliError(EXIT.USAGE, `no such context: ${name}`);
  delete store.contexts[name];
  if (store.current === name) store.current = null;
  saveStore(store);
  printer.line(`context "${name}" removed`);
}

// ctx show — the resolved entry, tokens REDACTED (never echo a secret).
function ctxShow({ store, printer, flags, args }) {
  const name = args[0] || store.current;
  if (!name) throw new CliError(EXIT.USAGE, 'ctx show needs a name (or set a current context)');
  const e = store.contexts[name];
  if (!e) throw new CliError(EXIT.USAGE, `no such context: ${name}`);
  const redacted = { ...e };
  if (redacted.token) redacted.token = '***';
  if (flags.json) printer.json({ name, current: store.current === name, ...redacted });
  else {
    printer.line([
      `name        ${name}${store.current === name ? ' (current)' : ''}`,
      `kind        ${entryKind(e)}`,
      `target      ${entryTarget(e)}`,
      e.remotePort ? `remotePort  ${e.remotePort}` : null,
      `token       ${e.token ? '(set)' : '(none)'}`,
    ].filter(Boolean).join('\n'));
  }
}

// ctx import — seed contexts from the LOCAL machine's Clodex userData. Read-only
// on the GUI's files; collisions skip unless --force; --dry-run writes nothing;
// `current` is never touched.
function ctxImport({ store, saveStore, printer, flags, env }) {
  const meta = imp.resolveDataDir({ dataDirFlag: flags['data-dir'], env });
  const candidates = imp.collectCandidates(meta.dir);
  const { store: nextStore, results } = imp.applyImport(store, candidates, { force: !!flags.force });
  const dryRun = !!flags['dry-run'];
  if (!dryRun) {
    // Only write if something actually changed (an all-skip run leaves the file
    // untouched — read-only convenience shouldn't rewrite for nothing).
    if (results.some((r) => r.result === 'added' || r.result === 'overwritten')) saveStore(nextStore);
  }
  if (flags.json) {
    printer.json({
      dataDir: meta.dir, source: meta.source, note: meta.note || null, dryRun,
      results: results.map((r) => ({ name: r.name, result: r.result, tokenState: r.tokenState, reason: r.reason || null })),
    });
  } else {
    printer.line(imp.renderReport(results, { dir: meta.dir, source: meta.source, note: meta.note, dryRun }));
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

// The transport kind label for a stored entry (ctx list/show).
function entryKind(e) {
  if (e.url) return 'url';
  if (e.ssh) return 'ssh';
  if (e.tunnel) return 'tunnel';
  if (e.ssm) return 'ssm';
  if (e.kubectl) return 'kubectl';
  if (e.gcloud) return 'gcloud';
  if (e.az) return 'az';
  return '?';
}

// A one-line HONEST target string per kind (spec §ctx list/show). Renders the
// distinguishing fields so a shared team file reads at a glance; no secrets.
function entryTarget(e) {
  if (e.url) return e.url;
  if (e.ssh) return e.ssh;
  if (e.tunnel) return e.tunnel.join(' ');
  if (e.ssm) {
    if (e.ssm.ecs) return `ecs ${e.ssm.ecs} (resolved at connect)`;
    return `${e.ssm.target}${e.ssm.region ? ` (${e.ssm.region})` : ''}`;
  }
  if (e.kubectl) return `${e.kubectl.target}${e.kubectl.namespace ? ` -n ${e.kubectl.namespace}` : ''}`;
  if (e.gcloud) return `${e.gcloud.instance}${e.gcloud.zone ? ` (${e.gcloud.zone})` : ''}`;
  if (e.az) {
    const vm = String(e.az.target || '').split('/').pop();
    return `${e.az.bastion} → ${vm}`;
  }
  return '';
}

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
function requireName(v, verb) {
  if (v == null || v === '') throw new CliError(EXIT.USAGE, `${verb} needs a session name`);
  if (!NAME_RE.test(v)) throw new CliError(EXIT.USAGE, `bad session name "${v}" — allowed [a-zA-Z0-9._-], 1-64 chars`);
  return v;
}

function parseIntOr(v, label) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new CliError(EXIT.USAGE, `--${label} must be a positive integer`);
  return n;
}

function defaultPrompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

module.exports = {
  info, sessions, logs, deltaFrom, query, argsGet, skills,
  spawn, send, input, exec, run, sessionType, kill, restart, argsSet, restartApp,
  ctxAdd, ctxUse, ctxList, ctxRm, ctxShow, ctxImport,
  entryKind, entryTarget,
  requireName, parseIntOr, QUERY_KINDS,
};
