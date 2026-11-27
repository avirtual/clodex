'use strict';

const PLATFORM_RE = /^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/;
const SCOPES = ['discovery', 'run'];
const MAX_BOXES = 16;
const MAX_PLATFORMS = 8;
const WIRE_KEYS = ['scope', 'boxes', 'open', 'kinds', 'facts'];
const FACT_KEYS = ['os', 'arch', 'cpus', 'memMb', 'runtime'];
const RUNTIME_KEYS = ['platforms'];
const KINDS = ['container', 'native'];
const TOKEN_RE = /^[a-z0-9_]{1,32}$/;
const MAX_CPUS = 4096;
const MAX_MEM_MB = 16777216;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (obj, allowed) => Object.keys(obj).every((k) => allowed.includes(k));
const isBoxCount = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_BOXES;
const intOrNull = (n, max) => (Number.isInteger(n) && n >= 1 && n <= max ? n : null);
const tokenOrNull = (s) => (typeof s === 'string' && TOKEN_RE.test(s) ? s : null);
const validInt = (n, max) => n === null || intOrNull(n, max) !== null;
const validToken = (s) => s === null || tokenOrNull(s) !== null;

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

function baseSanitizeWireOffers(raw) {
  if (!isPlainObject(raw)) return null;
  if (raw.own == null) return { own: null };
  const own = sanitizeWireEntry(raw.own);
  return own ? { own } : null;
}

module.exports = { baseSanitizeWireOffers };
