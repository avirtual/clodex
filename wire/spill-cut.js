'use strict';

const { HEAD_RE } = require('./spill');
const { POINTER_RE, FILED_POINTER_RE, RECEIPT_RE, TAIL_RECEIPT_RE, SPILL_FILLER, SPILLED_BODY, SPILLED_BODY_FIRST, SPILLED_BODY_EPHEMERAL, pointerMatch, resolveSpill } = require('../intent-spill');
const { cleanLine } = require('../intent-scanner');

const NEEDLES = ['@spill:', ' filed at /', '[Runtime note:', '(I sent', '(I wrote'];
const END_LINE = '[agent:end]';
const PLACEHOLDER = "(This turn's text was delivered in full; Clodex keeps it out of the request.)";

function hasNeedle(msg) {
  if (!Array.isArray(msg.content)) return false;
  for (const b of msg.content) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
    for (const n of NEEDLES) if (b.text.includes(n)) return true;
  }
  return false;
}

function headOf(t) {
  const m = HEAD_RE.exec(t);
  if (!m) return null;
  const body = t.slice(m[0].length).trim();
  const p = pointerMatch(body);
  if (!p) return null;
  const title = body.endsWith(p.pointer) ? body.slice(0, body.length - p.pointer.length).replace(/\s*—\s*$/, '').trim() : '';
  return title ? `${m[0]} ${title}` : m[0];
}

function classifyLine(line) {
  const t = cleanLine(line).trim();
  if (!t) return { kind: 0 };
  if (t === SPILL_FILLER || POINTER_RE.test(t) || RECEIPT_RE.test(t) || TAIL_RECEIPT_RE.test(t)) return { kind: 1 };
  const f = FILED_POINTER_RE.exec(t);
  if (f && !f[1]) return { kind: 1 };
  const head = headOf(t);
  if (head !== null) return { kind: 2, head };
  return { kind: 0 };
}

function bodyOf(line, root, agent) {
  if (!root || !agent) return null;
  const t = cleanLine(line).trim();
  const m = HEAD_RE.exec(t);
  if (!m) return null;
  const rest = t.slice(m[0].length).trim();
  const p = pointerMatch(rest);
  if (!p) return null;
  const r = resolveSpill(root, agent, p.id);
  if (!r.ok) return null;
  const f = FILED_POINTER_RE.exec(rest);
  return { key: f ? f[3] : p.pointer, lines: [m[0], r.body] };
}

function collectStubs(messages, root, agent) {
  const stubs = [];
  for (const msg of messages) {
    if (!msg || msg.role !== 'assistant' || !hasNeedle(msg)) continue;
    for (const b of msg.content) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
      for (const line of b.text.split('\n')) {
        if (classifyLine(line).kind === 2) stubs.push(bodyOf(line, root, agent));
      }
    }
  }
  return stubs;
}

function expansionOf(state) {
  const stub = state.stubs[state.next++] || null;
  if (!stub) return null;
  const ordinal = state.resolved++;
  if (ordinal < state.total - state.examples && !state.sticky.has(stub.key)) return null;
  state.expanded.push(stub.key);
  return stub.lines;
}

function cutText(text, state) {
  const lines = text.split('\n');
  const kept = [];
  let cut = 0;
  for (let i = 0; i < lines.length; i++) {
    const c = classifyLine(lines[i]);
    if (c.kind === 0) { kept.push(lines[i]); continue; }
    cut++;
    if (c.kind === 2) {
      const full = expansionOf(state);
      if (full) kept.push(...full, END_LINE);
      else {
        kept.push(c.head, state.first ? (state.examples <= 1 ? SPILLED_BODY_EPHEMERAL : SPILLED_BODY_FIRST) : SPILLED_BODY, END_LINE);
        state.first = false;
      }
      if (i + 1 < lines.length && cleanLine(lines[i + 1]).trim() === END_LINE) { cut++; i++; }
    }
  }
  return { text: cut ? kept.join('\n') : text, cut };
}

function isThinking(b) {
  return !!b && (b.type === 'thinking' || b.type === 'redacted_thinking');
}

function cutMessage(msg, state) {
  const blocks = [];
  let lines = 0;
  let droppedBlocks = 0;
  let orphanCache = null;
  for (const b of msg.content) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') { blocks.push(b); continue; }
    const r = cutText(b.text, state);
    if (!r.cut) { blocks.push(b); continue; }
    lines += r.cut;
    if (r.text.trim()) { blocks.push({ ...b, text: r.text }); continue; }
    droppedBlocks++;
    if (b.cache_control) orphanCache = b.cache_control;
  }
  if (orphanCache) {
    let at = blocks.length - 1;
    while (at >= 0 && isThinking(blocks[at])) at -= 1;
    if (at >= 0) {
      if (!blocks[at].cache_control) blocks[at] = { ...blocks[at], cache_control: orphanCache };
      orphanCache = null;
    }
  }
  return { blocks, lines, droppedBlocks, orphanCache };
}

function placeholderOf(r) {
  const text = { type: 'text', text: PLACEHOLDER };
  if (r.orphanCache) text.cache_control = r.orphanCache;
  return [...r.blocks.filter(isThinking), text];
}

function cutSpillStubs(obj, { root = null, agent = null, examples = 2, sticky = new Set() } = {}) {
  const report = { cut: false, lines: 0, blocks: 0, messages: 0, skipped: 0, placeholders: 0, expanded: [] };
  if (!obj || !Array.isArray(obj.messages)) return report;
  const out = [];
  let changed = false;
  const stubs = collectStubs(obj.messages, examples > 0 ? root : null, agent);
  const total = stubs.filter(Boolean).length;
  const state = { first: true, stubs, next: 0, resolved: 0, total, examples, sticky, expanded: report.expanded };
  for (const msg of obj.messages) {
    if (!msg || msg.role !== 'assistant' || !hasNeedle(msg)) { out.push(msg); continue; }
    const r = cutMessage(msg, state);
    if (!r.lines) { out.push(msg); continue; }
    if (!r.blocks.some((b) => !isThinking(b))) {
      const prev = out.length ? out[out.length - 1] : null;
      report.messages++;
      if (prev && prev.role === 'system') {
        report.placeholders++;
        out.push({ ...msg, content: placeholderOf(r) });
      }
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

module.exports = { cutSpillStubs, classifyLine, hasNeedle, NEEDLES, PLACEHOLDER };
