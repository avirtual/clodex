'use strict';

const NODE_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PLATFORM_RE = /^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/;
const DISCOVERY = 'discovery';
const RUN = 'run';
const SCOPES = [DISCOVERY, RUN];
const OFFERS_WIRE_VERSION = 1;
const AVAILABILITY = ['always', 'schedule'];
const MAX_BOXES = 16;
const MAX_PEERS = 32;
const MAX_WINDOWS = 8;
const MAX_PLATFORMS = 8;
const RECORD_KEYS = ['scope', 'enabled', 'boxes', 'availability', 'schedule', 'peers'];
const WINDOW_KEYS = ['days', 'from', 'to'];
const PEER_KEYS = ['name'];
const WIRE_KEYS = ['scope', 'boxes', 'open', 'kinds', 'facts'];
const FACT_KEYS = ['os', 'arch', 'cpus', 'memMb', 'runtime'];
const RUNTIME_KEYS = ['platforms'];
const KINDS = ['container', 'native'];
const PRODUCED_KINDS = ['container'];
const TOKEN_RE = /^[a-z0-9_]{1,32}$/;
const MAX_CPUS = 4096;
const MAX_MEM_MB = 16777216;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
const isBoxCount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_BOXES;

function toMinutes(hhmm) {
  const m = HHMM_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function sanitizeWindow(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, WINDOW_KEYS)) return null;
  const { from, to } = raw;
  if (!Array.isArray(raw.days)) return null;
  const days = Array.from(raw.days);
  if (days.length === 0 || days.length > 7) return null;
  if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (new Set(days).size !== days.length) return null;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const f = toMinutes(from);
  const t = toMinutes(to);
  if (f === null || t === null || f === t) return null;
  return { days: [...days], from, to };
}

function sanitizePeerList(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_PEERS) return null;
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    if (!isPlainObject(p) || !onlyKeys(p, PEER_KEYS)) return null;
    if (typeof p.name !== 'string' || !NODE_NAME_RE.test(p.name)) return null;
    if (seen.has(p.name)) return null;
    seen.add(p.name);
    out.push({ name: p.name });
  }
  return out;
}

function sanitizeBoxOffer(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, RECORD_KEYS)) return null;
  if (!SCOPES.includes(raw.scope)) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  if (!isBoxCount(raw.boxes)) return null;
  if (!AVAILABILITY.includes(raw.availability)) return null;
  const peers = sanitizePeerList(raw.peers);
  if (!peers) return null;
  const out = { scope: raw.scope, enabled: raw.enabled, boxes: raw.boxes, availability: raw.availability };
  if (raw.availability === 'schedule') {
    if (!Array.isArray(raw.schedule) || raw.schedule.length === 0 || raw.schedule.length > MAX_WINDOWS) return null;
    const windows = Array.from(raw.schedule, sanitizeWindow);
    if (windows.some((w) => w === null)) return null;
    out.schedule = windows;
  } else if ('schedule' in raw) {
    return null;
  }
  out.peers = peers;
  return out;
}

function offerFromEnv(env = process.env, log = console) {
  const text = env.CLODEX_BOX_OFFER;
  if (typeof text !== 'string' || !text.trim()) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    log.error(`CLODEX_BOX_OFFER is not valid JSON; box offer off: ${e.message}`);
    return null;
  }
  const offer = sanitizeBoxOffer(parsed);
  if (!offer) log.error('CLODEX_BOX_OFFER is not a valid box offer; box offer off');
  return offer;
}

function scheduleOpen(offer, now = new Date()) {
  if (!offer || offer.enabled !== true) return false;
  if (offer.availability === 'always') return true;
  if (offer.availability !== 'schedule' || !Array.isArray(offer.schedule)) return false;
  const day = now.getDay();
  const prevDay = (day + 6) % 7;
  const minute = now.getHours() * 60 + now.getMinutes();
  return offer.schedule.some((w) => {
    const from = toMinutes(w.from);
    const to = toMinutes(w.to);
    if (from === null || to === null) return false;
    if (from < to) return w.days.includes(day) && minute >= from && minute < to;
    return (w.days.includes(day) && minute >= from) || (w.days.includes(prevDay) && minute < to);
  });
}

function sanitizePlatforms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of Array.from(raw)) {
    if (typeof p === 'string' && PLATFORM_RE.test(p) && !out.includes(p)) out.push(p);
    if (out.length === MAX_PLATFORMS) break;
  }
  return out;
}

const intOrNull = (n, max) => (Number.isInteger(n) && n >= 1 && n <= max ? n : null);
const tokenOrNull = (s) => (typeof s === 'string' && TOKEN_RE.test(s) ? s : null);
const validInt = (n, max) => n === null || intOrNull(n, max) !== null;
const validToken = (s) => s === null || tokenOrNull(s) !== null;

function produceFacts(raw) {
  const f = isPlainObject(raw) ? raw : {};
  const platforms = isPlainObject(f.runtime) ? sanitizePlatforms(f.runtime.platforms) : [];
  return {
    os: tokenOrNull(f.os),
    arch: tokenOrNull(f.arch),
    cpus: intOrNull(f.cpus, MAX_CPUS),
    memMb: intOrNull(f.memMb, MAX_MEM_MB),
    runtime: platforms.length ? { platforms } : null,
  };
}

function runGrant(offer, peerName, now = new Date()) {
  const clean = sanitizeBoxOffer(offer);
  const serve = !!clean && clean.scope === RUN && clean.enabled
    && typeof peerName === 'string' && clean.peers.some((p) => p.name === peerName);
  return { admit: serve && scheduleOpen(clean, now), serve };
}

function runConfirmed(offer, confirm) {
  const clean = sanitizeBoxOffer(offer);
  if (!clean || clean.scope !== RUN || !clean.enabled) return true;
  if (!isPlainObject(confirm) || !Array.isArray(confirm.peers)) return false;
  const want = clean.peers.map((p) => p.name).sort();
  const got = Array.from(confirm.peers).sort();
  return want.length === got.length && want.every((n, i) => n === got[i]);
}

function offerEntry(offer, facts, now, { run = false } = {}) {
  const clean = sanitizeBoxOffer(offer);
  if (!clean || !clean.enabled) return null;
  return {
    scope: clean.scope === RUN && run === true ? RUN : DISCOVERY,
    boxes: clean.boxes,
    open: scheduleOpen(clean, now instanceof Date ? now : new Date()),
    kinds: [...PRODUCED_KINDS],
    facts: produceFacts(typeof facts === 'function' ? facts() : facts),
  };
}

function wireEntry(offer, facts, peerName, now, opts) {
  const clean = sanitizeBoxOffer(offer);
  if (!clean || typeof peerName !== 'string' || !clean.peers.some((p) => p.name === peerName)) return null;
  return offerEntry(clean, facts, now, opts);
}

function sanitizeWireRuntime(raw) {
  if (raw === null) return null;
  if (!isPlainObject(raw) || !onlyKeys(raw, RUNTIME_KEYS) || !Array.isArray(raw.platforms)) return undefined;
  const platforms = Array.from(raw.platforms);
  if (platforms.length === 0 || platforms.length > MAX_PLATFORMS) return undefined;
  if (!platforms.every((p) => typeof p === 'string' && PLATFORM_RE.test(p))) return undefined;
  return { platforms: [...new Set(platforms)] };
}

function sanitizeWireFacts(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, FACT_KEYS) || !FACT_KEYS.every((k) => k in raw)) return null;
  if (!validToken(raw.os) || !validToken(raw.arch)) return null;
  if (!validInt(raw.cpus, MAX_CPUS) || !validInt(raw.memMb, MAX_MEM_MB)) return null;
  const runtime = sanitizeWireRuntime(raw.runtime);
  if (runtime === undefined) return null;
  return { os: raw.os, arch: raw.arch, cpus: raw.cpus, memMb: raw.memMb, runtime };
}

function sanitizeWireKinds(raw) {
  if (!Array.isArray(raw)) return null;
  const kinds = Array.from(raw);
  if (kinds.length === 0 || !kinds.every((k) => KINDS.includes(k))) return null;
  return new Set(kinds).size === kinds.length ? kinds : null;
}

function sanitizeWireEntry(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, WIRE_KEYS)) return null;
  if (!SCOPES.includes(raw.scope) || !isBoxCount(raw.boxes) || typeof raw.open !== 'boolean') return null;
  const kinds = sanitizeWireKinds(raw.kinds);
  const facts = sanitizeWireFacts(raw.facts);
  if (!kinds || !facts) return null;
  return { scope: raw.scope, boxes: raw.boxes, open: raw.open, kinds, facts };
}

function sanitizeWireOffers(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.own == null) return { own: null };
  const own = sanitizeWireEntry(raw.own);
  return own ? { own } : null;
}

function warnStoredOffer(readRaw, warn) {
  let raw;
  try {
    raw = readRaw();
  } catch {
    return false;
  }
  if (!isPlainObject(raw) || raw.boxOffer == null || sanitizeBoxOffer(raw.boxOffer)) return false;
  warn('ui-settings boxOffer is not a valid box offer; box offer off');
  return true;
}

function bootOffer(env, readStored, log) {
  const fromEnv = offerFromEnv(env, log);
  if (fromEnv === undefined) warnStoredOffer(readStored, (m) => log.warn(m));
  return fromEnv;
}

const offerEnabled = (raw) => sanitizeBoxOffer(raw)?.enabled === true;

module.exports = {
  NODE_NAME_RE,
  MAX_PEERS,
  MAX_BOXES,
  sanitizeBoxOffer,
  offerFromEnv,
  scheduleOpen,
  runGrant,
  runConfirmed,
  offerEntry,
  wireEntry,
  sanitizeWireOffers,
  OFFERS_WIRE_VERSION,
  warnStoredOffer,
  bootOffer,
  offerEnabled,
};
