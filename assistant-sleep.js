'use strict';

const path = require('path');
const { seatDirFor } = require('./clodex-paths');
const { scanIntentLines } = require('./intent-segments');

const BRIEF_MAX_BYTES = 3072;
const BRIEF_TAIL = 10;
const BRIEF_HEAD = '## Before you slept\n\n';

function briefPathFor(root, name) {
  return path.join(seatDirFor(root, name), 'brief.md');
}

function proseOf(text) {
  const lines = String(text || '').split('\n');
  const kept = [];
  for (const seg of scanIntentLines(lines)) {
    if (seg.kind === 'prose') kept.push(...lines.slice(seg.from, seg.to));
  }
  return kept.join('\n').trim();
}

function splitTurnText(text) {
  const lines = String(text || '').split('\n');
  const kept = [];
  const intents = [];
  for (const seg of scanIntentLines(lines)) {
    if (seg.kind === 'prose') kept.push(...lines.slice(seg.from, seg.to));
    else if (seg.kind === 'intent') {
      const { type, sub, cmd } = seg.intent;
      intents.push({ type, ...(sub ? { sub } : {}), ...(cmd ? { cmd } : {}) });
    }
  }
  return { text: kept.join('\n').trim(), intents };
}

function cutHead(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  if (maxBytes <= 0) return '';
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

function composeBrief({ messages, tail = BRIEF_TAIL, maxBytes = BRIEF_MAX_BYTES } = {}) {
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.interim && (m.role === 'user' || m.role === 'assistant'));
  let from = 0;
  let users = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role !== 'user') continue;
    users++;
    from = i;
    if (users >= tail) break;
  }
  const out = [];
  for (const m of rows.slice(from)) {
    const text = proseOf(m.text);
    if (text) out.push({ label: m.role === 'user' ? '**player:** ' : '**you:** ', text });
  }
  if (!out.length) return null;
  const render = (list) => BRIEF_HEAD + list.map((r) => r.label + r.text).join('\n\n');
  while (out.length > 1 && Buffer.byteLength(render(out), 'utf8') > maxBytes) out.shift();
  if (Buffer.byteLength(render(out), 'utf8') > maxBytes) {
    const last = out[0];
    const room = maxBytes - Buffer.byteLength(BRIEF_HEAD + last.label, 'utf8');
    last.text = cutHead(last.text, room);
    if (!last.text) return null;
  }
  return render(out);
}

function idleDecision({ now, activityTs, idleMs, state, outbox, permissions } = {}) {
  const sleep = idleMs > 0 && state !== 'thinking' && !outbox && !permissions && now - activityTs >= idleMs;
  return sleep ? 'sleep' : 'keep';
}

function pickMaxAwakeVictim(rows, maxAwake) {
  const list = Array.isArray(rows) ? rows : [];
  if (!(maxAwake > 0) || list.length < maxAwake) return null;
  let victim = null;
  for (const r of list) {
    if (!r || r.busy) continue;
    if (!victim || r.activityTs < victim.activityTs) victim = r;
  }
  return victim ? victim.name : null;
}

module.exports = { BRIEF_MAX_BYTES, BRIEF_TAIL, briefPathFor, composeBrief, idleDecision, pickMaxAwakeVictim, splitTurnText };
