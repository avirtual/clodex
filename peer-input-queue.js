// PendingInput — the buffer behind "type-to-take control" on a read-only peer
// tab. The first data-producing keystroke kicks an async control acquire; the
// keystrokes typed during that acquire are buffered here and flushed, in order,
// once control is granted (or dropped on failure).
//
// Pure and Electron-free so the ordering + cap logic is unit-tested directly;
// the renderer owns the acquire call and the peerInput flush.
//
// Cap rationale: this is human typing during a sub-second acquire, not a paste
// flood. A chunk is kept WHOLE when it fits under the cap and dropped whole when
// it doesn't (a spliced keystroke stream is worse than a bounded-but-intact
// one), so a modest paste landing mid-acquire survives while a runaway is shed.

'use strict';

const DEFAULT_CAP_BYTES = 4096;

class PendingInput {
  constructor({ capBytes = DEFAULT_CAP_BYTES } = {}) {
    this._cap = capBytes;
    this._buf = [];
    this._size = 0;
    this.acquiring = false;
  }

  // Offer a keystroke chunk. Buffers it (subject to the cap) and returns true
  // iff this call should KICK a fresh acquire — i.e. we weren't already
  // acquiring. Concurrent offers while an acquire is in flight return false and
  // simply append, so the caller never fires a second acquire.
  offer(data) {
    const kick = !this.acquiring;
    if (kick) this.acquiring = true;
    this.push(data);
    return kick;
  }

  // Append a chunk if it fits whole under the cap; otherwise drop it whole.
  // Returns whether it was kept. (Exposed for tests; offer() is the real entry.)
  push(data) {
    const s = String(data == null ? '' : data);
    if (this._size + s.length > this._cap) return false;
    this._buf.push(s);
    this._size += s.length;
    return true;
  }

  // Concatenate and clear the buffer, ending the acquiring state. Returns the
  // ordered keystroke string to flush (empty string if nothing buffered).
  drain() {
    const out = this._buf.join('');
    this._buf = [];
    this._size = 0;
    this.acquiring = false;
    return out;
  }

  // Discard everything and end the acquiring state (acquire failed).
  reset() {
    this._buf = [];
    this._size = 0;
    this.acquiring = false;
  }

  get size() { return this._size; }
}

module.exports = { PendingInput, DEFAULT_CAP_BYTES };
