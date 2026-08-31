// One Ctrl-U → text → Enter sequence must stay atomic: two injections
// interleaving splices one message mid-word into the other. Every injection
// goes through one per-session chain. The quiet-gate exists because the
// leading Ctrl-U destroys an un-submitted operator draft; the max-wait cap
// keeps a walked-away draft from starving deliveries forever.

// Gap between the leading Ctrl-U (clear-line) write and the text write. EMPIRICAL
// (Claude Code 2.1.205, verified live): a LONE '\x15' written on its own — with a
// short gap before the text — registers as a clear-line KEY event (the CLI shows
// its "Ctrl+Y to paste deleted text" kill-ring hint and the draft vanishes). The
// OLD single-chunk write of '\x15'+text was read as ONE paste-like input event,
// which left the '\x15' as a LITERAL char in the buffer (it never cleared
// anything, and merged into an open draft). The gap is what makes the CLI's input
// loop process the key before the text arrives; ~30ms is comfortably enough.
const CTRLU_SETTLE_MS = 30;

// Bracketed-paste markers for the multi-line wrap below — single-sourced in
// proxy-util (a pure leaf, so this require keeps the module electron-free and
// unit-testable under plain node).
const { PASTE_START, PASTE_END } = require('./proxy-util');

// `hintHeld` covers the gap the typing window does not: a hint pre-armed against
// the operator's draft is one-shot and pops at the next TURN START, so injecting
// during a pause long enough to have stopped counting as typing would consume it.
// Its own cap lives with the hold, so the max-wait below still bounds it.
//
// `speaking` is the SAME protection as the typing window for an operator who is
// DICTATING. It is a separate input and not a widening of `lastHumanInputAt`
// because dictated words never pass through SessionManager.write(): the CLI
// records the audio and paints the transcription into its own composer, so the
// `isHumanPtyInput` stamp that feeds `lastHumanInputAt` never happens and a
// speaking operator reads as perfectly idle. The Ctrl-U that opens an injection
// eats his half-spoken draft exactly as it would eat a half-typed one — and
// speaking is SLOWER than typing, so the window it needs is longer, not shorter.
function shouldDeferInject({ now, lastHumanInputAt, waitingSince, quietMs, maxWaitMs, hintHeld = false, speaking = false }) {
  if (now - waitingSince >= maxWaitMs) return false;       // max-wait cap reached — inject anyway
  if (hintHeld) return true;
  if (speaking) return true;
  return now - (lastHumanInputAt || 0) < quietMs;          // still inside the typing window
}

function shouldWaitForReady({ now, waitingSince, ready, maxWaitMs }) {
  if (now - waitingSince >= maxWaitMs) return false;       // cap reached — inject anyway
  return !ready;                                           // not ready yet — wait
}

// A second /compact landing mid-compaction collides with the first
// ("Connection closed mid-response"), and a second latch stomps the first's
// continuation — hence in-flight covers latch, guard and stash alike.
function isInjectInFlight({ pending, guard, continuation }) {
  return !!(pending || guard || continuation);
}

// Claude Code silently discards slash commands while it is busy, so a latched
// /compact may only fire with both queues empty — a queued item would wake the
// CLI right back up. Retried at the next terminal stop; no timers.
function canFireCompact({ pending, holdQueueLen, ptyQueueLen }) {
  return !!pending && (holdQueueLen || 0) === 0 && (ptyQueueLen || 0) === 0;
}

class InjectQueue {
  // isDead(): writing into a closed fd throws Napi::Error natively.
  // ready(): a BOOT gate, not a liveness gate — the caller latches it.
  // readyMaxWaitMs / maxWaitMs: caps so a seat that never signals ready, or an
  // operator who walked away mid-draft, cannot strand a delivery.
  constructor({ write, settleMsFor, quietMs, maxWaitMs, lastHumanInputAt, isDead, now, sleep, onCapFire, ctrlUSettleMs, bracketedPaste, ready, readyMaxWaitMs, readyPollMs, onReadyCapFire, hintHeld, speaking }) {
    this._write = write;
    this._settleMsFor = settleMsFor;
    this._quietMs = quietMs;
    this._maxWaitMs = maxWaitMs;
    this._lastHumanInputAt = lastHumanInputAt || (() => 0);
    this._hintHeld = hintHeld || (() => false);
    this._speaking = speaking || (() => false);
    this._isDead = isDead || (() => false);
    this._now = now || Date.now;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._onCapFire = onCapFire || null;
    this._ctrlUSettleMs = Number.isFinite(ctrlUSettleMs) ? ctrlUSettleMs : CTRLU_SETTLE_MS;
    this._bracketedPaste = bracketedPaste || (() => false);
    this._ready = ready || (() => true);
    this._readyMaxWaitMs = Number.isFinite(readyMaxWaitMs) ? readyMaxWaitMs : Infinity;
    this._readyPollMs = Number.isFinite(readyPollMs) ? readyPollMs : 250;
    this._onReadyCapFire = onReadyCapFire || null;
    this._chain = Promise.resolve();
    this._length = 0;
  }

  get length() { return this._length; }

  // A throwing hold must not block delivery — the hint is optional, the message is not.
  _held() { try { return !!this._hintHeld(); } catch { return false; } }

  // Same swallow, same direction, and here the direction is load-bearing rather
  // than merely tidy: everything about this signal fails toward DELIVERING.
  // A deferral that cannot be released strands every message to the seat, so a
  // throwing reader must not be the thing that makes injection stop forever.
  _speakingNow() { try { return !!this._speaking(); } catch { return false; } }

  enqueue(text, opts = {}) {
    this._length++;
    const divert = typeof opts.divert === 'function' ? opts.divert : null;
    const produce = typeof opts.produce === 'function' ? opts.produce : null;
    const run = () => this._drain(text, divert, produce).finally(() => { this._length--; });
    this._chain = this._chain.then(run, run);   // run even if a prior item rejected
    return this._chain;
  }

  async _drain(text, divert = null, produce = null) {
    // Bytes written before a fresh seat's input loop enters raw mode are buffered
    // and read as ONE paste-like chunk, so the trailing Enter lands as content
    // instead of submitting. Runs before the quiet-gate: a virgin seat has no
    // draft to protect but may not accept input yet.
    const readySince = this._now();
    let readyDeferred = false;
    while (!this._isDead()
      && shouldWaitForReady({
        now: this._now(), waitingSince: readySince,
        ready: !!this._ready(), maxWaitMs: this._readyMaxWaitMs,
      })) {
      readyDeferred = true;
      await this._sleep(Math.min(this._readyMaxWaitMs, this._readyPollMs));
    }
    if (this._isDead()) return;
    if (readyDeferred && !this._ready() && this._onReadyCapFire) {
      try { this._onReadyCapFire(text); } catch {}
    }
    const waitingSince = this._now();
    let deferred = false;
    while (!this._isDead()
      && shouldDeferInject({
        now: this._now(),
        lastHumanInputAt: this._lastHumanInputAt(),
        waitingSince, quietMs: this._quietMs, maxWaitMs: this._maxWaitMs,
        hintHeld: this._held(),
        speaking: this._speakingNow(),
      })) {
      deferred = true;
      await this._sleep(Math.min(this._quietMs, 500));
    }
    if (this._isDead()) return;
    // Must run after the gates: the producer's claim is destructive, so a delivery
    // that can't land yet is never claimed off disk.
    if (produce) {
      let produced = null;
      try { produced = produce(); } catch { produced = null; }
      if (produced == null || produced === '') return;
      text = produced;
    }
    if (divert) {
      let claimed = false;
      try { claimed = !!divert(text); } catch {}
      if (claimed) return;
    }
    // Only a splice through LIVE typing is worth warning about; a hint hold that
    // hit the cap injects into an idle prompt and is not the same event.
    if (deferred && this._onCapFire
      && this._now() - (this._lastHumanInputAt() || 0) < this._quietMs) {
      try { this._onCapFire(text); } catch {}
    }
    this._write('\x15');                               // clear-line key event
    await this._sleep(this._ctrlUSettleMs);
    if (this._isDead()) return;
    // \n→\r makes every interior newline an ENTER if node-pty splits this write
    // across reads — the body submits early and the remainder lands as a second
    // prompt. Wrapping in 200~/201~ makes interior \r literal, but only while the
    // CLI actually has mode 2004 on; otherwise the markers land as literal text.
    let out = text.replace(/\n/g, '\r');               // the text (\n→\r)
    if (text.includes('\n')) {
      let pasteOn = false;
      try { pasteOn = !!this._bracketedPaste(); } catch {}
      if (pasteOn) out = PASTE_START + out + PASTE_END;
    }
    this._write(out);
    await this._sleep(this._settleMsFor(text));
    if (this._isDead()) return;
    this._write('\r');                                 // Enter — closes the unit
  }
}

module.exports = { InjectQueue, shouldDeferInject, shouldWaitForReady, isInjectInFlight, canFireCompact };
