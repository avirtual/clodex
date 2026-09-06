'use strict';

const SESSION_NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

const INVALID_BORDER = '#e94560';

const NAME_MESSAGES = {
  invalid: 'Letters, numbers, dot, underscore and hyphen only (1–64 characters), and never all dots.',
  live: 'That name is taken by a live session — pick another name.',
  persisted: 'That name is taken by an archived session — unarchive it or pick another name.',
  taken: 'That name is already taken — pick another name.',
};

function asSet(v) {
  if (v instanceof Set) return v;
  return new Set(Array.isArray(v) ? v : []);
}

function reservedSets(reply) {
  const live = asSet(reply && reply.live);
  const persisted = asSet(reply && reply.persisted);
  const taken = new Set();
  for (const n of ((reply && reply.names) || [])) {
    if (!live.has(n) && !persisted.has(n)) taken.add(n);
  }
  return { live, persisted, taken };
}

function reservedUnion(sets) {
  const s = sets || {};
  return new Set([...asSet(s.live), ...asSet(s.persisted), ...asSet(s.taken)]);
}

function nameFieldState(raw, sets) {
  const name = String(raw == null ? '' : raw).trim();
  const s = sets || {};
  if (!name) return { ok: false, kind: 'empty', message: '' };
  if (!SESSION_NAME_RE.test(name)) return { ok: false, kind: 'invalid', message: NAME_MESSAGES.invalid };
  if (asSet(s.live).has(name)) return { ok: false, kind: 'live', message: NAME_MESSAGES.live };
  if (asSet(s.persisted).has(name)) return { ok: false, kind: 'persisted', message: NAME_MESSAGES.persisted };
  if (asSet(s.taken).has(name)) return { ok: false, kind: 'taken', message: NAME_MESSAGES.taken };
  return { ok: true, kind: 'free', message: '' };
}

function createButtonState({ nameState, toolGate, mode, inFlight } = {}) {
  if (inFlight) return { disabled: true, title: '' };
  if (toolGate && toolGate.disabled) {
    return { disabled: true, title: (toolGate.notice && toolGate.notice.text) || '' };
  }
  if (mode === 'template') return { disabled: false, title: '' };
  const st = nameState || { ok: true, message: '' };
  if (st.ok) return { disabled: false, title: '' };
  return { disabled: true, title: st.message || '' };
}

function paintNameField(els, state) {
  const message = (state && state.message) || '';
  if (els && els.hint) {
    els.hint.textContent = message;
    els.hint.className = message ? 'hint-text name-hint-bad' : 'hint-text';
  }
  if (els && els.input) els.input.style.borderColor = message ? INVALID_BORDER : '';
  return state;
}

function applyCreateResult(els, result) {
  if (result && result.ok) {
    if (els && els.overlay) els.overlay.classList.add('hidden');
    return true;
  }
  paintNameField(els, {
    ok: false,
    kind: 'refused',
    message: (result && result.error) || 'unknown error',
  });
  return false;
}

module.exports = {
  SESSION_NAME_RE,
  INVALID_BORDER,
  NAME_MESSAGES,
  reservedSets,
  reservedUnion,
  nameFieldState,
  createButtonState,
  paintNameField,
  applyCreateResult,
};
