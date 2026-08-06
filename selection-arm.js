// selection-arm.js — registers the operator's drawer selection as a tail hint
// on the active session's wirescope route. selection-hint.js composes the text;
// this owns WHEN it is on the wire and when it comes off.
//
// Two registers per session, one per tier, and they are independent by
// construction: a peek is overwritten by the next drag while an attachment sits
// until the operator takes it back. Same-text arms are dropped BEFORE the POST —
// a drag that ends where it started, a re-render that re-reports an unchanged
// selection, and a second click on Copy must not each cost a request.
//
// THE PEEK IS SUPPRESSED WHILE THE SAME BYTES ARE ATTACHED. Both tiers ride the
// tail of the same request, so without this the model receives the operator's
// text twice under two different framings — one saying it was deliberate, one
// saying it may be irrelevant — and has no way to tell they are the same thing.
//
// EVERY PROXY OP FOR A SESSION IS SERIALIZED. In-process ordering is not enough:
// the attach path POSTs the attachment and then DELETEs the peek it supersedes,
// so a peek POST issued 300ms earlier and still in flight lands AFTER that
// DELETE. The result is both framings live on the proxy with the memo pointing
// at neither, which no later call can take back — clear() is memo-gated and
// finds nothing to do. The chain is what makes the DELETE reach the proxy after
// the POST it is meant to undo, not merely after it was issued.
//
// ARMING MAY NEVER BLOCK THE GESTURE. Every path resolves to a result object;
// nothing throws at the caller, and a proxy that is down or slow costs the
// operator a status line, never a copy.
//
// Electron-free, so the tier interaction is testable without a window.

'use strict';

const {
  buildSelectionHint, PEEK_ID, ATTACH_ID, PEEK_TTL_S, ATTACH_TTL_S,
} = require('./selection-hint');

const ID_FOR = { peek: PEEK_ID, attach: ATTACH_ID };
// The memo expires with the REGISTRATION it describes, which is what keeps a
// stale memo from producing a false claim: the proxy drops a hint at its ttl_s,
// and a memo that outlives it turns the next arm of the same text into a no-op
// reporting `armed` for something nothing is carrying.
const TTL_MS = { peek: PEEK_TTL_S * 1000, attach: ATTACH_TTL_S * 1000 };

// deps:
//   armHints    ({base, route, hint}) -> Promise<{status}>
//   clearHints  ({base, route, id}) -> Promise
//   enabled     () -> bool            the live pref, read per call
//   scrubber    () -> {scrub, tokens} the token set to redact, read per call
function createSelectionArm({
  armHints, clearHints, enabled = null, scrubber = null, log = null, now = Date.now,
}) {
  // session name -> { peek, attach }, each `{ text, bytes, truncated, until }`
  // or null. `text` is the RAW selection last accepted by the proxy, not the
  // composed hint: comparing raw is what makes the same-text drop survive a
  // change to the framing prose.
  const registers = new Map();
  // session name -> tail of that session's proxy ops (see the header).
  const chains = new Map();

  const debug = (msg) => { try { if (log && log.debug) log.debug('hint', msg); } catch {} };

  function regFor(key) {
    if (!registers.has(key)) registers.set(key, { peek: null, attach: null });
    return registers.get(key);
  }

  // A rejected predecessor must not poison the chain — one failed clear would
  // otherwise silently swallow every later selection for that session.
  function serialize(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(key, run.then(() => {}, () => {}));
    return run;
  }

  // What the proxy still holds for a tier, or null.
  function held(key, tier) {
    const reg = regFor(key);
    const e = reg[tier];
    if (!e) return null;
    if (e.until <= now()) { reg[tier] = null; return null; }
    return e;
  }

  function memo(key, tier, entry) {
    regFor(key)[tier] = entry ? { ...entry, until: now() + TTL_MS[tier] } : null;
  }

  // Idempotent on the proxy side, so the memo is the only thing worth guarding:
  // clearing a tier that was never armed is a free 200 nobody needs to pay for.
  async function clear(key, tier, ctx) {
    if (!held(key, tier)) return;
    memo(key, tier, null);
    const { base, route } = ctx || {};
    if (!base || !route) return;
    try {
      await clearHints({ base, route, id: ID_FOR[tier] });
    } catch (e) { debug(`selection clear (${tier}) failed for ${route}: ${e.message}`); }
  }

  async function armOnce(key, { text = '', tab = '', attach = false } = {}, ctx = {}) {
    const tier = attach ? 'attach' : 'peek';
    const raw = String(text == null ? '' : text);
    const { base, route } = ctx || {};
    // Read per call, never captured: the checkbox must take effect on the next
    // selection rather than the next launch.
    if (enabled && !enabled()) return { armed: false, reason: 'selection hints are off' };
    // No route means the CLI does not go through wirescope at all, so there is
    // nothing to attach to and nothing registered to take back.
    if (!base || !route) return { armed: false, reason: 'wirescope is not routing this session' };

    if (!raw.trim()) {
      await clear(key, tier, ctx);
      return { armed: false, reason: 'nothing selected' };
    }

    const attached = held(key, 'attach');
    // Clicking Copy on text that is already attached TAKES IT BACK. This is
    // the only off switch: an attachment is not `once`, so without it the
    // operator's text rides every request until the TTL expires, with no
    // gesture that stops it. Toggling on identity rather than on a separate
    // control keeps the affordance where the operator already is.
    if (attach && attached && attached.text === raw) {
      const bytes = attached.bytes;
      await clear(key, 'attach', ctx);
      return { armed: false, detached: true, bytes };
    }
    // The attachment already carries these exact bytes under a stronger
    // framing; a peek would duplicate them (see the header).
    if (!attach && attached && attached.text === raw) {
      await clear(key, 'peek', ctx);
      return { armed: false, reason: 'already attached' };
    }
    const live = held(key, tier);
    if (live && live.text === raw) {
      return { armed: true, bytes: live.bytes, truncated: live.truncated, unchanged: true };
    }

    // A null scrubber leaves buildSelectionHint's own identity defaults in
    // place. Spread rather than passed through: a scrubber returning `null`
    // for either field would DEFEAT those defaults, since a parameter default
    // fires on undefined and not on null.
    const s = (scrubber && scrubber()) || {};
    const hint = buildSelectionHint({
      text: raw,
      tab,
      attach,
      scrub: typeof s.scrub === 'function' ? s.scrub : undefined,
      tokens: Array.isArray(s.tokens) ? s.tokens : undefined,
    });
    if (!hint) {
      await clear(key, tier, ctx);
      return { armed: false, reason: 'nothing selected' };
    }
    // The measurements are for the operator's status line, not the proxy: the
    // rest spread is what keeps them off the wire without a second copy of the
    // field list here to drift against the composer's.
    const { bytes, truncated, ...wire } = hint;

    // Memoised BEFORE the await and rolled back on failure, so a caller that
    // does not go through arm() cannot double-POST — and a failed POST does not
    // leave a memo claiming the proxy holds something it refused.
    memo(key, tier, { text: raw, bytes, truncated });
    try {
      const res = await armHints({ base, route, hint: wire });
      if (res && res.status >= 400) {
        memo(key, tier, null);
        debug(`selection arm ${route} -> ${res.status}`);
        return { armed: false, reason: `proxy ${res.status}` };
      }
    } catch (e) {
      memo(key, tier, null);
      debug(`selection arm failed for ${route}: ${e.message}`);
      return { armed: false, reason: e.message };
    }
    // UNCONDITIONALLY, not only when the peek carries the same bytes: the
    // current selection just BECAME the attachment, so any peek still
    // registered is superseded by definition — and the renderer drops its
    // handle on it at the same moment, so a peek left behind here is one
    // nothing will ever release.
    if (attach) await clear(key, 'peek', ctx);
    debug(`selection armed ${route} tier=${tier} bytes=${bytes}`);
    // ttl_s rides back on a FRESH arm only. An `unchanged` result did not
    // re-POST, so the proxy's clock did not restart either — handing one back
    // there would let the operator's status line outlive the registration it
    // describes, which is the failure this whole return exists to prevent.
    return { armed: true, bytes, truncated, attached: attach, ttl_s: wire.ttl_s };
  }

  return {
    // One entry point for both tiers. Returns what the operator's status line
    // should say, never a throw: `{ armed, bytes, truncated, detached, reason }`.
    arm(key, payload = {}, ctx = {}) {
      return serialize(key, () => armOnce(key, payload, ctx));
    },

    // The operator abandoned the selection (collapsed the drawer, switched tabs,
    // clicked away). Only the peek goes: an attachment is deliberate and
    // survives until it is taken back.
    async release(key, ctx = {}) {
      await serialize(key, () => clear(key, 'peek', ctx));
      return { armed: false };
    },

    // Session teardown. The registers are dropped SYNCHRONOUSLY (the name is
    // free for a replacement seat the moment this returns) but the proxy is
    // still told, because _armCtx falls back to a NAME GLOB when the exact
    // route is unknown: a dead seat's attachment otherwise matches its
    // same-named replacement for the rest of its 1800s TTL, handing one
    // session's text to another the operator never attached it to.
    forget(key, ctx = null) {
      const reg = registers.get(key);
      registers.delete(key);
      const { base, route } = ctx || {};
      const t = now();
      const ids = [];
      if (reg && base && route) {
        for (const tier of ['peek', 'attach']) {
          if (reg[tier] && reg[tier].until > t) ids.push(ID_FOR[tier]);
        }
      }
      if (!ids.length) { chains.delete(key); return Promise.resolve(); }
      const drop = () => { chains.delete(key); };
      return serialize(key, async () => {
        for (const id of ids) {
          try { await clearHints({ base, route, id }); }
          catch (e) { debug(`selection forget (${id}) failed for ${route}: ${e.message}`); }
        }
      }).then(drop, drop);
    },

    // Test/inspection surface. Projects to the raw text so a caller cannot hold
    // a reference into the live memo.
    _registers(key) {
      const p = held(key, 'peek');
      const a = held(key, 'attach');
      return { peek: p ? p.text : null, attach: a ? a.text : null };
    },
  };
}

module.exports = { createSelectionArm, ID_FOR };
