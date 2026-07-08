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

// Pure decision: should the drainer keep waiting for a typing-quiet window before
// injecting this item? True = wait more. Waits while a human touched the pane
// within quietMs, but never past maxWaitMs from when THIS item began waiting.
function shouldDeferInject({ now, lastHumanInputAt, waitingSince, quietMs, maxWaitMs }) {
  if (now - waitingSince >= maxWaitMs) return false;       // max-wait cap reached — inject anyway
  return now - (lastHumanInputAt || 0) < quietMs;          // still inside the typing window
}

// Pure predicate for the compact in-flight guard: a self-compact is "in flight"
// while its guard is armed OR its continuation is still stashed (awaiting the
// summary). A duplicate [agent:context compact] landing in that window must be
// dropped rather than injected — a second /compact collides with the first
// mid-compaction ("Connection closed mid-response"). Extracted here purely so
// the drop decision has a unit test even though the SessionManager it lives on
// can't be required under plain node.
function isInjectInFlight({ guard, continuation }) {
  return !!(guard || continuation);
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
  constructor({ write, settleMsFor, quietMs, maxWaitMs, lastHumanInputAt, isDead, now, sleep }) {
    this._write = write;
    this._settleMsFor = settleMsFor;
    this._quietMs = quietMs;
    this._maxWaitMs = maxWaitMs;
    this._lastHumanInputAt = lastHumanInputAt || (() => 0);
    this._isDead = isDead || (() => false);
    this._now = now || Date.now;
    this._sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._chain = Promise.resolve();
    this._length = 0;
  }

  get length() { return this._length; }

  // Fire-and-forget: appends to the chain so items drain strictly in arrival
  // order, one critical section at a time. Returns the tail promise for tests.
  enqueue(text) {
    this._length++;
    const run = () => this._drain(text).finally(() => { this._length--; });
    this._chain = this._chain.then(run, run);   // run even if a prior item rejected
    return this._chain;
  }

  async _drain(text) {
    const waitingSince = this._now();
    // Quiet-gate: poll in short slices so a keystroke landing mid-wait extends
    // it, without busy-spinning. Bounded by maxWaitMs via shouldDeferInject.
    while (!this._isDead()
      && shouldDeferInject({
        now: this._now(),
        lastHumanInputAt: this._lastHumanInputAt(),
        waitingSince, quietMs: this._quietMs, maxWaitMs: this._maxWaitMs,
      })) {
      await this._sleep(Math.min(this._quietMs, 500));
    }
    if (this._isDead()) return;
    this._write('\x15' + text.replace(/\n/g, '\r'));   // Ctrl-U + text (\n→\r)
    await this._sleep(this._settleMsFor(text));
    if (this._isDead()) return;
    this._write('\r');                                 // Enter — closes the unit
  }
}

module.exports = { InjectQueue, shouldDeferInject, isInjectInFlight };
