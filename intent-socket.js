'use strict';

const INTENT_SOCKET_MAX_BYTES = 64 * 1024;
const INTENT_SOCKET_MAX_CONNS = 8;
const INTENT_SOCKET_TIMEOUT_MS = 10 * 1000;
const ASYNC_TAIL = "a reply arrives in the seat's main conversation";
const RESULT_TAIL = "any result arrives in the seat's main conversation";

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
  return sessionId === agentId || sessionId.endsWith(`-${agentId}`);
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
  seat, parse, entryOf, sessionIdOf, allows, refusal, dispatch, replyWaitMs,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  return async function handleIntentRequest(req, ctl) {
    const text = req && typeof req.intent === 'string' ? req.intent : '';
    if (!text.trim()) return { ok: false, error: 'empty intent' };
    const intents = parse(text).filter((i) => i && i.type !== 'end' && i.type !== 'escape');
    if (!intents.length) return { ok: false, error: 'no [agent:…] intent in the request' };
    if (intents.length > 1) return { ok: false, error: 'one intent per call' };
    const intent = intents[0];
    if (intent.type === 'unknown') return { ok: false, error: `unrecognized intent \`${intent.text}\`` };
    const agentId = req && typeof req.agentId === 'string' && req.agentId.trim() ? req.agentId.trim() : null;
    const subagent = !!agentId && !isMainThread(agentId, sessionIdOf());
    if (subagent) {
      const why = refusal ? refusal(intent, entryOf()) : (allows(intent, entryOf()) ? null : '');
      if (why !== null) return { ok: false, error: why || `not available to a subagent: ${intentLabel(intent)}` };
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
        if (!replied) return { ok: true, reply: lateReply(intent) };
      }
    } finally {
      open = false;
    }
    return { ok: true, reply: lines.length ? lines.join('\n') : defaultReply(intent) };
  };
}

function createIntentSocketServer({
  net, fs, crypto, sockPath, cred, handle, log,
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
    sock.on('close', release);
    let done = false;
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
      const request = { intent: req.intent, agentId: req.agentId, agentType: req.agentType };
      Promise.resolve()
        .then(() => handle(request, { closed: () => done, extend }))
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
        if (typeof server.unref === 'function') server.unref();
        resolve();
      });
    });
  }

  function stop() {
    if (server) { try { server.close(); } catch {} }
    server = null;
    try { fs.unlinkSync(sockPath); } catch {}
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
  intentLabel,
  createIntentRequestHandler,
  createIntentSocketServer,
};
