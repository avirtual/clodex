'use strict';

const LOGIN_OWED_TEXT = 'Claude login expired — run "claude login" in a terminal; keep-warm holds are paused until then';
const LOGIN_OWED_TIP = 'The bundled proxy can no longer refresh the Claude OAuth token; keep-warm holds stay paused until you log in again';

function loginOwedView(entries, { boxLabel = null } = {}) {
  let owed = false;
  if (entries && typeof entries[Symbol.iterator] === 'function') {
    for (const st of entries) {
      const a = st && st.payload && st.payload.authRefresh;
      if (a && a.stalled) { owed = true; break; }
    }
  }
  if (!owed) return { hidden: true, text: '', tip: '' };
  if (typeof boxLabel === 'string' && boxLabel !== '') {
    return {
      hidden: false,
      text: `Claude login expired in box ${boxLabel} — run "claude login" inside it; keep-warm holds there are paused until then`,
      tip: `The proxy inside ${boxLabel} can no longer refresh its Claude OAuth token; holds in that box stay paused until someone logs in there`,
    };
  }
  return { hidden: false, text: LOGIN_OWED_TEXT, tip: LOGIN_OWED_TIP };
}

module.exports = { loginOwedView };
