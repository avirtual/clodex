'use strict';

const { SPLIT_SETTLE_MS, SPLIT_EXIT_MS, measureSplit, sheetBand, initialSplitState, reduceSplit } = require('./lib/live-split');
const { createTranscriptRows } = require('./transcript-rows');
const { spinnerText } = require('./lib/working-row');
const { readMenuRows } = require('./lib/menu-rows');
const { rowCells } = require('./lib/menu-cells');
const { createPaintDelta, mergeByTs, isBusyScreen, blockText } = require('./lib/paint-delta');
const { readStatusRows } = require('./lib/status-rows');

const TRANSCRIPT_PULL_MS = 1000;
const PAINT_TAG_MS = 10000;
const PAINT_PLATFORMS = new Set(['codex', 'muse']);
const views = new WeakMap();
const NOOP = () => {};
const MD_KEY = 'clodex-transcript-md';
const MD_TITLE = 'Render the agent\'s markdown (tables, bold, links) — off shows the raw text';
const mdPanes = new Set();
const mdButtons = new WeakMap();
const mdGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry((ref) => mdPanes.delete(ref)) : null;

function markdownOn() {
  try { return localStorage.getItem(MD_KEY) !== '0'; } catch { return true; }
}

function setMarkdownPref(on) {
  try { localStorage.setItem(MD_KEY, on ? '1' : '0'); } catch {}
  for (const ref of [...mdPanes]) {
    const paneEl = ref.deref();
    if (!paneEl) { mdPanes.delete(ref); continue; }
    mdButtons.get(paneEl).setAttribute('aria-pressed', on ? 'true' : 'false');
    const rows = views.get(paneEl);
    if (rows) rows.setMarkdown(on);
  }
}

function transcriptRowsFor(doc, paneEl, ctx = {}) {
  let rows = views.get(paneEl);
  if (!rows) {
    rows = createTranscriptRows(doc, paneEl, { ...ctx, markdown: markdownOn() });
    views.set(paneEl, rows);
  }
  return rows;
}

function renderTranscript(doc, paneEl, records, ctx = {}, source = null) {
  transcriptRowsFor(doc, paneEl, ctx).render(records, source);
}

const TRANSCRIPT_MODES = [
  ['conversation', 'Conversation', 'Your messages and the agent\'s replies. Machine traffic folds to one line.'],
  ['internals', 'Internals', 'Everything the seat did: tool calls, deliveries from Clodex and other seats, runtime notices.'],
];

const TERMINAL_TITLE = 'Show the CLI\'s own screen (⌘⇧T)';
const HELP_TITLE = 'Clodex at a glance';

function barButton(doc, className, text, title, onClick) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function modeBar(doc, paneEl, mode, onMode = NOOP, { onHelp = null, onTerminal = null } = {}) {
  const bar = doc.createElement('div');
  bar.className = 'transcript-bar';
  const chips = doc.createElement('div');
  chips.className = 'transcript-bar-chips';
  const views = doc.createElement('div');
  views.className = 'transcript-bar-views';
  const control = doc.createElement('div');
  control.className = 'transcript-mode';
  let current = null;
  let rawOn = false;
  const buttons = TRANSCRIPT_MODES.map(([value, label, title]) => {
    const btn = barButton(doc, 'transcript-mode-btn', label, title, () => {
      if (current === value && !rawOn) return;
      setMode(value);
      onMode(value);
    });
    control.appendChild(btn);
    return btn;
  });
  const mdBtn = barButton(doc, 'transcript-mode-btn transcript-md-btn', 'md', MD_TITLE, () => setMarkdownPref(mdBtn.getAttribute('aria-pressed') !== 'true'));
  mdBtn.setAttribute('aria-pressed', markdownOn() ? 'true' : 'false');
  const ref = new WeakRef(paneEl);
  mdButtons.set(paneEl, mdBtn);
  mdPanes.add(ref);
  if (mdGone) mdGone.register(paneEl, ref);
  views.appendChild(control);
  views.appendChild(mdBtn);
  const help = onHelp ? barButton(doc, 'transcript-help-btn', '?', HELP_TITLE, () => onHelp()) : null;
  if (help) views.appendChild(help);
  const terminalBtn = onTerminal ? barButton(doc, 'transcript-mode-btn transcript-terminal-btn', 'Screen', TERMINAL_TITLE, () => onTerminal()) : null;
  if (terminalBtn) views.appendChild(terminalBtn);
  function paint() {
    TRANSCRIPT_MODES.forEach(([value], i) => buttons[i].setAttribute('aria-pressed', !rawOn && value === current ? 'true' : 'false'));
    if (terminalBtn) terminalBtn.setAttribute('aria-pressed', rawOn ? 'true' : 'false');
  }
  function setMode(next) {
    current = next === 'conversation' ? 'conversation' : 'internals';
    paint();
  }
  function setRaw(on) {
    rawOn = !!on;
    paint();
  }
  setMode(mode);
  bar.appendChild(chips);
  bar.appendChild(views);
  paneEl.insertBefore(bar, paneEl.firstChild);
  return { bar, chips, control, buttons, help, terminal: terminalBtn, markdown: mdBtn, setMode, setRaw };
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

const MODE_TEXT = { bypass: 'Bypass', 'accept-edits': 'Accept edits', auto: 'Auto', plan: 'Plan', manual: 'Manual' };
const MODE_TONE = { bypass: 'danger', 'accept-edits': 'warn', auto: 'warn', plan: 'info' };
const MODE_TITLES = {
  claude: 'Permission mode — click to cycle (shift+tab in the terminal)',
  codex: 'Collaboration mode — click to toggle Plan (shift+tab in the terminal)',
  muse: 'Approval posture (set at launch)',
};
const POSTURE_TEXT = { bypass: 'Bypass', 'read-only': 'Read-only' };
const POSTURE_TONE = { bypass: 'danger', 'read-only': 'info' };

function statusChip(doc, kind, text, tone, title, onChip) {
  const el = doc.createElement(onChip ? 'button' : 'span');
  if (onChip) {
    el.type = 'button';
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', () => onChip(kind));
  }
  el.className = 'seat-status-chip';
  el.dataset.chip = kind;
  el.dataset.tone = tone;
  el.title = title;
  el.textContent = text;
  return el;
}

function renderStatusChips(doc, el, read, effort, onChip = NOOP, platform = 'claude', posture = null) {
  const chips = [];
  const mode = read && read.mode;
  if (mode) {
    const known = Object.hasOwn(MODE_TEXT, mode.key);
    const family = !mode.cycles ? 'muse' : platform === 'codex' ? 'codex' : 'claude';
    const folded = family === 'codex' && Object.hasOwn(POSTURE_TEXT, posture) ? posture : null;
    const modeText = known ? MODE_TEXT[mode.key] : String(mode.label || '');
    const text = !folded ? modeText : mode.key === 'plan' ? `${POSTURE_TEXT[folded]} · ${modeText}` : POSTURE_TEXT[folded];
    const tone = folded ? POSTURE_TONE[folded] : Object.hasOwn(MODE_TONE, mode.key) ? MODE_TONE[mode.key] : 'muted';
    const title = folded ? `Approvals: ${POSTURE_TEXT[folded]}, set at launch. ${MODE_TITLES.codex}` : MODE_TITLES[family];
    chips.push(statusChip(doc, 'mode', text, tone, title, family === 'muse' ? null : onChip));
  }
  if (read && read.tasks) chips.push(statusChip(doc, 'tasks', String(read.tasks), 'muted', 'Background work in this seat', null));
  if (read && Number.isInteger(read.warnings)) chips.push(statusChip(doc, 'warnings', `⚠ ${read.warnings}`, 'warn', 'Codex startup warnings — click to view', onChip));
  if (typeof effort === 'string' && effort.trim() && effort.trim() !== 'default') chips.push(statusChip(doc, 'effort', effort.trim(), 'neutral', 'Effort level for this seat', null));
  el.replaceChildren(...chips);
}

function createLiveSplitView(terminal, wrapperEl, { isEligible, platform = () => 'claude', pullTranscript, now = Date.now, onChange = null, seatName = null, onTranscriptChanged = null, resolveFile = NOOP, peekFile = NOOP, openFilePeek = NOOP, openExternal = NOOP, toast = NOOP, echoPalette = null, composerEl = null, sheet = false, menuMirror = null, statusChips = null, mode = () => 'internals', onMode = NOOP, onHelp = null, onTerminal = null, onInset = NOOP }) {
  const paneEl = document.createElement('div');
  paneEl.className = 'transcript-pane';
  paneEl.hidden = true;
  wrapperEl.appendChild(paneEl);
  const toggle = modeBar(document, paneEl, mode(), (next) => {
    transcriptRowsFor(document, paneEl, rowsCtx).setMode(next);
    if (raw) setRawView(false);
    onMode(next);
  }, { onHelp, onTerminal: onTerminal || (() => setRawView(!raw)) });
  const menuEl = menuMirror ? document.createElement('div') : null;
  if (menuEl) {
    menuEl.className = 'seat-slash-menu seat-slash-menu-pty';
    menuEl.hidden = true;
    wrapperEl.appendChild(menuEl);
  }
  const statusEl = statusChips ? toggle.chips : null;
  if (statusEl) statusEl.hidden = true;
  let heldRead = null;
  let statusKey = null;
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
  let layouts = 0;
  let sheetRows = 0;
  let sheetRange = null;
  const composerVisible = () => !!composerEl && !composerEl.hidden;
  const dockPx = () => composerEl.offsetHeight || 0;
  const delta = createPaintDelta();
  let fileRecords = [];
  let fileSource = null;
  const extraRecords = [];
  let paintSeq = 0;
  let paintRows = [];
  let paintTimer = null;
  let sent = null;
  let tag = null;
  let fileHead = null;
  const bandKey = (b) => (b ? `${b.top}:${b.bottom}` : '');
  const rowsCtx = { seatName, resolveFile, peekFile, openFilePeek, openExternal, toast, echoPalette, now, lead: toggle.bar, mode: mode() };
  let turnRunning = false;
  let working = null;

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
    Promise.resolve(pullTranscript(rev)).then((res) => {
      pulling = false;
      if (disposed) return;
      const was = available;
      available = !!(res && res.ok);
      if (available && res.rev !== rev) {
        rev = res.rev;
        fileRecords = Array.isArray(res.records) ? res.records : [];
        fileSource = res.source == null ? null : res.source;
        paint();
        evaluate();
      } else if (available !== was) evaluate();
    }).catch(() => { pulling = false; });
  }

  const commandText = (r) => `${r.name || ''}${r.args ? ` ${r.args}` : ''}`;

  function shownExtras() {
    const first = fileRecords.find((r) => typeof r.ts === 'number');
    if (first && fileHead != null && first.ts > fileHead) for (let i = extraRecords.length - 1; i >= 0; i--) if (extraRecords[i].ts < first.ts) extraRecords.splice(i, 1);
    if (first) fileHead = first.ts;
    return extraRecords.filter((x) => x.kind !== 'command' || !fileRecords.some((f) => f.kind === 'command' && typeof f.ts === 'number' && Math.abs(f.ts - x.ts) <= PAINT_TAG_MS && commandText(f) === commandText(x)));
  }

  function paint() {
    const extras = shownExtras();
    renderTranscript(document, paneEl, extras.length ? mergeByTs(fileRecords, extras) : fileRecords, rowsCtx, fileSource);
    stickToBottom();
  }

  function latestFileText() {
    for (let i = fileRecords.length - 1; i >= 0; i--) {
      const r = fileRecords[i];
      if (r.kind === 'command') return [commandText(r), String(r.name || '')];
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
    sent = null;
    if (!text) return;
    const n = (paintSeq += 1);
    const head = tag && t - tag.at <= PAINT_TAG_MS ? tag.text.trim() : null;
    tag = null;
    const turn = `paint:${n}`;
    if (head) {
      const [name, ...args] = head.split(/\s+/u);
      extraRecords.push({ kind: 'command', name, args: args.join(' '), ts: t, id: `paint:${n}:cmd`, turn });
    }
    extraRecords.push({ kind: 'command-output', text, ts: t, id: turn, turn });
    paint();
  }

  function trackPaint(rows, measured) {
    if (!PAINT_PLATFORMS.has(platform())) return;
    if (!rows || state.mode !== 'split' || !composerVisible()) {
      delta.reset();
      tag = null;
      sent = null;
      return;
    }
    if (!measured || measured.mode !== 'split') return;
    const top = Math.min(state.top, measured.top);
    if (isBusyScreen(rows, top)) {
      delta.reset();
      dropPaint();
      return;
    }
    const fresh = delta.feed(rows.slice(0, top));
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
    if (read && composerEl) menuEl.style.bottom = `${dockPx() + 8}px`;
    renderMenuMirror(document, menuEl, read);
    return read;
  }

  function showComposer(on) {
    const el = terminal.element;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const hadTerminalFocus = !!active && active === terminal.textarea;
    const hadDockFocus = !!active && (active === composerEl || (!!statusEl && (active === statusEl || statusEl.contains(active))));
    el.style.visibility = on ? 'hidden' : '';
    composerEl.hidden = !on;
    if (statusEl) statusEl.hidden = !on;
    if (on && hadTerminalFocus) composerEl.focus();
    else if (!on && hadDockFocus) terminal.focus();
  }

  function effortNow() {
    const v = statusChips.effort ? statusChips.effort() : null;
    return typeof v === 'string' && v.trim() && v.trim() !== 'default' ? v.trim() : null;
  }

  function postureNow() {
    const v = statusChips.posture ? statusChips.posture() : null;
    return v === 'bypass' || v === 'read-only' ? v : null;
  }

  function onChip(kind) {
    if (disposed || raw || state.mode !== 'split' || !composerVisible() || (menuMirror && menuMirror.on())) return;
    if (kind === 'mode') statusChips.write('\x1b[Z');
    else if (kind === 'warnings') statusChips.write('\x1bOQ');
  }

  function reconcileStatus() {
    const effort = effortNow();
    const posture = postureNow();
    const key = JSON.stringify({ read: heldRead, effort, posture });
    if (key === statusKey) return;
    statusKey = key;
    renderStatusChips(document, statusEl, heldRead, effort, onChip, platform(), posture);
  }

  function readStatus(rows, measured) {
    if (!statusEl) return;
    const readable = !raw && state.mode === 'split' && !!measured && measured.mode === 'split' && !!rows && !(menuMirror && menuMirror.on());
    if (readable) {
      const read = readStatusRows(rows, measured.at, platform());
      if (read) heldRead = read;
    }
    reconcileStatus();
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
    layouts += 1;
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
      showRawBar(raw && isEligible());
      return;
    }
    showRawBar(false);
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
      const composerTop = wrapperEl.clientHeight - padBottom - dockPx();
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
    readStatus(rows, measured);
    if (turnRunning) showWorking(rows ? spinnerText(rows, state.top, platform()) : null);
    const busy = !menuRead && !!measured && (measured.mode === 'split' || !!measured.busy);
    trackPaint(raw ? null : rows, measured);
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

  function setRawView(on) {
    if (raw === !!on) return;
    raw = !!on;
    toggle.setRaw(raw);
    const before = layouts;
    evaluate();
    if (layouts === before) layout();
  }

  function showRawBar(on) {
    if (on) {
      paneEl.dataset.raw = '1';
      wrapperEl.classList.add('live-raw');
      paneEl.style.height = '';
      paneEl.hidden = false;
    } else {
      delete paneEl.dataset.raw;
      wrapperEl.classList.remove('live-raw');
    }
    const inset = on ? `${paneEl.offsetTop + paneEl.offsetHeight}px` : '';
    if (wrapperEl.style.paddingTop === inset) return;
    wrapperEl.style.paddingTop = inset;
    onInset();
  }

  function showWorking(text) {
    const next = text || 'Working';
    if (!working || working.text === next) return;
    working = { ...working, text: next };
    transcriptRowsFor(document, paneEl, rowsCtx).setWorking(working);
  }

  return {
    refresh() {
      const next = mode();
      toggle.setMode(next);
      transcriptRowsFor(document, paneEl, rowsCtx).setMode(next);
      evaluate();
      layout();
    },
    setTurnRunning(activity, since) {
      turnRunning = activity === 'thinking';
      working = turnRunning || activity === 'attention' ? { state: activity, since, text: turnRunning ? (working && working.text) || 'Working' : null } : null;
      transcriptRowsFor(document, paneEl, rowsCtx).setWorking(working);
      stickToBottom();
    },
    setRaw: setRawView,
    raw: () => raw,
    refreshStatus() {
      if (!disposed && statusEl) reconcileStatus();
    },
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
      const rows = views.get(paneEl);
      if (rows) rows.setWorking(null);
      paneEl.removeEventListener('scroll', onPaneScroll);
      paneEl.remove();
      if (menuEl) menuEl.remove();
      wrapperEl.style.paddingTop = '';
      wrapperEl.classList.remove('live-raw');
    },
  };
}

module.exports = { TRANSCRIPT_PULL_MS, transcriptRowsFor, renderTranscript, renderMenuMirror, renderStatusChips, modeBar, createLiveSplitView };
