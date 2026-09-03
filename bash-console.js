'use strict';

const fs = require('fs');
const path = require('path');
const { pathFor } = require('./clodex-paths');

const CONSOLE_MAX_RECORDS = 2000;
const RECORD_MAX_BYTES = 256 * 1024;
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

function recordFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  return names.filter((n) => n.endsWith('.json')).sort();
}

function readRecordFile(dir, base) {
  const full = path.join(dir, base);
  try {
    if (fs.statSync(full).size > RECORD_MAX_BYTES) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function readBashConsole(root, name, cursor) {
  const dir = pathFor(root, name, 'bashConsole');
  const files = recordFiles(dir);
  if (files === null) return { records: [], cursor: '', reset: !!cursor, live: false };

  const since = typeof cursor === 'string' ? cursor : '';
  let fresh = since ? files.filter((f) => f > since) : files;

  const reset = !!since && files.length > 0 && files[0] > since && fresh.length === files.length;

  if (fresh.length > PULL_MAX_RECORDS) fresh = fresh.slice(-PULL_MAX_RECORDS);

  const records = [];
  for (const base of fresh) {
    const text = readRecordFile(dir, base);
    if (text === null) continue;
    let obj = null;
    try { obj = JSON.parse(text); } catch { continue; }
    const rec = normalizeRecord(obj);
    if (rec) records.push(rec);
  }

  const next = fresh.length ? fresh[fresh.length - 1] : since;
  return { records, cursor: next, reset, live: true };
}

module.exports = {
  CONSOLE_MAX_RECORDS,
  RECORD_MAX_BYTES,
  PULL_MAX_RECORDS,
  stripAnsi,
  splitFailure,
  normalizeRecord,
  parseChunk,
  readBashConsole,
};
