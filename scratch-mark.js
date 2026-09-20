'use strict';

const ACK_PREFIX = '[agent:scratch] episode open · mark ';
const SCRATCH_NOTELESS_SENTENCE = 'You left no note: you recorded that stretch as a negative result — '
  + 'nothing in it was worth keeping. Do not repeat it; take a different approach or report the dead end.';

const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system']);

const NONCE_LEN = 6;

function nonce(rand = Math.random) {
  let out = '';
  while (out.length < NONCE_LEN) {
    out += Math.floor(rand() * 36 ** NONCE_LEN).toString(36);
  }
  return out.slice(0, NONCE_LEN);
}

function parseTranscriptTail(input, opts = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const baseOffset = Number.isFinite(opts.baseOffset) ? opts.baseOffset : 0;
  const records = [];
  let undecodable = 0;
  let partialHead = null;
  let cursor = 0;
  let first = true;

  while (cursor < buf.length) {
    let nl = buf.indexOf(0x0a, cursor);
    const complete = nl !== -1;
    if (!complete) nl = buf.length;
    const offset = cursor;
    const slice = buf.subarray(cursor, nl);
    cursor = nl + 1;

    const isHead = first;
    first = false;
    const text = slice.toString('utf8').trim();
    if (!text) continue;

    let record = null;
    try { record = JSON.parse(text); } catch { record = null; }

    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      if (isHead && baseOffset > 0) {
        partialHead = { offset: baseOffset + offset, byteLength: slice.length };
        continue;
      }
      undecodable++;
      continue;
    }

    const type = typeof record.type === 'string' ? record.type : '';
    records.push({
      offset: baseOffset + offset,
      endOffset: baseOffset + nl + (complete ? 1 : 0),
      byteLength: slice.length,
      type,
      conversation: CONVERSATION_TYPES.has(type),
      complete,
      record,
    });
  }

  return { records, undecodable, partialHead };
}

function toolUseIds(record) {
  const content = record && record.message && record.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => b.id);
}

function toolResultIds(record) {
  const content = record && record.message && record.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && b.type === 'tool_result' && b.tool_use_id)
    .map((b) => b.tool_use_id);
}

function contentBlockTypes(record) {
  const content = record && record.message && record.message.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b.type === 'string').map((b) => b.type);
}

function boundaryAt(records) {
  const list = Array.isArray(records) ? records : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!entry.conversation) continue;
    const rec = entry.record;
    if (entry.type === 'system' && rec.subtype === 'turn_duration') {
      return { ok: true, reason: null, entry };
    }
    if (entry.type === 'assistant') {
      const stop = rec.message && rec.message.stop_reason;
      if (stop !== 'end_turn') {
        return { ok: false, reason: 'not-a-boundary', entry };
      }
      if (contentBlockTypes(rec).includes('tool_use')) {
        return { ok: false, reason: 'not-a-boundary', entry };
      }
      return { ok: true, reason: null, entry };
    }
    return { ok: false, reason: 'not-a-boundary', entry };
  }
  return { ok: false, reason: 'no-conversation-record', entry: null };
}

function beginCutAt(records) {
  const list = Array.isArray(records) ? records : [];
  let i = list.length - 1;
  while (i >= 0 && list[i].type !== 'assistant') i--;
  if (i < 0) return null;
  const id = (list[i].record.message || {}).id;
  let start = i;
  for (let j = i - 1; j >= 0; j--) {
    const e = list[j];
    if (!e.conversation) continue;
    if (e.type !== 'assistant' || !id || (e.record.message || {}).id !== id) break;
    start = j;
  }
  const leaf = list.slice(0, start).reverse().find((e) => e.conversation) || null;
  return { offset: list[start].offset, leaf };
}

function classifyUserRecord(record) {
  if (!record || record.type !== 'user') return null;
  const content = record.message && record.message.content;

  if (Array.isArray(content)) {
    const types = content.filter((b) => b && typeof b.type === 'string').map((b) => b.type);
    if (types.includes('tool_result')) return 'tool_result';
    if (record.isMeta === true || record.turnCompanion === true) return 'meta';
    return 'arrival';
  }

  if (typeof content !== 'string') return 'arrival';
  if (record.isMeta === true || record.turnCompanion === true) return 'meta';

  const kind = record.origin && record.origin.kind;
  if (kind === 'task-notification' || record.promptSource === 'system') return 'task-notification';

  if (content.startsWith('[agent:from ')) return 'arrival';
  if (content.startsWith('[agent:')) return 'notice';
  return 'arrival';
}

function userText(record) {
  const content = record && record.message && record.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function usageTotal(record) {
  const usage = record && record.message && record.message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens);
}

function markUsageTotal(mark) {
  const usage = mark && mark.usageAtBegin;
  if (!usage || typeof usage !== 'object') return null;
  const fields = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (!fields.some((v) => Number.isFinite(v))) return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite);
}

function lastUsageIn(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const total = usageTotal(entries[i].record);
    if (total !== null) return total;
  }
  return null;
}

function isBackgroundTaskEnqueue(entry) {
  if (entry.type !== 'queue-operation') return false;
  const rec = entry.record;
  if (rec.operation !== 'enqueue') return false;
  const content = typeof rec.content === 'string' ? rec.content : '';
  return content.includes('<task-notification>');
}

function cutStats({ parsed, cutOffset, size, mark } = {}) {
  const entries = Array.isArray(parsed) ? parsed : [];
  const kept = entries.filter((e) => e.offset < cutOffset);
  const dropped = entries.filter((e) => e.offset >= cutOffset);
  const before = Number.isFinite(size) ? size : 0;

  const byType = { assistant: 0, user: 0, system: 0, sidecar: 0 };
  let toolResults = 0;
  let toolResultBytes = 0;
  let turnsDropped = 0;
  let backgroundTasksDropped = 0;

  for (const entry of dropped) {
    if (entry.type === 'assistant' || entry.type === 'user' || entry.type === 'system') byType[entry.type]++;
    else byType.sidecar++;

    if (entry.type === 'user') {
      const ids = toolResultIds(entry.record);
      if (ids.length) {
        toolResults += ids.length;
        toolResultBytes += entry.byteLength;
      }
      const shape = classifyUserRecord(entry.record);
      if (shape && shape !== 'tool_result' && shape !== 'meta'
        && typeof (entry.record.message || {}).content === 'string') {
        turnsDropped++;
      }
    }

    if (isBackgroundTaskEnqueue(entry)) backgroundTasksDropped++;
  }

  const atBegin = markUsageTotal(mark) ?? lastUsageIn(kept);
  const atCut = lastUsageIn(entries);

  return {
    bytes: { before, kept: cutOffset, dropped: Math.max(0, before - cutOffset) },
    records: {
      dropped: dropped.length,
      byType,
      toolResults,
      toolResultBytes,
      backgroundTasksDropped,
    },
    turns: { dropped: turnsDropped },
    tokens: {
      atBegin,
      atCut,
      dropped: atBegin === null || atCut === null ? null : atCut - atBegin,
    },
  };
}

function refuse(reason, detail, extra = {}) {
  return { ok: false, cutOffset: null, reason, detail, stats: null, arrivals: [], ...extra };
}

function validateScratchCut(mark, fileBuffer, opts = {}) {
  const buf = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(String(fileBuffer || ''), 'utf8');
  const size = buf.length;

  if (!mark || typeof mark !== 'object') return refuse('no-mark', 'no episode is open');

  if (opts.realpath !== undefined && opts.realpath !== mark.realpath) {
    return refuse('cleared', `the transcript is now ${opts.realpath}, not the file that was marked`);
  }

  if (size < mark.sizeAtBegin) {
    return refuse('rewritten', `the transcript shrank from ${mark.sizeAtBegin} to ${size} bytes since the mark`);
  }

  const tail = mark.tailBytes ? Buffer.from(mark.tailBytes) : null;
  if (tail && tail.length) {
    const from = mark.sizeAtBegin - tail.length;
    if (from < 0 || !buf.subarray(from, mark.sizeAtBegin).equals(tail)) {
      return refuse('rewritten', 'the transcript no longer starts with what was marked');
    }
  }

  const { records } = parseTranscriptTail(buf);
  const last = [...records].reverse().find((e) => e.conversation);
  if (mark.sessionId && last && last.record.sessionId && last.record.sessionId !== mark.sessionId) {
    return refuse('cleared', `the transcript now carries sessionId ${last.record.sessionId}, not ${mark.sessionId}`);
  }

  const after = records.filter((e) => e.offset >= mark.sizeAtBegin);

  const ackNeedle = ACK_PREFIX + mark.nonce;
  const acks = after.filter((e) => e.type === 'user'
    && typeof (e.record.message || {}).content === 'string'
    && e.record.message.content.startsWith(ackNeedle));

  if (acks.length === 0) return refuse('ack-missing', `no ack for mark ${mark.nonce} was found after the mark`);
  if (acks.length > 1) return refuse('ack-duplicate', `${acks.length} acks for mark ${mark.nonce} were found after the mark`);

  const cutOffset = mark.sizeAtBegin;

  const compacted = after.find((e) => e.record.isCompactSummary === true);
  if (compacted) return refuse('compacted', 'a compact landed inside the episode');

  const kept = records.filter((e) => e.offset < cutOffset);

  const results = new Set();
  for (const entry of kept) {
    if (entry.type !== 'user') continue;
    for (const id of toolResultIds(entry.record)) results.add(id);
  }
  const orphans = [];
  for (const entry of kept) {
    if (entry.type !== 'assistant') continue;
    for (const id of toolUseIds(entry.record)) {
      if (!results.has(id)) orphans.push(id);
    }
  }
  if (orphans.length) {
    return refuse('orphaned-tool-use',
      `${orphans.length} tool_use block(s) in the kept set have no tool_result: ${orphans.join(', ')}`);
  }

  const leaf = [...kept].reverse().find((e) => e.conversation) || null;
  const boundary = leaf && leaf.type === 'user' ? { ok: true, reason: null, entry: leaf } : boundaryAt(kept);
  if (!boundary.ok) {
    return refuse(boundary.reason, 'the last kept record is not a turn boundary');
  }
  if (mark.leafUuid && boundary.entry.record.uuid !== mark.leafUuid) {
    return refuse('leaf-mismatch',
      `the last kept record is ${boundary.entry.record.uuid}, not the marked leaf ${mark.leafUuid}`);
  }

  const arrivals = after
    .filter((e) => e.offset > cutOffset && e.type === 'user' && classifyUserRecord(e.record) === 'arrival')
    .map((e) => ({
      offset: e.offset,
      at: e.record.timestamp || null,
      text: userText(e.record),
    }));

  const stats = cutStats({ parsed: records, cutOffset, size, mark });

  if (arrivals.length && !opts.replay) {
    return refuse('arrivals',
      `${arrivals.length} message(s) arrived during the episode and would be cut with it`,
      { stats, arrivals });
  }

  const body = typeof opts.body === 'string' ? opts.body : '';
  const dispatched = Array.isArray(mark.dispatched) ? mark.dispatched : [];
  const unmentioned = dispatched
    .map((d) => (d && typeof d.token === 'string' ? d.token : null))
    .filter((t) => t && !body.includes(t));
  if (unmentioned.length) {
    return refuse('dispatch-unmentioned',
      `the summary does not mention ${unmentioned.join(', ')}`,
      { stats, arrivals });
  }

  return { ok: true, cutOffset, reason: null, detail: null, stats, arrivals };
}

function defaultFormatTime(ms) {
  return new Date(ms).toTimeString().slice(0, 5);
}

function arrivalClock(at, formatTime = defaultFormatTime) {
  const s = at == null ? '' : String(at);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? formatTime(ms) : null;
}

function scratchReplayLine(mark, arrival, opts = {}) {
  const formatTime = typeof opts.formatTime === 'function' ? opts.formatTime : defaultFormatTime;
  const clock = arrivalClock(arrival && arrival.at, formatTime);
  const when = clock ? `arrived ${clock}; ` : '';
  const header = `Replayed from scratch episode ${mark.nonce} (${when}you saw it inside the episode `
    + 'and your summary says what you did about it — do not re-answer unless it says otherwise):';
  const text = (arrival && typeof arrival.text === 'string') ? arrival.text : '';
  return `${header}\n${text}`;
}

function scratchBriefing(mark, stats, body, opts = {}) {
  const formatTime = typeof opts.formatTime === 'function' ? opts.formatTime : defaultFormatTime;
  const endedAt = Number.isFinite(opts.endedAt) ? opts.endedAt : Date.now();
  const turns = ((stats || {}).turns || {}).dropped || 0;
  const droppedBytes = ((stats || {}).bytes || {}).dropped || 0;
  const kb = Math.round(droppedBytes / 1024);

  const label = typeof opts.label === 'string' && opts.label ? opts.label : (mark.label || null);
  if (!label) {
    const header = `Scratch episode result · mark ${mark.nonce} (delivered by Clodex). `
      + `You opened this episode at ${formatTime(mark.beganAt)} and closed it at ${formatTime(endedAt)}; `
      + `the ${turns} turns / ${kb} KB of reads between them are no longer in your transcript — `
      + 'only the summary below, which you wrote at close, survives. It is your own conclusion, delivered as '
      + 'given facts: what it does not state, you have not verified. Continue from it.';
    return `${header}\n\n${String(body == null ? '' : body)}`;
  }

  const note = String(body == null ? '' : body);
  const noteless = opts.noteless === true || note.trim() === '';
  const earlier = (Array.isArray(opts.notes) ? opts.notes : [])
    .filter((n) => n && typeof n.body === 'string')
    .map((n) => `[${formatTime(n.at)}] ${n.body}`);
  const tail = noteless
    ? `. ${SCRATCH_NOTELESS_SENTENCE}`
    : ' — only the note(s) below survive. They are your own conclusions, delivered as given facts: '
      + 'what they do not state, you have not verified. Continue from them.';
  const header = `Scratch rewind result · mark ${mark.nonce} · label ${label} (delivered by Clodex). `
    + `You set this mark at ${formatTime(mark.beganAt)} and rewound to it at ${formatTime(endedAt)}; `
    + `the ${turns} turns / ${kb} KB between them are no longer in your transcript${tail}`;
  const blocks = [header];
  if (earlier.length) blocks.push((noteless ? 'Notes left at this mark earlier:\n' : '') + earlier.join('\n\n'));
  if (!noteless) blocks.push(`[${formatTime(endedAt)}] ${note}`);
  return blocks.join('\n\n');
}

function scratchReArmLine(mark) {
  return `${ACK_PREFIX}${mark.nonce} · label ${mark.label} re-armed here — `
    + `rewind to it again with \`[agent:scratch rewind ${mark.label}] <note>\`.`;
}

module.exports = {
  ACK_PREFIX,
  CONVERSATION_TYPES,
  nonce,
  parseTranscriptTail,
  boundaryAt,
  beginCutAt,
  classifyUserRecord,
  cutStats,
  validateScratchCut,
  scratchBriefing,
  scratchReArmLine,
  scratchReplayLine,
  arrivalClock,
  SCRATCH_NOTELESS_SENTENCE,
};
