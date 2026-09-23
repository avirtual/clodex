// jsonl-watcher.js — the JsonlWatcher class. Polls the run/<name>/transcript.jsonl
// transcript symlink (created by the SessionStart hook) every 250ms, follows it
// through /clear + /compact, and drives one state machine over the platform
// reader's classification of each record (transcript-readers.js: Claude, Codex,
// Muse). Text is buffered and flushed on a new rid (or ANY text entry carrying
// no id, which cannot be grouped by one) / a textless non-inert record / 1s
// silence — emitting onText (intent scan, with a per-flush { turnEnd,
// interrupted } — the turn ended on the agent's own REPLY; a user interrupt
// triggered the flush), onSessionId (persistence), onActivity (UI),
// onCompactSummary, onFileTouches.
//
// The flush rule is stated precisely because a header that mis-states it is
// what made a silent text-loss bug hard to see: grouping by an id that a text
// entry never sets reads two unrelated replies as one turn and drops the first.
//
// FACTORY (M3 DI): the class reads one main.js global, REGISTRY_DIR (to resolve
// the run/<name>/transcript.jsonl symlink via clodex-paths.pathFor), injected as
// a factory param. The 250ms fs polling loop needs a live filesystem, so the
// class itself is left to integration; the readers and extractFileTouches have
// their own unit tests in their home modules.

const fs = require('fs');
const path = require('path');
const { readerFor } = require('./transcript-readers');
const { extractFileTouches } = require('./file-touch');
const { pathFor } = require('./clodex-paths');

// Watcher-owned tuning (moved from main.js — M3 left them behind as free
// identifiers, which broke every non-wire agent spawn at watcher.start()).
const POLL_INTERVAL = 250; // ms
const TURN_COMPLETE_TIMEOUT = 1000; // ms

function createJsonlWatcher({ REGISTRY_DIR }) {
  class JsonlWatcher {
    constructor(name, onText, onSessionId, onActivity, onCompactSummary, onFileTouches, opts = {}) {
      this._name = name;
      this._reader = (opts && opts.reader) || readerFor(null);
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
      this._activityTurnEnd = false;
      this._pendingInterrupted = false;
      // Whether the pending text's turn is over. Carried to the flush rather
      // than re-derived there: by flush time the entry is gone, and the
      // 1s-silence flush has no entry at all.
      this._pendingTurnEnd = false;
      // Whether the pending text is the agent's own reply rather than a tool's
      // output. Only a reply may end a turn audibly.
      this._pendingIsReply = false;
      // Touches seen since the last text flush. They fire per-LINE the moment
      // they are parsed (onFileTouches, below) because the touched-files UI wants them
      // immediately; onText flushes on a requestId change or 1s of silence. The
      // plugin feed needs them CORRELATED with the text they accompanied, so
      // they are also accumulated here and handed to onText at flush time.
      this._pendingTouches = [];
    }

    _setActivity(state, turnEnd = false) {
      const end = !!turnEnd;
      if (this._activityState === state && !(end && !this._activityTurnEnd)) return;
      this._activityState = state;
      this._activityTurnEnd = end;
      try { this._onActivity(state, end); } catch {}
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

      const linkPath = pathFor(REGISTRY_DIR, this._name, 'transcript');

      // Check symlink target
      try {
        const target = fs.realpathSync(linkPath);
        if (target !== this._currentTarget && fs.existsSync(target)) {
          // FIRST, before the fd closes: emit any text still pending from the OLD
          // transcript with the touches that actually accompanied it. Resetting
          // only _pendingTouches below would leave the mirror-image lie — old
          // text surviving the repoint, then flushing with the NEW
          // conversation's first touch attached. A correlation has two halves.
          this._flushPending();
          if (this._fd !== null) {
            try { fs.closeSync(this._fd); } catch {}
          }
          this._fd = fs.openSync(target, 'r');
          this._currentTarget = target;
          this._readBuf = '';
          // Belt to the flush above's braces: bounds the no-text-ever case,
          // where _flushPending emits nothing and touches would otherwise
          // accumulate for the watcher's life.
          this._pendingTouches = [];
          // Start at EOF. On Clodex restart / resume, the transcript already
          // contains historical turns we've processed before; replaying them
          // would re-fire past [agent:...] intents. We only care about turns
          // appended from now on.
          try { this._position = fs.fstatSync(this._fd).size; }
          catch { this._position = 0; }
          const sessionId = (this._reader.sessionIdOf && this._reader.sessionIdOf(target)) || path.basename(target, '.jsonl');
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
        if (!obj || typeof obj !== 'object') continue;

        for (const rec of this._reader.expand(obj)) {
          const c = this._reader.classify(rec);
          // Compact boundary: Claude writes a user entry with isCompactSummary:true
          // when /compact finishes (in-place, same sessionId, appended to this same
          // transcript). It's the clean trigger for the compact-continuation nudge —
          // by the time it lands the summarized conversation is back and the CLI is
          // ready for input. Flush any pending turn first, then signal.
          if (c.compactSummary) {
            if (this._pendingText) this._flushPending();
            try { this._onCompactSummary(); } catch {}
            continue;
          }

          // Touched-files tap for the legacy path (wire-routed sessions get these
          // off turn.completed instead — this watcher isn't running steady-state
          // there, and sentinel-made watchers pass no callback).
          const touches = extractFileTouches(rec);
          if (touches.length) {
            try { this._onFileTouches(touches); } catch {}
            this._pendingTouches.push(...touches);
          }

          if (c.inert) continue;
          if (c.text) {
            // AN EMPTY RID IS ITS OWN FLUSH UNIT, never a match. A Codex
            // function_call_output (the tool-output shape the reader reads text
            // from) carries neither requestId nor payload.id, so its `rid` is ''
            // and an equality test reads two unrelated text entries as the same
            // turn — the second OVERWRITES the first. What that silently discards
            // is the intent scan's input: an [agent:dm ...] emitted in a
            // commentary message followed by a quick tool call would never be
            // seen.
            if ((c.rid !== this._pendingRid || !c.rid) && this._pendingText) {
              this._flushPending();
            }
            this._pendingRid = c.rid;
            this._pendingText = c.text;
            this._pendingTime = Date.now();
            // WHERE the pending text came from, not just what it says. A turn can
            // end on a tool output (an interrupted Codex turn closes right after
            // one), and a terminator that flagged whatever happened to be pending
            // would mark a command dump as the reply — which is the one scope rule
            // the operator stated twice: never tool output.
            this._pendingIsReply = c.isReply;
            this._pendingTurnEnd = c.turnEnd;
            this._setActivity('thinking');
          } else {
            // A textless record ends the pending turn. Codex closes with
            // `task_complete` and Muse with `terminal`, neither carrying text, so
            // the flag is read off THIS record before flushing, or the flag that
            // ships is the one computed at the reply, which is false by
            // construction and leaves the reply permanently unspoken.
            if (this._pendingIsReply && c.turnEnd) this._pendingTurnEnd = true;
            if (this._pendingText && c.interrupted) this._pendingInterrupted = true;
            if (this._pendingText) this._flushPending();
            else if (c.turnEnd && this._activityState === 'thinking') this._setActivity('idle', true);
          }
          if (c.turnStart) this._setActivity('thinking');
        }
      }
    }

    _flushPending() {
      if (this._pendingText) {
        try {
          this._onText(this._pendingText, this._pendingTouches, {
            turnEnd: this._pendingTurnEnd, interrupted: this._pendingInterrupted,
          });
        } catch {}
        this._setActivity('idle', this._pendingTurnEnd);
      }
      this._pendingRid = null;
      this._pendingText = null;
      // Cleared with the rest of the pending state rather than relying on every
      // writer of _pendingText to reassign it — true today, and not an invariant
      // the next reader should have to rediscover.
      this._pendingTurnEnd = false;
      this._pendingInterrupted = false;
      this._pendingIsReply = false;
      // Cleared unconditionally, including on a no-text flush: touches held past
      // their own turn would attach to a LATER turn's text, which is a worse
      // claim than not reporting them.
      this._pendingTouches = [];
    }
  }

  return { JsonlWatcher };
}

module.exports = { createJsonlWatcher };
