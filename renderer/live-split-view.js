'use strict';

const { SPLIT_SETTLE_MS, SPLIT_EXIT_MS, measureSplit, sheetBand, initialSplitState, reduceSplit } = require('./lib/live-split');
const { createTranscriptRows } = require('./transcript-rows');
const { readMenuRows } = require('./lib/menu-rows');
const { rowCells } = require('./lib/menu-cells');
const { createPaintDelta, mergeByTs, isBusyScreen, blockText } = require('./lib/paint-delta');

const TRANSCRIPT_PULL_MS = 1000;
const PAINT_TAG_MS = 10000;
const PAINT_PLATFORMS = new Set(['codex', 'muse']);
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

function markedText(doc, text, spans) {
  const frag = [];
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at || s.end <= s.start) continue;
    if (s.start > at) frag.push(doc.createTextNode(text.slice(at, s.start)));
    const b = doc.createElement('b');
    b.textContent = text.slice(s.start, s.end);
    frag.push(b);
    at = s.end;
  }
  if (at < text.length) frag.push(doc.createTextNode(text.slice(at)));
  return frag;
}

function renderMenuMirror(doc, el, read) {
  el.replaceChildren();
  const rows = read && Array.isArray(read.rows) ? read.rows : [];
  for (const r of rows) {
    const spans = Array.isArray(r.matchSpans) ? r.matchSpans : [];
    const row = doc.createElement('div');
    row.className = r.selected ? 'seat-slash-item active' : 'seat-slash-item';
    const name = doc.createElement('span');
    name.className = 'seat-slash-name';
    for (const n of markedText(doc, String(r.name || ''), spans.filter((s) => s.field === 'name'))) name.appendChild(n);
    row.appendChild(name);
    if (r.description) {
      const desc = doc.createElement('span');
      desc.className = 'seat-slash-desc';
      for (const n of markedText(doc, String(r.description), spans.filter((s) => s.field === 'description'))) desc.appendChild(n);
      row.appendChild(desc);
    }
    el.appendChild(row);
  }
  el.hidden = rows.length === 0;
}

function createLiveSplitView(terminal, wrapperEl, { isEligible, platform = () => 'claude', pullTranscript, now = Date.now, onChange = null, seatName = null, onTranscriptChanged = null, resolveFile = NOOP, openFilePeek = NOOP, openExternal = NOOP, toast = NOOP, echoPalette = null, composerEl = null, sheet = false, menuMirror = null }) {
  const paneEl = document.createElement('div');
  paneEl.className = 'transcript-pane';
  paneEl.hidden = true;
  wrapperEl.appendChild(paneEl);
  const menuEl = menuMirror ? document.createElement('div') : null;
  if (menuEl) {
    menuEl.className = 'seat-slash-menu seat-slash-menu-pty';
    menuEl.hidden = true;
    wrapperEl.appendChild(menuEl);
  }
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
  let sheetRange = null;
  const composerVisible = () => !!composerEl && !composerEl.hidden;
  const delta = createPaintDelta();
  let fileRecords = [];
  const extraRecords = [];
  let paintSeq = 0;
  let paintRows = [];
  let paintTimer = null;
  let sent = null;
  let tag = null;
  const bandKey = (b) => (b ? `${b.top}:${b.bottom}` : '');

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
        fileRecords = Array.isArray(res.records) ? res.records : [];
        paint();
        evaluate();
      } else if (available !== was) evaluate();
    }).catch(() => { pulling = false; });
  }

  function paint() {
    renderTranscript(document, paneEl, extraRecords.length ? mergeByTs(fileRecords, extraRecords) : fileRecords, { seatName, resolveFile, openFilePeek, openExternal, toast, echoPalette });
    stickToBottom();
  }

  function latestFileText() {
    for (let i = fileRecords.length - 1; i >= 0; i--) {
      const r = fileRecords[i];
      if (r.kind === 'command') return [`${r.name || ''}${r.args ? ` ${r.args}` : ''}`, String(r.name || '')];
      if (r.kind === 'prompt') return String(r.text || '').split('\n');
    }
    return [];
  }

  function dropPaint() {
    clearTimeout(paintTimer);
    paintTimer = null;
    paintRows = [];
  }

  function closePaint() {
    const rows = paintRows;
    dropPaint();
    if (disposed) return;
    const t = now();
    const latest = latestFileText();
    const text = blockText(rows, [...(sent ? sent.text.split('\n') : []), ...latest]);
    if (!text) return;
    const n = (paintSeq += 1);
    const head = tag && t - tag.at <= PAINT_TAG_MS ? tag.text.trim() : null;
    tag = null;
    const turn = `paint:${n}`;
    if (head && !latest.includes(head)) {
      const [name, ...args] = head.split(/\s+/u);
      extraRecords.push({ kind: 'command', name, args: args.join(' '), ts: t, id: `paint:${n}:cmd`, turn });
    }
    extraRecords.push({ kind: 'command-output', text, ts: t, id: turn, turn });
    paint();
  }

  function trackPaint(rows, measured) {
    if (!PAINT_PLATFORMS.has(platform())) return;
    if (isBusyScreen(rows)) {
      delta.reset();
      dropPaint();
      return;
    }
    if (state.mode !== 'split' || !measured || measured.mode !== 'split' || !composerVisible()) return;
    const fresh = delta.feed(rows.slice(0, Math.min(state.top, measured.top)));
    if (!fresh.length) return;
    paintRows.push(...fresh);
    clearTimeout(paintTimer);
    paintTimer = setTimeout(closePaint, SPLIT_SETTLE_MS);
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

  function screenCells() {
    const buf = terminal.buffer.active;
    const cells = [];
    for (let i = 0; i < terminal.rows; i++) cells.push(rowCells(buf.getLine(buf.baseY + i), terminal.cols));
    return cells;
  }

  function readMenu(rows) {
    if (!menuMirror) return null;
    const read = !raw && state.mode === 'split' && composerVisible() && menuMirror.on() ? readMenuRows(rows || screenRows(), screenCells(), platform()) : null;
    menuMirror.setRead(read);
    if (!read && menuEl.hidden) return null;
    if (read && composerEl) menuEl.style.bottom = `${(composerEl.offsetHeight || 0) + 8}px`;
    renderMenuMirror(document, menuEl, read);
    return read;
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
    if (!sheet || !composerEl || state.mode !== 'full') return null;
    return sheetBand(rows, Math.max(1, Math.floor(terminal.rows / 2)));
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
      const stripTop = placeStrip(el, screen, rowPx, sheetRange.top, sheetRange.bottom, padBottom);
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
    const prevSheet = sheetRange;
    state = reduceSplit(state, measured, now(), undefined, raw ? 0 : undefined);
    const menuRead = readMenu(rows);
    const busy = !menuRead && !!measured && (measured.mode === 'split' || !!measured.busy);
    if (rows && !raw) trackPaint(rows, measured);
    sheetRange = busy ? sheetRowsOf(rows) : null;
    sheetRows = sheetRange ? sheetRange.bottom - sheetRange.top + 1 : 0;
    if (state.wakeAt != null) wakeTimer = setTimeout(evaluate, Math.max(0, state.wakeAt - now()));
    if (bandKey(prevSheet) !== bandKey(sheetRange) && prev.mode === state.mode && prev.top === state.top && prev.bottom === state.bottom) layout();
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
    terminal.onResize(() => { delta.reset(); dropPaint(); evaluate(); layout(); }),
    terminal.onScroll(() => {
      if (state.mode !== 'split' && !(sheetRows > 0)) return;
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
    composerSent(text) {
      const s = String(text || '');
      sent = { text: s, at: now() };
      tag = s.trim().startsWith('/') ? sent : null;
    },
    state: () => state,
    composerVisible,
    dispose() {
      disposed = true;
      clearTimeout(wakeTimer);
      dropPaint();
      for (const d of subs) { try { d.dispose(); } catch {} }
      if (typeof unsubTranscript === 'function') unsubTranscript();
      if (ro) ro.disconnect();
      paneEl.removeEventListener('scroll', onPaneScroll);
      paneEl.remove();
      if (menuEl) menuEl.remove();
    },
  };
}

module.exports = { TRANSCRIPT_PULL_MS, renderTranscript, renderMenuMirror, createLiveSplitView };
