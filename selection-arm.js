// selection-arm.js — the operator's drawer selection on its way to the agent.
// selection-hint.js composes the text; this owns WHICH CHANNEL carries it and
// when it comes off.
//
// TWO GESTURES, TWO CHANNELS, and the split is the whole design:
//
//   SELECTING (peek) → the wirescope tail. One-shot, uncached, short TTL, and
//     gone whether or not it was used. People select to read, to scroll, to
//     mark their place; a weak signal belongs somewhere it costs nothing to be
//     wrong about, and the transcript is not that place — anything that lands
//     there is permanent.
//   COPYING (attach) → a per-seat QUEUE the CLI's UserPromptSubmit hook drains
//     into the transcript. A hard copy: the operator asked for this text to be
//     part of the conversation, so it is delivered once and then it is simply
//     there, cached with the rest of the prefix, at no per-turn tail cost.
//
// So the tiers no longer share a failure mode and no longer need the elaborate
// mutual exclusion the all-on-the-wire version did. What survives is the one
// case where both channels carry the SAME bytes into the SAME request: text
// that is queued for the transcript while still selected on screen. The peek is
// suppressed there, or the model reads the operator's text twice under two
// framings and cannot tell they are the same thing.
//
// Only the PEEK needs wirescope. An attachment reaches the agent through the
// CLI's own hook, so it works with the proxy off entirely.
//
// ARMING MAY NEVER BLOCK THE GESTURE. Every path resolves to a result object;
// nothing throws at the caller, and a proxy that is down or slow costs the
// operator a status line, never a copy.
//
// Electron-free, so the tier interaction is testable without a window.

'use strict';

const { buildSelectionHint, PEEK_ID, PEEK_TTL_S } = require('./selection-hint');

// The memo expires with the REGISTRATION it describes, which is what keeps a
// stale memo from producing a false claim: the proxy drops a hint at its ttl_s,
// and a memo that outlives it turns the next arm of the same text into a no-op
// reporting `armed` for something nothing is carrying.
const PEEK_TTL_MS = PEEK_TTL_S * 1000;

// deps:
//   armHints    ({base, route, hint}) -> Promise<{status}>
//   clearHints  ({base, route, id}) -> Promise
//   readHints   ({base, route}) -> Promise<{status, json}>   what the proxy HOLDS
//   queue       ({name, text}) -> void   append to the seat's hook queue
//   readQueue   ({name}) -> string[]     what is STILL in that file, undrained
//   enabled     () -> bool               the live pref, read per call
//   scrubber    () -> {scrub, tokens}    the token set to redact, read per call
function createSelectionArm({
  armHints, clearHints, readHints = null, queue = null, readQueue = null,
  enabled = null, scrubber = null, log = null, now = Date.now,
}) {
  // session name -> { peek, pending }.
  //   peek    — `{ text, bytes, truncated, until }` the proxy currently holds.
  //   pending — the raw text of attachments queued but not yet drained by the
  //             hook. An ARRAY: two Copy clicks between one pair of submits are
  //             two attachments, and the queue file is line-delimited for the
  //             same reason.
  const registers = new Map();
  // session name -> tail of that session's proxy ops. Serialized because a
  // clear issued while its own POST is still in flight would otherwise reach
  // the proxy first and delete nothing, leaving the registration behind with
  // an empty memo that no later call can act on.
  const chains = new Map();

  const debug = (msg) => { try { if (log && log.debug) log.debug('hint', msg); } catch {} };

  function regFor(key) {
    if (!registers.has(key)) registers.set(key, { peek: null, pending: [] });
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

  // What the proxy still holds, or null.
  function heldPeek(key) {
    const reg = regFor(key);
    if (!reg.peek) return null;
    if (reg.peek.until <= now()) { reg.peek = null; return null; }
    return reg.peek;
  }

  function memoPeek(key, entry) {
    regFor(key).peek = entry ? { ...entry, until: now() + PEEK_TTL_MS } : null;
  }

  // Idempotent on the proxy side, so the memo is the only thing worth guarding:
  // clearing a peek that was never armed is a free 200 nobody needs to pay for.
  async function clearPeek(key, ctx) {
    if (!heldPeek(key)) return;
    memoPeek(key, null);
    const { base, route } = ctx || {};
    if (!base || !route) return;
    try {
      await clearHints({ base, route, id: PEEK_ID });
    } catch (e) { debug(`selection clear failed for ${route}: ${e.message}`); }
  }

  function compose(raw, tab, attach) {
    // A null scrubber leaves buildSelectionHint's own identity defaults in
    // place. Spread rather than passed through: a scrubber returning `null`
    // for either field would DEFEAT those defaults, since a parameter default
    // fires on undefined and not on null.
    const s = (scrubber && scrubber()) || {};
    return buildSelectionHint({
      text: raw,
      tab,
      attach,
      scrub: typeof s.scrub === 'function' ? s.scrub : undefined,
      tokens: Array.isArray(s.tokens) ? s.tokens : undefined,
    });
  }

  // The Copy button. Nothing here touches the proxy: the text goes into the
  // seat's queue file and the CLI's own hook picks it up at the next submit.
  function handOver(key, { text = '', tab = '' } = {}) {
    const raw = String(text == null ? '' : text);
    if (enabled && !enabled()) return { handed: false, reason: 'selection hints are off' };
    if (!raw.trim()) return { handed: false, reason: 'nothing selected' };
    if (!queue) return { handed: false, reason: 'this session has no queue' };

    const reg = regFor(key);
    // A second click on text already waiting is the SAME hand-off, not a second
    // one. There is no un-queue gesture and deliberately so: the wire version
    // needed a detach because an attachment rode every request for 1800s, while
    // this one is delivered once and then is simply part of the conversation.
    // Idempotence is what that costs.
    if (reg.pending.includes(raw)) {
      const hint = compose(raw, tab, true);
      return { handed: true, bytes: hint ? hint.bytes : raw.length, unchanged: true };
    }

    const hint = compose(raw, tab, true);
    if (!hint) return { handed: false, reason: 'nothing selected' };
    try {
      queue({ name: key, text: hint.text });
    } catch (e) {
      debug(`selection queue failed for ${key}: ${e.message}`);
      return { handed: false, reason: e.message };
    }
    reg.pending.push(raw);
    debug(`selection queued for ${key} bytes=${hint.bytes}`);
    return { handed: true, bytes: hint.bytes, truncated: hint.truncated };
  }

  async function armPeekOnce(key, { text = '', tab = '' } = {}, ctx = {}) {
    const raw = String(text == null ? '' : text);
    const { base, route } = ctx || {};
    // Read per call, never captured: the checkbox must take effect on the next
    // selection rather than the next launch.
    if (enabled && !enabled()) return { armed: false, reason: 'selection hints are off' };
    // No route means the CLI does not go through wirescope at all, so there is
    // nothing to arm and nothing registered to take back. Attachments are
    // unaffected — they do not come this way.
    if (!base || !route) return { armed: false, reason: 'wirescope is not routing this session' };

    if (!raw.trim()) {
      await clearPeek(key, ctx);
      return { armed: false, reason: 'nothing selected' };
    }

    // Text queued for the transcript is about to arrive under a deliberate
    // framing; a peek would put the same bytes in the same request under a
    // hedged one.
    if (regFor(key).pending.includes(raw)) {
      await clearPeek(key, ctx);
      return { armed: false, reason: 'already handed over' };
    }

    const live = heldPeek(key);
    if (live && live.text === raw) {
      return { armed: true, bytes: live.bytes, truncated: live.truncated, unchanged: true };
    }

    const hint = compose(raw, tab, false);
    if (!hint) {
      await clearPeek(key, ctx);
      return { armed: false, reason: 'nothing selected' };
    }
    // The measurements are for the operator's status line, not the proxy: the
    // rest spread is what keeps them off the wire without a second copy of the
    // field list here to drift against the composer's.
    const { bytes, truncated, ...wire } = hint;

    // Memoised BEFORE the await and rolled back on failure, so a caller that
    // does not go through arm() cannot double-POST — and a failed POST does not
    // leave a memo claiming the proxy holds something it refused.
    memoPeek(key, { text: raw, bytes, truncated });
    try {
      const res = await armHints({ base, route, hint: wire });
      if (res && res.status >= 400) {
        memoPeek(key, null);
        debug(`selection arm ${route} -> ${res.status}`);
        return { armed: false, reason: `proxy ${res.status}` };
      }
    } catch (e) {
      memoPeek(key, null);
      debug(`selection arm failed for ${route}: ${e.message}`);
      return { armed: false, reason: e.message };
    }
    debug(`selection armed ${route} bytes=${bytes}`);
    return { armed: true, bytes, truncated };
  }

  return {
    // One entry point for both gestures, because the renderer has one hook to
    // hang them on. The tier decides the channel, not the caller.
    arm(key, payload = {}, ctx = {}) {
      if (payload && payload.attach) return Promise.resolve(handOver(key, payload));
      return serialize(key, () => armPeekOnce(key, payload, ctx));
    },

    // The operator abandoned the selection (collapsed the drawer, switched
    // tabs, clicked away). Only the peek goes: a hand-off was deliberate and
    // is already queued for the transcript.
    async release(key, ctx = {}) {
      await serialize(key, () => clearPeek(key, ctx));
      return { armed: false };
    },

    // The Enter byte. The hook drains the queue on this same submit, so the
    // pending list has done its job: holding it any longer would suppress a
    // peek for text the transcript now carries anyway, which is the wrong way
    // round — once it is IN the conversation, re-selecting it is an ordinary
    // selection about an ordinary part of the context.
    // Returns whether anything was actually waiting, so the caller can tell the
    // renderer to retire its "sending" claim without guessing.
    onSubmit(key) {
      const reg = registers.get(key);
      if (!reg || !reg.pending.length) return false;
      reg.pending = [];
      return true;
    },

    // Session teardown. The queue file dies with the run dir, so only the
    // proxy-side registration needs taking back — and only when the exact
    // route is unknown does it matter, since _armCtx falls back to a NAME GLOB
    // that a same-named replacement seat would match.
    forget(key, ctx = null) {
      const reg = registers.get(key);
      registers.delete(key);
      const { base, route } = ctx || {};
      const live = reg && reg.peek && reg.peek.until > now();
      if (!live || !base || !route) { chains.delete(key); return Promise.resolve(); }
      const drop = () => { chains.delete(key); };
      return serialize(key, async () => {
        try { await clearHints({ base, route, id: PEEK_ID }); }
        catch (e) { debug(`selection forget failed for ${route}: ${e.message}`); }
      }).then(drop, drop);
    },

    // What is ACTUALLY on its way to the agent, for the operator's popover.
    //
    // Reports the proxy's answer and this module's memo SEPARATELY rather than
    // reconciling them, because their disagreement is the interesting state and
    // reconciling would hide it. Measured 2026-08-06: three arms logged
    // `timeout`, the memo rolled back to empty, and the peek was registered on
    // the proxy the whole time and rode the next request. An instrument built
    // on the memo alone would have reported "nothing armed" while text was
    // being sent, which is the failure this exists to make visible.
    //
    // NOT serialized onto the session's chain: a read must not queue behind a
    // POST that is hung, since a hung POST is exactly when the operator opens
    // this. Reading mid-flight can catch a half-applied state, which is honest —
    // waiting for a chain that may never drain is not.
    async inspect(key, ctx = {}) {
      const reg = regFor(key);
      const memo = heldPeek(key);
      const out = {
        enabled: !(enabled && !enabled()),
        local: {
          peek: memo ? { text: memo.text, bytes: memo.bytes, truncated: memo.truncated,
            expiresInMs: Math.max(0, memo.until - now()) } : null,
          pending: [...reg.pending],
        },
        proxy: { routed: false, hints: null, error: null },
        // The queue FILE, which is the attach tier's truth for the same reason
        // the proxy is the peek tier's: the hook drains it in another process,
        // so `pending` is only what this one believes it queued. A drain between
        // the two makes them disagree, and that disagreement is worth seeing.
        queued: null,
      };
      if (readQueue) {
        try { out.queued = readQueue({ name: key }); }
        catch (e) { out.queued = { error: e.message }; }
      }
      const { base, route } = ctx || {};
      if (!base || !route) return out;
      out.proxy.routed = true;
      out.proxy.route = route;
      if (!readHints) { out.proxy.error = 'no reader'; return out; }
      try {
        const res = await readHints({ base, route });
        if (!res || res.status >= 400 || !res.json) {
          out.proxy.error = `proxy ${(res && res.status) || 'unreachable'}`;
          return out;
        }
        const list = Array.isArray(res.json.agent_hints) ? res.json.agent_hints : [];
        // Age, not set_at: the operator cares how long it has left, and the
        // proxy's clock is not this process's. `age_s` is the proxy's own
        // subtraction, so it survives any skew between the two.
        out.proxy.hints = list.map((h) => ({
          id: h.id,
          text: typeof h.text === 'string' ? h.text : '',
          ttlS: typeof h.ttl_s === 'number' ? h.ttl_s : null,
          ageS: typeof h.age_s === 'number' ? h.age_s : null,
          turnStartOnly: !!h.turn_start_only,
        }));
      } catch (e) {
        out.proxy.error = e.message;
      }
      return out;
    },

    // Test/inspection surface. Projects to raw text so a caller cannot hold a
    // reference into the live memo.
    _registers(key) {
      const p = heldPeek(key);
      return { peek: p ? p.text : null, pending: [...regFor(key).pending] };
    },
  };
}

module.exports = { createSelectionArm };
