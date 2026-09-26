'use strict';

const { SPLIT_EXIT_MS, measureSplit, initialSplitState, reduceSplit } = require('./lib/live-split');
const { createTranscriptRows } = require('./transcript-rows');

const TRANSCRIPT_PULL_MS = 1000;
const views = new WeakMap();
const NOOP = () => {};

function renderTranscript(doc, paneEl, records, ctx = {}) {
  let rows = views.get(paneEl);
  if (!rows) {
    rows = createTranscriptRows(doc, paneEl, ctx);
    views.set(paneEl, rows);
  }
  rows.render(records);
}

function createLiveSplitView(terminal, wrapperEl, { isEligible, platform = () => 'claude', pullTranscript, now = Date.now, onChange = null, seatName = null, onTranscriptChanged = null, resolveFile = NOOP, openFilePeek = NOOP, openExternal = NOOP, toast = NOOP, echoPalette = null, composerEl = null, sheet = false }) {
  const paneEl = document.createElement('div');
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
  let cursorHidden = false;
  let follow = true;
  let pinnedTop = null;
  let raw = false;
  let sheetRows = 0;

  function stickToBottom() {
    if (!follow) return;
    paneEl.scrollTop = paneEl.scrollHeight;
    pinnedTop = paneEl.scrollTop;
  }

  function onPaneScroll() {
    if (follow && paneEl.scrollTop === pinnedTop) return;
    pinnedTop = null;
    follow = paneEl.scrollTop + paneEl.clientHeight >= paneEl.scrollHeight - 4;
  }
  paneEl.addEventListener('scroll', onPaneScroll);

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
        renderTranscript(document, paneEl, res.records, { seatName, resolveFile, openFilePeek, openExternal, toast, echoPalette });
        stickToBottom();
        evaluate();
      } else if (available !== was) evaluate();
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

  function showComposer(on) {
    const el = terminal.element;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const hadTerminalFocus = !!active && active === terminal.textarea;
    const hadComposerFocus = !!active && active === composerEl;
    el.style.visibility = on ? 'hidden' : '';
    composerEl.hidden = !on;
    if (on && hadTerminalFocus) composerEl.focus();
    else if (!on && hadComposerFocus) terminal.focus();
  }

  function sheetRowsOf(rows) {
    if (!sheet || !composerEl || state.mode !== 'full') return 0;
    const first = rows.findIndex((r) => /\S/u.test(r || ''));
    if (first < 0) return 0;
    return Math.min(rows.length - first, terminal.rows, Math.max(1, Math.floor(terminal.rows / 2)));
  }

  function placeStrip(el, screen, rowPx, top, bottom, padBottom) {
    const stripPx = (bottom - top + 1) * rowPx;
    const stripTop = wrapperEl.clientHeight - padBottom - stripPx;
    const rowInEl = screen.offsetTop + top * rowPx;
    const endInEl = screen.offsetTop + (bottom + 1) * rowPx;
    el.style.transform = `translateY(${Math.round(stripTop - el.offsetTop - rowInEl)}px)`;
    el.style.clipPath = `inset(${rowInEl}px 0 ${Math.max(0, el.offsetHeight - endInEl)}px 0)`;
    return stripTop;
  }

  function layout() {
    const el = terminal.element;
    if (!el) return;
    const screen = el.querySelector('.xterm-screen');
    const rowPx = screen && terminal.rows ? screen.offsetHeight / terminal.rows : 0;
    const inSheet = state.mode === 'full' && sheetRows > 0 && !!rowPx;
    if ((state.mode !== 'split' && !inSheet) || !rowPx) {
      el.style.transform = '';
      el.style.clipPath = '';
      wrapperEl.classList.remove('live-split');
      wrapperEl.classList.remove('live-sheet');
      paneEl.hidden = true;
      if (composerEl) showComposer(false);
      return;
    }
    const cs = getComputedStyle(wrapperEl);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    if (inSheet) {
      showComposer(false);
      const stripTop = placeStrip(el, screen, rowPx, terminal.rows - sheetRows, terminal.rows - 1, padBottom);
      wrapperEl.classList.remove('live-split');
      wrapperEl.classList.add('live-sheet');
      paneEl.style.height = `${Math.max(0, Math.round(stripTop - padTop))}px`;
      paneEl.hidden = false;
      stickToBottom();
      return;
    }
    wrapperEl.classList.remove('live-sheet');
    if (composerEl) {
      el.style.transform = '';
      el.style.clipPath = '';
      showComposer(true);
      const composerTop = wrapperEl.clientHeight - padBottom - composerEl.offsetHeight;
      wrapperEl.classList.add('live-split');
      paneEl.style.height = `${Math.max(0, Math.round(composerTop - padTop))}px`;
      paneEl.hidden = false;
      stickToBottom();
      return;
    }
    const stripTop = placeStrip(el, screen, rowPx, state.top, Math.min(state.bottom, terminal.rows - 1), padBottom);
    wrapperEl.classList.add('live-split');
    paneEl.style.height = `${Math.max(0, Math.round(stripTop - padTop))}px`;
    paneEl.hidden = false;
    stickToBottom();
  }

  function evaluate() {
    if (disposed) return;
    clearTimeout(wakeTimer);
    wakeTimer = null;
    let measured = null;
    let rows = null;
    if (!raw && isEligible()) {
      pull();
      const buf = terminal.buffer.active;
      if (available) {
        rows = screenRows();
        measured = measureSplit(rows, buf.cursorY, terminal.cols, platform());
      }
    }
    const prev = state;
    const prevSheet = sheetRows;
    state = reduceSplit(state, measured, now(), undefined, raw ? 0 : undefined);
    const busy = !!measured && (measured.mode === 'split' || !!measured.busy);
    sheetRows = busy ? sheetRowsOf(rows) : 0;
    if (state.wakeAt != null) wakeTimer = setTimeout(evaluate, Math.max(0, state.wakeAt - now()));
    if (prevSheet !== sheetRows && prev.mode === state.mode && prev.top === state.top && prev.bottom === state.bottom) layout();
    else if (prev.mode !== state.mode || prev.top !== state.top || prev.bottom !== state.bottom) {
      layout();
      if (onChange) onChange(state);
    }
  }

  const cursorVisibility = (hidden) => (params) => {
    if (Array.from(params || []).includes(25)) cursorHidden = hidden;
    return false;
  };
  const parser = terminal.parser;
  const subs = [
    ...(parser ? [
      parser.registerCsiHandler({ prefix: '?', final: 'l' }, cursorVisibility(true)),
      parser.registerCsiHandler({ prefix: '?', final: 'h' }, cursorVisibility(false)),
    ] : []),
    terminal.onWriteParsed(() => {
      if (!cursorHidden) evaluate();
      else if (!wakeTimer) wakeTimer = setTimeout(evaluate, SPLIT_EXIT_MS);
    }),
    terminal.onResize(() => { evaluate(); layout(); }),
    terminal.onScroll(() => {
      if (state.mode !== 'split') return;
      const buf = terminal.buffer.active;
      if (buf.viewportY !== buf.baseY) terminal.scrollToBottom();
    }),
  ];
  const unsubTranscript = onTranscriptChanged ? onTranscriptChanged((name) => {
    if (disposed || raw || name !== seatName || !isEligible()) return;
    lastPull = 0;
    pull();
  }) : null;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  if (ro) ro.observe(wrapperEl);
  if (ro && composerEl) ro.observe(composerEl);
  const composerVisible = () => !!composerEl && !composerEl.hidden;
  paneEl.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) (composerVisible() ? composerEl : terminal).focus();
  });

  return {
    refresh() { evaluate(); layout(); },
    setRaw(on) {
      if (raw === !!on) return;
      raw = !!on;
      evaluate();
    },
    raw: () => raw,
    state: () => state,
    composerVisible,
    dispose() {
      disposed = true;
      clearTimeout(wakeTimer);
      for (const d of subs) { try { d.dispose(); } catch {} }
      if (typeof unsubTranscript === 'function') unsubTranscript();
      if (ro) ro.disconnect();
      paneEl.removeEventListener('scroll', onPaneScroll);
      paneEl.remove();
    },
  };
}

module.exports = { TRANSCRIPT_PULL_MS, renderTranscript, createLiveSplitView };
