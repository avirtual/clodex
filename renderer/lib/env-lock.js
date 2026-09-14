'use strict';

function envLockFor(locked, key) {
  if (!locked || typeof locked !== 'object') return null;
  const name = locked[key];
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function envLockView(locked, key) {
  const name = envLockFor(locked, key);
  return {
    locked: !!name,
    envName: name,
    note: name ? `Set by ${name} — this box serves that value and the field cannot change it. Clear the variable and restart to use what Settings holds.` : '',
  };
}

function applyEnvLock(el, stateEl, view) {
  if (el) {
    el.readOnly = !!(view && view.locked);
    el.classList.toggle('env-locked', !!(view && view.locked));
  }
  if (stateEl) stateEl.textContent = (view && view.note) || '';
}

function patchUnlessEnvLocked(locked, key, value) {
  return envLockFor(locked, key) ? {} : { [key]: value };
}

module.exports = { envLockFor, envLockView, applyEnvLock, patchUnlessEnvLocked };
