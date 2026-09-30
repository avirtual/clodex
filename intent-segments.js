'use strict';

const scanner = require('./intent-scanner');
const registry = require('./intent-registry');

function jsonComplete(s) {
  const t = s.trim();
  if (!t) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

function scanIntentLines(lines, opts = {}) {
  const parseIntent = opts.parseIntent || scanner.parseIntent;
  const fencedLines = opts.fencedLines || scanner.fencedLines;
  const looksLikeIntent = opts.looksLikeIntent || scanner.looksLikeIntent;
  const bodyModeFor = opts.bodyModeFor || registry.bodyModeFor;
  const execBodyCap = opts.execBodyCap;
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
      let j = i;
      let complete = jsonComplete(buf);
      while (!complete && j < lines.length) {
        const next = fenced[j] ? null : parseIntent(lines[j]);
        if (next && next.type !== 'escape') break;
        const grown = buf + '\n' + lines[j];
        if (Buffer.byteLength(grown, 'utf8') > execBodyCap) break;
        buf = grown;
        j++;
        complete = jsonComplete(buf);
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

module.exports = { scanIntentLines };
