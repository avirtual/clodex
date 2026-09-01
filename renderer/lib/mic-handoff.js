'use strict';
// mic-handoff.js — what a window does when the microphone MOVES OFF one of its
// seats. Fed the `mic-target` broadcast; owns the mirror update and the stop.
//
// The broadcast already made the losers stop ARMING — `isMicTarget` gates the
// turn-end re-arm. It did nothing about a recorder ALREADY LIT, so a seat that
// lost the microphone went on streaming the room to the CLI until its ~15s
// silence auto-finish, in a window the operator had just switched away from.
// That is the gap this closes, and it is the only thing here.
//
// It lives in a module because renderer.js has no test harness — the same
// reason mirror-latch.js does.

function createMicHandoff({ mirror, watcherFor }) {
  return function onMicTarget(next) {
    const lost = mirror.read();
    // BEFORE the stop, never after. The losing seat's re-arm timer can fire
    // during this call, and it reads the mirror through `isMicTarget`: with the
    // mirror still naming the loser, that re-arm re-lights the recorder we are
    // in the middle of stopping. Noting first makes it decline instead.
    mirror.note(next);
    // A stop is owed only to a seat that HELD it and no longer does. The
    // equality read is taken through the mirror rather than against `next`, so
    // normalization cannot make an unchanged target look like a handoff and
    // write a byte on every repeat of a broadcast.
    if (!lost || lost === mirror.read()) return false;
    let w = null;
    try { w = watcherFor(lost); } catch { w = null; }
    if (!w || typeof w.tapOff !== 'function') return false;
    // ENSURE-OFF, reused rather than reimplemented: it already owns the rule
    // that only a LIT recorder is written to, and that an unreadable screen or
    // a non-empty composer writes nothing. A stop open-coded here would be the
    // fifth writer of the trigger byte and would have to re-derive that
    // polarity — which is how this subsystem's inverted-write bugs started.
    try { return w.tapOff() === true; } catch { return false; }
  };
}

module.exports = { createMicHandoff };
