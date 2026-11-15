'use strict';

const { fmtSpan } = require('../../suite-activity-view');

const PANE_CAP_CHARS = 256 * 1024;
const READ_BYTES = 256 * 1024;
const POLL_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const HELD_MAX = 4096;
const DROPPED_LINE = '… earlier output not shown …';
const RESET_LINE = '— output restarted from the beginning —';
const EXPIRED_TEXT = 'output expired';
const EMPTY_TEXT = 'no output yet';
const NONE_TEXT = 'no output';
const UNKNOWN_TEXT = 'job not found';

const STRING_SEQ = /(?:\x1b[\]P^_X]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const CSI_SEQ = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g;
const ESC_SEQ = /\x1b[ -/]*[0-~]/g;
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
const OPEN_TAIL = /\x1b(?:\[[0-?]*[ -/]*|[\]P^_X][^\x07\x1b\x9c]*\x1b?|[ -/]*)$/;

function sanitizeOutput(text) {
  return String(text)
    .replace(STRING_SEQ, '')
    .replace(CSI_SEQ, '')
    .replace(ESC_SEQ, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(CONTROLS, '');
}

function createOutputBuffer({ cap = PANE_CAP_CHARS } = {}) {
  let text = '';
  let held = '';
  let dropped = false;

  function trim() {
    if (text.length <= cap) return;
    dropped = true;
    const from = text.length - cap;
    const atLineStart = text[from - 1] === '\n';
    text = text.slice(from);
    const nl = atLineStart ? -1 : text.indexOf('\n');
    if (nl >= 0 && nl < text.length - 1) text = text.slice(nl + 1);
  }

  function append(chunk) {
    let raw = held + String(chunk);
    held = '';
    const open = OPEN_TAIL.exec(raw);
    if (open && open[0].length <= HELD_MAX) {
      held = open[0];
      raw = raw.slice(0, raw.length - held.length);
    }
    text += sanitizeOutput(raw);
    trim();
  }

  function mark(line) {
    held = '';
    if (text && !text.endsWith('\n')) text += '\n';
    text += `${line}\n`;
    trim();
  }

  function render() {
    return dropped ? `${DROPPED_LINE}\n${text}` : text;
  }

  return { append, reset: () => mark(RESET_LINE), render, get dropped() { return dropped; }, get length() { return text.length; } };
}

function statusText(r) {
  if (!r) return '';
  if (r.unknown) return UNKNOWN_TEXT;
  if (r.expired) return EXPIRED_TEXT;
  if (r.total === 0) return r.live ? EMPTY_TEXT : NONE_TEXT;
  return '';
}

function headerText(r) {
  if (!r || !r.ok) return '';
  const since = r.startedAt != null ? r.startedAt : r.queuedAt;
  const end = r.endedAt != null ? r.endedAt : r.at;
  const last = r.lastOutputAt == null ? 'no output' : `last output ${fmtSpan(r.at - r.lastOutputAt)} ago`;
  return `${r.phase} · age ${fmtSpan(end - since)} · ${last}`;
}

function createOutputFollower({
  read, onUpdate = () => {}, timers = { setTimeout, clearTimeout },
  pollMs = POLL_MS, maxBackoffMs = MAX_BACKOFF_MS, cap = PANE_CAP_CHARS, readBytes = READ_BYTES,
} = {}) {
  const buffer = createOutputBuffer({ cap });
  let offset = null;
  let timer = null;
  let inFlight = false;
  let closed = false;
  let stopped = false;
  let follow = true;
  let delay = pollMs;
  let last = null;
  let error = null;

  function emit() {
    onUpdate({
      text: buffer.render(), header: headerText(last), status: error || statusText(last),
      live: !!(last && last.live) && !stopped, follow, stopped,
    });
  }

  function schedule(ms) {
    if (closed || stopped || timer) return;
    timer = timers.setTimeout(tick, ms);
  }

  function stop() {
    stopped = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  async function tick() {
    timer = null;
    if (closed || stopped || inFlight) return;
    inFlight = true;
    let r;
    try { r = await read({ offset, length: readBytes }); } catch (e) { r = { ok: false, error: e && e.message ? e.message : String(e) }; }
    inFlight = false;
    if (closed) return;
    if (!r || !r.ok) {
      const status = r && r.status;
      if (status === 404 || status === 400) {
        last = status === 404 ? { unknown: true } : last;
        error = status === 404 ? null : (r.error || 'bad request');
        stop();
        emit();
        return;
      }
      error = `read failed: ${(r && r.error) || 'no answer'}`;
      delay = Math.min(delay * 2, maxBackoffMs);
      emit();
      schedule(delay);
      return;
    }
    error = null;
    delay = pollMs;
    last = r;
    if (offset != null && r.total < offset) {
      buffer.reset();
      offset = 0;
      emit();
      schedule(0);
      return;
    }
    if (r.text) buffer.append(r.text);
    offset = r.next;
    const behind = r.next < r.total;
    if (!r.live && !behind) stop();
    emit();
    if (behind) schedule(0);
    else if (follow) schedule(pollMs);
  }

  function setFollow(on) {
    follow = !!on;
    if (!follow && timer) { timers.clearTimeout(timer); timer = null; }
    if (follow) schedule(0);
    emit();
  }

  function close() {
    closed = true;
    if (timer) timers.clearTimeout(timer);
    timer = null;
  }

  return {
    start: () => schedule(0), setFollow, close, buffer,
    get inFlight() { return inFlight; }, get pending() { return timer != null; }, get delay() { return delay; },
  };
}

module.exports = {
  sanitizeOutput, createOutputBuffer, createOutputFollower, headerText, statusText,
  PANE_CAP_CHARS, READ_BYTES, POLL_MS, MAX_BACKOFF_MS, DROPPED_LINE, RESET_LINE,
  EXPIRED_TEXT, EMPTY_TEXT, NONE_TEXT, UNKNOWN_TEXT,
};
