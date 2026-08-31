'use strict';
// mirror-latch.js — a renderer-side mirror of a value main owns, fed by a
// BROADCAST (an edge) and by a catch-up PULL (a promise the window makes on
// startup, for the edge it was not open for).
//
// The pull is the whole reason this is not a bare variable. It resolves at an
// unspecified time, so it can land AFTER a broadcast has already delivered a
// newer answer — and then a naive `if (value === initial)` test cannot tell
// "nothing has arrived yet" from "a broadcast delivered exactly the initial
// value". For the two mirrors this serves, `null` is a legitimate released mic
// target and `false` a legitimate backgrounded app, so the value can never
// double as that flag: it takes its own.
//
// The rule is one line — a broadcast, once heard, wins over every later pull —
// and it lives here rather than in renderer.js because renderer.js has no test
// harness.

function createMirrorLatch(initial = null, { normalize = (v) => v } = {}) {
  let value = normalize(initial);
  let heard = false;

  return {
    // A broadcast landed. Always wins, and latches the mirror against pulls.
    note(next) {
      heard = true;
      value = normalize(next);
    },
    // The catch-up read resolved. Ignored once any broadcast has been heard.
    pull(next) {
      if (heard) return;
      value = normalize(next);
    },
    read() { return value; },
    // For tests and for a caller that needs to distinguish "no host answers
    // this" from a legitimate falsy value — the headless host never reports.
    heard() { return heard; },
  };
}

module.exports = { createMirrorLatch };
