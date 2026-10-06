'use strict';

const nodeCrypto = require('node:crypto');
const nodePath = require('node:path');

const INTENT_SOCKET_MAX_BYTES = 64 * 1024;
const INTENT_SOCKET_MAX_CONNS = 8;
const INTENT_SOCKET_TIMEOUT_MS = 10 * 1000;
const ASYNC_TAIL = "a reply arrives in the seat's main conversation";
const RESULT_TAIL = "any result arrives in the seat's main conversation";
const IDENT_ENV = 'CLODEX_HOOK_IDENT';
const IDENT_HEX = 16;
const IDENT_SEEN_MAX = 512;
const IDENT_SEEN_MS = 10 * 60 * 1000;
const MAIN_IDENT_RE = /^main\.(?:([0-9a-f]{16})\.)?([0-9a-f]+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CMD_PREFIX = ['command', 'exec', 'env', 'builtin', 'nohup'];
const SHELL_KEYWORDS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'];
const TIMEOUT_ARG_FLAGS = ['-s', '-k', '--signal', '--kill-after'];
const DURATION_RE = /^[0-9]+(\.[0-9]+)?[smhd]?$/;
const SEPARATORS = ';&|(){}\n';
const SUBAGENT_BRIEF = "This seat's browser pane is the `browser` MCP tool (verb, service, bracket, body — same replies and refusals as the Bash form); the Bash form `clodex '[agent:browser …]'` and the other Clodex intents are reachable from Bash too; run `clodex --help` for the subagent catalog.";

function mintIntentCredential(crypto) {
  return crypto.randomBytes(32).toString('hex');
}

function seatChannelEnv({ name, sockPath, cred }) {
  return { CLODEX_SEAT: name, CLODEX_INTENT_SOCK: sockPath, CLODEX_INTENT_CRED: cred };
}

function credMatches(crypto, want, got) {
  if (typeof want !== 'string' || typeof got !== 'string') return false;
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SUBAGENT_TAG_SUFFIX = '/agent';

function subagentTag(seat) {
  return `${seat}${SUBAGENT_TAG_SUFFIX}`;
}

function seatOfAgentTag(name) {
  if (typeof name !== 'string' || name.includes('@') || !name.endsWith(SUBAGENT_TAG_SUFFIX)) return name;
  const seat = name.slice(0, -SUBAGENT_TAG_SUFFIX.length);
  return seat || name;
}

function isMainThread(agentId, sessionId) {
  if (!agentId || typeof sessionId !== 'string' || !sessionId) return false;
  if (sessionId === agentId) return true;
  return UUID_RE.test(agentId) && sessionId.endsWith(`-${agentId}`);
}

function identPart(s) {
  return String(s || '').replace(/[^A-Za-z0-9_:-]/g, '_') || '_';
}

function mintIdentNonce(crypto) {
  return crypto.randomBytes(IDENT_HEX / 2).toString('hex');
}

function identToken(crypto, cred, agentId, agentType, sessionId, nonce = mintIdentNonce(crypto)) {
  const kind = agentId ? 'sub' : 'main';
  const mac = crypto.createHmac('sha256', String(cred))
    .update(`${kind}${agentId || ''}${sessionId || ''}${nonce}`).digest('hex').slice(0, IDENT_HEX);
  return agentId ? `sub.${identPart(agentId)}.${identPart(agentType)}.${nonce}.${mac}` : `main.${nonce}.${mac}`;
}

function rememberIdentNonce(seen, nonce, now) {
  for (const [n, at] of seen) {
    if (seen.size < IDENT_SEEN_MAX && now - at < IDENT_SEEN_MS) break;
    seen.delete(n);
  }
  seen.set(nonce, now);
}

function identVerdict(crypto, cred, ident, sessionId, seen, now) {
  if (!cred || typeof ident !== 'string' || typeof sessionId !== 'string' || !sessionId) return 'sub';
  const m = MAIN_IDENT_RE.exec(ident);
  if (!m || !m[1]) return 'sub';
  if (!credMatches(crypto, identToken(crypto, cred, null, null, sessionId, m[1]), ident)) return 'sub';
  if (!seen) return 'main';
  if (seen.has(m[1])) return 'replay';
  rememberIdentNonce(seen, m[1], now);
  return 'main';
}

function identIsMain(crypto, cred, ident, sessionId, seen = null, now = Date.now()) {
  return identVerdict(crypto, cred, ident, sessionId, seen, now) === 'main';
}

function callerIsSubagent({ req, isCodex, sessionId, cred, crypto, seen = null, now = Date.now(), onReplay = null }) {
  if (isCodex) {
    const agentId = req && typeof req.agentId === 'string' && req.agentId.trim() ? req.agentId.trim() : null;
    if (!sessionId) return true;
    return !!agentId && !isMainThread(agentId, sessionId);
  }
  const verdict = identVerdict(crypto, cred, req && req.ident, sessionId, seen, now);
  if (verdict === 'replay' && onReplay) onReplay();
  return verdict !== 'main';
}

function heredocWord(cmd, i) {
  let j = i + 2;
  const strip = cmd.charAt(j) === '-';
  if (strip) j++;
  while (cmd.charAt(j) === ' ' || cmd.charAt(j) === '\t') j++;
  let delim = '';
  let q = null;
  for (; j < cmd.length; j++) {
    const c = cmd.charAt(j);
    if (q) { if (c === q) q = null; else delim += c; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '\\' && j + 1 < cmd.length) { delim += cmd.charAt(++j); continue; }
    if (c <= ' ' || SEPARATORS.includes(c) || c === '<' || c === '>') break;
    delim += c;
  }
  return delim ? { end: j, delim, strip } : null;
}

function skipHeredocs(cmd, i, pending) {
  let at = i;
  for (const h of pending) {
    for (;;) {
      if (at >= cmd.length) return cmd.length;
      const nl = cmd.indexOf('\n', at);
      const stop = nl < 0 ? cmd.length : nl;
      const line = cmd.slice(at, stop);
      at = stop + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
    }
  }
  return at - 1;
}

function shellSegments(cmd) {
  const segs = [[]];
  let tok = null;
  let q = null;
  let pending = [];
  const at = (i) => { if (!tok) tok = { start: i, end: i, text: '' }; return tok; };
  const push = (i) => { if (tok) { tok.end = i; segs[segs.length - 1].push(tok); } tok = null; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charAt(i);
    if (q) {
      if (c === q) { q = null; continue; }
      if (q === '"' && c === '\\' && i + 1 < cmd.length) { i++; tok.text += cmd.charAt(i); continue; }
      tok.text += c;
      continue;
    }
    if (c === "'" || c === '"') { at(i); q = c; continue; }
    if (c === '\\' && i + 1 < cmd.length) { at(i).text += cmd.charAt(i + 1); i++; continue; }
    if (c === '{' && cmd.charAt(i + 1) === '}') { at(i).text += '{}'; i++; continue; }
    if (c === '<' && cmd.charAt(i + 1) === '<' && cmd.charAt(i + 2) === '<') { at(i).text += '<<<'; i += 2; continue; }
    if (c === '<' && cmd.charAt(i + 1) === '<') {
      const h = heredocWord(cmd, i);
      if (h) { push(i); at(i).text = cmd.slice(i, h.end); push(h.end); pending.push(h); i = h.end - 1; continue; }
    }
    if (c === '\n' && pending.length) { push(i); segs.push([]); i = skipHeredocs(cmd, i + 1, pending); pending = []; continue; }
    if (SEPARATORS.includes(c)) { push(i); segs.push([]); continue; }
    if (c <= ' ') { push(i); continue; }
    at(i).text += c;
  }
  push(cmd.length);
  return segs;
}

function isClodexWord(w) {
  return typeof w === 'string' && (w === 'clodex' || w.endsWith('/clodex'));
}

function prefixLength(word, i) {
  const w = word(i);
  if (w === 'time') return word(i + 1) === '-p' ? 2 : 1;
  if (CMD_PREFIX.includes(w)) return 1;
  if (w === 'timeout') {
    let j = i + 1;
    while (typeof word(j) === 'string' && word(j).startsWith('-')) j += TIMEOUT_ARG_FLAGS.includes(word(j)) ? 2 : 1;
    return DURATION_RE.test(word(j) || '') ? j + 1 - i : 0;
  }
  if (w === 'nice') {
    if (word(i + 1) === '-n') return 3;
    return /^-n?[0-9]+$/.test(word(i + 1) || '') ? 2 : 1;
  }
  return 0;
}

function stampClodexCommand(cmd, token) {
  const edits = [];
  for (const seg of shellSegments(cmd)) {
    let i = 0;
    const word = (k) => (seg[k] ? seg[k].text : undefined);
    for (;;) {
      if (SHELL_KEYWORDS.includes(word(i))) i++;
      else if (word(i) === 'time') i += prefixLength(word, i);
      else break;
    }
    const at = i;
    const forged = [];
    for (;;) {
      const w = word(i);
      if (w === undefined) break;
      if (ASSIGN_RE.test(w)) {
        if (w.startsWith(`${IDENT_ENV}=`)) forged.push(seg[i]);
        i++;
      } else if (prefixLength(word, i) > 0) {
        i += prefixLength(word, i);
      } else {
        break;
      }
    }
    if (!seg[i] || !isClodexWord(seg[i].text)) continue;
    for (const f of forged) {
      let end = f.end;
      while (end < cmd.length && (cmd.charAt(end) === ' ' || cmd.charAt(end) === '\t')) end++;
      edits.push({ start: f.start, end, text: '' });
    }
    edits.push({ start: seg[at].start, end: seg[at].start, text: `${IDENT_ENV}=${typeof token === 'function' ? token() : token} ` });
  }
  if (!edits.length) return null;
  edits.sort((a, b) => b.start - a.start || (b.end - b.start) - (a.end - a.start));
  let out = cmd;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

function sweepIdentDir(fs, dir, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const p = nodePath.join(dir, name);
    try { if (now - fs.statSync(p).mtimeMs > IDENT_SEEN_MS) fs.unlinkSync(p); } catch {}
  }
}

function hookIdentOutput(raw, cred, crypto = nodeCrypto, { identDir, fs = require('node:fs'), now = Date.now() } = {}) {
  let d;
  try { d = JSON.parse(raw); } catch { return ''; }
  if (!d || typeof d !== 'object') return '';
  if (d.hook_event_name === 'SubagentStart') {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT_BRIEF } });
  }
  const input = d.tool_input;
  const cmd = input && input.command;
  if (typeof cmd !== 'string' || !cmd || !cred || !identDir) return '';
  const agentId = typeof d.agent_id === 'string' && d.agent_id ? d.agent_id : null;
  const stamps = [];
  const next = stampClodexCommand(cmd, () => {
    const nonce = mintIdentNonce(crypto);
    stamps.push([nonce, identToken(crypto, cred, agentId, d.agent_type, d.session_id, nonce)]);
    return `@${nonce}`;
  });
  if (next == null) return '';
  sweepIdentDir(fs, identDir, now);
  fs.mkdirSync(identDir, { recursive: true, mode: 0o700 });
  for (const [nonce, stamp] of stamps) fs.writeFileSync(nodePath.join(identDir, nonce), stamp, { mode: 0o600, flag: 'wx' });
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: next } } });
}

function intentLabel(intent) {
  if (!intent) return 'unknown';
  if (intent.type === 'exec' && intent.cmd) return `exec ${intent.cmd}`;
  return intent.sub ? `${intent.type} ${intent.sub}` : intent.type;
}

function defaultReply(intent) {
  if (intent.type === 'dm') return `sent to ${intent.target}; ${ASYNC_TAIL}`;
  return `${intentLabel(intent)} accepted; ${RESULT_TAIL}`;
}

function lateReply(intent) {
  return `${intent.type} accepted; its reply will arrive in the seat's main conversation`;
}

function createIntentRequestHandler({
  seat, parse, entryOf, sessionIdOf, allows, refusal, dispatch, replyWaitMs, classifyReply, cred, isCodex = false,
  crypto = nodeCrypto, setTimer = setTimeout, clearTimer = clearTimeout, log = null, identSeen = new Map(), now = Date.now,
}) {
  return async function handleIntentRequest(req, ctl) {
    const text = req && typeof req.intent === 'string' ? req.intent : '';
    if (!text.trim()) return { ok: false, error: 'empty intent' };
    const intents = parse(text).filter((i) => i && i.type !== 'end' && i.type !== 'escape');
    if (!intents.length) return { ok: false, error: 'no [agent:…] intent in the request' };
    if (intents.length > 1) return { ok: false, error: 'one intent per call' };
    const intent = intents[0];
    if (intent.type === 'unknown') return { ok: false, error: `unrecognized intent \`${intent.text}\`` };
    const subagent = callerIsSubagent({
      req, isCodex, sessionId: sessionIdOf(), cred, crypto, seen: identSeen, now: now(),
      onReplay: () => { if (log) log.warn('intent-socket', `${seat}: replayed identity stamp refused`); },
    });
    if (subagent) {
      const why = refusal ? refusal(intent, entryOf()) : (allows(intent, entryOf()) ? null : '');
      if (why !== null) return { ok: false, status: 'refused', error: why || `not available to a subagent: ${intentLabel(intent)}` };
    }
    const lines = [];
    let open = true;
    let wake = null;
    const replyTo = (t) => {
      if (!open || (ctl && ctl.closed())) return false;
      lines.push(String(t));
      if (wake) wake();
      return true;
    };
    try {
      await dispatch(intent, { replyTo, fromLabel: subagent ? subagentTag(seat) : null });
      const waitMs = !lines.length && replyWaitMs ? replyWaitMs(intent) : 0;
      if (waitMs > 0 && !(ctl && ctl.closed())) {
        if (ctl && ctl.extend) ctl.extend(waitMs + INTENT_SOCKET_TIMEOUT_MS);
        const replied = await new Promise((resolve) => {
          const timer = setTimer(() => resolve(false), waitMs);
          wake = () => { clearTimer(timer); resolve(true); };
        });
        if (!replied && !lines.length) return { ok: true, status: 'ok', reply: lateReply(intent) };
      }
    } finally {
      open = false;
    }
    if (!lines.length) return { ok: true, status: 'ok', reply: defaultReply(intent) };
    const status = classifyReply ? classifyReply(intent, lines[0]) : 'ok';
    return { ok: true, status: status === 'error' || status === 'refused' ? status : 'ok', reply: lines.join('\n') };
  };
}

function createIntentSocketServer({
  net, fs, crypto, sockPath, cred, credPath, handle, log,
  maxBytes = INTENT_SOCKET_MAX_BYTES,
  maxConns = INTENT_SOCKET_MAX_CONNS,
  timeoutMs = INTENT_SOCKET_TIMEOUT_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let active = 0;
  let server = null;

  const respond = (sock, res) => {
    try { sock.end(JSON.stringify(res) + '\n', () => sock.destroy()); } catch {}
  };

  const onConnection = (sock) => {
    sock.on('error', () => {});
    if (active >= maxConns) {
      respond(sock, { ok: false, error: 'busy' });
      return;
    }
    active += 1;
    let released = false;
    const release = () => { if (!released) { released = true; active -= 1; } };
    let done = false;
    let gone = false;
    sock.on('close', () => { gone = true; release(); });
    let buf = Buffer.alloc(0);
    const end = (res) => {
      if (done) return;
      done = true;
      respond(sock, res);
    };
    sock.on('data', (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl === -1 ? buf.length > maxBytes : nl > maxBytes) {
        end({ ok: false, error: 'request too large' });
        return;
      }
      if (nl === -1) return;
      let req;
      try { req = JSON.parse(buf.subarray(0, nl).toString('utf8')); } catch { req = null; }
      if (!req || typeof req !== 'object') { end({ ok: false, error: 'bad request' }); return; }
      if (!credMatches(crypto, cred, req.cred)) { end({ ok: false, error: 'unauthorized' }); return; }
      const expire = () => end({ ok: false, error: 'timeout' });
      let timer = setTimer(expire, timeoutMs);
      const extend = (ms) => { clearTimer(timer); timer = setTimer(expire, ms); };
      const request = { intent: req.intent, agentId: req.agentId, agentType: req.agentType, ident: req.ident };
      Promise.resolve()
        .then(() => handle(request, { closed: () => done || gone, extend }))
        .then((r) => end(r && typeof r === 'object' ? r : { ok: false, error: 'no reply' }),
          (e) => {
            if (log) log.warn('intent-socket', `request failed: ${(e && e.message) || e}`);
            end({ ok: false, error: 'internal error' });
          })
        .finally(() => clearTimer(timer));
    });
  };

  function start() {
    try { fs.unlinkSync(sockPath); } catch {}
    server = net.createServer(onConnection);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => {
        server.removeListener('error', reject);
        server.on('error', (e) => { if (log) log.warn('intent-socket', `${sockPath}: ${e.message}`); });
        try { fs.chmodSync(sockPath, 0o600); } catch {}
        if (credPath) {
          try { fs.writeFileSync(credPath, cred, { mode: 0o600 }); fs.chmodSync(credPath, 0o600); } catch (e) {
            if (log) log.warn('intent-socket', `${credPath}: ${e.message}`);
          }
        }
        if (typeof server.unref === 'function') server.unref();
        resolve();
      });
    });
  }

  function stop() {
    if (server) { try { server.close(); } catch {} }
    server = null;
    try { fs.unlinkSync(sockPath); } catch {}
    if (credPath) { try { fs.unlinkSync(credPath); } catch {} }
  }

  return { start, stop, activeCount: () => active };
}

module.exports = {
  INTENT_SOCKET_MAX_BYTES,
  INTENT_SOCKET_MAX_CONNS,
  INTENT_SOCKET_TIMEOUT_MS,
  mintIntentCredential,
  seatChannelEnv,
  credMatches,
  subagentTag,
  seatOfAgentTag,
  isMainThread,
  IDENT_ENV,
  IDENT_SEEN_MAX,
  IDENT_SEEN_MS,
  mintIdentNonce,
  SUBAGENT_BRIEF,
  identToken,
  identIsMain,
  callerIsSubagent,
  shellSegments,
  stampClodexCommand,
  hookIdentOutput,
  intentLabel,
  createIntentRequestHandler,
  createIntentSocketServer,
};
