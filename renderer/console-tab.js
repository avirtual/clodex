const { esc } = require('./lib/format');

const MAX_BLOCKS = 300;
const POLL_MS = 1200;

function createConsoleTab({ host, getActiveSession, getSeatType = null }) {
  const seats = new Map();
  let seat = null;
  let bodyEl = null;
  let emptyEl = null;
  let pollTimer = null;
  let notify = Object.assign(() => {}, { selectionChanged: () => {} });

  const typeNow = () => {
    try { return getSeatType ? getSeatType() : null; } catch { return null; }
  };

  function stateFor(name) {
    let st = seats.get(name);
    if (!st) {
      st = { cursor: '', blocks: [] };
      seats.set(name, st);
    }
    return st;
  }

  function fmtDuration(ms) {
    if (typeof ms !== 'number') return '';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60000);
    return `${m}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
  }

  function fmtBytes(n) {
    if (typeof n !== 'number') return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function blockNode(b) {
    const el = document.createElement('div');
    el.className = 'console-block' + (b.failed ? ' failed' : '');

    const marks = [];
    if (b.failed) {
      marks.push(`<span class="console-block-exit">${b.exitCode === null ? 'failed' : `exit ${esc(String(b.exitCode))}`}</span>`);
    }
    if (b.interrupted) marks.push('<span class="console-block-mark">interrupted</span>');
    if (b.timedOut) marks.push('<span class="console-block-mark">timed out</span>');
    const dur = fmtDuration(b.durationMs);
    if (dur) marks.push(`<span class="console-block-time">${esc(dur)}</span>`);

    const head = '<div class="console-block-head">'
      + `<span class="console-block-cmd">${esc(b.command)}</span>`
      + marks.join('')
      + '</div>';

    const out = String(b.output || '').replace(/\n+$/, '');
    const body = out ? `<pre class="console-block-out">${esc(out)}</pre>` : '';
    const note = b.truncated
      ? `<div class="console-block-note">output truncated by the CLI at ${esc(String(out.length))} chars`
        + `${b.fullBytes ? ` — the full result was ${esc(fmtBytes(b.fullBytes))}` : ''}</div>`
      : '';
    el.innerHTML = head + body + note;
    return el;
  }

  function pushBlock(st, b) {
    st.blocks.push(b);
    while (st.blocks.length > MAX_BLOCKS) st.blocks.shift();
  }

  function renderAll() {
    if (!bodyEl) return;
    const st = seat ? stateFor(seat) : null;
    bodyEl.innerHTML = '';
    if (!st || !st.blocks.length) {
      emptyEl.textContent = seat
        ? `No Bash calls seen yet for ${seat}.`
        : 'Select an agent session to see its Bash calls.';
      bodyEl.appendChild(emptyEl);
      return;
    }
    for (const b of st.blocks) bodyEl.appendChild(blockNode(b));
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendNew(st, records) {
    const nearBottom = bodyEl
      && bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
    if (emptyEl && emptyEl.parentNode === bodyEl) emptyEl.remove();
    for (const b of records) {
      pushBlock(st, b);
      if (bodyEl) bodyEl.appendChild(blockNode(b));
    }
    while (bodyEl && bodyEl.childElementCount > st.blocks.length) {
      bodyEl.firstElementChild.remove();
    }
    if (bodyEl && nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function pull() {
    const name = seat;
    if (!name) return;
    const st = stateFor(name);
    let res = null;
    try {
      res = await window.api.consoleRead(name, st.cursor);
    } catch {
      return;
    }
    if (!res || seat !== name) return;
    if (res.reset) {
      st.blocks.length = 0;
      renderAll();
    }
    st.cursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : st.cursor;
    const records = Array.isArray(res.records) ? res.records : [];
    if (!records.length) return;
    appendNew(st, records);
    notify(records.some((r) => r.failed) ? 'attention' : 'activity');
  }

  function startPolling() {
    if (pollTimer) return false;
    pollTimer = setInterval(pull, POLL_MS);
    pull();
    return true;
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function mount(pane, actions) {
    pane.innerHTML = '<div id="console-body"><div id="console-empty"></div></div>';
    bodyEl = pane.querySelector('#console-body');
    emptyEl = pane.querySelector('#console-empty');

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'console-clear';
    clearBtn.title = 'Clear this seat’s console view';
    clearBtn.setAttribute('aria-label', 'Clear this seat’s console view');
    clearBtn.textContent = '⌫';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!seat) return;
      stateFor(seat).blocks.length = 0;
      renderAll();
    });
    actions.appendChild(clearBtn);
  }

  function onShow() {
    const next = getActiveSession ? getActiveSession() : null;
    const switched = next !== seat;
    if (switched) {
      seat = next;
      renderAll();
    }
    const started = startPolling();
    if (switched && !started) pull();
  }

  function onHide() {
    stopPolling();
  }

  notify = host.register({
    id: 'console',
    label: 'Console',
    availableFor: () => typeNow() === 'claude',
    mount,
    onShow,
    onHide,
    selection: () => host.domSelection(bodyEl),
    onSeatChanged: () => onShow(),
  });

  return { open: () => host.open('console') };
}

module.exports = { createConsoleTab, MAX_BLOCKS, POLL_MS };
