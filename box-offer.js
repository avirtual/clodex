'use strict';

const NODE_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PLATFORM_RE = /^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/;
const SCOPE = 'discovery';
const AVAILABILITY = ['always', 'schedule'];
const MAX_BOXES = 16;
const MAX_PEERS = 32;
const MAX_WINDOWS = 8;
const MAX_PLATFORMS = 8;
const RECORD_KEYS = ['scope', 'enabled', 'boxes', 'availability', 'schedule', 'peers'];
const WINDOW_KEYS = ['days', 'from', 'to'];
const PEER_KEYS = ['name'];
const WIRE_KEYS = ['scope', 'boxes', 'platforms', 'runtime', 'open'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
const isBoxCount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_BOXES;

function toMinutes(hhmm) {
  const m = HHMM_RE.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function sanitizeWindow(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, WINDOW_KEYS)) return null;
  const { days, from, to } = raw;
  if (!Array.isArray(days) || days.length === 0 || days.length > 7) return null;
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
  if (raw.scope !== SCOPE) return null;
  if (typeof raw.enabled !== 'boolean') return null;
  if (!isBoxCount(raw.boxes)) return null;
  if (!AVAILABILITY.includes(raw.availability)) return null;
  const peers = sanitizePeerList(raw.peers);
  if (!peers) return null;
  const out = { scope: SCOPE, enabled: raw.enabled, boxes: raw.boxes, availability: raw.availability };
  if (raw.availability === 'schedule') {
    if (!Array.isArray(raw.schedule) || raw.schedule.length === 0 || raw.schedule.length > MAX_WINDOWS) return null;
    const windows = raw.schedule.map(sanitizeWindow);
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
  for (const p of raw) {
    if (typeof p === 'string' && PLATFORM_RE.test(p) && !out.includes(p)) out.push(p);
    if (out.length === MAX_PLATFORMS) break;
  }
  return out;
}

function wireEntry(offer, facts, peerName) {
  const clean = sanitizeBoxOffer(offer);
  if (!clean || !clean.enabled) return null;
  if (typeof peerName !== 'string' || !clean.peers.some((p) => p.name === peerName)) return null;
  const f = facts || {};
  return {
    scope: SCOPE,
    boxes: clean.boxes,
    platforms: sanitizePlatforms(f.platforms),
    runtime: f.runtime === true,
    open: scheduleOpen(clean, f.now instanceof Date ? f.now : new Date()),
  };
}

function sanitizeWireEntry(raw) {
  if (!isPlainObject(raw) || !onlyKeys(raw, WIRE_KEYS)) return null;
  if (raw.scope !== SCOPE || !isBoxCount(raw.boxes)) return null;
  if (!Array.isArray(raw.platforms) || raw.platforms.length > MAX_PLATFORMS) return null;
  if (!raw.platforms.every((p) => typeof p === 'string' && PLATFORM_RE.test(p))) return null;
  if (typeof raw.runtime !== 'boolean' || typeof raw.open !== 'boolean') return null;
  return { scope: SCOPE, boxes: raw.boxes, platforms: [...new Set(raw.platforms)], runtime: raw.runtime, open: raw.open };
}

function sanitizeWireOffers(raw) {
  if (!isPlainObject(raw)) return null;
  return { own: raw.own == null ? null : sanitizeWireEntry(raw.own) };
}

module.exports = {
  sanitizeBoxOffer,
  offerFromEnv,
  scheduleOpen,
  wireEntry,
  sanitizeWireOffers,
};
