'use strict';

const LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PLANS = new Set(['pro', 'max', 'team', 'api', 'unknown']);
const DEFAULT_LABEL = 'default';
const SHARED_LINKS = ['projects', 'plugins', 'skills', 'agents', 'commands'];

function modelOfArgs(argv) {
  const a = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (typeof v !== 'string') continue;
    if ((v === '--model' || v === '-m') && typeof a[i + 1] === 'string') return a[i + 1];
    if (v.startsWith('--model=')) return v.slice('--model='.length);
  }
  return '';
}

function modelSelects(argModel, wanted) {
  const have = String(argModel || '');
  const want = String(wanted || '');
  if (!have || !want) return false;
  if (have === want) return true;
  const fableish = (s) => s === 'fable' || /^claude-fable(-|$)/.test(s);
  return fableish(have) && fableish(want);
}

function createAccounts(deps = {}) {
  const fs = deps.fs || require('fs');
  const path = deps.path || require('path');
  const os = deps.os || require('os');
  const clodexHome = deps.clodexHome || path.join(os.homedir(), '.clodex');
  const claudeHome = deps.claudeHome || path.join(os.homedir(), '.claude');
  const claudeConfigFile = deps.claudeConfigFile || path.join(path.dirname(claudeHome), '.claude.json');

  const registryFile = path.join(clodexHome, 'accounts.json');
  const accountsDir = path.join(clodexHome, 'accounts');

  const norm = (p) => {
    if (typeof p !== 'string' || !p) return '';
    const r = path.resolve(p);
    return r.length > 1 && r.endsWith(path.sep) ? r.slice(0, -1) : r;
  };

  function defaultRow() {
    return { label: DEFAULT_LABEL, email: null, configDir: claudeHome, plan: 'unknown', addedAt: null };
  }

  function sanitizeRow(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const label = String(raw.label || '');
    if (!LABEL_RE.test(label) || label === DEFAULT_LABEL) return null;
    const configDir = String(raw.configDir || '');
    if (!path.isAbsolute(configDir)) return null;
    return {
      label,
      email: raw.email == null ? null : String(raw.email),
      configDir,
      plan: PLANS.has(raw.plan) ? raw.plan : 'unknown',
      addedAt: Number.isFinite(raw.addedAt) ? raw.addedAt : null,
    };
  }

  function load() {
    try {
      const obj = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.accounts)) return [];
      return obj.accounts.map(sanitizeRow).filter(Boolean);
    } catch { return []; }
  }

  // Write-then-rename: a crash or a full disk mid-write would otherwise leave a
  // truncated registry, and load()'s JSON.parse catch turns that into an EMPTY
  // account list — every registered account silently gone with no error anywhere.
  function save(rows) {
    try { fs.mkdirSync(clodexHome, { recursive: true }); } catch {}
    const tmp = `${registryFile}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ accounts: rows }, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, registryFile);
  }

  function list() {
    return [defaultRow(), ...load()];
  }

  function configDirFor(label) {
    const want = String(label || '');
    if (want === DEFAULT_LABEL) return claudeHome;
    const hit = load().find((a) => a.label === want);
    return hit ? hit.configDir : null;
  }

  function resolveLabel(rows, configDir) {
    const dir = norm(configDir);
    if (!dir) return null;
    if (dir === norm(claudeHome)) return DEFAULT_LABEL;
    const hit = rows.find((a) => norm(a.configDir) === dir);
    if (hit) return hit.label;
    return path.basename(dir);
  }

  function labelFor(configDir) {
    return resolveLabel(load(), configDir);
  }

  // The batch form of labelFor: one registry read for a whole `session:list`
  // pass instead of one per row. Callers that label many dirs at once must use
  // this — labelFor re-reads and re-parses accounts.json every call, so a
  // twenty-seat list did twenty reads of the same file on every poll.
  function labelResolver() {
    const rows = load();
    return (configDir) => resolveLabel(rows, configDir);
  }

  function readTheme() {
    try {
      const obj = JSON.parse(fs.readFileSync(claudeConfigFile, 'utf-8'));
      if (obj && typeof obj.theme === 'string' && obj.theme) return obj.theme;
    } catch {}
    return 'dark';
  }

  function exists(p) {
    try { fs.lstatSync(p); return true; } catch { return false; }
  }

  function copySettings(dir, { overwrite }) {
    const src = path.join(claudeHome, 'settings.json');
    const dest = path.join(dir, 'settings.json');
    if (!exists(src)) return false;
    if (exists(dest) && !overwrite) return false;
    fs.writeFileSync(dest, fs.readFileSync(src), { mode: 0o600 });
    return true;
  }

  function mint(label) {
    if (!LABEL_RE.test(String(label || '')) || label === DEFAULT_LABEL) {
      throw new Error(`invalid account label "${label}" — must match ${LABEL_RE}`);
    }
    const dir = path.join(accountsDir, label);
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch {}

    const configFile = path.join(dir, '.claude.json');
    if (!exists(configFile)) {
      const body = { hasCompletedOnboarding: true, theme: readTheme(), projects: {} };
      fs.writeFileSync(configFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    }
    for (const name of SHARED_LINKS) {
      const target = path.join(claudeHome, name);
      const link = path.join(dir, name);
      if (!exists(target) || exists(link)) continue;
      try { fs.symlinkSync(target, link); } catch {}
    }
    copySettings(dir, { overwrite: false });
    return dir;
  }

  function resync(label) {
    const dir = configDirFor(label);
    if (!dir) return { ok: false, error: `unknown account "${label}"` };
    if (label === DEFAULT_LABEL) return { ok: false, error: 'the default account is the source, not a copy' };
    return { ok: true, copied: copySettings(dir, { overwrite: true }) };
  }

  function add({ label, email = null, plan = 'unknown', configDir = null } = {}) {
    const want = String(label || '');
    if (!LABEL_RE.test(want)) throw new Error(`invalid account label "${label}" — must match ${LABEL_RE}`);
    if (want === DEFAULT_LABEL) throw new Error(`"${DEFAULT_LABEL}" is the implicit account and cannot be added`);
    if (!PLANS.has(plan)) throw new Error(`invalid plan "${plan}" — one of ${[...PLANS].join('|')}`);
    const rows = load();
    if (rows.some((a) => a.label === want)) throw new Error(`account "${want}" already exists`);
    let dir = configDir ? String(configDir) : '';
    if (dir && !path.isAbsolute(dir)) throw new Error(`configDir must be absolute, got "${dir}"`);
    if (!dir) dir = mint(want);
    const row = {
      label: want,
      email: email == null ? null : String(email),
      configDir: dir,
      plan,
      addedAt: Date.now(),
    };
    rows.push(row);
    save(rows);
    return row;
  }

  function remove(label) {
    const rows = load();
    const next = rows.filter((a) => a.label !== String(label || ''));
    if (next.length === rows.length) return false;
    save(next);
    return true;
  }

  return {
    LABEL_RE,
    PLANS,
    registryFile,
    accountsDir,
    list,
    add,
    remove,
    labelFor,
    labelResolver,
    configDirFor,
    mint,
    resync,
  };
}

async function sweepAccountMove({ model, label, liveSessions, getEntry, configDirFor, applyArgs }) {
  const dir = configDirFor(label);
  if (!dir) return { ok: false, error: `unknown account "${label}"`, moved: [], skipped: [] };
  const toDefault = String(label) === DEFAULT_LABEL;

  const moved = [];
  const skipped = [];
  for (const live of Array.from(liveSessions)) {
    const name = live.name;
    if (live.type !== 'claude') { skipped.push({ name, reason: 'not a claude session' }); continue; }
    const entry = getEntry(name);
    if (!modelSelects(modelOfArgs(entry && entry.extraArgs), model)) {
      skipped.push({ name, reason: `model ${model} not selected` });
      continue;
    }
    const prevEnv = (entry && entry.env && typeof entry.env === 'object') ? entry.env : {};
    // A seat with NO CLAUDE_CONFIG_DIR already runs on `default` — the absence
    // of the var IS the default selection, so a move to `default` must skip it
    // rather than restart it to set a variable that changes nothing.
    const already = prevEnv.CLAUDE_CONFIG_DIR ? prevEnv.CLAUDE_CONFIG_DIR === dir : toDefault;
    if (already) { skipped.push({ name, reason: `already on account ${label}` }); continue; }
    if (live.activityState && live.activityState !== 'idle') {
      skipped.push({ name, reason: 'session is mid-turn' });
      continue;
    }
    const res = await applyArgs(name, {
      extraArgs: (entry && entry.extraArgs) || [],
      proxy: (entry && entry.proxy) ?? null,
      env: { ...prevEnv, CLAUDE_CONFIG_DIR: dir },
      restart: true,
    }, entry && entry.workspaceId);
    if (res && res.ok) moved.push(name);
    else skipped.push({ name, reason: (res && res.error) || 'restart failed' });
  }
  return { ok: true, moved, skipped };
}

module.exports = { createAccounts, sweepAccountMove, modelOfArgs, modelSelects, LABEL_RE, PLANS, SHARED_LINKS };
