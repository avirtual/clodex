'use strict';

const { classifySender } = require('./sender-class');

const CONVERSATION = 'conversation';
const INTERNALS = 'internals';

const TALK_VERBS = new Set(['dm', 'shout', 'file', 'review-done']);
const ALWAYS_TALK = new Set(['prompt', 'command', 'command-output', 'boundary']);
const LOUD_LEVELS = new Set(['warning', 'error']);
const MERGED_NAG_RE = /^merged\b.*not accepted$/;

function isNagTag(tag) {
  if (typeof tag !== 'string') return false;
  return tag === 'REPLAY' || tag === 'wake' || tag.endsWith(' REDELIVERY') || MERGED_NAG_RE.test(tag);
}

function isTalkIntent(seg) {
  return Boolean(seg) && seg.kind === 'intent'
    && (TALK_VERBS.has(seg.verb) || (seg.verb === 'task' && seg.sub !== 'list'));
}

function segmentSurface(seg) {
  if (!seg || typeof seg !== 'object') return INTERNALS;
  if (seg.kind === 'prose') return typeof seg.text === 'string' && seg.text.trim() ? CONVERSATION : INTERNALS;
  return isTalkIntent(seg) ? CONVERSATION : INTERNALS;
}

function inboundSurface(rec) {
  if (rec.from === 'user') return CONVERSATION;
  if (rec.ticket) return isNagTag(rec.ticket.tag) ? INTERNALS : CONVERSATION;
  return classifySender(rec.from).cls === 'system' ? INTERNALS : CONVERSATION;
}

function surfaceOf(rec) {
  if (!rec || typeof rec !== 'object') return INTERNALS;
  if (ALWAYS_TALK.has(rec.kind)) return CONVERSATION;
  switch (rec.kind) {
    case 'inbound': return inboundSurface(rec);
    case 'reply': return rec.verb === 'task' && rec.ticket ? CONVERSATION : INTERNALS;
    case 'notice': return LOUD_LEVELS.has(rec.level) ? CONVERSATION : INTERNALS;
    case 'assistant':
      if (rec.apiError || !Array.isArray(rec.segments) || !rec.segments.length) return CONVERSATION;
      return rec.segments.some((s) => segmentSurface(s) === CONVERSATION) ? CONVERSATION : INTERNALS;
    default: return INTERNALS;
  }
}

const DRIVER_KINDS = new Set(['prompt', 'inbound', 'reply', 'notification']);

function turnDriver(records) {
  if (!Array.isArray(records)) return null;
  return records.find((r) => r && DRIVER_KINDS.has(r.kind)) || null;
}

function fromOperator(rec) {
  return Boolean(rec) && (rec.kind === 'prompt' || (rec.kind === 'inbound' && rec.from === 'user'));
}

function talksBack(rec) {
  return rec && rec.kind === 'assistant' && Array.isArray(rec.segments)
    && rec.segments.some(isTalkIntent);
}

function apiErrored(rec) {
  return Boolean(rec) && rec.kind === 'assistant' && Boolean(rec.apiError);
}

function turnFolds(records, mode) {
  if (mode !== CONVERSATION) return false;
  if (!turnDriver(records)) return false;
  return !records.some((r) => fromOperator(r) || talksBack(r) || apiErrored(r));
}

module.exports = { surfaceOf, segmentSurface, turnDriver, turnFolds };
