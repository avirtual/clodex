'use strict';

const crypto = require('crypto');

const SUITE_DESK_V = 1;
const CALL_ID_RE = /^[0-9a-f]{16}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;
const PRESENCE_MS = 45000;
const TOMBSTONE_MAX = 4096;
const SUITE_DESK_REPLY_MAX = 2 * 1024 * 1024;
const DESK_LIMITS = Object.freeze({
  perOrigin: 32,
  total: 128,
  blobBytes: 32 * 1024 * 1024,
  batchBytes: 512 * 1024,
  chunkMax: 4 * 1024 * 1024,
  submitMax: 256 * 1024,
  floorMs: 20000,
  putMs: 120000,
  origins: 256,
});
const EXPIRY_LOG_MS = 5000;
const RUNNER_RESTART =Object.freeze({ ok: false, error: 'runner session replaced', reason: 'runner-restart' });

function answer(status, body, error = null) {
  return { status, body, error };
}

function plainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function redactPath(path) {
  const q = path.indexOf('?');
  if (q < 0) return path;
  const keys = [...new URLSearchParams(path.slice(q + 1))].map(([k, v]) => (k === 'ids' ? `ids[${v.split(',').filter(Boolean).length}]` : k));
  return `${path.slice(0, q)}?${keys.join('&')}`;
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function createSuiteDesk({
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  notify = () => {},
  limits = {},
  presenceMs = PRESENCE_MS,
  randomHex = (n) => crypto.randomBytes(n).toString('hex'),
  log = () => {},
} = {}) {
  const lim = { ...DESK_LIMITS, ...limits };
  const expiryLog = new Map();
  const slots = new Map();
  const calls = new Map();
  const tombs = new Map();

  function slot(origin) {
    let s = slots.get(origin);
    if (!s) {
      s = { session: null, lastClaim: null, lastSeen: null, pending: [], claimed: new Map(), bytes: 0 };
      slots.set(origin, s);
    }
    return s;
  }

  function evictIdle() {
    let oldest = null;
    for (const [origin, s] of slots) {
      if (attached(origin) || s.pending.length || s.claimed.size) continue;
      if (!oldest || s.lastSeen < slots.get(oldest).lastSeen) oldest = origin;
    }
    if (oldest == null) return false;
    slots.delete(oldest);
    return true;
  }

  function attached(origin) {
    const s = slots.get(origin);
    if (!s || !s.session) return false;
    const t = now();
    if (s.lastSeen != null && t - s.lastSeen < presenceMs) return true;
    for (const call of s.claimed.values()) if (t < call.deadline) return true;
    return false;
  }

  function tomb(id, reason) {
    tombs.set(id, reason);
    while (tombs.size > TOMBSTONE_MAX) tombs.delete(tombs.keys().next().value);
  }

  function settle(call, result, reason) {
    if (calls.get(call.id) !== call) return false;
    calls.delete(call.id);
    timers.clearTimeout(call.timer);
    const s = slots.get(call.origin);
    if (s) {
      const at = s.pending.indexOf(call);
      if (at >= 0) s.pending.splice(at, 1);
      s.claimed.delete(call.id);
      if (call.blob) s.bytes -= call.blob.length;
    }
    call.blob = null;
    call.body = null;
    tomb(call.id, reason);
    call.resolve(result);
    return true;
  }

  function logExpiry(call, state) {
    const t = now();
    const seen = expiryLog.get(call.origin) || { at: null, suppressed: 0 };
    expiryLog.set(call.origin, seen);
    if (seen.at != null && t - seen.at < EXPIRY_LOG_MS) {
      seen.suppressed += 1;
      return;
    }
    const more = seen.suppressed ? ` +${seen.suppressed}` : '';
    seen.at = t;
    seen.suppressed = 0;
    log(`call expired unanswered: ${call.origin} ${call.method} ${redactPath(call.path)} (${state}, ${t - call.born} ms)${more}`);
  }

  function expire(call) {
    const state = call.claim ? 'claimed' : 'pending';
    if (settle(call, answer(0, null, 'runner did not answer in time'), 'expired')) logExpiry(call, state);
  }

  function freshId() {
    for (;;) {
      const id = randomHex(8);
      if (!calls.has(id) && !tombs.has(id)) return id;
    }
  }

  function enqueue(origin, { method, path, headers, body, bodyBytes, blob }, timeout) {
    if (!attached(origin)) return Promise.resolve(answer(503, null, `runner ${origin} is not attached`));
    const s = slot(origin);
    if (s.pending.length + s.claimed.size >= lim.perOrigin || calls.size >= lim.total) {
      return Promise.resolve(answer(429, null, 'suite desk is full'));
    }
    if (blob && s.bytes + blob.length > lim.blobBytes) {
      return Promise.resolve(answer(429, null, 'suite desk holds too many bytes for this runner'));
    }
    const ms = Math.max(Number.isFinite(timeout) ? timeout : 0, lim.floorMs);
    return new Promise((resolve) => {
      const call = {
        id: freshId(), origin, method, path, headers, body, bodyBytes, blob,
        born: now(), deadline: now() + ms, claim: null, resolve, timer: null,
      };
      call.timer = timers.setTimeout(() => expire(call), ms);
      if (call.timer && typeof call.timer.unref === 'function') call.timer.unref();
      calls.set(call.id, call);
      s.pending.push(call);
      if (blob) s.bytes += blob.length;
      try { notify(origin); } catch {}
    });
  }

  function conn(origin) {
    return {
      suiteAsk(method, path, payload = null, timeout) {
        const text = payload == null ? null : JSON.stringify(payload);
        const bodyBytes = text == null ? 0 : Buffer.byteLength(text);
        if (bodyBytes > lim.submitMax) return Promise.resolve(answer(413, { ok: false, error: 'request body too large' }));
        return enqueue(origin, {
          method: String(method), path: String(path), headers: {},
          body: text == null ? null : JSON.parse(text), bodyBytes, blob: null,
        }, timeout);
      },
      suitePut(path, buffer, headers, timeout = lim.putMs) {
        if (!Buffer.isBuffer(buffer)) return Promise.resolve(answer(400, { ok: false, error: 'body must be a buffer' }));
        if (buffer.length > lim.chunkMax) return Promise.resolve(answer(413, { ok: false, error: 'chunk too large' }));
        const copied = {};
        for (const [k, v] of Object.entries(headers || {})) copied[String(k).toLowerCase()] = String(v);
        return enqueue(origin, { method: 'PUT', path: String(path), headers: copied, body: null, bodyBytes: 0, blob: buffer }, timeout);
      },
    };
  }

  function claim(origin, session) {
    if (typeof session !== 'string' || !SESSION_RE.test(session)) return { status: 400, error: 'bad session' };
    if (!slots.has(origin) && slots.size >= lim.origins && !evictIdle()) {
      return { status: 429, error: 'suite desk tracks too many runners' };
    }
    const s = slot(origin);
    const t = now();
    if (s.session && s.session !== session) {
      if (attached(origin)) {
        return { status: 409, error: 'another runner session is attached for this origin' };
      }
      let n = 0;
      for (const call of [...s.pending, ...s.claimed.values()]) if (settle(call, answer(404, { ...RUNNER_RESTART }), 'replaced')) n += 1;
      log(`runner session for ${origin} replaced; settled ${n} call(s)`);
    }
    s.session = session;
    s.lastClaim = t;
    s.lastSeen = t;
    const out = [];
    let bytes = 0;
    while (s.pending.length) {
      const call = s.pending[0];
      if (t >= call.deadline) {
        expire(call);
        continue;
      }
      if (out.length && bytes + call.bodyBytes > lim.batchBytes) break;
      s.pending.shift();
      call.claim = randomHex(16);
      s.claimed.set(call.id, call);
      bytes += call.bodyBytes;
      out.push({
        id: call.id, claim: call.claim, ttlMs: call.deadline - t,
        method: call.method, path: call.path, headers: { ...call.headers },
        body: call.body, blob: call.blob ? { bytes: call.blob.length } : null,
      });
    }
    return { status: 200, calls: out };
  }

  function lookup(id, token) {
    const call = calls.get(id);
    if (!call) {
      const reason = tombs.get(id);
      if (!reason) return { status: 404, error: 'unknown call' };
      return { status: 410, error: reason === 'expired' ? 'call expired' : 'call already settled' };
    }
    if (!call.claim || !sameToken(token, call.claim)) return { status: 409, error: 'wrong claim token' };
    const s = slots.get(call.origin);
    if (s && s.claimed.get(call.id) === call) s.lastSeen = now();
    if (now() >= call.deadline) {
      expire(call);
      return { status: 410, error: 'call expired' };
    }
    return { call };
  }

  function blob(id, token) {
    const found = lookup(id, token);
    if (!found.call) return found;
    if (!found.call.blob) return { status: 404, error: 'call has no blob' };
    return { status: 200, bytes: found.call.blob };
  }

  function reply(id, token, got) {
    const found = lookup(id, token);
    if (!found.call) return found;
    const st = got && got.status;
    if (!Number.isInteger(st) || st < 100 || st > 599 || !plainObject(got.body)) {
      settle(found.call, answer(502, null, 'runner sent a malformed reply'), 'settled');
      return { status: 400, error: 'bad reply' };
    }
    settle(found.call, answer(st, got.body), 'settled');
    return { status: 200 };
  }

  function retained(origin) {
    const s = slots.get(origin);
    return s ? { unsettled: s.pending.length + s.claimed.size, bytes: s.bytes } : { unsettled: 0, bytes: 0 };
  }

  function origins() {
    return [...slots.entries()]
      .filter(([, s]) => s.lastClaim != null)
      .map(([origin, s]) => ({ origin, attached: attached(origin), lastClaim: s.lastClaim, lastSeen: s.lastSeen }));
  }

  function close() {
    for (const call of [...calls.values()]) settle(call, answer(0, null, 'suite desk closed'), 'expired');
    slots.clear();
  }

  return { conn, claim, blob, reply, attached, origins, retained, close };
}

module.exports = {
  createSuiteDesk, SUITE_DESK_V, CALL_ID_RE, SESSION_RE, PRESENCE_MS, DESK_LIMITS, SUITE_DESK_REPLY_MAX,
};
