'use strict';

const vm = require('node:vm');
const { stripAnsi } = require('./cli/src/output');

const TAIL_DEFAULT = 50;
const TAIL_MAX = 400;
const GREP_MAX = 50;
const READ_CAP = 16 * 1024;
const PATTERN_MAX = 200;
const GREP_BUDGET_MS = 1000;

const USAGE = 'use [agent:term read], [agent:term read] tail N or [agent:term read] grep <regex>';

function parseReadRequest(body) {
  const text = String(body == null ? '' : body).trim();
  if (!text) return { ok: true, mode: 'tail', n: TAIL_DEFAULT };
  const m = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const verb = m[1].toLowerCase();
  const rest = (m[2] || '').trim();
  if (verb === 'tail') {
    if (!rest) return { ok: true, mode: 'tail', n: TAIL_DEFAULT };
    if (!/^-?\d+$/.test(rest)) return { ok: false, error: `tail takes a line count, not \`${rest}\` — ${USAGE}` };
    return { ok: true, mode: 'tail', n: Math.min(TAIL_MAX, Math.max(1, Number(rest))) };
  }
  if (verb === 'grep') {
    if (!rest) return { ok: false, error: `grep needs a pattern — ${USAGE}` };
    if (rest.length > PATTERN_MAX) return { ok: false, error: `pattern is ${rest.length} characters; the limit is ${PATTERN_MAX}` };
    try { new RegExp(rest); } catch (e) { return { ok: false, error: `bad pattern: ${e.message}` }; }
    return { ok: true, mode: 'grep', pattern: rest };
  }
  return { ok: false, error: `unknown form \`term read ${verb}\` — ${USAGE}` };
}

function bufferLines(raw) {
  const lines = stripAnsi(String(raw || '')).replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function grepIndexes(lines, pattern, timeoutMs) {
  const found = vm.runInNewContext(
    'const re = new RegExp(pattern); const out = []; for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push(i); out;',
    { lines, pattern },
    { timeout: timeoutMs },
  );
  return Array.from(found);
}

function capText(text) {
  if (text.length <= READ_CAP) return { text, cut: false };
  return { text: `…\n${text.slice(-READ_CAP)}`, cut: true };
}

function readScrollback(raw, body, { timeoutMs = GREP_BUDGET_MS } = {}) {
  const req = parseReadRequest(body);
  if (!req.ok) return req;
  const lines = bufferLines(raw);
  const total = lines.length;
  let head;
  let text;
  if (req.mode === 'tail') {
    const kept = lines.slice(-req.n);
    head = `tail ${req.n}: last ${kept.length} of ${total} lines`;
    text = kept.join('\n');
  } else {
    let idx;
    try { idx = grepIndexes(lines, req.pattern, timeoutMs); } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { ok: false, error: `pattern took longer than ${timeoutMs} ms over ${total} lines — simplify it` };
      return { ok: false, error: `bad pattern: ${(e && e.message) || e}` };
    }
    if (!idx.length) return { ok: true, text: `grep /${req.pattern}/: no line matches in ${total} lines` };
    const kept = idx.slice(-GREP_MAX);
    head = `grep /${req.pattern}/: ${kept.length === idx.length ? `${idx.length}` : `last ${kept.length} of ${idx.length}`} matching lines of ${total} (L1 = most recent)`;
    text = kept.map((i) => `L${total - i}: ${lines[i]}`).join('\n');
  }
  const capped = capText(text);
  const note = capped.cut ? `\n(truncated: only the last ${READ_CAP} characters are shown)` : '';
  return { ok: true, text: `${head}${note}\n${capped.text}` };
}

module.exports = { readScrollback, parseReadRequest, TAIL_DEFAULT, TAIL_MAX, GREP_MAX, READ_CAP, PATTERN_MAX, GREP_BUDGET_MS };
