'use strict';

const crypto = require('crypto');

const OFFER_TTL_MS = 60000;
const RUNTIME_TTL_MS = 15000;
const RUNTIME_TIMEOUT_MS = 5000;
const PROVENANCES = ['hello', 'announce'];
const PLATFORM_RE = /^[a-z0-9]{1,16}\/[a-z0-9_]{1,16}$/;
const MAX_PLATFORMS = 8;

const newRouteHandle = () => crypto.randomBytes(12).toString('base64url');

const unrefTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

function createOfferDirectory({ now = Date.now, ttlMs = OFFER_TTL_MS, newRoute = newRouteHandle } = {}) {
  const rows = new Map();
  const keyOf = (provenance, source) => `${provenance}\u0000${source}`;

  function sweep() {
    const t = now();
    for (const [key, row] of rows) {
      if (t - row.at >= ttlMs) rows.delete(key);
    }
  }

  function set({ provenance, source, name, offer } = {}) {
    if (!PROVENANCES.includes(provenance) || typeof source !== 'string' || !source) return false;
    sweep();
    const key = keyOf(provenance, source);
    if (!offer) {
      rows.delete(key);
      return true;
    }
    const prev = rows.get(key);
    rows.set(key, {
      route: prev ? prev.route : newRoute(),
      provenance,
      name: typeof name === 'string' && name ? name : source,
      offer,
      at: now(),
    });
    return true;
  }

  function list() {
    sweep();
    return [...rows.values()].map((row) => ({ ...row }));
  }

  return { set, list };
}

function parsePlatforms(text) {
  const out = [];
  for (const p of String(text || '').split(/[\s,]+/)) {
    if (PLATFORM_RE.test(p) && !out.includes(p)) out.push(p);
    if (out.length === MAX_PLATFORMS) break;
  }
  return out;
}

function createRuntimeProbe({
  run, enabled = true, now = Date.now, ttlMs = RUNTIME_TTL_MS, timeoutMs = RUNTIME_TIMEOUT_MS,
  setTimer = unrefTimer, clearTimer = clearTimeout,
} = {}) {
  let value = null;
  let at = null;
  let inflight = null;

  function refresh() {
    if (!enabled || typeof run !== 'function') return Promise.resolve(null);
    if (inflight) return inflight;
    inflight = new Promise((resolve) => {
      let timer = null;
      let settled = false;
      const finish = (v) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        resolve(v);
      };
      timer = setTimer(() => finish(null), timeoutMs);
      Promise.resolve()
        .then(() => run(timeoutMs))
        .then((out) => {
          const platforms = parsePlatforms(out);
          finish(platforms.length ? { platforms } : null);
        }, () => finish(null));
    }).then((v) => {
      value = v;
      at = now();
      inflight = null;
      return v;
    });
    return inflight;
  }

  function current() {
    if (enabled && (at === null || now() - at >= ttlMs)) refresh();
    return value;
  }

  return { current, refresh };
}

function hostFacts({ osModule, platform, arch, runtime }) {
  const cpus = osModule.cpus();
  return {
    os: platform,
    arch,
    cpus: Array.isArray(cpus) ? cpus.length : null,
    memMb: Math.round(osModule.totalmem() / 1048576),
    runtime: runtime || null,
  };
}

module.exports = {
  OFFER_TTL_MS,
  createOfferDirectory,
  createRuntimeProbe,
  parsePlatforms,
  hostFacts,
};
