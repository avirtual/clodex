'use strict';

const path = require('path');
const crypto = require('crypto');

const { SEAT_KINDS, seatDirFor, seatPathFor, claudeProjectSlug } = require('./clodex-paths');
const { ensureSeatLink, renameTargets, pathInUse } = require('./seat-layout');

const SEAT_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

const IMPORT_MAX_BYTES = 512 * 1024 * 1024;
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

const TOP_LEVEL = new Set(['transcript.jsonl', 'seat', 'pending', 'loadlog.jsonl', 'reminders.json']);
const SINGLE_FILE = new Set(['transcript.jsonl', 'loadlog.jsonl', 'reminders.json']);
const IMPORTABLE_KINDS = Object.keys(SEAT_KINDS).filter((k) => k !== 'run');

function fail(error) {
  return { ok: false, error };
}

function createSeatImport({
  root, claudeProjects, reminders,
  fs = require('fs'), now = Date.now, log = null, maxBytes = IMPORT_MAX_BYTES,
} = {}) {
  if (!root) throw new Error('seat-import: root is required');
  if (!claudeProjects) throw new Error('seat-import: claudeProjects is required');

  const importRoot = path.join(root, 'import');

  function stagingDir(id) {
    return path.join(importRoot, id);
  }

  function filesDir(id) {
    return path.join(stagingDir(id), 'files');
  }

  function manifestPath(id) {
    return path.join(stagingDir(id), 'manifest.json');
  }

  function failedPath(id) {
    return path.join(stagingDir(id), 'failed');
  }

  function exists(p) {
    try { fs.lstatSync(p); return true; } catch { return false; }
  }

  function sizeOf(p) {
    try { return fs.statSync(p).size; } catch { return 0; }
  }

  function readManifest(id) {
    try {
      const obj = JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
      if (obj && typeof obj === 'object' && typeof obj.name === 'string') return obj;
    } catch {}
    return null;
  }

  function listStagings() {
    try { return fs.readdirSync(importRoot); } catch { return []; }
  }

  function failureReason(id) {
    try { return fs.readFileSync(failedPath(id), 'utf8').trim() || 'staging failed'; } catch { return null; }
  }

  function markFailed(id, reason) {
    try { fs.writeFileSync(failedPath(id), `${reason}\n`); } catch {}
  }

  function rmStaging(id) {
    try { fs.rmSync(stagingDir(id), { recursive: true, force: true }); } catch {}
  }

  function stagedBytes(id) {
    let total = 0;
    const stack = [filesDir(id)];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else total += sizeOf(p);
      }
    }
    return total;
  }

  function nameCollision(name) {
    for (const target of renameTargets(root, name)) {
      if (pathInUse(fs, target)) return target;
    }
    const pending = path.join(root, 'pending', name);
    if (pathInUse(fs, pending)) return pending;
    return null;
  }

  function checkRelPath(relPath) {
    if (typeof relPath !== 'string' || !relPath) return 'relPath is required';
    if (relPath.includes('\0')) return 'relPath contains a NUL byte';
    const segs = relPath.split('/');
    for (const seg of segs) {
      if (!seg) return `empty path segment in '${relPath}'`;
      if (seg === '.' || seg === '..') return `path segment '${seg}' is refused`;
      if (!SEGMENT_RE.test(seg)) return `path segment '${seg}' is refused`;
    }
    const head = segs[0];
    if (!TOP_LEVEL.has(head)) return `unknown top-level entry '${head}'`;
    if (SINGLE_FILE.has(head)) {
      if (segs.length !== 1) return `'${head}' is a file, not a directory`;
      return null;
    }
    if (head === 'seat') {
      if (segs.length < 3) return "a staged path under 'seat/' needs a kind and a file";
      const kind = segs[1];
      if (kind === 'run') return "seat kind 'run' is not imported";
      if (!Object.prototype.hasOwnProperty.call(SEAT_KINDS, kind)) return `unknown seat kind '${kind}'`;
      return null;
    }
    if (segs.length < 2) return "'pending' is a directory, not a file";
    return null;
  }

  function stagedSeatKinds(id) {
    const dir = path.join(filesDir(id), 'seat');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries.filter((e) => e.isDirectory() && IMPORTABLE_KINDS.includes(e.name)).map((e) => e.name);
  }

  function sha256(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }

  function begin({ name, record } = {}) {
    if (typeof name !== 'string' || !SEAT_NAME_RE.test(name)) return fail(`invalid seat name '${name}'`);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('record must be an object');
    if (record.type !== 'claude' && record.type !== 'codex') return fail(`unsupported seat type '${record.type}'`);
    if (record.type === 'codex') return fail('codex seats cannot be moved yet');
    if (typeof record.sessionId !== 'string' || !SESSION_ID_RE.test(record.sessionId)) {
      return fail('record.sessionId is required and must be a session uuid');
    }
    if (typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)) return fail('record.cwd must be an absolute path');

    for (const other of listStagings()) {
      const m = readManifest(other);
      if (m && m.name === name) return fail(`import of ${name} already in progress`);
    }

    const collision = nameCollision(name);
    if (collision) return fail(`${name} is already in use on this box: ${collision}`);

    const id = crypto.randomBytes(8).toString('hex');
    try {
      fs.mkdirSync(filesDir(id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(manifestPath(id), `${JSON.stringify({ name, record, startedAt: now() })}\n`);
    } catch (e) {
      rmStaging(id);
      return fail(`cannot create staging: ${e.message}`);
    }
    if (log) log.info('seat-import', `staging ${id} opened for ${name}`);
    return { ok: true, id, dropped: [] };
  }

  function putFile({ id, relPath, bytes, offset = 0 } = {}) {
    if (typeof id !== 'string' || !SEGMENT_RE.test(id) || !readManifest(id)) return fail(`unknown staging '${id}'`);
    const failed = failureReason(id);
    if (failed) return fail(`staging is failed: ${failed}`);
    const bad = checkRelPath(relPath);
    if (bad) return fail(bad);
    if (!Buffer.isBuffer(bytes)) return fail('bytes must be a Buffer');
    if (!Number.isInteger(offset) || offset < 0) return fail('offset must be a non-negative integer');

    const target = path.join(filesDir(id), ...relPath.split('/'));
    const current = exists(target) ? sizeOf(target) : 0;
    if (offset !== current) return fail('out-of-order chunk');

    if (stagedBytes(id) + bytes.length > maxBytes) {
      const reason = `import exceeds the ${maxBytes} byte cap`;
      markFailed(id, reason);
      return fail(reason);
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      if (offset === 0) fs.writeFileSync(target, bytes);
      else fs.appendFileSync(target, bytes);
    } catch (e) {
      return fail(`cannot stage ${relPath}: ${e.message}`);
    }
    return { ok: true, size: sizeOf(target) };
  }

  function abort({ id } = {}) {
    if (typeof id !== 'string' || !SEGMENT_RE.test(id)) return fail(`unknown staging '${id}'`);
    if (!exists(stagingDir(id))) return fail(`unknown staging '${id}'`);
    rmStaging(id);
    return { ok: true };
  }

  function sweep() {
    const removed = [];
    const cutoff = now() - STAGING_MAX_AGE_MS;
    for (const id of listStagings()) {
      const m = readManifest(id);
      if (!m || typeof m.startedAt !== 'number') continue;
      if (m.startedAt < cutoff) {
        rmStaging(id);
        removed.push(id);
      }
    }
    if (removed.length && log) log.info('seat-import', `swept ${removed.length} stale staging(s)`);
    return removed;
  }

  function commit({ id } = {}) {
    if (typeof id !== 'string' || !SEGMENT_RE.test(id)) return fail(`unknown staging '${id}'`);
    const manifest = readManifest(id);
    if (!manifest) return fail(`unknown staging '${id}'`);
    const failed = failureReason(id);
    if (failed) return fail(`staging is failed: ${failed}`);

    const { name, record } = manifest;
    if (typeof name !== 'string' || !SEAT_NAME_RE.test(name)) return fail(`invalid seat name '${name}'`);
    if (!record || typeof record !== 'object') return fail('staging manifest has no record');

    const collision = nameCollision(name);
    if (collision) return fail(`${name} is already in use on this box: ${collision}`);

    const staged = filesDir(id);
    const stagedTranscript = path.join(staged, 'transcript.jsonl');
    if (!exists(stagedTranscript)) return fail('no transcript.jsonl was staged');

    const projectDir = path.join(claudeProjects, claudeProjectSlug(record.cwd));
    const transcriptTarget = path.join(projectDir, `${record.sessionId}.jsonl`);
    let transcriptIdentical = false;
    if (exists(transcriptTarget)) {
      let same = false;
      try {
        same = sizeOf(transcriptTarget) === sizeOf(stagedTranscript)
          && sha256(transcriptTarget) === sha256(stagedTranscript);
      } catch { same = false; }
      if (!same) return fail(`a different transcript already exists at ${transcriptTarget}`);
      transcriptIdentical = true;
    }

    const stagedPending = path.join(staged, 'pending');
    const stagedLoadlog = path.join(staged, 'loadlog.jsonl');
    const stagedReminders = path.join(staged, 'reminders.json');
    const loadlogTarget = path.join(root, 'library', 'memory-loadlog', `${name}.jsonl`);
    if (exists(stagedLoadlog) && exists(loadlogTarget)) {
      return fail(`a load log already exists at ${loadlogTarget}`);
    }

    let reminderRows = null;
    if (exists(stagedReminders)) {
      try {
        reminderRows = JSON.parse(fs.readFileSync(stagedReminders, 'utf8'));
      } catch (e) {
        return fail(`staged reminders.json is malformed: ${e.message}`);
      }
      if (!Array.isArray(reminderRows) || reminderRows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
        return fail('staged reminders.json must be an array of rows');
      }
      if (reminderRows.length && !reminders) return fail('no reminders store was provided');
    }

    const kinds = stagedSeatKinds(id);

    const installed = { transcript: null, seatDir: null, pending: null, loadlog: null, reminders: 0 };
    const dropped = [];

    if (transcriptIdentical) {
      installed.transcript = 'identical';
    } else {
      fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
      const tmpTarget = `${transcriptTarget}.import-${id}`;
      fs.copyFileSync(stagedTranscript, tmpTarget);
      fs.renameSync(tmpTarget, transcriptTarget);
      installed.transcript = transcriptTarget;
    }

    const seatDir = seatDirFor(root, name);
    fs.mkdirSync(seatDir, { recursive: true, mode: 0o700 });
    for (const kind of kinds) fs.renameSync(path.join(staged, 'seat', kind), seatPathFor(root, name, kind));
    for (const kind of IMPORTABLE_KINDS) ensureSeatLink({ root, name, kind, fs });
    installed.seatDir = seatDir;

    if (exists(stagedPending)) {
      const pendingTarget = path.join(root, 'pending', name);
      fs.mkdirSync(path.dirname(pendingTarget), { recursive: true, mode: 0o700 });
      fs.renameSync(stagedPending, pendingTarget);
      installed.pending = pendingTarget;
    }

    if (exists(stagedLoadlog)) {
      fs.mkdirSync(path.dirname(loadlogTarget), { recursive: true, mode: 0o700 });
      fs.renameSync(stagedLoadlog, loadlogTarget);
      installed.loadlog = loadlogTarget;
    }

    if (reminderRows) {
      let ticketBound = 0;
      for (const row of reminderRows) {
        if (row.ticket) ticketBound += 1;
        reminders.add({
          agent: name,
          kind: row.kind,
          spec: row.spec,
          body: typeof row.body === 'string' ? row.body : '',
          nextFireAt: typeof row.nextFireAt === 'number' ? row.nextFireAt : null,
          ticket: null,
        });
        installed.reminders += 1;
      }
      if (ticketBound) dropped.push(`reminders.ticket-bound:${ticketBound}`);
    }

    if (record.env && record.env.CLAUDE_CONFIG_DIR) dropped.push('account');

    rmStaging(id);
    if (log) log.info('seat-import', `installed ${name} from staging ${id}`);
    return { ok: true, name, record, installed, dropped };
  }

  return { begin, putFile, abort, sweep, commit, maxBytes };
}

module.exports = { createSeatImport, IMPORT_MAX_BYTES };
