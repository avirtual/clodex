'use strict';

const scanner = require('./intent-scanner');
const registry = require('./intent-registry');

function jsonComplete(s) {
  const t = s.trim();
  if (!t) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

const DEFAULT_EXEC_BODY_CAP = 64 * 1024;

function newShape() { return { depth: 0, inStr: false, esc: false, seen: false }; }

function jsonShape(shape, s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (shape.inStr) {
      if (shape.esc) shape.esc = false;
      else if (c === 0x5c) shape.esc = true;
      else if (c === 0x22) shape.inStr = false;
      continue;
    }
    if (c === 0x22) { shape.inStr = true; shape.seen = true; }
    else if (c === 0x7b || c === 0x5b) { shape.depth++; shape.seen = true; }
    else if (c === 0x7d || c === 0x5d) { shape.depth--; shape.seen = true; }
    else if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) shape.seen = true;
  }
  return shape;
}

function jsonPrefix(shape) {
  return !shape.inStr && shape.depth >= 0 && !(shape.seen && shape.depth === 0);
}

function scanIntentLines(lines, opts = {}) {
  const parseIntent = opts.parseIntent || scanner.parseIntent;
  const fencedLines = opts.fencedLines || scanner.fencedLines;
  const looksLikeIntent = opts.looksLikeIntent || scanner.looksLikeIntent;
  const bodyModeFor = opts.bodyModeFor || registry.bodyModeFor;
  const bodyRunsToTurnEnd = opts.bodyRunsToTurnEnd || registry.bodyRunsToTurnEnd;
  const execBodyCap = opts.execBodyCap ?? DEFAULT_EXEC_BODY_CAP;
  const isComplete = opts.jsonComplete || jsonComplete;
  const segs = [];
  let proseFrom = null;
  const prose = (at) => { if (proseFrom == null) proseFrom = at; };
  const flush = (at) => {
    if (proseFrom != null && at > proseFrom) segs.push({ kind: 'prose', from: proseFrom, to: at });
    proseFrom = null;
  };
  const fenced = fencedLines(lines);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const inFence = fenced[i];
    const headAt = i;
    i++;
    if (inFence) { prose(headAt); continue; }
    const intent = parseIntent(line);
    if (intent && intent.type === 'end') {
      flush(headAt);
      segs.push({ kind: 'end', at: headAt });
      continue;
    }
    if (!intent || intent.type === 'escape') {
      const nearMiss = !intent && looksLikeIntent(line);
      if (nearMiss) {
        flush(headAt);
        segs.push({ kind: 'near-miss', at: headAt, text: nearMiss });
      } else prose(headAt);
      continue;
    }
    flush(headAt);

    if (bodyModeFor(intent) === 'json') {
      let buf = intent.body || '';
      let bytes = Buffer.byteLength(buf, 'utf8');
      const shape = jsonShape(newShape(), buf);
      let j = i;
      let complete = isComplete(buf);
      while (!complete && j < lines.length && jsonPrefix(shape)) {
        const next = fenced[j] ? null : parseIntent(lines[j]);
        if (next && next.type !== 'escape') break;
        const grownBytes = bytes + 1 + Buffer.byteLength(lines[j], 'utf8');
        if (grownBytes > execBodyCap) break;
        buf = buf + '\n' + lines[j];
        bytes = grownBytes;
        jsonShape(shape, lines[j]);
        j++;
        complete = shape.seen && shape.depth === 0 && !shape.inStr && isComplete(buf);
      }
      if (complete) {
        intent.body = buf;
        i = j;
        segs.push({ kind: 'intent', from: headAt, to: i, intent, closed: true });
        continue;
      }
    }

    let closed = true;
    const bodyMode = bodyModeFor(intent);
    if (bodyMode === 'greedy' || bodyMode === 'json') {
      const body = [];
      closed = false;
      while (i < lines.length) {
        const next = fenced[i] ? null : parseIntent(lines[i]);
        if (next && next.type !== 'escape') { closed = true; break; }
        body.push(lines[i]);
        i++;
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      if (!closed && bodyRunsToTurnEnd(intent)) {
        intent.bodyRanToTurnEnd = true;
        closed = true;
      }
      if (!closed) {
        intent.bodyOpen = true;
        i = headAt + 1;
        segs.push({ kind: 'intent', from: headAt, to: i, intent, closed, tail: body.length });
        continue;
      }
      if (body.length) {
        const firstBody = intent.body || '';
        intent.body = firstBody + '\n' + body.join('\n');
      }
    }

    segs.push({ kind: 'intent', from: headAt, to: i, intent, closed });
  }
  flush(lines.length);
  return segs;
}

module.exports = { scanIntentLines, jsonComplete, DEFAULT_EXEC_BODY_CAP };
