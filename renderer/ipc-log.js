// ipc-log.js — the IPC-traffic log: a read-only view of every inter-agent
// message, and the drawer host's first tenant (tab id `log`). Owns its rows,
// its export mirror and its own IPC subscription; renderer.js keeps only the
// `appendIpcEntry` handle it needs to log a synthetic deploy-failure line.
//
// The drawer's toggle, layout flip, terminal refit and unread counter moved to
// drawer-host.js — this module now learns about traffic (notify) and about
// becoming visible (onShow) and owns nothing else about the drawer.
//
// DOM-bound, so no unit tests per the R1 rule — move-only fidelity is the
// guarantee for the row/export half that stayed.

const { esc } = require('./lib/format');
const { MAX_EXPORT_LINES, formatIpcLine, buildExportText, exportFilename } = require('./lib/ipc-export');

function createIpcLog({ host }) {
  let ipcLogBody = null;
  let ipcEmpty = null;
  let notify = () => {};

  let ipcMessageCount = 0;
  // Plain-text mirror of the entries for Export — the DOM is display-only.
  // Capped; oldest lines drop first (the file says so when it happens).
  const exportLines = [];
  let exportDropped = 0;

  function clearIpcLog() {
    ipcLogBody.innerHTML = '';
    ipcLogBody.appendChild(ipcEmpty);
    ipcMessageCount = 0;
    exportLines.length = 0;
    exportDropped = 0;
  }

  function exportIpcLog() {
    const head = exportDropped > 0
      ? [`# ${exportDropped} older message(s) dropped (buffer keeps the last ${MAX_EXPORT_LINES})`]
      : [];
    const text = buildExportText(head.concat(exportLines));
    if (!text) return; // nothing logged yet
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(new Date());
    a.click();
    // Revoke on a delay — revoking synchronously races the download start.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function mount(pane, actions) {
    pane.innerHTML = `
      <div id="ipc-log-body">
        <div id="ipc-empty">No messages yet. Inter-agent DMs will appear here.</div>
      </div>`;
    ipcLogBody = pane.querySelector('#ipc-log-body');
    ipcEmpty = pane.querySelector('#ipc-empty');

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.id = 'ipc-export';
    exportBtn.title = 'Save log as a text file';
    exportBtn.textContent = 'Export';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'ipc-clear';
    clearBtn.title = 'Clear log';
    clearBtn.textContent = 'Clear';
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportIpcLog(); });
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearIpcLog(); });
    actions.appendChild(exportBtn);
    actions.appendChild(clearBtn);
  }

  function renderEntry(msg) {
    // Unmounted: the tab was declined by available(), so there is no pane to
    // render into. The export mirror above still records the line, and
    // peers-ui's deploy-failure call must not throw on the way past.
    if (!ipcLogBody) return;
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
  }

  function appendIpcEntry(msg) {
    exportLines.push(formatIpcLine(msg, new Date()));
    if (exportLines.length > MAX_EXPORT_LINES) {
      exportLines.shift();
      exportDropped++;
    }

    renderEntry(msg);

    // The host decides whether this counts as unread — it knows whether the
    // log tab is the visible one.
    notify('activity');
  }

  notify = host.register({
    id: 'log',
    label: 'IPC Traffic',
    available: () => true,
    mount,
    onShow() { ipcLogBody.scrollTop = ipcLogBody.scrollHeight; },
  });

  window.api.onIpcMessage((msg) => {
    appendIpcEntry(msg);
  });

  return { appendIpcEntry };
}

module.exports = { createIpcLog };
