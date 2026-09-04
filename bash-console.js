'use strict';

const fs = require('fs');
const path = require('path');
const { pathFor } = require('./clodex-paths');

const CONSOLE_MAX_RECORDS = 2000;
const RECORD_MAX_BYTES = 256 * 1024;
const PULL_MAX_RECORDS = 50;
const BG_MAX_BYTES = 30000;

const RECORD_NAME_RE = /^[0-9]{1,32}-[0-9]{1,16}\.json$/;

function stampOf(base) {
  const i = base.indexOf('-');
  return i < 0 ? base : base.slice(0, i);
}

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
const BG_TASK_ID_RE = /^[a-z0-9]{1,32}$/;
const BG_EXIT_RE = /\n*\[exited with code (-?\d+)\]\n*$/;

function splitFailure(error) {
  const raw = String(error == null ? '' : error);
  const m = EXIT_RE.exec(raw);
  if (!m) return { exitCode: null, output: raw };
  return { exitCode: Number(m[1]), output: raw.slice(m[0].length) };
}

function bgOutputPath(scratchpadDir, taskId) {
  if (typeof scratchpadDir !== 'string' || !scratchpadDir) return null;
  if (!path.isAbsolute(scratchpadDir)) return null;
  if (typeof taskId !== 'string' || !BG_TASK_ID_RE.test(taskId)) return null;
  return path.join(path.dirname(scratchpadDir), 'tasks', `${taskId}.output`);
}

function readBgOutput(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const size = st.size;
    const tailed = size > BG_MAX_BYTES;
    const len = tailed ? BG_MAX_BYTES : size;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    const got = len ? fs.readSync(fd, buf, 0, len, tailed ? size - len : 0) : 0;
    fs.closeSync(fd);
    fd = null;
    return { text: buf.subarray(0, got).toString('utf8'), size, tailed };
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { fd = null; } }
    return null;
  }
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
      backgrounded: false,
      bgState: null,
      bgRunning: false,
      tailed: false,
    };
  }

  const resp = obj.tool_response && typeof obj.tool_response === 'object' ? obj.tool_response : {};
  const stdout = typeof resp.stdout === 'string' ? resp.stdout : '';
  const stderr = typeof resp.stderr === 'string' ? resp.stderr : '';
  const persistedSize = typeof resp.persistedOutputSize === 'number' ? resp.persistedOutputSize : null;
  const taskId = typeof resp.backgroundTaskId === 'string' ? resp.backgroundTaskId : '';

  let output = stripAnsi(stderr ? `${stdout}\n${stderr}` : stdout);
  let exitCode = 0;
  let failed = false;
  let fullBytes = persistedSize;
  let bgState = null;
  let bgRunning = false;
  let tailed = false;

  if (taskId && !output.trim()) {
    const file = bgOutputPath(obj.scratchpad_dir, taskId);
    const got = file ? readBgOutput(file) : null;
    if (!got || typeof got.text !== 'string') {
      bgState = 'absent';
    } else {
      const m = BG_EXIT_RE.exec(got.text);
      if (m) {
        exitCode = Number(m[1]);
        failed = exitCode !== 0;
      }
      bgRunning = !m;
      tailed = got.tailed === true;
      if (tailed) fullBytes = got.size;
      output = stripAnsi(m ? got.text.slice(0, got.text.length - m[0].length) : got.text.replace(/\n+$/, ''));
      bgState = output.trim() ? 'attached' : 'empty';
    }
  }

  return {
    ...base,
    failed,
    exitCode,
    output,
    interrupted: resp.interrupted === true,
    timedOut: false,
    truncated: typeof resp.persistedOutputPath === 'string' && !!resp.persistedOutputPath,
    fullBytes,
    backgrounded: !!taskId,
    bgState,
    bgRunning,
    tailed,
  };
}

function recordFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  return names.filter((n) => RECORD_NAME_RE.test(n)).sort();
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
  if (files === null) return { records: [], cursor: '', reset: !!cursor, skipped: 0, live: false };

  const since = typeof cursor === 'string' ? cursor : '';
  const sinceStamp = since ? stampOf(since) : '';
  let fresh = since
    ? files.filter((f) => stampOf(f) >= sinceStamp)
    : files;

  const reset = !!since && files.length > 0 && !files.includes(since);

  let skipped = 0;
  if (fresh.length > PULL_MAX_RECORDS) {
    skipped = fresh.length - PULL_MAX_RECORDS;
    fresh = fresh.slice(-PULL_MAX_RECORDS);
  }

  const records = [];
  for (const base of fresh) {
    const text = readRecordFile(dir, base);
    if (text === null) continue;
    let obj = null;
    try { obj = JSON.parse(text); } catch { continue; }
    const rec = normalizeRecord(obj);
    if (rec) records.push({ key: base, ...rec });
  }

  const last = fresh.length ? fresh[fresh.length - 1] : '';
  const next = last > since ? last : since;
  return { records, cursor: next, reset, skipped, live: true };
}

module.exports = {
  CONSOLE_MAX_RECORDS,
  RECORD_MAX_BYTES,
  PULL_MAX_RECORDS,
  BG_MAX_BYTES,
  RECORD_NAME_RE,
  stripAnsi,
  splitFailure,
  bgOutputPath,
  readBgOutput,
  normalizeRecord,
  readBashConsole,
};
