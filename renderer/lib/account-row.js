'use strict';

const { DEFAULT_LABEL, abbrevHome } = require('./account-select');

function accountRowView(account, seats, home) {
  const a = (account && typeof account === 'object') ? account : {};
  const label = String(a.label == null ? '' : a.label);
  const isDefault = label === DEFAULT_LABEL;
  const n = Number.isFinite(seats) ? seats : 0;
  return {
    label,
    isDefault,
    email: a.email ? String(a.email) : '—',
    plan: isDefault ? '' : String(a.plan || 'unknown'),
    dir: abbrevHome(a.configDir, home),
    seats: n === 1 ? '1 seat' : `${n} seats`,
    dirTitle: String(a.configDir || ''),
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
  const remove = view.isDefault ? null : mk('prefs-account-remove', 'Remove');

  return { row, login, move, resync, remove };
}

module.exports = { accountRowView, buildAccountRow };
