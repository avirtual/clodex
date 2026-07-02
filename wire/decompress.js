'use strict';

const zlib = require('zlib');

// Observer-side incremental decoder. The CLIENT always receives the raw
// upstream bytes untouched — this exists only so the SSE tee can read a
// compressed stream. Callback-based because zlib streams deliver async.
//
// Corrupt framing kills the observer for this stream only; the client
// keeps receiving raw bytes (tee, don't transform).
class Decompressor {
  constructor(encoding, onData) {
    const enc = (encoding || '').toLowerCase().trim();
    this.passthrough = enc !== 'gzip' && enc !== 'deflate';
    this._onData = onData;
    this._dead = false;
    this._pendingDone = null;
    if (!this.passthrough) {
      this._z = enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate();
      this._z.on('data', (d) => this._onData(d));
      // A zlib error means end()'s own callback will never fire — release
      // any caller already waiting in end(), or stream-end would be lost.
      this._z.on('error', () => {
        this._dead = true;
        this._release();
      });
    }
  }

  // True once the zlib stream errored: the observer's view of this body is
  // truncated at an unknown point — consumers must not publish receipts
  // synthesized from it (partial data already delivered stays delivered).
  get dead() {
    return this._dead;
  }

  feed(chunk) {
    if (!chunk || !chunk.length) return;
    if (this.passthrough) { this._onData(chunk); return; }
    if (!this._dead) this._z.write(chunk);
  }

  // Flush remaining bytes, then call done (always called, even when dead).
  end(done) {
    if (this.passthrough || this._dead) { if (done) done(); return; }
    this._pendingDone = done || null;
    this._z.end(() => this._release());
  }

  _release() {
    const d = this._pendingDone;
    this._pendingDone = null;
    if (d) d();
  }
}

module.exports = { Decompressor };
