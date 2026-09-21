'use strict';

const { HEAD_RE } = require('./spill');
const { POINTER_RE, FILED_POINTER_RE, RECEIPT_RE, TAIL_RECEIPT_RE, SPILL_FILLER, pointerOf } = require('../intent-spill');
const { cleanLine } = require('../intent-scanner');

const NEEDLES = ['@spill:', ' filed at /', '[Runtime note:', '(I sent', '(I wrote'];
const END_LINE = '[agent:end]';

function hasNeedle(msg) {
  if (!Array.isArray(msg.content)) return false;
  for (const b of msg.content) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
    for (const n of NEEDLES) if (b.text.includes(n)) return true;
  }
  return false;
}

function isStubLine(line) {
  const t = cleanLine(line).trim();
  if (!t) return 0;
  if (t === SPILL_FILLER || POINTER_RE.test(t) || RECEIPT_RE.test(t) || TAIL_RECEIPT_RE.test(t)) return 1;
  const f = FILED_POINTER_RE.exec(t);
  if (f && !f[1]) return 1;
  const m = HEAD_RE.exec(t);
  if (m && pointerOf(t.slice(m[0].length).trim()) !== null) return 2;
  return 0;
}

function cutText(text) {
  const lines = text.split('\n');
  const kept = [];
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const kind = isStubLine(lines[i]);
    if (kind === 0) { kept.push(lines[i]); continue; }
    cut++;
    if (kind === 2 && i + 1 < lines.length && cleanLine(lines[i + 1]).trim() === END_LINE) { cut++; i++; }
  }
  return { text: cut ? kept.join('\n') : text, cut };
}

function isThinking(b) {
  return !!b && (b.type === 'thinking' || b.type === 'redacted_thinking');
}

function cutMessage(msg) {
  const blocks = [];
  let lines = 0;
  let droppedBlocks = 0;
  let orphanCache = null;
  for (const b of msg.content) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') { blocks.push(b); continue; }
    const r = cutText(b.text);
    if (!r.cut) { blocks.push(b); continue; }
    lines += r.cut;
    if (r.text.trim()) { blocks.push({ ...b, text: r.text }); continue; }
    droppedBlocks++;
    if (b.cache_control) orphanCache = b.cache_control;
  }
  if (orphanCache) {
    let at = blocks.length - 1;
    while (at >= 0 && isThinking(blocks[at])) at -= 1;
    if (at >= 0 && !blocks[at].cache_control) blocks[at] = { ...blocks[at], cache_control: orphanCache };
  }
  return { blocks, lines, droppedBlocks };
}

function cutSpillStubs(obj) {
  const report = { cut: false, lines: 0, blocks: 0, messages: 0, skipped: 0 };
  if (!obj || !Array.isArray(obj.messages)) return report;
  const out = [];
  let changed = false;
  for (const msg of obj.messages) {
    if (!msg || msg.role !== 'assistant' || !hasNeedle(msg)) { out.push(msg); continue; }
    const r = cutMessage(msg);
    if (!r.lines) { out.push(msg); continue; }
    if (!r.blocks.some((b) => !isThinking(b))) {
      const prev = out.length ? out[out.length - 1] : null;
      if (prev && prev.role === 'system') { report.skipped++; out.push(msg); continue; }
      report.messages++;
    } else {
      out.push({ ...msg, content: r.blocks });
    }
    changed = true;
    report.lines += r.lines;
    report.blocks += r.droppedBlocks;
  }
  if (changed) { obj.messages = out; report.cut = true; }
  return report;
}

module.exports = { cutSpillStubs, NEEDLES };
