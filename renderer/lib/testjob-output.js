'use strict';

const { fmtSpan } = require('../../suite-activity-view');
const { fmtBytes } = require('./format');

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
const NOT_STARTED_TEXT = 'this job did not start, so it has no output';
const READ_FAILED_PREFIX = 'could not read the output: ';

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

  return { append, reset: () => mark(RESET_LINE), markDropped: () => { dropped = true; }, render, get dropped() { return dropped; }, get length() { return text.length; } };
}

const otherStream = (stream) => (stream === 'stderr' ? 'stdout' : 'stderr');

function statusText(r, { stream = null, otherBytes = null } = {}) {
  if (!r) return '';
  if (r.unknown) return UNKNOWN_TEXT;
  if (r.expired) return EXPIRED_TEXT;
  if (r.total === 0 && r.ok && !r.live && r.startedAt === null) return NOT_STARTED_TEXT;
  if (r.total === 0 && stream && otherBytes > 0) {
    return `no ${stream}${r.live ? ' yet' : ''}; ${otherStream(stream)} has ${fmtBytes(otherBytes)}`;
  }
  if (r.total === 0 && !r.live && stream) return `${stream} is empty`;
  if (r.total === 0) return r.live ? EMPTY_TEXT : NONE_TEXT;
  return '';
}

function headerText(r, { stream = null, lastOutputAt } = {}) {
  if (!r || !r.ok) return '';
  const since = r.startedAt != null ? r.startedAt : r.queuedAt;
  const end = r.endedAt != null ? r.endedAt : r.at;
  const perStream = stream && lastOutputAt !== undefined;
  const at = perStream ? lastOutputAt : r.lastOutputAt;
  const what = perStream ? stream : 'output';
  const last = at == null ? `no ${what}` : `last ${what} ${fmtSpan(r.at - at)} ago`;
  return `${r.phase} · age ${fmtSpan(end - since)} · ${last}`;
}

function startOf(job) {
  return job.startedAt != null ? job.startedAt : job.queuedAt;
}

function autoOpenJob(snapshot) {
  if (!snapshot) return null;
  const running = Array.isArray(snapshot.running) ? snapshot.running : [];
  if (running.length) return running.reduce((a, b) => (startOf(b) < startOf(a) ? b : a)).id;
  const recent = Array.isArray(snapshot.recent) ? snapshot.recent : [];
  if (recent.length) return recent.reduce((a, b) => (b.endedAt > a.endedAt ? b : a)).id;
  return null;
}

function streamInfo(job, stream) {
  const s = job && job.streams && job.streams[stream];
  return s ? { bytes: s.bytes, lastOutputAt: s.lastOutputAt } : { bytes: null, lastOutputAt: undefined };
}

function chooseStream(job) {
  return streamInfo(job, 'stdout').bytes === 0 && streamInfo(job, 'stderr').bytes > 0 ? 'stderr' : 'stdout';
}

function createStreamChoice() {
  let id = null;
  let stream = 'stdout';
  return {
    open(jobId, job) {
      if (jobId !== id) {
        id = jobId;
        stream = chooseStream(job);
      }
      return stream;
    },
    pick(picked) {
      if (picked === 'stdout' || picked === 'stderr') stream = picked;
      return stream;
    },
    close() {
      id = null;
      stream = 'stdout';
    },
    get stream() { return stream; },
  };
}

function streamLabel(stream, bytes) {
  return bytes == null ? stream : `${stream} ${fmtBytes(bytes)}`;
}

function createOutputFollower({
  read, onUpdate = () => {}, timers = { setTimeout, clearTimeout },
  pollMs = POLL_MS, maxBackoffMs = MAX_BACKOFF_MS, cap = PANE_CAP_CHARS, readBytes = READ_BYTES,
  stream = null, context = () => ({}),
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
    const ctx = context() || {};
    onUpdate({
      text: buffer.render(),
      header: headerText(last, { stream, lastOutputAt: ctx.lastOutputAt }),
      status: error || statusText(last, { stream, otherBytes: ctx.otherBytes }),
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
        error = status === 404 ? null : READ_FAILED_PREFIX + (r.error || 'bad request');
        stop();
        emit();
        return;
      }
      error = READ_FAILED_PREFIX + ((r && r.error) || 'no answer');
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
    if (offset == null && r.offset > 0) buffer.markDropped();
    if (r.text) buffer.append(r.text);
    const from = offset;
    offset = r.next;
    const behind = r.next < r.total && (from == null || r.next > from);
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
    start: () => schedule(0), setFollow, close, buffer, refresh: () => { if (!closed) emit(); },
    get total() { return last && last.ok ? last.total : null; },
    get inFlight() { return inFlight; }, get pending() { return timer != null; }, get delay() { return delay; },
  };
}

module.exports = {
  sanitizeOutput, createOutputBuffer, createOutputFollower, headerText, statusText,
  autoOpenJob, chooseStream, createStreamChoice, streamInfo, streamLabel, otherStream,
  PANE_CAP_CHARS, READ_BYTES, POLL_MS, MAX_BACKOFF_MS, DROPPED_LINE, RESET_LINE,
  EXPIRED_TEXT, EMPTY_TEXT, NONE_TEXT, UNKNOWN_TEXT, NOT_STARTED_TEXT, READ_FAILED_PREFIX,
};
