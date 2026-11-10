'use strict';

const { DEFAULT_LABEL, abbrevHome } = require('./account-select');

const API_KEY_PLACEHOLDER = 'API key (sk-ant-…)';
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
const INSECURE_KEY_REFUSAL = 'an API key is accepted only over a local or encrypted connection';

function keyTransportRefusal(win) {
  return win && win.isSecureContext === false ? INSECURE_KEY_REFUSAL : null;
}

function modelOptions(rows) {
  const out = new Set(MODEL_ALIASES);
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object' || r.type !== 'claude') continue;
    const m = String(r.model == null ? '' : r.model);
    if (m) out.add(m);
  }
  return [...out];
}

function keyFieldVisible(plan) {
  return plan === 'api';
}

function accountRowView(account, seats, home) {
  const a = (account && typeof account === 'object') ? account : {};
  const label = String(a.label == null ? '' : a.label);
  const isDefault = label === DEFAULT_LABEL;
  const n = Number.isFinite(seats) ? seats : 0;
  const keyed = !isDefault && keyFieldVisible(a.plan);
  const hasKey = keyed && a.apiKey === true;
  return {
    label,
    isDefault,
    email: a.email ? String(a.email) : '—',
    plan: isDefault ? '' : String(a.plan || 'unknown'),
    dir: abbrevHome(a.configDir, home),
    seats: n === 1 ? '1 seat' : `${n} seats`,
    dirTitle: String(a.configDir || ''),
    keyed,
    keyChip: keyed ? (hasKey ? 'key ✓' : 'no key') : '',
    hasKey,
  };
}

function buildAccountRow(doc, view) {
  const row = doc.createElement('div');
  row.className = 'prefs-account-row';
  row.dataset.label = view.label;

  const name = doc.createElement('code');
  name.className = 'prefs-account-name';
  name.textContent = view.label;
  row.appendChild(name);

  const email = doc.createElement('span');
  email.className = 'hint-text prefs-account-email';
  email.textContent = view.email;
  row.appendChild(email);

  if (view.plan) {
    const plan = doc.createElement('span');
    plan.className = 'prefs-account-plan';
    plan.textContent = view.plan;
    row.appendChild(plan);
  }

  if (view.keyChip) {
    const chip = doc.createElement('span');
    chip.className = 'prefs-account-key';
    chip.textContent = view.keyChip;
    row.appendChild(chip);
  }

  const dir = doc.createElement('span');
  dir.className = 'hint-text prefs-account-dir';
  dir.textContent = view.dir;
  dir.title = view.dirTitle;
  row.appendChild(dir);

  const seats = doc.createElement('span');
  seats.className = 'hint-text prefs-account-seats';
  seats.textContent = view.seats;
  row.appendChild(seats);

  const mk = (cls, text) => {
    const b = doc.createElement('button');
    b.className = `secondary ${cls}`;
    b.type = 'button';
    b.textContent = text;
    row.appendChild(b);
    return b;
  };

  const login = mk('prefs-account-login', 'Log in');
  const move = view.isDefault ? null : mk('prefs-account-move', 'Move');
  const resync = view.isDefault ? null : mk('prefs-account-resync', 'Re-sync settings');
  const setKey = view.keyed ? mk('prefs-account-setkey', 'Set key…') : null;
  const clearKey = view.hasKey ? mk('prefs-account-clearkey', 'Clear key') : null;
  const remove = view.isDefault ? null : mk('prefs-account-remove', 'Remove');

  return { row, login, move, resync, setKey, clearKey, remove };
}

function buildKeyPrompt(doc) {
  const input = doc.createElement('input');
  input.type = 'password';
  input.className = 'prefs-account-key-input';
  input.placeholder = API_KEY_PLACEHOLDER;
  input.autocomplete = 'off';
  input.spellcheck = false;
  const save = doc.createElement('button');
  save.className = 'secondary prefs-account-key-save';
  save.type = 'button';
  save.textContent = 'Save key';
  return { input, save };
}

module.exports = { accountRowView, buildAccountRow, buildKeyPrompt, keyFieldVisible, keyTransportRefusal, modelOptions, MODEL_ALIASES, API_KEY_PLACEHOLDER, INSECURE_KEY_REFUSAL };
