'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { rowCells } = require('../../renderer/lib/menu-cells');

const COLS = 100;
const ROWS = 40;
const OUT_DIR = process.env.MENU_OUT || path.join(os.tmpdir(), 'clodex-menu-states');
const LOG_DIR = process.env.MENU_LOG || path.join(os.tmpdir(), 'clodex-menu-capture');
const CWD = process.env.MENU_CWD || process.cwd();
const POLL_MS = 10;
const SILENCE_MS = 100;
const SETTLE_CAP_MS = 4000;
const RUN_CAP_MS = 8 * 60 * 1000;

const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];

const MENU_ONLY = ['arrow-down', 'arrow-down-2', 'arrow-up', 'backspace', 'retype', 'escape', 'escape-backspace', 'escape-retype', 'tab'];

const PLATFORMS = {
  claude: { bin: process.env.CLAUDE_BIN || 'claude', args: [], ready: /❯/u },
  codex: { bin: process.env.CODEX_BIN || 'codex', args: ['-c', 'check_for_update_on_startup=false'], ready: /^›/mu, busy: /Starting MCP servers/u, alt: 'co', skip: MENU_ONLY },
  muse: { bin: process.env.MUSE_BIN || 'muse', args: [], ready: /[❯›>]/u, alt: 'co', skip: MENU_ONLY },
};

const BS = '\x7f';
const STEPS = [
  ['snap', 'idle'],
  ['key', '/', 'idle-slash'],
  ['key', 'c', 'one-char'],
  ['key', 'l', 'two-chars'],
  ['key', 'o', 'three-chars'],
  ['key', '\x1b[B', 'arrow-down'],
  ['key', '\x1b[B', 'arrow-down-2'],
  ['key', '\x1b[A', 'arrow-up'],
  ['key', BS, 'backspace'],
  ['key', 'o', 'retype'],
  ['key', '\x1b', 'escape'],
  ['key', BS, 'escape-backspace'],
  ['key', 'o', 'escape-retype'],
  ['key', '\t', 'tab'],
  ['clear'],
  ['key', '\x1b[200~/clo\x1b[201~', 'paste'],
  ['clear'],
  ['burst', ['/', 'c', 'l', 'o'], 'burst'],
  ['clear'],
];

function altSteps(query) {
  return [
    ['key', '/', 'alt-slash'],
    ...[...query].map((ch, i) => ['key', ch, `alt-${i + 1}`]),
    ['key', '\x1b[B', 'alt-arrow-down'],
    ['key', '\x1b[B', 'alt-arrow-down-2'],
    ['key', '\x1b[A', 'alt-arrow-up'],
    ['key', BS, 'alt-backspace'],
    ['key', query[query.length - 1], 'alt-retype'],
    ['key', '\x1b', 'alt-escape'],
    ['key', BS, 'alt-escape-backspace'],
    ['key', query[query.length - 1], 'alt-escape-retype'],
    ['key', '\t', 'alt-tab'],
    ['clear'],
    ['key', `\x1b[200~/${query}\x1b[201~`, 'alt-paste'],
    ['clear'],
  ];
}

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of SESSION_VARS) delete env[k];
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function capture(term) {
  const buf = term.buffer.active;
  const rows = [];
  const cells = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    rows.push(line ? line.translateToString(true) : '');
    cells.push(rowCells(line, term.cols));
  }
  return { rows, cells, baseY: buf.baseY, cursorX: buf.cursorX, cursorY: buf.cursorY, alt: buf.type === 'alternate' };
}

function signature(c) {
  return JSON.stringify([c.rows, c.cells, c.cursorX, c.cursorY]);
}

async function run(platform) {
  const spec = PLATFORMS[platform];
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  const proc = pty.spawn(spec.bin, spec.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: CWD, env: childEnv() });
  let last = Date.now();
  let chunks = [];
  let exited = false;
  proc.onData((d) => { last = Date.now(); chunks.push({ t: last, d }); term.write(d); });
  proc.onExit(() => { exited = true; });
  term.onData((d) => { if (!exited) proc.write(d); });
  const flush = () => new Promise((r) => term.write('', r));
  const log = { platform, steps: [] };

  const readyBy = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyBy && !exited) {
    await sleep(300);
    await flush();
    const s = capture(term).rows.join('\n');
    if (/trust (this|the) (contents|folder|files|directory)|Do you trust/i.test(s) && Date.now() - last > 800) {
      log.steps.push({ note: 'trust', screen: s });
      if (/[❯›] (\d\. )?No\b/u.test(s)) { proc.write('\x1b[B'); await sleep(300); }
      proc.write('\r'); last = Date.now(); await sleep(1500); continue;
    }
    if (spec.ready.test(s) && !(spec.busy && spec.busy.test(s)) && Date.now() - last > 2500) { ready = true; break; }
  }
  log.ready = ready;
  if (!ready) log.screen = capture(term).rows.join("\n");

  async function settle(t0, before) {
    await flush();
    let sig = before;
    let changedAt = t0;
    let changed = false;
    while (Date.now() - t0 < SETTLE_CAP_MS) {
      await sleep(POLL_MS);
      await flush();
      const s = signature(capture(term));
      if (s !== sig) { sig = s; changedAt = Date.now(); changed = true; }
      if (Date.now() - changedAt >= SILENCE_MS && (changed || Date.now() - t0 >= 1000)) break;
    }
    return { settleMs: changed ? changedAt - t0 : null, capped: Date.now() - t0 >= SETTLE_CAP_MS };
  }

  function save(name, c) {
    fs.writeFileSync(path.join(OUT_DIR, `${platform}-${name}@${COLS}.screen.txt`), c.rows.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT_DIR, `${platform}-${name}@${COLS}.cells.json`), JSON.stringify(c.cells.map((r) => r), null, 0).replace(/\],\[/g, '],\n[') + '\n');
  }

  const main = STEPS.filter((st) => !(spec.skip || []).includes(st[2] || st[1]));
  const steps = spec.alt ? main.concat(altSteps(spec.alt)) : main;
  for (const [op, a1, a2] of steps) {
    if (!ready || exited) break;
    if (op === 'snap') {
      await sleep(500);
      const c = capture(term);
      save(a1, c);
      log.steps.push({ name: a1, baseY: c.baseY, cursorX: c.cursorX, cursorY: c.cursorY, alt: c.alt });
    } else if (op === 'clear') {
      proc.write('\x05'); await sleep(100);
      for (let i = 0; i < 16; i++) { proc.write(BS); await sleep(30); }
      await sleep(800);
      const c = capture(term);
      log.steps.push({ note: 'clear', screen: c.rows.join('\n') });
    } else if (op === 'burst') {
      await flush();
      const before = signature(capture(term));
      chunks = [];
      const t0 = Date.now();
      for (const k of a1) { proc.write(k); await sleep(50); }
      const s = await settle(t0, before);
      const c = capture(term);
      save(a2, c);
      log.steps.push({ name: a2, key: a1.join(''), ...s, totalMs: Date.now() - t0, bytes: chunks.map((ch) => ({ dt: ch.t - t0, d: ch.d })), baseY: c.baseY, cursorX: c.cursorX, cursorY: c.cursorY, alt: c.alt });
    } else if (op === 'key') {
      await flush();
      const before = signature(capture(term));
      chunks = [];
      const t0 = Date.now();
      proc.write(a1);
      const s = await settle(t0, before);
      const c = capture(term);
      save(a2, c);
      const bytes = chunks.map((ch) => ({ dt: ch.t - t0, d: ch.d }));
      log.steps.push({ name: a2, key: a1, ...s, firstByteMs: bytes.length ? bytes[0].dt : null, bytes, baseY: c.baseY, cursorX: c.cursorX, cursorY: c.cursorY, alt: c.alt });
      await sleep(Math.max(0, 50 - (Date.now() - t0)));
    }
  }
  try { proc.write('\x03'); await sleep(300); proc.write('\x03'); await sleep(300); proc.write('\x03'); } catch {}
  await sleep(800);
  try { proc.kill('SIGTERM'); } catch {}
  return log;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const cap = setTimeout(() => { process.stdout.write('RUN CAP HIT\n'); process.exit(2); }, RUN_CAP_MS);
  for (const p of process.argv.slice(2)) {
    const log = await run(p);
    fs.writeFileSync(path.join(LOG_DIR, `${p}.json`), JSON.stringify(log, null, 1));
    const t = log.steps.filter((s) => s.key).map((s) => `${s.name}:${s.settleMs}${s.capped ? '!' : ''}`);
    process.stdout.write(`${p} ready=${log.ready} ${t.join(' ')}\n`);
  }
  clearTimeout(cap);
  process.exit(0);
})();
