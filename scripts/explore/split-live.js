'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const r = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const fs = require('fs');
const os = require('os');
const { app, BrowserWindow, ipcMain } = require('electron');
const pty = require(path.join(ROOT, 'node_modules', 'node-pty'));
const { createTranscriptSpikeReader } = require(path.join(ROOT, 'transcript-spike'));

const CLAUDE = process.env.CLAUDE_BIN || '/Users/bogdan/.local/bin/claude';
const OUT = process.env.SPLIT_OUT || path.join(os.tmpdir(), 'clodex-split-live');
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROMPT = process.env.SPLIT_PROMPT
  || 'Run ls, then run wc -l notes.txt, then use the Edit tool to change alpha to beta in notes.txt, then run cat notes.txt. Keep your final reply to one line.';
const RUN_CAP_MS = 8 * 60 * 1000;
const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'ANTHROPIC_BASE_URL'];

const PAGE = `<!doctype html><html data-theme="midnight"><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${ROOT}/node_modules/@xterm/xterm/css/xterm.css">
<link rel="stylesheet" href="file://${ROOT}/renderer/styles.css">
<style>html,body{margin:0;height:100%;overflow:hidden}#tc{position:relative;width:1000px;height:720px}</style>
</head><body><div id="tc"><div class="terminal-wrapper visible"></div></div>
<script>
const { ipcRenderer } = require('electron');
const { Terminal } = require(${JSON.stringify(path.join(ROOT, 'node_modules/@xterm/xterm'))});
const { FitAddon } = require(${JSON.stringify(path.join(ROOT, 'node_modules/@xterm/addon-fit'))});
const { WebglAddon } = require(${JSON.stringify(path.join(ROOT, 'node_modules/@xterm/addon-webgl'))});
const { createLiveSplitView } = require(${JSON.stringify(path.join(ROOT, 'renderer/live-split-view.js'))});
const wrapperEl = document.querySelector('.terminal-wrapper');
const terminal = new Terminal({ fontSize: 13, fontFamily: "'SF Mono', Menlo, monospace", allowProposedApi: true, scrollback: 5000 });
const fit = new FitAddon();
terminal.loadAddon(fit);
terminal.open(wrapperEl);
let webgl = 'off';
if (${process.env.SPLIT_WEBGL !== '0'}) { try { terminal.loadAddon(new WebglAddon()); webgl = 'on'; } catch (e) { webgl = 'failed: ' + e.message; } }
fit.fit();
const view = createLiveSplitView(terminal, wrapperEl, {
  isEligible: () => true,
  pullTranscript: () => ipcRenderer.invoke('pull'),
  onChange: (st) => ipcRenderer.send('mode', { t: Date.now(), mode: st.mode, top: st.top, bottom: st.bottom }),
});
terminal.onData((d) => ipcRenderer.send('in', d));
ipcRenderer.on('pty', (_e, d) => terminal.write(d));
function rows(all) {
  const b = terminal.buffer.active;
  const out = [];
  const from = all ? 0 : b.baseY;
  const to = all ? b.length : b.baseY + terminal.rows;
  for (let i = from; i < to; i++) { const l = b.getLine(i); out.push(l ? l.translateToString(true) : ''); }
  return out;
}
ipcRenderer.on('sample', (_e, id, all) => {
  const st = view.state();
  const pane = document.querySelector('.transcript-pane');
  const el = terminal.element;
  const wr = wrapperEl.getBoundingClientRect();
  const ta = document.activeElement === terminal.textarea;
  ipcRenderer.send('sample:' + id, {
    mode: st.mode, top: st.top, bottom: st.bottom, cursorY: terminal.buffer.active.cursorY,
    bufType: terminal.buffer.active.type, viewportY: terminal.buffer.active.viewportY, baseY: terminal.buffer.active.baseY,
    rows: rows(all), paneLines: pane && !pane.hidden ? pane.textContent.split('\\n').length : 0,
    paneText: pane ? pane.textContent : '', paneHeight: pane && !pane.hidden ? pane.offsetHeight : 0,
    transform: el.style.transform, clip: el.style.clipPath, wrapper: { top: wr.top, bottom: wr.bottom, left: wr.left, height: wr.height },
    screenH: el.querySelector('.xterm-screen').offsetHeight, termRows: terminal.rows, termCols: terminal.cols, focused: ta, webgl,
  });
});
ipcRenderer.on('focus', () => terminal.focus());
ipcRenderer.on('blur', () => { terminal.blur(); document.body.focus(); });
ipcRenderer.send('ready', { cols: terminal.cols, rows: terminal.rows, webgl });
</script></body></html>`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(OUT, 'seat-'));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'alpha\ngamma\n');
  const pagePath = path.join(OUT, 'page.html');
  fs.writeFileSync(pagePath, PAGE);
  const log = [];
  const note = (what, extra) => { const e = { t: Date.now(), what, ...(extra || {}) }; log.push(e); process.stdout.write(`${new Date(e.t).toISOString().slice(11, 23)} ${what}${extra ? ' ' + JSON.stringify(extra).slice(0, 200) : ''}\n`); };
  const cap = setTimeout(() => { note('RUN CAP'); finish(2); }, RUN_CAP_MS);
  const win = new BrowserWindow({
    width: 1000, height: 720, useContentSize: true, show: process.env.SPLIT_SHOW === '1', paintWhenInitiallyHidden: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const linkPath = path.join(OUT, 'transcript.jsonl');
  const slug = fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const projDir = path.join(CONFIG_DIR, 'projects', slug);
  function relink() {
    let files = [];
    try { files = fs.readdirSync(projDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(projDir, f)); } catch {}
    if (!files.length) return false;
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    let cur = null;
    try { cur = fs.readlinkSync(linkPath); } catch {}
    if (cur !== files[0]) { try { fs.unlinkSync(linkPath); } catch {} fs.symlinkSync(files[0], linkPath); }
    return true;
  }
  try { fs.unlinkSync(linkPath); } catch {}
  const reader = createTranscriptSpikeReader({ linkPathFor: () => linkPath });
  let lastPull = null;
  ipcMain.handle('pull', () => { relink(); lastPull = reader.pull('seat'); return lastPull; });
  const modes = [];
  ipcMain.on('mode', (_e, m) => { modes.push(m); note('mode', m); });
  const typed = [];
  const received = [];
  let proc = null;
  let lastOut = Date.now();
  ipcMain.on('in', (_e, d) => { received.push(d); if (proc) proc.write(d); });
  let sampleSeq = 0;
  function sample(all) {
    const id = ++sampleSeq;
    return new Promise((resolve) => { ipcMain.once('sample:' + id, (_e, s) => resolve(s)); win.webContents.send('sample', id, !!all); });
  }
  const ready = new Promise((r) => ipcMain.once('ready', (_e, info) => r(info)));
  await win.loadFile(pagePath);
  const info = await ready;
  note('renderer ready', info);
  proc = pty.spawn(CLAUDE, ['--permission-mode', 'manual', '--setting-sources', 'project'], {
    name: 'xterm-256color', cols: info.cols, rows: info.rows, cwd,
    env: Object.fromEntries(Object.entries({ ...process.env, TERM: 'xterm-256color' }).filter(([k]) => !SESSION_VARS.includes(k))),
  });
  proc.onData((d) => { lastOut = Date.now(); if (!win.isDestroyed()) win.webContents.send('pty', d); });
  proc.onExit(() => note('pty exit'));
  const shots = [];
  async function shot(name) {
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    const s = await sample(false);
    shots.push({ name, file, bytes: fs.statSync(file).size, mode: s.mode, top: s.top, bottom: s.bottom, paneHeight: s.paneHeight, transform: s.transform, clip: s.clip });
    note('shot', shots[shots.length - 1]);
    return s;
  }
  async function waitScreen(re, max) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline) {
      const s = await sample(false);
      if (re.test(s.rows.join('\n'))) return s;
      await sleep(250);
    }
    return null;
  }
  async function quiet(ms, max) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline) { await sleep(150); if (Date.now() - lastOut >= ms) return true; }
    return false;
  }
  function key(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: 'char', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  async function typeText(text) {
    for (const ch of text) {
      typed.push(ch);
      const modifiers = /[A-Z]/.test(ch) ? ['shift'] : [];
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers });
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers });
      await sleep(12);
    }
  }
  async function clickStripComposer() {
    const s = await sample(false);
    const rowPx = s.screenH / s.termRows;
    const y = s.wrapper.bottom - 4 - (s.bottom - s.top + 1) * rowPx + 1.5 * rowPx;
    const x = s.wrapper.left + 60;
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
    await sleep(200);
    const after = await sample(false);
    note('click strip composer', { x: Math.round(x), y: Math.round(y), focused: after.focused });
    return after.focused;
  }
  let exitCode = 0;
  async function finish(code) {
    exitCode = code;
    clearTimeout(cap);
    let final = null;
    try { final = await sample(true); } catch {}
    const report = { cwd, info, modes, shots, typed: typed.join(''), received: received.join(''), log, final, lastPull };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    try { proc.write('\x03'); await sleep(300); proc.write('\x03'); await sleep(500); proc.kill(); } catch {}
    app.exit(exitCode);
  }
  try {
    const trust = await waitScreen(/Yes, I trust this folder/, 30000);
    if (trust) { await quiet(800, 5000); win.webContents.send('focus'); await sleep(100); key('Down'); await sleep(250); key('Return'); note('trust accepted'); }
    if (!(await waitScreen(/❯/, 60000))) throw new Error('no composer');
    await quiet(1500, 20000);
    await sleep(600);
    await shot('01-idle');
    win.webContents.send('blur');
    await sleep(100);
    const focusedByClick = await clickStripComposer();
    if (!focusedByClick) win.webContents.send('focus');
    await typeText(PROMPT);
    await sleep(400);
    await shot('02-typed');
    key('Return');
    note('submitted');
    const turnStart = Date.now();
    let dialogs = 0;
    let lastSample = null;
    const splitHidden = [];
    while (Date.now() - turnStart < 300000) {
      await sleep(400);
      const s = await sample(false);
      lastSample = s;
      const text = s.rows.join('\n');
      if (s.mode === 'split') {
        const above = s.rows.slice(Math.max(0, s.top - 8), s.top).filter((r) => r.trim());
        splitHidden.push({ t: Date.now() - turnStart, top: s.top, bottom: s.bottom, above });
      }
      if (/Do you want to (proceed|make this edit)/.test(text) && Date.now() - lastOut > 700) {
        dialogs += 1;
        await shot(`03-dialog-${dialogs}`);
        key('Return');
        note('dialog answered', { dialogs });
        await sleep(1200);
        continue;
      }
      if (dialogs === 0 && s.mode === 'split' && /Running|Waiting/.test(text) && !shots.some((x) => x.name === '04-tool-split')) await shot('04-tool-split');
      if (/✻ \S+ for \d+s/.test(text) && Date.now() - lastOut > 4000) break;
    }
    await quiet(2000, 20000);
    await sleep(1500);
    await shot('05-done');
    win.webContents.send('blur');
    await sleep(150);
    const clickFocused = await clickStripComposer();
    const probe = 'Strip check 123';
    await typeText(probe);
    await sleep(800);
    const probeSample = await shot('06-strip-typed');
    const composerRow = probeSample.rows[probeSample.top + 1] || '';
    note('strip typing', { clickFocused, composerRow: composerRow.trim(), ok: composerRow.includes(probe) });
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'U', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'U', modifiers: ['control'] });
    await sleep(500);
    fs.writeFileSync(path.join(OUT, 'split-hidden.json'), JSON.stringify(splitHidden, null, 1));
    note('turn done', { dialogs, samples: splitHidden.length, lastMode: lastSample && lastSample.mode });
    await finish(0);
  } catch (e) {
    note('error', { message: e.message });
    await finish(1);
  }
});
