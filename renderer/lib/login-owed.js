'use strict';

const { abbrevHome } = require('./account-select');

const LOGIN_OWED_TEXT = 'Claude login expired — run "claude login" in a terminal; keep-warm holds are paused until then';
const LOGIN_OWED_TIP = 'The bundled proxy can no longer refresh the Claude OAuth token; keep-warm holds stay paused until you log in again';
const DEFAULT_STORE = 'default';

function trimSlash(s) {
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function resolveStore(store, accounts) {
  if (store === DEFAULT_STORE) return { name: DEFAULT_STORE, command: 'claude login' };
  const want = trimSlash(store);
  const row = accounts.find((a) => a && typeof a.configDir === 'string' && trimSlash(a.configDir) === want);
  if (!row) return { name: abbrevHome(store), command: `CLAUDE_CONFIG_DIR=${store} claude login` };
  const label = String(row.label == null ? '' : row.label);
  return {
    name: row.email ? `${label} (${row.email})` : label,
    label,
    command: `CLAUDE_CONFIG_DIR=${row.configDir} claude login`,
  };
}

function loginOwedView(entries, { boxLabel = null, accounts = [] } = {}) {
  let owed = false;
  const stores = [];
  if (entries && typeof entries[Symbol.iterator] === 'function') {
    for (const st of entries) {
      const a = st && st.payload && st.payload.authRefresh;
      if (!a || !a.stalled) continue;
      owed = true;
      for (const s of Array.isArray(a.stalledStores) ? a.stalledStores : []) {
        if (typeof s === 'string' && s !== '' && !stores.includes(s)) stores.push(s);
      }
    }
  }
  if (!owed) return { hidden: true, text: '', tip: '' };
  if (typeof boxLabel === 'string' && boxLabel !== '') {
    return {
      hidden: false,
      text: `Claude login expired in box ${boxLabel} — run "claude login" inside it; keep-warm holds there are paused until then`,
      tip: `The proxy inside ${boxLabel} can no longer refresh its Claude OAuth token; holds in that box stay paused until someone logs in there`,
      command: 'claude login',
    };
  }
  if (stores.length === 0 || (stores.length === 1 && stores[0] === DEFAULT_STORE)) {
    return { hidden: false, text: LOGIN_OWED_TEXT, tip: LOGIN_OWED_TIP, command: 'claude login' };
  }
  const rows = Array.isArray(accounts) ? accounts : [];
  const resolved = stores.map((s) => resolveStore(s, rows));
  if (resolved.length === 1) {
    const r = resolved[0];
    return {
      hidden: false,
      text: `Claude login expired for ${r.name} — run the command below in a terminal; keep-warm holds on that account are paused until then`,
      tip: `The bundled proxy can no longer refresh the Claude OAuth token for ${r.label || r.name}; keep-warm holds on that account stay paused until you log in again`,
      command: r.command,
    };
  }
  const names = resolved.map((r) => r.label || r.name).join(', ');
  return {
    hidden: false,
    text: `Claude login expired for ${resolved.length} accounts (${names}) — run the command below once per account; keep-warm holds there are paused until then`,
    tip: `The bundled proxy can no longer refresh the Claude OAuth token for ${names}; keep-warm holds on those accounts stay paused until each one logs in again`,
    command: resolved.map((r) => r.command).join('\n'),
  };
}

module.exports = { loginOwedView };
