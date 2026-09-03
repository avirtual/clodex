'use strict';

const fs = require('fs');
const { pathFor } = require('./clodex-paths');

const CONSOLE_MAX_BYTES = 4 * 1024 * 1024;
const PULL_MAX_BYTES = 512 * 1024;
const PULL_MAX_RECORDS = 50;

const ANSI_RE = new RegExp(
  '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)'
  + '|\\u001bP[\\s\\S]*?\\u001b\\\\'
  + '|\\u001b[\\[\\]()#;?]*[0-9;]*[A-Za-z@-~]'
  + '|[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]',
  'g',
);

function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

const EXIT_RE = /^Exit code (\d+)\n?/;

function splitFailure(error) {
  const raw = String(error == null ? '' : error);
  const m = EXIT_RE.exec(raw);
  if (!m) return { exitCode: null, output: raw };
  return { exitCode: Number(m[1]), output: raw.slice(m[0].length) };
}

function normalizeRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.tool_name !== 'Bash') return null;
  const input = obj.tool_input && typeof obj.tool_input === 'object' ? obj.tool_input : {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return null;

  const base = {
    id: typeof obj.tool_use_id === 'string' ? obj.tool_use_id : null,
    command,
    durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : null,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    agentId: typeof obj.agent_id === 'string' ? obj.agent_id : null,
  };

  if (obj.hook_event_name === 'PostToolUseFailure') {
    const { exitCode, output } = splitFailure(obj.error);
    return {
      ...base,
      failed: true,
      exitCode,
      output: stripAnsi(output),
      interrupted: obj.is_interrupt === true,
      timedOut: obj.is_timeout === true,
      truncated: false,
      fullBytes: null,
    };
  }

  const resp = obj.tool_response && typeof obj.tool_response === 'object' ? obj.tool_response : {};
  const stdout = typeof resp.stdout === 'string' ? resp.stdout : '';
  const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
  const persistedSize = typeof resp.persistedOutputSize === 'number' ? resp.persistedOutputSize : null;
  return {
    ...base,
    failed: false,
    exitCode: 0,
    output: stripAnsi(stderr ? `${stdout}\n${stderr}` : stdout),
    interrupted: resp.interrupted === true,
    timedOut: false,
    truncated: typeof resp.persistedOutputPath === 'string' && !!resp.persistedOutputPath,
    fullBytes: persistedSize,
  };
}

function parseChunk(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { continue; }
    const rec = normalizeRecord(obj);
    if (rec) out.push(rec);
  }
  return out;
}

function readRange(file, from, to) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(to - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

function lastLineBreak(text) {
  const at = text.lastIndexOf('\n');
  return at < 0 ? null : at + 1;
}

function readBashConsole(root, name, offset) {
  const file = pathFor(root, name, 'bashConsole');
  const size = sizeOf(file);
  if (size === null) return { records: [], offset: 0, reset: offset > 0, live: false };

  let from = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  let reset = false;
  if (from > size) {
    from = 0;
    reset = true;
  }
  if (from === size) return { records: [], offset: from, reset, live: true };

  const to = Math.min(size, from + PULL_MAX_BYTES);
  const text = readRange(file, from, to);
  const cut = lastLineBreak(text);
  if (cut === null) return { records: [], offset: from, reset, live: true };

  let records = parseChunk(text.slice(0, cut));
  let next = from + Buffer.byteLength(text.slice(0, cut), 'utf8');
  if (records.length > PULL_MAX_RECORDS) {
    records = records.slice(-PULL_MAX_RECORDS);
  }
  return { records, offset: next, reset, live: true };
}

module.exports = {
  CONSOLE_MAX_BYTES,
  PULL_MAX_BYTES,
  PULL_MAX_RECORDS,
  stripAnsi,
  splitFailure,
  normalizeRecord,
  parseChunk,
  readBashConsole,
};
