// env-file.js — atomic 0600 KEY=value env-file primitives, dependency-free (no
// electron) so they unit-test under plain node. The shape both the sandbox's
// auth.env and the host's remote.env use: a multi-key set whose VALUES reach a
// process/container env yet never enter a config store, log, or IPC result.
// Multi-key by design — setting/clearing one key never disturbs another, and an
// empty set deletes the file. Extracted from sandbox.js's readAuthEnv/writeAuthEnv
// (M4) so the remote-token file can share the exact atomic semantics.
const fs = require('fs');
const path = require('path');

// Parse `<file>` into a { KEY: value } object. Missing/unreadable file → {}.
// Lines without a `=` (or with a leading `=`) are skipped; the value is the raw
// remainder after the first `=` (tokens never contain newlines).
function readEnvFile(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

// Write `env` ({ KEY: value }) atomically at mode 0600, sorted for a stable
// on-disk order. Null/empty values are dropped; an env that reduces to no keys
// deletes the file (ENOENT on delete is fine). tmp + rename + chmod-reassert so
// a reader never sees a torn or world-readable file.
function writeEnvFile(file, env) {
  const keys = Object.keys(env).filter((k) => env[k] != null && String(env[k]).length).sort();
  if (!keys.length) {
    try { fs.unlinkSync(file); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = keys.map((k) => `${k}=${env[k]}`).join('\n') + '\n';
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best-effort mode reassert */ }
}

module.exports = { readEnvFile, writeEnvFile };
