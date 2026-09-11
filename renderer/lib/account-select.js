'use strict';

const os = require('os');
const { parseEnvLines } = require('./env-edit');

const ENV_KEY = 'CLAUDE_CONFIG_DIR';
const DEFAULT_LABEL = 'default';
const CUSTOM_LABEL = 'custom';

function normDir(p) {
  const s = String(p == null ? '' : p);
  if (!s) return '';
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function abbrevHome(p, home = os.homedir()) {
  const s = String(p == null ? '' : p);
  if (!s || !home) return s;
  if (s === home) return '~';
  return s.startsWith(`${home}/`) ? `~${s.slice(home.length)}` : s;
}

function rowsOf(accounts) {
  return Array.isArray(accounts) ? accounts.filter((a) => a && typeof a === 'object') : [];
}

function accountFromEnv(envText, accounts) {
  const dir = normDir(parseEnvLines(envText).env[ENV_KEY]);
  if (!dir) return DEFAULT_LABEL;
  const hit = rowsOf(accounts).find((a) => normDir(a.configDir) === dir);
  return hit ? String(hit.label) : CUSTOM_LABEL;
}

function isAssignTo(line, key) {
  const lead = String(line).replace(/^\s+/, '');
  if (!lead || lead[0] === '#') return false;
  const eq = line.indexOf('=');
  return eq >= 0 && line.slice(0, eq).trim() === key;
}

function envWithAccount(envText, label, accounts) {
  const text = String(envText == null ? '' : envText);
  const want = String(label == null ? '' : label);
  if (want === CUSTOM_LABEL) return text;

  let dir = '';
  if (want !== DEFAULT_LABEL) {
    const hit = rowsOf(accounts).find((a) => String(a.label) === want);
    if (!hit) return text;
    dir = String(hit.configDir || '');
    if (!dir) return text;
  }

  const lines = text.split('\n');
  let at = -1;
  const kept = [];
  for (const line of lines) {
    if (isAssignTo(line, ENV_KEY)) {
      if (at < 0) at = kept.length;
      continue;
    }
    kept.push(line);
  }
  if (!dir) {
    if (at < 0) return text;
    if (kept.length === 1 && kept[0] === '') return '';
    return kept.join('\n');
  }
  const assign = `${ENV_KEY}=${dir}`;
  if (at >= 0) {
    kept.splice(at, 0, assign);
    return kept.join('\n');
  }
  if (kept.length === 1 && kept[0] === '') return assign;
  if (kept[kept.length - 1] === '') kept.splice(kept.length - 1, 0, assign);
  else kept.push(assign);
  return kept.join('\n');
}

function optionText(row, home) {
  const label = String(row.label);
  if (label === DEFAULT_LABEL) return `${label} — ${row.email || abbrevHome(row.configDir, home)}`;
  const who = row.email || abbrevHome(row.configDir, home);
  return `${label} — ${who} (${row.plan || 'unknown'})`;
}

function accountOptions(accounts, current, home = os.homedir()) {
  const cur = (current && typeof current === 'object') ? current : { label: current, configDir: '' };
  const curLabel = String(cur.label == null ? DEFAULT_LABEL : cur.label);
  const rows = rowsOf(accounts);
  const out = [];
  const def = rows.find((a) => String(a.label) === DEFAULT_LABEL)
    || { label: DEFAULT_LABEL, email: null, configDir: `${home}/.claude` };
  out.push({ value: DEFAULT_LABEL, text: optionText(def, home), selected: curLabel === DEFAULT_LABEL });
  for (const row of rows) {
    if (String(row.label) === DEFAULT_LABEL) continue;
    out.push({ value: String(row.label), text: optionText(row, home), selected: curLabel === String(row.label) });
  }
  if (curLabel === CUSTOM_LABEL) {
    out.push({ value: CUSTOM_LABEL, text: `${CUSTOM_LABEL} — ${abbrevHome(cur.configDir, home)}`, selected: true });
  }
  return out;
}

function loginSeat(label, account, { reserved = [], home = os.homedir(), bump = null } = {}) {
  const want = String(label == null ? DEFAULT_LABEL : label);
  const base = `login-${want}`;
  const taken = reserved instanceof Set ? reserved : new Set(reserved || []);
  let name = base;
  if (typeof bump === 'function' && taken.has(base)) name = bump(`${base}-2`, taken);
  const params = { name, type: 'bash', cwd: home, env: null };
  if (want !== DEFAULT_LABEL) {
    const dir = String((account && account.configDir) || '');
    if (!dir) return null;
    params.env = { [ENV_KEY]: dir };
  }
  return params;
}

module.exports = {
  ENV_KEY,
  DEFAULT_LABEL,
  CUSTOM_LABEL,
  abbrevHome,
  accountFromEnv,
  envWithAccount,
  accountOptions,
  loginSeat,
};
