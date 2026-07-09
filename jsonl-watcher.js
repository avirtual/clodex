// jsonl-watcher.js — the JsonlWatcher class. Polls the ~/.clodex/{name}.jsonl
// transcript symlink (created by the SessionStart hook) every 250ms, follows it
// through /clear + /compact, extracts assistant text (Claude type:"assistant";
// Codex event_msg/agent_message), buffers by requestId, and flushes on a new
// requestId / non-assistant entry / 1s silence — emitting onText (intent scan),
// onSessionId (persistence), onActivity (UI), onCompactSummary, onFileTouches.
//
// FACTORY (M3 DI): the class reads one main.js global, REGISTRY_DIR (to resolve
// the {name}.jsonl symlink), injected as a factory param so the class body stays
// byte-identical. Text/file-touch extraction is delegated to transcript.js and
// file-touch.js. The 250ms fs polling loop needs a live filesystem, so the class
// itself is left to integration; extractText/extractFileTouches have their own
// unit tests in their home modules.

const fs = require('fs');
const path = require('path');
const { extractText } = require('./transcript');
const { extractFileTouches } = require('./file-touch');

function createJsonlWatcher({ REGISTRY_DIR }) {
  class JsonlWatcher {
    constructor(name, onText, onSessionId, onActivity, onCompactSummary, onFileTouches) {
      this._name = name;
      this._onText = onText;
      this._onSessionId = onSessionId || (() => {});
      this._onActivity = onActivity || (() => {});
      this._onCompactSummary = onCompactSummary || (() => {});
      this._onFileTouches = onFileTouches || (() => {});
      this._stopped = false;
      this._timer = null;
      this._fd = null;
      this._currentTarget = null;
      this._position = 0;
      this._pendingRid = null;
      this._pendingText = null;
      this._pendingTime = 0;
      this._readBuf = '';
      this._activityState = 'idle';
    }

    _setActivity(state) {
      if (this._activityState !== state) {
        this._activityState = state;
        try { this._onActivity(state); } catch {}
      }
    }

    start() {
      this._poll();
    }

    stop() {
      this._stopped = true;
      if (this._timer) clearTimeout(this._timer);
      this._flushPending();
      if (this._fd !== null) {
        try { fs.closeSync(this._fd); } catch {}
      }
    }

    _poll() {
      if (this._stopped) return;

      const linkPath = path.join(REGISTRY_DIR, `${this._name}.jsonl`);

      // Check symlink target
      try {
        const target = fs.realpathSync(linkPath);
        if (target !== this._currentTarget && fs.existsSync(target)) {
          if (this._fd !== null) {
            try { fs.closeSync(this._fd); } catch {}
          }
          this._fd = fs.openSync(target, 'r');
          this._currentTarget = target;
          this._readBuf = '';
          // Start at EOF. On Clodex restart / resume, the transcript already
          // contains historical turns we've processed before; replaying them
          // would re-fire past [agent:...] intents. We only care about turns
          // appended from now on.
          try { this._position = fs.fstatSync(this._fd).size; }
          catch { this._position = 0; }
          const sessionId = path.basename(target, '.jsonl');
          if (sessionId) {
            try { this._onSessionId(sessionId); } catch {}
          }
        }
      } catch {}

      if (this._fd !== null) {
        this._readLines();
      }

      this._timer = setTimeout(() => this._poll(), POLL_INTERVAL);
    }

    _readLines() {
      const buf = Buffer.alloc(8192);
      let bytesRead;
      try {
        bytesRead = fs.readSync(this._fd, buf, 0, buf.length, this._position);
        this._position += bytesRead;
      } catch { return; }

      if (bytesRead === 0) {
        // No new data — check turn-complete timeout
        if (this._pendingText && (Date.now() - this._pendingTime) > TURN_COMPLETE_TIMEOUT) {
          this._flushPending();
        }
        return;
      }

      this._readBuf += buf.toString('utf-8', 0, bytesRead);
      const lines = this._readBuf.split('\n');
      this._readBuf = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }

        // Compact boundary: Claude writes a user entry with isCompactSummary:true
        // when /compact finishes (in-place, same sessionId, appended to this same
        // transcript). It's the clean trigger for the compact-continuation nudge —
        // by the time it lands the summarized conversation is back and the CLI is
        // ready for input. Flush any pending turn first, then signal.
        if (obj.isCompactSummary === true) {
          if (this._pendingText) this._flushPending();
          try { this._onCompactSummary(); } catch {}
          continue;
        }

        // Touched-files tap for the legacy path (wire-routed sessions get these
        // off turn.completed instead — this watcher isn't running steady-state
        // there, and sentinel-made watchers pass no callback).
        const touches = extractFileTouches(obj);
        if (touches.length) { try { this._onFileTouches(touches); } catch {} }

        const text = extractText(obj);
        if (text) {
          const rid = obj.requestId || (obj.payload || {}).id || '';
          if (rid !== this._pendingRid && this._pendingText) {
            this._flushPending();
          }
          this._pendingRid = rid;
          this._pendingText = text;
          this._pendingTime = Date.now();
          this._setActivity('thinking');
        } else if (!['assistant', 'response_item'].includes(obj.type || '')) {
          if (this._pendingText) this._flushPending();
        }
      }
    }

    _flushPending() {
      if (this._pendingText) {
        try { this._onText(this._pendingText); } catch {}
        this._setActivity('idle');
      }
      this._pendingRid = null;
      this._pendingText = null;
    }
  }

  return { JsonlWatcher };
}

module.exports = { createJsonlWatcher };
