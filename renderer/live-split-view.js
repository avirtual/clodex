'use strict';

const { measureSplit, initialSplitState, reduceSplit } = require('./lib/live-split');

const TRANSCRIPT_PULL_MS = 1000;

function createLiveSplitView(terminal, wrapperEl, { isEligible, pullTranscript, now = Date.now, onChange = null }) {
  const paneEl = document.createElement('pre');
  paneEl.className = 'transcript-pane';
  paneEl.hidden = true;
  wrapperEl.appendChild(paneEl);
  let state = initialSplitState();
  let wakeTimer = null;
  let available = false;
  let rev = -1;
  let lastPull = 0;
  let pulling = false;
  let disposed = false;

  function pull() {
    const t = now();
    if (pulling || t - lastPull < TRANSCRIPT_PULL_MS) return;
    pulling = true;
    lastPull = t;
    Promise.resolve(pullTranscript()).then((res) => {
      pulling = false;
      if (disposed) return;
      const was = available;
      available = !!(res && res.ok);
      if (available && res.rev !== rev) {
        rev = res.rev;
        const follow = paneEl.scrollTop + paneEl.clientHeight >= paneEl.scrollHeight - 4;
        paneEl.textContent = res.lines.join('\n');
        if (follow) paneEl.scrollTop = paneEl.scrollHeight;
      }
      if (available !== was) evaluate();
    }).catch(() => { pulling = false; });
  }

  function screenRows() {
    const buf = terminal.buffer.active;
    const rows = [];
    for (let i = 0; i < terminal.rows; i++) {
      const line = buf.getLine(buf.baseY + i);
      rows.push(line ? line.translateToString(true) : '');
    }
    return rows;
  }

  function layout() {
    const el = terminal.element;
    if (!el) return;
    const screen = el.querySelector('.xterm-screen');
    const rowPx = screen && terminal.rows ? screen.offsetHeight / terminal.rows : 0;
    if (state.mode !== 'split' || !rowPx) {
      el.style.transform = '';
      el.style.clipPath = '';
      wrapperEl.classList.remove('live-split');
      paneEl.hidden = true;
      return;
    }
    const cs = getComputedStyle(wrapperEl);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const bottom = Math.min(state.bottom, terminal.rows - 1);
    const stripPx = (bottom - state.top + 1) * rowPx;
    const stripTop = wrapperEl.clientHeight - padBottom - stripPx;
    const rowInEl = screen.offsetTop + state.top * rowPx;
    const endInEl = screen.offsetTop + (bottom + 1) * rowPx;
    el.style.transform = `translateY(${Math.round(stripTop - el.offsetTop - rowInEl)}px)`;
    el.style.clipPath = `inset(${rowInEl}px 0 ${Math.max(0, el.offsetHeight - endInEl)}px 0)`;
    wrapperEl.classList.add('live-split');
    paneEl.style.height = `${Math.max(0, Math.round(stripTop - padTop))}px`;
    paneEl.hidden = false;
  }

  function evaluate() {
    if (disposed) return;
    clearTimeout(wakeTimer);
    wakeTimer = null;
    let measured = null;
    if (isEligible()) {
      pull();
      const buf = terminal.buffer.active;
      if (available && buf.type === 'normal') measured = measureSplit(screenRows(), buf.cursorY, terminal.cols);
    }
    const prev = state;
    state = reduceSplit(state, measured, now());
    if (state.wakeAt != null) wakeTimer = setTimeout(evaluate, Math.max(0, state.wakeAt - now()));
    if (prev.mode !== state.mode || prev.top !== state.top || prev.bottom !== state.bottom) {
      layout();
      if (onChange) onChange(state);
    }
  }

  const subs = [
    terminal.onWriteParsed(evaluate),
    terminal.onResize(() => { evaluate(); layout(); }),
    terminal.onScroll(() => {
      if (state.mode !== 'split') return;
      const buf = terminal.buffer.active;
      if (buf.viewportY !== buf.baseY) terminal.scrollToBottom();
    }),
  ];
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  if (ro) ro.observe(wrapperEl);
  paneEl.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) terminal.focus();
  });

  return {
    refresh() { evaluate(); layout(); },
    state: () => state,
    dispose() {
      disposed = true;
      clearTimeout(wakeTimer);
      for (const d of subs) { try { d.dispose(); } catch {} }
      if (ro) ro.disconnect();
      paneEl.remove();
    },
  };
}

module.exports = { TRANSCRIPT_PULL_MS, createLiveSplitView };
