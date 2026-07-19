'use strict';
// detect-cache.js — a generic TTL + in-flight-dedupe cache around an async probe.
// Lifted out of sandbox.js (Task 12) so tool-doctor.js can share it WITHOUT a lean
// leaf pulling in the whole sandbox module (compose generation, net, crypto,
// env-file). sandbox.js now requires + re-exports createDetectCache, so its unit
// suite still imports it from ../sandbox unchanged.
//
// Pure leaf: no electron, no I/O of its own — the `probe` is injected, and `now`
// is injectable so the TTL is unit-testable with a fake clock. NEW leaf (not a
// renderer extraction) — deliberately NOT in free-identifier-leaks SCANNED lists.

// Default trust window: the probed state (a CLI on PATH, docker up) changes
// rarely, so a coarse TTL keeps gating cheap (one probe per window, not per click)
// while still noticing a change within ~half a minute.
const DEFAULT_DETECT_TTL_MS = 30000;

// TTL cache + in-flight dedupe around a detection `probe`. get() returns the
// cached result (stamped with `cachedAt`) while it's younger than ttlMs, folds
// concurrent callers onto one in-flight probe, and re-probes past the TTL.
// invalidate() drops the cache so the next get() re-probes immediately — used
// after a late failure reveals the probed thing went away.
function createDetectCache({ probe, now = Date.now, ttlMs = DEFAULT_DETECT_TTL_MS } = {}) {
  let last = null;      // { result, ts } — the most recent settled probe
  let inflight = null;  // the shared Promise while a probe is running
  const stamp = (result, ts) => ({ ...result, cachedAt: ts });
  function get() {
    if (last && (now() - last.ts) < ttlMs) return Promise.resolve(stamp(last.result, last.ts));
    if (inflight) return inflight;
    inflight = Promise.resolve().then(probe).then(
      (result) => { const ts = now(); last = { result, ts }; inflight = null; return stamp(result, ts); },
      (err) => { inflight = null; throw err; },
    );
    return inflight;
  }
  function invalidate() { last = null; }
  return { get, invalidate };
}

module.exports = { createDetectCache, DEFAULT_DETECT_TTL_MS };
