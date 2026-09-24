'use strict';

const { SPLIT_EXIT_MS, measureSplit, initialSplitState, reduceSplit } = require('./lib/live-split');
const { ansiRuns } = require('./lib/ansi-html');
const { classifyRows } = require('./lib/intent-marks');
const { scanLinks } = require('./lib/path-scan');
const { rewriteEchoSgr } = require('./lib/prompt-echo');
const { isExternallyOpenable } = require('../external-link');

const TRANSCRIPT_PULL_MS = 1000;
const OUTPUT_LINE_CAP = 400;
const ROW_PREFIX_RE = /^(?:⏺ |❯ | {2}→ )/;
const NOOP = () => {};

function styled(doc, text, style) {
  if (!style) return doc.createTextNode(text);
  const span = doc.createElement('span');
  span.style.cssText = style;
  span.textContent = text;
  return span;
}

function linkNode(doc, span, style, ctx) {
  const a = doc.createElement('a');
  a.className = 'pane-link';
  a.href = '#';
  a.textContent = span.text;
  if (style) a.style.cssText = style;
  if (span.kind === 'path') {
    a.dataset.path = span.path;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      Promise.resolve().then(() => ctx.resolveFile(span.path))
        .catch((err) => ({ ok: false, error: String(err) }))
        .then((res) => {
          if (!res || !res.ok) {
            ctx.toast((res && res.error) || `Can't find "${span.path}"`, { kind: 'warn', duration: 4000 });
            return;
          }
          ctx.openFilePeek(ctx.seatName, res.path, 'file', span.line);
        });
    });
  } else {
    a.dataset.url = span.text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (isExternallyOpenable(span.text)) ctx.openExternal(span.text);
    });
  }
  return a;
}

function appendLinked(doc, parent, text, style, ctx) {
  for (const span of scanLinks(text)) {
    parent.appendChild(span.kind === 'text' ? styled(doc, span.text, style) : linkNode(doc, span, style, ctx));
  }
}

function appendOutput(doc, frag, text, ctx) {
  const palette = typeof ctx.echoPalette === 'function' ? ctx.echoPalette() : ctx.echoPalette;
  if (palette) {
    const { out, state } = rewriteEchoSgr(text, palette);
    text = out + state.carry;
  }
  const lines = text.split('\n');
  const more = lines.length - OUTPUT_LINE_CAP;
  for (const run of ansiRuns(more > 0 ? lines.slice(0, OUTPUT_LINE_CAP).join('\n') : text)) {
    appendLinked(doc, frag, run.text, run.style, ctx);
  }
  if (more > 0) frag.appendChild(doc.createTextNode(`\n… ${more} more lines`));
}

function appendTextRow(doc, frag, row, ctx) {
  const lines = row.split('\n');
  const prefix = (lines[0].match(ROW_PREFIX_RE) || [''])[0];
  lines[0] = lines[0].slice(prefix.length);
  const marks = new Map();
  for (const m of classifyRows(lines.map((text) => ({ text, isWrapped: false })))) {
    if (m.span) marks.set(m.start, m);
  }
  if (prefix) frag.appendChild(doc.createTextNode(prefix));
  lines.forEach((line, k) => {
    if (k) frag.appendChild(doc.createTextNode('\n'));
    const m = marks.get(k);
    if (!m) { appendLinked(doc, frag, line, '', ctx); return; }
    const end = m.span.offset + m.span.length;
    appendLinked(doc, frag, line.slice(0, m.span.offset), '', ctx);
    const mark = doc.createElement('span');
    mark.className = `intent-mark intent-mark-${m.kind}`;
    mark.textContent = line.slice(m.span.offset, end);
    frag.appendChild(mark);
    appendLinked(doc, frag, line.slice(end), '', ctx);
  });
}

function renderTranscript(doc, paneEl, rows, ctx = {}) {
  const deps = {
    seatName: null, resolveFile: NOOP, openFilePeek: NOOP, openExternal: NOOP, toast: NOOP, echoPalette: null, ...ctx,
  };
  const frag = doc.createDocumentFragment();
  rows.forEach((row, i) => {
    if (i) frag.appendChild(doc.createTextNode('\n'));
    if (typeof row === 'string') appendTextRow(doc, frag, row, deps);
    else if (row && row.kind === 'command') frag.appendChild(doc.createTextNode(`❯ ${row.name}${row.args ? ` ${row.args}` : ''}`));
    else if (row && row.kind === 'command-output') appendOutput(doc, frag, String(row.text), deps);
  });
  paneEl.replaceChildren(frag);
}

function createLiveSplitView(terminal, wrapperEl, { isEligible, pullTranscript, now = Date.now, onChange = null, seatName = null, onTranscriptChanged = null, resolveFile = NOOP, openFilePeek = NOOP, openExternal = NOOP, toast = NOOP, echoPalette = null }) {
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
  let cursorHidden = false;
  let follow = true;
  let pinnedTop = null;

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
        renderTranscript(document, paneEl, res.lines, { seatName, resolveFile, openFilePeek, openExternal, toast, echoPalette });
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
    stickToBottom();
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
    terminal.onResize(() => { evaluate(); layout(); stickToBottom(); }),
    terminal.onScroll(() => {
      if (state.mode !== 'split') return;
      const buf = terminal.buffer.active;
      if (buf.viewportY !== buf.baseY) terminal.scrollToBottom();
    }),
  ];
  const unsubTranscript = onTranscriptChanged ? onTranscriptChanged((name) => {
    if (disposed || name !== seatName || !isEligible()) return;
    lastPull = 0;
    pull();
  }) : null;
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
      if (typeof unsubTranscript === 'function') unsubTranscript();
      if (ro) ro.disconnect();
      paneEl.removeEventListener('scroll', onPaneScroll);
      paneEl.remove();
    },
  };
}

module.exports = { TRANSCRIPT_PULL_MS, OUTPUT_LINE_CAP, renderTranscript, createLiveSplitView };
