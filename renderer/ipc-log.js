// ipc-log.js — the collapsible IPC-traffic log drawer at the bottom of the
// window (read-only view of every inter-agent message). Owns its DOM handles,
// its two counters (total + unread), and its own IPC subscription; renderer.js
// keeps only the `appendIpcEntry` handle it needs to log a synthetic
// deploy-failure line.
//
// FACTORY (R2): created via createIpcLog(deps). toggleIpcLog refits the active
// terminal after the layout shift, which needs core state — so `sessions` (the
// live Map) and `getActiveSession` (a getter, since activeSession is a
// reassignable let in renderer.js) are passed in. Those two are the only
// cross-island reach-ins; everything else is self-contained.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee.

const { esc } = require('./lib/format');

function createIpcLog({ sessions, getActiveSession }) {
  const ipcLog = document.getElementById('ipc-log');
  const ipcLogHeader = document.getElementById('ipc-log-header');
  const ipcLogBody = document.getElementById('ipc-log-body');
  const ipcEmpty = document.getElementById('ipc-empty');
  const ipcCount = document.getElementById('ipc-count');
  const ipcClearBtn = document.getElementById('ipc-clear');
  const ipcToggleBtn = document.getElementById('ipc-toggle');

  let ipcMessageCount = 0;
  let unreadIpcCount = 0;

  function updateIpcCount() {
    ipcCount.textContent = String(unreadIpcCount);
    ipcCount.classList.toggle('zero', unreadIpcCount === 0);
  }
  updateIpcCount();

  function toggleIpcLog() {
    ipcLog.classList.toggle('collapsed');
    const expanded = !ipcLog.classList.contains('collapsed');
    document.getElementById('main').classList.toggle('ipc-expanded', expanded);
    if (expanded) {
      unreadIpcCount = 0;
      updateIpcCount();
      ipcLogBody.scrollTop = ipcLogBody.scrollHeight;
    }
    // Refit the terminal after layout shift
    if (getActiveSession()) {
      const s = sessions.get(getActiveSession());
      if (s) {
        requestAnimationFrame(() => {
          s.fitAddon.fit();
          window.api.resizeSession(getActiveSession(), s.terminal.cols, s.terminal.rows);
        });
      }
    }
  }

  function clearIpcLog() {
    ipcLogBody.innerHTML = '';
    ipcLogBody.appendChild(ipcEmpty);
    ipcMessageCount = 0;
    unreadIpcCount = 0;
    updateIpcCount();
  }

  ipcLogHeader.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    toggleIpcLog();
  });
  ipcToggleBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleIpcLog(); });
  ipcClearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearIpcLog(); });

  function appendIpcEntry(msg) {
    if (ipcMessageCount === 0 && ipcEmpty.parentNode === ipcLogBody) ipcEmpty.remove();
    ipcMessageCount++;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'ipc-entry';

    const fromBadge = `<span class="ipc-from">${esc(msg.from)}</span>`;
    const arrow = `<span class="ipc-arrow">→</span>`;
    const targetBadge = `<span class="ipc-to">${esc(msg.to)}</span>`;
    const body = `<span class="ipc-body">${esc(msg.body)}</span>`;

    entry.innerHTML = `<span class="ipc-time">${time}</span>${fromBadge}${arrow}${targetBadge}${body}`;
    ipcLogBody.appendChild(entry);

    // Auto-scroll if already near the bottom
    const nearBottom = ipcLogBody.scrollHeight - ipcLogBody.scrollTop - ipcLogBody.clientHeight < 40;
    if (nearBottom) ipcLogBody.scrollTop = ipcLogBody.scrollHeight;

    // Update unread counter if panel is collapsed
    if (ipcLog.classList.contains('collapsed')) {
      unreadIpcCount++;
      updateIpcCount();
    }
  }

  window.api.onIpcMessage((msg) => {
    appendIpcEntry(msg);
  });

  window.api.onRequestOpenIpcLog(() => {
    if (ipcLog.classList.contains('collapsed')) toggleIpcLog();
  });

  return { appendIpcEntry, toggleIpcLog };
}

module.exports = { createIpcLog };
