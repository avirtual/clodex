'use strict';

const LOGIN_OWED_TEXT = 'Claude login expired — run "claude login" in a terminal; keep-warm holds are paused until then';
const LOGIN_OWED_TIP = 'The bundled proxy can no longer refresh the Claude OAuth token; keep-warm holds stay paused until you log in again';

function loginOwedView(entries) {
  let owed = false;
  if (entries && typeof entries[Symbol.iterator] === 'function') {
    for (const st of entries) {
      const a = st && st.payload && st.payload.authRefresh;
      if (a && a.stalled) { owed = true; break; }
    }
  }
  if (!owed) return { hidden: true, text: '', tip: '' };
  return { hidden: false, text: LOGIN_OWED_TEXT, tip: LOGIN_OWED_TIP };
}

module.exports = { loginOwedView };
