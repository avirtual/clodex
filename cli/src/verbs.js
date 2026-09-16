'use strict';

const readline = require('readline');
const path = require('path');
const { CliError, EXIT } = require('./errors');
const out = require('./output');
const imp = require('./import');
const { validateEntry } = require('./contexts');
const { openGuarded } = require('./sse-guard');
const R = require('./resources');
const { VERSION } = require('./help');


async function info({ client, printer, flags }) {
  const hello = await client.get('/api/peer/hello', 'info');
  if (flags.json) printer.json(hello);
  else printer.line(out.renderInfo(hello));
}

async function get({ client, ctx, printer, flags, args, io = {} }) {
  const target = R.parseTarget(args, 'get');
  const label = R.ctxLabel(ctx, flags);
  if (flags.subresource != null) {
    return getSubresource({ client, ctx, printer, flags, label, target, io });
  }
  if (target.resource === 'sessions') {
    if (target.name) return getSession({ client, printer, flags, name: target.name, label });
    return getSessions({ client, printer, flags });
  }
  if (target.resource === 'workspaces') {
    if (target.name) throw new CliError(EXIT.USAGE, 'get workspaces takes no name (try: describe workspace <name>)');
    return getWorkspaces({ client, printer, flags, label });
  }
  if (NODE_LISTS[target.resource]) {
    if (target.name) {
      throw new CliError(EXIT.USAGE,
        `get ${target.plural} takes no name (try: describe ${target.singular} ${target.name})`);
    }
    return getNodeResource({ client, printer, flags, label, plural: target.plural, singular: target.singular });
  }
  if (target.resource === 'catalogs') {
    if (target.name) throw new CliError(EXIT.USAGE, 'get catalogs takes no name');
    return getCatalogs({ client, printer, flags });
  }
  throw new CliError(EXIT.USAGE, `get ${target.plural} is not supported (try: describe ${target.singular} <name>)`);
}

const NODE_LISTS = {
  peers: { key: 'peers', plain: 'renderPeers', wide: 'renderPeersWide' },
  teams: { key: 'teams', plain: 'renderTeams', wide: 'renderTeams' },
  tickets: { key: 'tickets', plain: 'renderTickets', wide: 'renderTicketsWide' },
  sandboxes: { key: 'sandboxes', plain: 'renderSandboxes', wide: 'renderSandboxes' },
  agents: { key: 'agents', plain: 'renderAgents', wide: 'renderAgentsWide' },
  worktrees: { key: 'worktrees', plain: 'renderWorktrees', wide: 'renderWorktreesWide', nameKey: 'path' },
};

const TICKET_ID_RE = /^t\d+$/;
const TICKET_STATES = ['open', 'done', 'cancelled', 'all'];

function ticketQuery(flags) {
  const parts = [];
  if (flags.team != null) parts.push(`team=${encodeURIComponent(String(flags.team))}`);
  const state = ticketState(flags);
  if (state != null) parts.push(`state=${encodeURIComponent(state)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

function ticketState(flags) {
  if (flags.state == null) return flags.json ? null : 'open';
  const want = String(flags.state);
  if (!TICKET_STATES.includes(want)) {
    throw new CliError(EXIT.USAGE, `unknown ticket state: ${want} (${TICKET_STATES.join('|')})`);
  }
  return want;
}

function worktreeQuery(flags) {
  if (flags.repo == null || String(flags.repo) === '') {
    throw new CliError(EXIT.USAGE, 'get worktrees needs --repo DIR');
  }
  return `?repo=${encodeURIComponent(path.resolve(String(flags.repo)))}`;
}

function requireTicketId(id) {
  if (!TICKET_ID_RE.test(id)) throw new CliError(EXIT.USAGE, `not a ticket id: ${id} (ids look like t42)`);
  return id;
}

function ambiguousTicket(e, id) {
  const candidates = e && e.body && e.body.candidates;
  if (!Array.isArray(candidates) || !candidates.length) return e;
  return new CliError(EXIT.USAGE, `ticket ${id} exists in teams: ${candidates.join(', ')} — add --team`);
}

async function getNodeResource({ client, printer, flags, label, plural, singular }) {
  const spec = NODE_LISTS[plural];
  let query = '';
  if (plural === 'tickets') query = ticketQuery(flags);
  if (plural === 'worktrees') query = worktreeQuery(flags);
  await R.requireResource(client, plural, 'list', label);
  const body = await client.get(`/api/${plural}${query}`, `get ${plural}`);
  const rows = body[spec.key] || [];
  if (flags.json) { printer.json(body); return; }
  if (flags.output === 'name') {
    const named = spec.nameKey ? rows.map((r) => ({ name: r && r[spec.nameKey] })) : rows;
    printer.line(out.renderNames(singular, named));
    return;
  }
  printer.line(out[flags.output === 'wide' ? spec.wide : spec.plain](rows));
}

async function getSessions({ client, printer, flags }) {
  const body = await client.get('/api/sessions', 'get sessions');
  const all = body.sessions || [];
  const rows = filterWorkspace(all, flags);
  if (flags.json) { printer.json(rows === all ? body : { ...body, sessions: rows }); return; }
  if (flags.output === 'name') { printer.line(out.renderNames('session', rows)); return; }
  if (flags.output === 'wide') { printer.line(out.renderSessionsWide(rows)); return; }
  printer.line(out.renderSessions(rows));
}

function filterWorkspace(sessions, flags) {
  if (flags.workspace == null) return sessions;
  const want = String(flags.workspace);
  return sessions.filter((s) => s.workspace === want);
}

async function getSession({ client, printer, flags, name, label }) {
  await R.requireResource(client, 'sessions', 'get', label);
  const body = await client.get(`/api/sessions/${encodeURIComponent(name)}`, 'get session');
  const session = body.session || {};
  if (flags.json) { printer.json(body); return; }
  if (flags.output === 'name') { printer.line(out.renderNames('session', [session])); return; }
  if (flags.output === 'wide') { printer.line(out.renderSessionsWide([session])); return; }
  printer.line(out.renderSessions([session]));
}

const SESSION_SUBRESOURCES = ['skills', 'args', 'transcript'];

async function getSubresource({ client, ctx, printer, flags, label, target, io }) {
  const sub = String(flags.subresource);
  if (target.resource !== 'sessions') {
    throw new CliError(EXIT.USAGE, `--subresource is only valid on get session (not ${target.plural})`);
  }
  if (!SESSION_SUBRESOURCES.includes(sub)) {
    throw new CliError(EXIT.USAGE, `unknown subresource: ${sub} (${SESSION_SUBRESOURCES.join('|')})`);
  }
  const name = requireName(target.name, `get session --subresource ${sub}`);
  if (sub === 'transcript') return logs({ client, ctx, printer, flags: { ...flags, follow: false }, args: [name], io });
  await R.requireResource(client, 'sessions', 'get', label, sub);
  const body = await client.get(`/api/sessions/${encodeURIComponent(name)}/${sub}`, `get session --subresource ${sub}`);
  printer.json(body);
}

async function getWorkspaces({ client, printer, flags, label }) {
  await R.requireResource(client, 'workspaces', 'list', label);
  const body = await client.get('/api/workspaces', 'get workspaces');
  const workspaces = body.workspaces || [];
  if (flags.json) { printer.json(body); return; }
  if (flags.output === 'name') { printer.line(out.renderNames('workspace', workspaces)); return; }
  printer.line(out.renderWorkspaces(workspaces));
}

async function getCatalogs({ client, printer, flags }) {
  const body = await client.get('/api/catalogs', 'get catalogs');
  if (flags.json) { printer.json(body); return; }
  printer.line(out.renderDescribe(body.catalogs || {}));
}

async function describe({ client, ctx, printer, flags, args }) {
  const target = R.parseTarget(args, 'describe');
  const label = R.ctxLabel(ctx, flags);
  if (target.resource === 'catalogs') {
    await R.requireResource(client, 'catalogs', 'get', label);
    const body = await client.get('/api/catalogs', 'describe catalogs');
    printer.line(out.renderDescribe(body.catalogs || {}));
    return;
  }
  if (target.resource === 'sessions') {
    const name = requireName(target.name, 'describe session');
    await R.requireResource(client, 'sessions', 'get', label);
    const body = await client.get(`/api/sessions/${encodeURIComponent(name)}`, 'describe session');
    printer.line(out.renderDescribe(body.session || {}));
    return;
  }
  if (NODE_DESCRIBERS[target.resource]) {
    return describeNodeResource({ client, printer, label, plural: target.plural, singular: target.singular, name: target.name, flags });
  }
  if (NODE_LISTS[target.resource]) {
    throw new CliError(EXIT.USAGE,
      `describe ${target.singular} is not supported (try: get ${target.plural})`);
  }
  const name = target.name;
  if (!name) throw new CliError(EXIT.USAGE, 'describe workspace needs a name');
  await R.requireResource(client, 'workspaces', 'list', label);
  const body = await client.get('/api/workspaces', 'describe workspace');
  const ws = (body.workspaces || []).find((w) => w.name === name || w.id === name);
  if (!ws) throw new CliError(EXIT.NOTFOUND, `describe workspace failed: no workspace ${name}`);
  printer.line(out.renderDescribe(ws));
}

const NODE_DESCRIBERS = {
  peers: { key: 'peer', render: 'describePeer' },
  teams: { key: 'team', render: 'describeTeam' },
  tickets: { key: 'ticket', render: 'renderDescribe' },
  sandboxes: { key: 'sandbox', render: 'describeSandbox' },
  agents: { key: 'agent', render: 'describeAgent' },
};

async function describeNodeResource({ client, printer, label, plural, singular, name, flags }) {
  if (name == null || name === '') throw new CliError(EXIT.USAGE, `describe ${singular} needs a name`);
  const want = name;
  const spec = NODE_DESCRIBERS[plural];
  let query = '';
  if (plural === 'tickets') {
    requireTicketId(want);
    query = flags.team != null ? `?team=${encodeURIComponent(String(flags.team))}` : '';
  }
  await R.requireResource(client, plural, 'get', label);
  let body;
  try {
    body = await client.get(`/api/${plural}/${encodeURIComponent(want)}${query}`, `describe ${singular}`);
  } catch (e) {
    throw plural === 'tickets' ? ambiguousTicket(e, want) : e;
  }
  printer.line(out[spec.render](body[spec.key] || {}));
}

async function apiResources({ client, ctx, printer, flags }) {
  const label = R.ctxLabel(ctx, flags);
  const doc = await R.fetchResources(client);
  if (!doc) await R.failUpgrade(client, 'resources', 'get', label);
  if (flags.json) { printer.json(doc); return; }
  printer.line(out.renderResources(doc.resources || []));
}

async function version({ client, printer, flags }) {
  const hello = await client.get('/api/peer/hello', 'version');
  const host = hello.host || '?';
  const ver = hello.version || '?';
  if (flags.json) { printer.json({ client: VERSION, server: { host, version: ver } }); return; }
  printer.line(VERSION);
  printer.line(`Server: ${host} ${ver}`);
}

async function logs({ client, ctx, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'logs');
  await R.requireResource(client, 'sessions', 'get', R.ctxLabel(ctx, flags), 'transcript');
  const q = flags.tail ? `?limit=${encodeURIComponent(parseIntOr(flags.tail, 'tail'))}` : '';
  const body = await client.get(`${transcriptPath(name)}${q}`, 'logs');
  const messages = body.messages || [];
  if (flags.follow) return logsFollow({ client, printer, flags, name, initial: body, messages, io });
  if (flags.json) printer.json(body);
  else printer.line(out.renderTranscript(messages));
}

const REANCHOR_AFTER_EMPTY_PAGES = 2;

async function logsFollow({ client, printer, flags, name, initial, messages, io }) {
  if (flags.json) { for (const m of messages) printer.json(m); }
  else if (messages.length) printer.line(out.renderTranscript(messages));

  let lastSeq = lastSeqOf(messages);
  let legacyCount = lastSeq < 0 ? messages.length : 0;
  let emptyPages = 0;
  let refetching = false;           // coalesce overlapping activity frames
  let pending = false;

  const emit = (fresh) => {
    if (!fresh.length) return;
    if (flags.json) { for (const m of fresh) printer.json(m); }
    else printer.line(out.renderTranscript(fresh));
  };

  const reanchor = async () => {
    let tail;
    try { tail = await client.get(`${transcriptPath(name)}?limit=1`, 'logs -f (reanchor)'); }
    catch { return; }
    const seq = lastSeqOf(tail.messages);
    if (seq >= 0 && seq < lastSeq) lastSeq = seq;
    emptyPages = 0;
  };

  const refetch = async () => {
    if (refetching) { pending = true; return; }
    refetching = true;
    try {
      const after = await client.get(`${transcriptPath(name)}?since=${lastSeq + 1}&limit=500`, 'logs -f (refetch)');
      const page = after.messages || [];
      const seq = lastSeqOf(page);
      if (!page.length) {
        if (++emptyPages >= REANCHOR_AFTER_EMPTY_PAGES) await reanchor();
      } else if (seq < 0) {
        emit(page.slice(legacyCount));
        legacyCount = page.length;
      } else {
        emptyPages = 0;
        lastSeq = Math.max(lastSeq, seq);
        emit(page);
      }
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
      // On (re)connect, silently advance the cursor so a reconnect
      // never re-prints old lines (no gap markers in v1).
      onOpen: async () => {
        const snap = await client.get(`${transcriptPath(name)}?since=${lastSeq + 1}&limit=500`, 'logs -f (resnapshot)');
        const seen = snap.messages || [];
        if (!seen.length) return;
        emptyPages = 0;
        const seq = lastSeqOf(seen);
        if (seq < 0) legacyCount = seen.length;
        else lastSeq = Math.max(lastSeq, seq);
      },
      onEvent: (event, data) => {
        if (event !== 'activity' || !data || data.name !== name) return;
        refetch();
      },
      onGiveUp: (err) => finish(err),
    });
  });
}

function lastSeqOf(msgs) {
  const list = msgs || [];
  const last = list.length ? list[list.length - 1] : null;
  return last && Number.isFinite(last.seq) ? last.seq : -1;
}

const QUERY_KINDS = new Set(['ctx', 'report', 'bust', 'files', 'filePeek', 'fileDiff']);
async function query({ client, ctx, printer, flags, args }) {
  const name = requireName(args[0], 'query');
  const kind = args[1];
  if (!QUERY_KINDS.has(kind)) {
    throw new CliError(EXIT.USAGE, `query kind must be one of: ${[...QUERY_KINDS].join(', ')}`);
  }
  const qargs = {};
  if (flags.path) qargs.path = String(flags.path);
  if (flags.detail) qargs.detail = true;
  await R.requireResource(client, 'sessions', 'post', R.ctxLabel(ctx, flags), 'query');
  const body = await client.post(`/api/sessions/${encodeURIComponent(name)}/query`, 'query', { kind, args: qargs });
  printer.json(body);
}

function parseEnvFlags(envFlag, body) {
  const raw = Array.isArray(envFlag) ? envFlag : (envFlag != null ? [envFlag] : []);
  if (!raw.length) return [];
  const env = {};
  for (const tok of raw) {
    const s = String(tok);
    const eq = s.indexOf('=');
    if (eq <= 0) throw new CliError(EXIT.USAGE, `--env must be KEY=VALUE, got "${s}"`);
    env[s.slice(0, eq)] = s.slice(eq + 1);
  }
  body.env = env;
  return Object.keys(env).sort();
}

// Loud old-box / sanitize warning: any key we sent that the ack did NOT echo back
// as applied is NOT live on the session. Printed to stderr-grade output so it
// can't be missed even when the human form reports a pid. `applied` is undefined
// on a box predating env support (the whole set is missing).
function warnEnvMismatch(printer, sentKeys, applied) {
  const got = new Set(Array.isArray(applied) ? applied : []);
  const missing = sentKeys.filter((k) => !got.has(k));
  if (!missing.length) return;
  if (applied === undefined) {
    printer.line(`WARNING: env NOT applied — this node predates env support (no envKeys in the ack). Sent but dropped: ${missing.join(', ')}. The session is running WITHOUT them.`);
  } else {
    printer.line(`WARNING: some env vars were NOT applied by the node (rejected/denied): ${missing.join(', ')}. The session is running WITHOUT them.`);
  }
}

const CREATABLE = ['session', 'node'];
const DELETABLE = ['session', 'node'];
const PATCHABLE = ['session'];
const RESTARTABLE = ['session', 'node'];
const DEPLOYABLE = ['node'];
const USABLE = ['node'];

const NAMELESS_RESOURCES = new Set(['restart node']);

function takeResourceWord(args, verb, supported) {
  const word = args[0];
  if (!word) throw new CliError(EXIT.USAGE, `${verb} needs a resource (${supported.join('|')})`);
  const entry = R.resolveResource(word);
  const singular = entry ? entry.singular : word;
  if (!supported.includes(singular)) {
    throw new CliError(EXIT.USAGE, `${verb} ${word} is not supported (${supported.join('|')})`);
  }
  const rest = args.slice(1);
  const takes = NAMELESS_RESOURCES.has(`${verb} ${singular}`) ? 0 : 1;
  if (rest.length > takes) {
    throw new CliError(EXIT.USAGE, `${verb} ${singular}: unexpected argument "${rest[takes]}"`);
  }
  return { word: singular, rest };
}

const RESOURCE_VERBS = { create: CREATABLE, delete: DELETABLE, patch: PATCHABLE, restart: RESTARTABLE, deploy: DEPLOYABLE, undeploy: DEPLOYABLE, upgrade: DEPLOYABLE, use: USABLE };

function checkResourceWord(verb, args) {
  const supported = RESOURCE_VERBS[verb];
  if (supported) takeResourceWord(args, verb, supported);
}

async function create(bundle) {
  const { word, rest } = takeResourceWord(bundle.args, 'create', CREATABLE);
  if (word === 'session') return createSession({ ...bundle, args: rest });
}

async function createSession({ client, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'create session');
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
  const sentEnvKeys = parseEnvFlags(flags.env, body); // sorted keys we asked to set
  const res = await client.post('/api/sessions', 'create session', body);
      // Human-only warning: --json stdout stays the raw wire payload (which carries envKeys itself).
  if (sentEnvKeys.length && !flags.json) warnEnvMismatch(printer, sentEnvKeys, res.envKeys);
      // A child that dies on execvp still returns a pid, then vanishes from the engine —
      // hence the delayed re-check; a read failure leaves `alive` null, not false.
  const type = res.type || flags.type || null;
  const alive = await createAlive(client, res.name || name, io.sleepFn);
  if (flags.json) { printer.json({ ...res, alive }); return; }
  if (alive === false) {
    printer.line(`spawned ${res.name || name} (${type || '?'})${res.pid ? ` pid=${res.pid}` : ''} — but it exited immediately (gone from the engine).`);
    if (type && type !== 'bash') {
      printer.line(`  likely the \`${type}\` CLI isn't installed on the node — a native OS-flavor deploy provisions the engine only. Check with \`clodexctl get sessions\`; re-run \`clodexctl deploy …\` to (re)install the agent CLIs.`);
    }
    return;
  }
  printer.line(`spawned ${res.name || name} (${type || '?'})${res.pid ? ` pid=${res.pid}` : ''}${res.warnings && res.warnings.length ? `\nwarnings: ${res.warnings.join('; ')}` : ''}`);
}

const CREATE_LIVENESS_DELAY_MS = 600;
async function createAlive(client, name, sleepFn) {
  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  try {
    await sleep(CREATE_LIVENESS_DELAY_MS);
    const body = await client.get('/api/sessions', 'create session liveness');
    const list = body.sessions || [];
    return list.some((s) => s && s.name === name);
  } catch { return null; }
}

async function dm({ client, ctx, printer, flags, args }) {
  const name = requireName(args[0], 'dm');
  const text = args.slice(1).join(' ').trim();
  if (!text) throw new CliError(EXIT.USAGE, 'dm needs message text');
  if (flags.wait) throw new CliError(EXIT.USAGE, 'dm has no --wait — it is fire-and-forget; to wait for the reply use: clodexctl exec <name> <text…>');
  await R.requireResource(client, 'sessions', 'post', R.ctxLabel(ctx, flags), 'dm');
  const res = await client.post(`/api/sessions/${encodeURIComponent(name)}/dm`, 'dm', { text });
  if (flags.json) printer.json(res);
  else printer.line(`sent to ${name} (fire-and-forget)`);
}

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

    // --pty picks the PTY mode outright; else ROUTES on the authoritative type, `bash`
    // (PTY) vs everything else (dm-and-wait). Binary, not a claude/codex whitelist.
async function exec({ client, ctx, printer, flags, args, io = {} }) {
  const name = requireName(args[0], 'exec');
  const text = args.slice(1).join(' ').trim();
  if (!text) throw new CliError(EXIT.USAGE, 'exec needs text — a prompt for an agent, or a command for a bash session');
  if (flags.pty) return execPty({ client, ctx, printer, flags, args, mode: 'pty' });
  const type = await sessionType(client, name);
  if (type === 'bash') {
    return execPty({ client, ctx, printer, flags, args, mode: 'pty' });
  }
  return dmWait({ client, ctx, printer, flags, name, text, mode: 'agent', io });
}

async function dmWait({ client, ctx, printer, flags, name, text, mode = null, io = {} }) {
  await R.requireResource(client, 'sessions', 'post', R.ctxLabel(ctx, flags), 'dm');
  const timeoutMs = (flags.timeout != null ? parseIntOr(flags.timeout, 'timeout') : 300) * 1000;
      // --timeout is a hard ceiling on the WHOLE verb (wait phase, then refetch at +grace):
      // a wedged fetch holds its socket open and keeps dmWait from returning, which blocks
      // the caller from reaping the transport child. io.refetchGraceMs is the test seam.
  const graceMs = io.refetchGraceMs != null ? io.refetchGraceMs : 8000;

  let stream = null;
  let settled = false;
  let hardTimer = null;
  let sinceSeq = 0;
  const waitAc = new AbortController();
  const waitResult = await new Promise((resolve, reject) => {
    const finish = (fn, v) => { if (settled) return; settled = true; if (hardTimer) clearTimeout(hardTimer); fn(v); };
    // Arm the ceiling BEFORE opening the stream and INDEPENDENT of onOpen — if
    // the stream never reaches 200, or the snapshot/send await hangs, onOpen
    // never reaches a timer of its own, so the ceiling must live out here. On
    // fire: abort the in-flight wait-phase request and settle as a timeout.
    hardTimer = setTimeout(() => { try { waitAc.abort(); } catch {} finish(resolve, { timedOut: true }); }, timeoutMs);
    stream = client.openEventStream('/api/events', 'exec (events)', {
      onOpen: async () => {
        try {
          const before = await client.get(`${transcriptPath(name)}?limit=500`, 'exec (snapshot)', { signal: waitAc.signal });
          sinceSeq = lastSeqOf(before.messages) + 1;
          await client.post(`/api/sessions/${encodeURIComponent(name)}/dm`, 'exec (dm)', { text }, { signal: waitAc.signal });
        } catch (e) { finish(reject, e); } // a ceiling abort lands here too — finish is then a no-op (already settled)
      },
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

      // Print from the first assistant entry on (drops our echoed user message). The transcript
      // flush can lag the turnEnd frame, so an assistant-less delta is retried with backoff;
      // the whole loop is bounded by grace because a wedged refetch would never return.
  const freshFrom = (msgs) => {
    const delta = msgs || [];
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
        after = await client.get(`${transcriptPath(name)}?since=${sinceSeq}&limit=500`, 'exec (refetch)', { signal: refetchAc.signal });
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
    throw new CliError(EXIT.SERVER, `exec: no end-of-turn within ${Math.round(timeoutMs / 1000)}s — the agent may still be working; check \`logs ${name}\``);
  }
}

    // The input subresource is a raw keystroke channel — nothing appends Enter server-side, hence the default '\r'.
async function input({ client, ctx, printer, flags, args }) {
  const name = requireName(args[0], 'input');
  const text = args.slice(1).join(' ');
  if (!text) throw new CliError(EXIT.USAGE, 'input needs text to send');
  const data = flags['no-enter'] ? text : text + '\r';
  await R.requireResource(client, 'sessions', 'post', R.ctxLabel(ctx, flags), 'control');
  const acq = await client.post(`/api/sessions/${encodeURIComponent(name)}/control`, 'input (acquire control)', { action: 'acquire', client: 'clodexctl' });
  const token = acq.token;
  try {
    const res = await client.post(`/api/sessions/${encodeURIComponent(name)}/input`, 'input', { token, data });
    if (flags.json) printer.json(res);
    else printer.line(`input sent to ${name}`);
  } finally {
    try { await client.post(`/api/sessions/${encodeURIComponent(name)}/control`, 'input (release control)', { action: 'release', token }); } catch {}
  }
}

    // Open the attach SSE BEFORE acquiring control: the stream registers us as an attacher and
    // holds the control token alive — the last stream closing auto-releases control.
async function execPty({ client, ctx, printer, flags, args, mode = null }) {
  const name = requireName(args[0], 'exec');
  const cmd = args.slice(1).join(' ');
  if (!cmd) throw new CliError(EXIT.USAGE, 'exec needs a command to run');
  await R.requireResource(client, 'sessions', 'get', R.ctxLabel(ctx, flags), 'attach');

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

    stream = client.openEventStream(`/api/sessions/${encodeURIComponent(name)}/attach`, 'exec (attach)', {
      onOpen: async () => {
        hardTimer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
        try {
          const acq = await client.post(`/api/sessions/${encodeURIComponent(name)}/control`, 'exec (acquire control)', { action: 'acquire', client: 'clodexctl' });
          token = acq.token;
          await client.post(`/api/sessions/${encodeURIComponent(name)}/input`, 'exec (input)', { token, data: cmd + '\r' });
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

  try { if (token) await client.post(`/api/sessions/${encodeURIComponent(name)}/control`, 'exec (release control)', { action: 'release', token }); } catch {}
  try { if (stream) stream.close(); } catch {}

  const raw = Buffer.concat(chunks).toString('utf8');
  const text = flags.raw ? raw : out.stripAnsi(raw);
  const timedOut = !!outcome.timedOut;

  if (flags.json) {
    printer.json({ ok: outcome.ok, name, ...(mode ? { mode } : {}), output: text, truncated: timedOut });
  } else if (text) {
    printer.line(text.replace(/\n$/, ''));
  }

  if (outcome.error) throw outcome.error;
  if (timedOut) {
    throw new CliError(EXIT.SERVER, `exec: no quiet within ${Math.round(timeoutMs / 1000)}s — printed partial output (exit reflects delivery, not the remote command's status)`);
  }
}

async function del(bundle) {
  const { word, rest } = takeResourceWord(bundle.args, 'delete', DELETABLE);
  if (word === 'session') return deleteSession({ ...bundle, args: rest });
}

async function deleteSession({ client, ctx, printer, flags, args, prompt = defaultPrompt }) {
  const name = requireName(args[0], 'delete session');
  if (!flags.force && flags.json) {
    throw new CliError(EXIT.USAGE, 'delete session needs --force in -o json|yaml/non-interactive mode (wire delete is a hard delete, no resume)');
  }
  await R.requireResource(client, 'sessions', 'delete', R.ctxLabel(ctx, flags));
  if (!flags.force) {
    const ok = await prompt(`delete "${name}"? This is a HARD DELETE on the engine — no resume. Type the name to confirm: `);
    if (String(ok).trim() !== name) throw new CliError(EXIT.USAGE, 'aborted — confirmation did not match');
  }
  const res = await client.del(`/api/sessions/${encodeURIComponent(name)}`, 'delete session');
  if (flags.json) printer.json(res);
  else printer.line(`deleted ${res.name || name} (hard delete — not resumable)`);
}

async function restart(bundle) {
  const { word, rest } = takeResourceWord(bundle.args, 'restart', RESTARTABLE);
  if (word === 'session') return restartSession({ ...bundle, args: rest });
  return restartNode(bundle);
}

async function restartSession({ client, ctx, printer, flags, args }) {
  const name = requireName(args[0], 'restart session');
  await R.requireResource(client, 'sessions', 'post', R.ctxLabel(ctx, flags), 'restart');
  const res = await client.post(`/api/sessions/${encodeURIComponent(name)}/restart`, 'restart session', { fresh: !!flags.fresh });
  if (flags.json) printer.json(res);
  else printer.line(`restarted ${name}${flags.fresh ? ' (fresh)' : ' (resume)'}`);
}

async function patch(bundle) {
  const { word, rest } = takeResourceWord(bundle.args, 'patch', PATCHABLE);
  if (word === 'session') return patchSession({ ...bundle, args: rest });
}

async function patchSession({ client, ctx, printer, flags, args }) {
  const name = requireName(args[0], 'patch session');
  const body = {};
  if (Array.isArray(flags.arg)) body.extraArgs = flags.arg;
  else if (flags.arg) body.extraArgs = [String(flags.arg)];
  if (flags.proxy != null) body.proxy = String(flags.proxy);
  if (flags.restart) body.restart = true;
  if (Object.keys(body).length === 0) throw new CliError(EXIT.USAGE, 'patch session needs at least one of --arg / --proxy / --restart');
  await R.requireResource(client, 'sessions', 'patch', R.ctxLabel(ctx, flags), 'args');
  const res = await client.patch(`/api/sessions/${encodeURIComponent(name)}/args`, 'patch session', body);
  if (flags.json) printer.json(res);
  else printer.line(`args applied to ${name}${res.restarted ? ' (respawned)' : ''}`);
}

async function restartNode({ client, printer, flags, prompt = defaultPrompt }) {
  if (!flags.force) {
    if (flags.json) throw new CliError(EXIT.USAGE, 'restart node needs --force in -o json|yaml/non-interactive mode');
    const ok = await prompt('restart the WHOLE engine? All sessions relaunch. [y/N]: ');
    if (!/^y(es)?$/i.test(String(ok).trim())) throw new CliError(EXIT.USAGE, 'aborted');
  }
  const res = await client.post('/api/restart', 'restart node', {});
  if (flags.json) printer.json(res);
  else printer.line('engine restart requested');
}


function entryFromFlags(flags) {
  const entry = {};
  if (flags.url) entry.url = String(flags.url);
  if (flags.ssh) entry.ssh = String(flags.ssh);
  if (flags.tunnel) entry.tunnel = Array.isArray(flags.tunnel) ? flags.tunnel : [String(flags.tunnel)];
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
  return entry;
}

function ctxAdd({ store, saveStore, printer, flags, args }) {
  const name = requireName(args[0], 'ctx add');
  const entry = entryFromFlags(flags);
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

function ctxCurrent({ store, printer }) {
  if (!store.current) throw new CliError(EXIT.NOTFOUND, 'no current context (ctx use <name>)');
  printer.line(store.current);
}

function ctxList({ store, printer, flags }) {
  const names = Object.keys(store.contexts);
  if (flags.json) { printer.json({ current: store.current, contexts: store.contexts }); return; }
  if (names.length === 0) { printer.line('(no contexts — add one with `ctx add`)'); return; }
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

function nodeKind(e) {
  const family = entryKind(e);
  if (family === 'ssm') return e.ssm && e.ssm.ecs ? 'ssm-ecs' : 'ssm';
  if (family === 'gcloud') return 'gcloud-iap';
  if (family === 'az') return 'az-bastion';
  return family;
}

function nodeRow(name, entry, current) {
  const e = entry || {};
  return {
    name,
    current: name === current,
    kind: nodeKind(e),
    locator: entryTarget(e),
    remotePort: e.remotePort || null,
    tokenSet: !!e.token,
  };
}

function nodeRows(store) {
  return Object.keys(store.contexts).map((n) => nodeRow(n, store.contexts[n], store.current));
}

const NODE_EMPTY = '(no nodes — add one with `clodexctl create node <name> --url …`)';

function nodeList({ store, printer, flags, args }) {
  if (flags.current) return nodeCurrent({ store, printer });
  const target = R.parseTarget(args, 'get');
  if (target.name) {
    throw new CliError(EXIT.USAGE, `get nodes takes no name (try: describe node ${target.name})`);
  }
  const rows = nodeRows(store);
  if (flags.json) { printer.json({ current: store.current, nodes: rows }); return; }
  if (flags.output === 'name') { printer.line(out.renderNames('node', rows)); return; }
  if (rows.length === 0) { printer.line(NODE_EMPTY); return; }
  if (flags.output === 'wide') {
    printer.line(out.table(['', 'NAME', 'KIND', 'LOCATOR', 'REMOTE-PORT', 'TOKEN'],
      rows.map((r) => [r.current ? '*' : '', r.name, r.kind, r.locator, r.remotePort || '', r.tokenSet ? '(set)' : '(none)'])));
    return;
  }
  printer.line(out.table(['', 'NAME', 'KIND', 'LOCATOR'],
    rows.map((r) => [r.current ? '*' : '', r.name, r.kind, r.locator])));
}

function nodeCurrent({ store, printer }) {
  if (!store.current) throw new CliError(EXIT.NOTFOUND, 'no current node (clodexctl use node <name>)');
  printer.line(store.current);
}

function nodeName(store, args, verb) {
  const target = R.parseTarget(args, verb);
  const name = target.name || store.current;
  if (!name) throw new CliError(EXIT.USAGE, `${verb} node needs a name (or set a current node)`);
  return name;
}

function nodeDescribe({ store, printer, args }) {
  const name = nodeName(store, args, 'describe');
  const e = store.contexts[name];
  if (!e) throw new CliError(EXIT.USAGE, `no such node: ${name}`);
  const r = nodeRow(name, e, store.current);
  printer.line([
    `name        ${name}${r.current ? ' (current)' : ''}`,
    `kind        ${r.kind}`,
    `locator     ${r.locator}`,
    r.remotePort ? `remotePort  ${r.remotePort}` : null,
    `token       ${r.tokenSet ? '(set)' : '(none)'}`,
  ].filter(Boolean).join('\n'));
}

function nodeCreate(bundle) {
  const { store, saveStore, printer, flags } = bundle;
  const { rest: args } = takeResourceWord(bundle.args, 'create', CREATABLE);
  if (flags.import) {
    if (args.length) throw new CliError(EXIT.USAGE, `create node --import takes no name ("${args[0]}" is extra)`);
    return ctxImport(bundle);
  }
  const name = requireName(args[0], 'create node', 'node');
  store.contexts[name] = entryFromFlags(flags);
  if (!store.current) store.current = name;
  saveStore(store);
  printer.line(`node "${name}" created${store.current === name ? ' (current)' : ''}`);
}

async function nodeDelete({ store, saveStore, printer, flags, args: raw, prompt = defaultPrompt }) {
  const { rest: args } = takeResourceWord(raw, 'delete', DELETABLE);
  const name = requireName(args[0], 'delete node', 'node');
  if (!store.contexts[name]) throw new CliError(EXIT.USAGE, `no such node: ${name}`);
  if (!flags.force && flags.json) {
    throw new CliError(EXIT.USAGE, 'delete node needs --force in -o json|yaml/non-interactive mode (there is no prompt to answer)');
  }
  if (!flags.force) {
    const ok = await prompt(`delete node "${name}"? Type the name to confirm: `);
    if (String(ok).trim() !== name) throw new CliError(EXIT.USAGE, 'aborted — confirmation did not match');
  }
  delete store.contexts[name];
  if (store.current === name) store.current = null;
  saveStore(store);
  if (flags.json) printer.json({ name, deleted: true, current: store.current });
  else printer.line(`node "${name}" deleted`);
}

function nodeUse({ store, saveStore, printer, args: raw }) {
  const { rest: args } = takeResourceWord(raw, 'use', USABLE);
  const name = requireName(args[0], 'use node', 'node');
  if (!store.contexts[name]) throw new CliError(EXIT.USAGE, `no such node: ${name}`);
  store.current = name;
  saveStore(store);
  printer.line(`current node: ${name}`);
}

function ctxImport({ store, saveStore, printer, flags, env }) {
  const meta = imp.resolveDataDir({ dataDirFlag: flags['data-dir'], env });
  const candidates = imp.collectCandidates(meta.dir);
  const { store: nextStore, results } = imp.applyImport(store, candidates, { force: !!flags.force });
  const dryRun = !!flags['dry-run'];
  if (!dryRun) {
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

function transcriptPath(name) {
  return `/api/sessions/${encodeURIComponent(name)}/transcript`;
}

const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
function requireName(v, verb, noun = 'session') {
  if (v == null || v === '') throw new CliError(EXIT.USAGE, `${verb} needs a ${noun} name`);
  if (!NAME_RE.test(v)) throw new CliError(EXIT.USAGE, `bad ${noun} name "${v}" — allowed [a-zA-Z0-9._-], 1-64 chars`);
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
  info, get, describe, apiResources, version, filterWorkspace,
  logs, query,
  create, createSession, dm, input, exec, execPty, sessionType,
  delete: del, deleteSession, restart, restartSession, restartNode, patch, patchSession,
  ctxAdd, ctxUse, ctxCurrent, ctxList, ctxRm, ctxShow, ctxImport,
  nodeList, nodeCurrent, nodeDescribe, nodeCreate, nodeDelete, nodeUse, nodeRows,
  entryKind, entryTarget,
  requireName, parseIntOr, QUERY_KINDS, SESSION_SUBRESOURCES, takeResourceWord, checkResourceWord, RESOURCE_VERBS, DEPLOYABLE, USABLE,
};
