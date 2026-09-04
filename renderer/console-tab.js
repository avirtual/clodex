const { esc } = require('./lib/format');

const MAX_BLOCKS = 300;
const MAX_TRACKED = 600;
const POLL_MS = 500;

function createConsoleTab({ host, getActiveSession, getSeatType = null }) {
  const seats = new Map();
  let seat = null;
  let bodyEl = null;
  let emptyEl = null;
  let liveEl = null;
  let pollTimer = null;
  let pulling = false;
  let livePulling = false;
  let notify = Object.assign(() => {}, { selectionChanged: () => {} });

  const typeNow = () => {
    try { return getSeatType ? getSeatType() : null; } catch { return null; }
  };

  function stateFor(name) {
    let st = seats.get(name);
    if (!st) {
      st = {
        cursor: '', blocks: [], lastKeys: new Set(), lastSkipped: 0,
        live: [], settled: new Set(), sigs: new Map(),
      };
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
    let note = '';
    if (b.bgState === 'absent') {
      note = '<div class="console-block-note">the CLI ran this in the background — its output was never sent here, and the task file is gone</div>';
    } else if (b.bgState === 'empty') {
      note = `<div class="console-block-note">${b.bgExitSeen
        ? 'the CLI ran this in the background — its task file is there and empty, so it really printed nothing'
        : 'the CLI ran this in the background — no exit line in its task file, and nothing printed as of this read'}</div>`;
    } else if (b.bgState === 'attached') {
      note = `<div class="console-block-note">${b.bgExitSeen
        ? 'the CLI ran this in the background — output read back from its task file'
        : 'the CLI ran this in the background — no exit line in its task file, so this is the output as of this read'}`
        + `${b.tailed ? ` — the last ${esc(String(out.length))} chars of ${esc(fmtBytes(b.fullBytes))}` : ''}</div>`;
    } else if (b.truncated) {
      note = `<div class="console-block-note">output truncated by the CLI at ${esc(String(out.length))} chars`
        + `${b.fullBytes ? ` — the full result was ${esc(fmtBytes(b.fullBytes))}` : ''}</div>`;
    }
    el.innerHTML = head + body + note;
    return el;
  }

  function liveNode(r) {
    const el = document.createElement('div');
    el.className = 'console-block console-live';
    const marks = [`<span class="console-block-mark">${r.finished ? 'finishing' : 'running'}</span>`];
    const dur = fmtDuration(r.elapsedMs);
    if (dur) marks.push(`<span class="console-block-time">${esc(dur)}</span>`);
    const head = '<div class="console-block-head">'
      + `<span class="console-block-cmd">${esc(r.command)}</span>`
      + marks.join('')
      + '</div>';
    const out = String(r.output || '').replace(/\n+$/, '');
    const body = out ? `<pre class="console-block-out">${esc(out)}</pre>` : '';
    const state = r.finished ? 'finished' : 'still running';
    const note = r.resolved === false
      ? `<div class="console-block-note">${state} — its output could not be told`
        + ' apart from another command\'s, so none is shown;'
        + ' the finished record replaces this</div>'
      : `<div class="console-block-note">${state} — live preview${
        r.tailed ? `, last ${esc(String(out.length))} chars of ${esc(fmtBytes(r.bytes))}` : ''
      }; the finished record replaces this</div>`;
    el.innerHTML = head + body + note;
    return el;
  }

  function gapNode(n) {
    const el = document.createElement('div');
    el.className = 'console-gap';
    el.textContent = `… ${n} earlier call${n === 1 ? '' : 's'} not shown — the backlog outran this pane`;
    return el;
  }

  function contentSig(r) {
    return [
      r.output ? r.output.length : 0,
      typeof r.bytes === 'number' ? r.bytes : '',
      typeof r.fullBytes === 'number' ? r.fullBytes : '',
      r.exitCode === null || r.exitCode === undefined ? '' : r.exitCode,
      r.failed ? 1 : 0,
      r.bgState || '',
    ].join(':');
  }

  function repaintGrown(st, raw) {
    for (const r of raw) {
      if (!r || !r.key || !st.lastKeys.has(r.key)) continue;
      const sig = contentSig(r);
      if (st.sigs.get(r.key) === sig) continue;
      st.sigs.set(r.key, sig);
      const i = st.blocks.findIndex((b) => !b.gap && b.key === r.key);
      if (i < 0) continue;
      st.blocks[i] = r;
      const old = bodyEl && bodyEl.children[i];
      if (old) bodyEl.replaceChild(blockNode(r), old);
    }
  }

  function trim(store, cap) {
    if (store.size <= cap) return;
    for (const k of [...store.keys()].slice(0, store.size - cap)) store.delete(k);
  }

  function pushBlock(st, b) {
    st.blocks.push(b);
    while (st.blocks.length > MAX_BLOCKS) st.blocks.shift();
  }

  function renderLive() {
    if (!liveEl) return;
    const st = seat ? stateFor(seat) : null;
    liveEl.innerHTML = '';
    if (!st || !st.live.length) return;
    for (const r of st.live) liveEl.appendChild(liveNode(r));
    liveEl.scrollTop = liveEl.scrollHeight;
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
    for (const b of st.blocks) bodyEl.appendChild(b.gap ? gapNode(b.gap) : blockNode(b));
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function appendNew(st, records) {
    const nearBottom = bodyEl
      && bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 60;
    if (emptyEl && emptyEl.parentNode === bodyEl) emptyEl.remove();
    for (const b of records) {
      pushBlock(st, b);
      if (bodyEl) bodyEl.appendChild(b.gap ? gapNode(b.gap) : blockNode(b));
    }
    while (bodyEl && bodyEl.childElementCount > st.blocks.length) {
      bodyEl.firstElementChild.remove();
    }
    if (bodyEl && nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function pull() {
    const name = seat;
    if (!name || pulling) return;
    const st = stateFor(name);
    pulling = true;
    let res = null;
    try {
      res = await window.api.consoleRead(name, st.cursor);
    } catch {
      return;
    } finally {
      pulling = false;
    }
    if (!res || seat !== name) return;
    if (res.reset) {
      st.blocks.length = 0;
      st.lastKeys.clear();
      st.lastSkipped = 0;
      st.settled.clear();
      st.sigs.clear();
      renderAll();
    }
    st.cursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : st.cursor;
    const raw = Array.isArray(res.records) ? res.records : [];
    const records = raw.filter((r) => !st.lastKeys.has(r.key));
    repaintGrown(st, raw);
    if (raw.length) st.lastKeys = new Set(raw.map((r) => r.key));
    for (const r of records) st.sigs.set(r.key, contentSig(r));
    const skipped = typeof res.skipped === 'number' && res.skipped > 0 ? res.skipped : 0;
    const repeatGap = skipped <= st.lastSkipped;
    st.lastSkipped = skipped;
    for (const r of records) if (r.id) st.settled.add(r.id);
    trim(st.settled, MAX_TRACKED);
    trim(st.sigs, MAX_TRACKED);
    if (!records.length && (!skipped || repeatGap)) return;
    appendNew(st, skipped ? [{ gap: skipped }, ...records] : records);
    notify(records.some((r) => r.failed) ? 'attention' : 'activity');
  }

  async function pullLive() {
    const name = seat;
    if (!name || livePulling) return;
    const st = stateFor(name);
    livePulling = true;
    let rows = null;
    try {
      rows = await window.api.consoleLive(name);
    } catch {
      return;
    } finally {
      livePulling = false;
    }
    if (seat !== name) return;
    const next = (Array.isArray(rows) ? rows : []).filter((r) => r && !st.settled.has(r.id));
    const secs = (r) => (typeof r.elapsedMs === 'number' ? Math.floor(r.elapsedMs / 1000) : -1);
    const same = next.length === st.live.length
      && next.every((r, i) => st.live[i].id === r.id
        && st.live[i].output === r.output
        && st.live[i].finished === r.finished
        && st.live[i].resolved === r.resolved
        && secs(st.live[i]) === secs(r));
    st.live = next;
    if (!same) renderLive();
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await pull();
      await pullLive();
    } finally {
      ticking = false;
    }
  }

  function startPolling() {
    if (pollTimer) return false;
    pollTimer = setInterval(tick, POLL_MS);
    tick();
    return true;
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
    for (const st of seats.values()) st.live.length = 0;
    renderLive();
  }

  function mount(pane, actions) {
    pane.innerHTML = '<div id="console-body"><div id="console-empty"></div></div>'
      + '<div id="console-live"></div>';
    bodyEl = pane.querySelector('#console-body');
    emptyEl = pane.querySelector('#console-empty');
    liveEl = pane.querySelector('#console-live');

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'console-clear';
    clearBtn.title = 'Clear this seat’s console view';
    clearBtn.setAttribute('aria-label', 'Clear this seat’s console view');
    clearBtn.textContent = '⌫';
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!seat) return;
      const st = stateFor(seat);
      st.blocks.length = 0;
      st.live.length = 0;
      renderAll();
      renderLive();
    });
    actions.appendChild(clearBtn);
  }

  function onShow() {
    const next = getActiveSession ? getActiveSession() : null;
    const switched = next !== seat;
    if (switched) {
      seat = next;
      renderAll();
      renderLive();
    }
    const started = startPolling();
    if (switched && !started) tick();
  }

  function onHide() {
    stopPolling();
  }

  notify = host.register({
    id: 'console',
    label: 'Console',
    available: () => !window.__CLODEX_WEB__,
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
