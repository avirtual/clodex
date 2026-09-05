'use strict';

function envRowView(v, defaults) {
  const key = v && v.key ? String(v.key) : '';
  const secret = !!(v && v.secret);
  const value = secret ? '' : String(v && v.value == null ? '' : v.value);
  const rec = defaults && Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : null;
  const shipped = !!rec && !secret && value === String(rec.value == null ? '' : rec.value);
  const note = rec && rec.note ? String(rec.note) : '';
  return {
    key,
    secret,
    valueText: secret ? '•••••••• (secret — set)' : value,
    nameTitle: note ? `${key} — ${note}` : key,
    valueTitle: secret ? `${key} is stored write-only` : `${key}=${value}`,
    shipped,
  };
}

// Builds the row through an injected document so the class names and titles are
// assertable without a browser. `doc` needs only createElement.
function buildEnvRow(doc, view) {
  const row = doc.createElement('div');
  row.className = 'prefs-env-row';

  const keyEl = doc.createElement('code');
  keyEl.className = 'prefs-env-name';
  keyEl.textContent = view.key;
  keyEl.title = view.nameTitle;
  row.appendChild(keyEl);

  if (view.shipped) {
    const marker = doc.createElement('span');
    marker.className = 'prefs-env-shipped';
    marker.textContent = 'shipped';
    marker.title = 'A Clodex default, still at its shipped value.';
    row.appendChild(marker);
  }

  const valEl = doc.createElement('span');
  valEl.className = 'hint-text prefs-env-val';
  valEl.textContent = view.valueText;
  valEl.title = view.valueTitle;
  row.appendChild(valEl);

  return { row, keyEl, valEl };
}

module.exports = { envRowView, buildEnvRow };
