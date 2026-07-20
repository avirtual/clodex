// Per-session serialized PTY injection with a typing quiet-gate.
//
// Why this exists: an injection is Ctrl-U (clear line) + text + a settle delay +
// Enter. The Ctrl-U and the Enter used to be a synchronous write and a *deferred*
// setTimeout with nothing guarding the gap — so two near-simultaneous injections
// (an operator app-panel message and a DM delivery, say) interleaved: the second
// item's Ctrl-U+text landed between the first's text and its Enter, splicing one
// message mid-word into the other (observed live twice). Serializing every
// injection through one per-session chain makes each Ctrl-U→Enter an atomic unit.
//
// The quiet-gate is the second half: the leading Ctrl-U destroys an operator's
// un-submitted draft even with perfect serialization. So before starting an
// item, the drainer waits out a short window since the last human keystroke,
// capped by a max-wait so a walked-away draft can't starve deliveries forever
// (the cap falls back to today's inject-anyway behavior — never worse than
// before). Applies to EVERYTHING, self-intents included: no injection is so
// urgent that eating the operator's draft is correct.
//
// Deliberately dependency-injected (write / timers / clocks / predicates) so the
// serialization and the gate are unit-testable without a live PTY or Electron.

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

// Pure decision: should the drainer keep waiting for a typing-quiet window before
// injecting this item? True = wait more. Waits while a human touched the pane
// within quietMs, but never past maxWaitMs from when THIS item began waiting.
function shouldDeferInject({ now, lastHumanInputAt, waitingSince, quietMs, maxWaitMs }) {
  if (now - waitingSince >= maxWaitMs) return false;       // max-wait cap reached — inject anyway
  return now - (lastHumanInputAt || 0) < quietMs;          // still inside the typing window
}

// Pure decision: should the drainer keep waiting for the seat to signal BOOT
// readiness before injecting? True = wait more. On a freshly spawned CLI seat
// the input loop may not be up yet — bytes written pre-raw-mode get buffered and
// read as ONE paste-like chunk, so the trailing Enter lands as content and the
// message never submits (T35). Waits while `ready` is false, but never past
// maxWaitMs from when THIS item began waiting (never strand a delivery on a CLI
// build that doesn't emit the readiness edge). Default ready ⇒ true, so this is
// a no-op for bash/codex and every non-claude path.
function shouldWaitForReady({ now, waitingSince, ready, maxWaitMs }) {
  if (now - waitingSince >= maxWaitMs) return false;       // cap reached — inject anyway
  return !ready;                                           // not ready yet — wait
}

// Pure predicate for the compact in-flight guard: a self-compact is "in flight"
// while its LATCH is set (pending, awaiting a terminal stop to fire), its guard
// is armed, OR its continuation is still stashed (awaiting the summary). A
// duplicate [agent:context compact] landing in any of those windows must be
// dropped rather than injected — a second /compact collides with the first
// mid-compaction ("Connection closed mid-response"), and a second latch would
// stomp the first's continuation. Extracted here purely so the drop decision has
// a unit test even though the SessionManager it lives on can't be required under
// plain node.
function isInjectInFlight({ pending, guard, continuation }) {
  return !!(pending || guard || continuation);
}

// Pure predicate for the compact LATCH fire gate: a latched self-compact (see
// _handleContextIntent) may only fire when the CLI is genuinely parked at its
// prompt — i.e. a latch is set AND both inject queues are empty. A non-empty
// queue means an injection is about to wake the CLI right back up, so firing
// /compact now would land it mid-turn and Claude Code silently discards slash
// commands while busy (the original 3-attempt failure). Empty ⇒ fire; the fire
// site retries at the next terminal main-line stop otherwise (event-driven, no
// timers). holdQueueLen = the turn-batch hold array; ptyQueueLen = the
// byte-atomic InjectQueue.length.
function canFireCompact({ pending, holdQueueLen, ptyQueueLen }) {
  return !!pending && (holdQueueLen || 0) === 0 && (ptyQueueLen || 0) === 0;
}

class InjectQueue {
  // opts:
  //   write(bytes)          performs the raw PTY write (caller swallows throws)
  //   settleMsFor(text)     ms to wait between the text and its Enter
  //   quietMs / maxWaitMs   typing quiet-gate window + its starvation cap
  //   lastHumanInputAt()    ts of the last human keystroke in this pane
  //   isDead()              session gone — abandon the item (no write into a
  //                         closed fd, which throws Napi::Error natively)
  //   now / sleep           test seams (default Date.now / real setTimeout)
  //   onCapFire(text)       optional: the max-wait cap forced this item through
  //                         while a human was STILL typing (the splice-risk case)
  //                         — surfaced for observability, never changes behavior
  //   ctrlUSettleMs         gap between the Ctrl-U write and the text write
  //                         (default CTRLU_SETTLE_MS; tests override to 0)
  //   bracketedPaste()      live "does the CLI have paste mode 2004 on right
  //                         now?" (sniffed from PTY output via pasteModeSignal)
  //                         — gates the multi-line paste-wrap; default off
  //   ready()               boot-readiness gate (T35): a fresh CLI seat's input
  //                         loop may not be up yet — an item waits until this
  //                         returns true (default () => true = pass-through, so
  //                         bash/codex and every existing path are unaffected).
  //                         Latched by the caller: a BOOT gate, not a liveness
  //                         gate. Capped by readyMaxWaitMs.
  //   readyMaxWaitMs        cap on the boot-readiness wait — inject anyway after
  //                         this long so a CLI that never signals ready can't
  //                         strand a delivery (default Infinity; irrelevant when
  //                         ready defaults to true and never blocks).
  //   readyPollMs           poll slice for the boot-readiness loop (default 250)
  //   onReadyCapFire(text)  optional: readiness cap forced this item through
  //                         before the seat ever signalled ready — surfaced for
  //                         observability, never changes behavior
  constructor({ write, settleMsFor, quietMs, maxWaitMs, lastHumanInputAt, isDead, now, sleep, onCapFire, ctrlUSettleMs, bracketedPaste, ready, readyMaxWaitMs, readyPollMs, onReadyCapFire }) {
    this._write = write;
    this._settleMsFor = settleMsFor;
    this._quietMs = quietMs;
    this._maxWaitMs = maxWaitMs;
    this._lastHumanInputAt = lastHumanInputAt || (() => 0);
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

  // Fire-and-forget: appends to the chain so items drain strictly in arrival
  // order, one critical section at a time. Returns the tail promise for tests.
  //
  // opts.divert(text): optional per-item seam checked RIGHT before the write
  // (after the quiet-gate). If it returns true the item is claimed — the queue
  // skips the write+Enter entirely, so the bytes never reach the pane. This is
  // how a delivery gets park-diverted when the operator opened a draft DURING
  // the quiet-gate wait: the divert re-checks draft state at fire time, not at
  // enqueue time. Absent/throwing divert ⇒ the item writes as normal.
  enqueue(text, opts = {}) {
    this._length++;
    const divert = typeof opts.divert === 'function' ? opts.divert : null;
    const run = () => this._drain(text, divert).finally(() => { this._length--; });
    this._chain = this._chain.then(run, run);   // run even if a prior item rejected
    return this._chain;
  }

  async _drain(text, divert = null) {
    // Boot-readiness gate (T35): a freshly spawned CLI seat's input loop may not
    // be up when the first item drains — bytes written pre-raw-mode are buffered
    // and read as ONE paste-like chunk, so the trailing Enter lands as content
    // and the message sits unsubmitted in the composer. Wait for the seat's
    // readiness signal (Claude's mode-2004 edge, latched by the caller), capped
    // by readyMaxWaitMs so a build that never emits it still injects rather than
    // stranding the delivery. Default ready ⇒ () => true, so bash/codex and every
    // existing path fall straight through this loop. Runs BEFORE the quiet-gate:
    // a virgin seat has no human draft to protect, but it may not accept input.
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
    // Cap-fire: we waited and gave up while the seat still hadn't signalled ready
    // — the item injects anyway (never strand it). Surface for observability.
    if (readyDeferred && !this._ready() && this._onReadyCapFire) {
      try { this._onReadyCapFire(text); } catch {}
    }
    const waitingSince = this._now();
    let deferred = false;
    // Quiet-gate: poll in short slices so a keystroke landing mid-wait extends
    // it, without busy-spinning. Bounded by maxWaitMs via shouldDeferInject.
    while (!this._isDead()
      && shouldDeferInject({
        now: this._now(),
        lastHumanInputAt: this._lastHumanInputAt(),
        waitingSince, quietMs: this._quietMs, maxWaitMs: this._maxWaitMs,
      })) {
      deferred = true;
      await this._sleep(Math.min(this._quietMs, 500));
    }
    if (this._isDead()) return;
    // Park-at-fire-time divert: a draft may have OPENED during the quiet-gate
    // wait above (the one-shot enqueue-time park decision couldn't see it).
    // Re-check now, immediately before the write. If the caller claims the item
    // (parks it), skip the write+Enter entirely — the bytes never touch the
    // pane, so there's no splice. Checked before the cap-fire below so a parked
    // item doesn't log a spurious splice warning. A throwing divert falls
    // through to a normal write (never drop a delivery).
    if (divert) {
      let claimed = false;
      try { claimed = !!divert(text); } catch {}
      if (claimed) return;
    }
    // Cap-fire: we waited, and we're proceeding while a human is STILL inside
    // the typing window — the max-wait cap forced us through an active draft
    // (the splice-risk case). Surface it (never suppress the inject). Once
    // parking lands these should drop to ~zero: DMs park instead of queueing
    // while the operator types, so nothing reaches this gate mid-composition.
    if (deferred && this._onCapFire
      && this._now() - (this._lastHumanInputAt() || 0) < this._quietMs) {
      try { this._onCapFire(text); } catch {}
    }
    // Ctrl-U as its OWN write, a short gap, then the text — see CTRLU_SETTLE_MS:
    // written together they'd be read as one paste-like event and the \x15 would
    // land literal. Parking now handles the draft-open case, so this Ctrl-U is
    // mostly a no-op guard clearing stray junk off an otherwise-empty prompt.
    this._write('\x15');                               // clear-line key event
    await this._sleep(this._ctrlUSettleMs);
    if (this._isDead()) return;
    // Multi-line text: the \n→\r conversion below makes every interior newline
    // an ENTER if node-pty happens to split this write across reads — the body
    // submits early and the remainder lands as a SECOND prompt (observed live:
    // a dm body + reply trailer arrived as two user turns in a box session).
    // While the CLI has bracketed paste on (mode 2004, sniffed live from its
    // own output — see pasteModeSignal), wrap the text in 200~/201~ markers:
    // interior \r is then literal content regardless of read-splitting, exactly
    // like a real terminal paste, and the paste region legitimately spans
    // reads. The deferred Enter below still submits. Single-line text has no
    // interior \r so it never needs the wrap; mode off ⇒ the old bare bytes
    // (a wrap the CLI doesn't understand would land the markers literally).
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
