'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { rowCells } = require('../../renderer/lib/menu-cells');
const { renderClaudeStatusScript, codexStatusLineArg } = require('../../statusline');

const [variant, colsArg, rowsArg, planArg] = process.argv.slice(2);
const COLS = Number(colsArg || 100);
const ROWS = Number(rowsArg || 40);
const PLAN = (planArg || 'idle,wiggle,draft,modes,turn').split(',');
const OUT_DIR = process.env.STATUS_OUT || path.join(os.tmpdir(), 'clodex-status-states');
const CWD = process.env.STATUS_CWD || process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-status-capture-'));
const REG = path.join(TMP, 'reg');

const UI = { get: () => ({ statusline: { claude: ['model', 'context', 'cost', 'cwd'], claudeCommand: '', codex: ['context-used', 'model-name', 'project-root', 'git-branch', 'five-hour-limit', 'current-dir'] } }) };

function statusSettings(headless) {
  const suffix = headless ? '-headless' : '';
  const script = path.join(TMP, `status${suffix}.sh`);
  fs.writeFileSync(script, renderClaudeStatusScript('probe', headless, UI, REG), { mode: 0o700 });
  const settings = path.join(TMP, `settings${suffix}.json`);
  fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: script } }));
  return settings;
}

fs.mkdirSync(path.join(REG, 'run', 'probe'), { recursive: true });
const SETTINGS = statusSettings(false);
const SETTINGS_HEADLESS = statusSettings(true);

const CODEX_ARGS = ['-c', 'check_for_update_on_startup=false', '--no-alt-screen', '-c', codexStatusLineArg(UI)];
const VARIANTS = {
  claude: { bin: process.env.CLAUDE_BIN || 'claude', args: ['--settings', SETTINGS, '--permission-mode', 'default'], ready: /❯/u },
  'claude-headless': { bin: process.env.CLAUDE_BIN || 'claude', args: ['--settings', SETTINGS_HEADLESS, '--permission-mode', 'default'], ready: /❯/u },
  'claude-bypass': { bin: process.env.CLAUDE_BIN || 'claude', args: ['--settings', SETTINGS, '--dangerously-skip-permissions'], ready: /❯/u },
  codex: { bin: process.env.CODEX_BIN || 'codex', args: CODEX_ARGS, ready: /^›/mu, busy: /Starting MCP servers/u },
  'codex-yolo': { bin: process.env.CODEX_BIN || 'codex', args: [...CODEX_ARGS, '--dangerously-bypass-approvals-and-sandbox'], ready: /^›/mu, busy: /Starting MCP servers/u },
  muse: { bin: process.env.MUSE_BIN || 'muse', args: [], ready: /❯/u },
  'muse-never': { bin: process.env.MUSE_BIN || 'muse', args: ['--approval-mode', 'never', '--disable-sandbox'], ready: /❯/u },
};

const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'WB_WRAP_NAME'];
const DEFAULT_PROMPT = 'Run the shell command `sleep 6 && echo done` and then reply with just the word ok.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastNonBlank(rows) {
  let i = rows.length - 1;
  while (i > 0 && !rows[i].trim()) i--;
  return i;
}

function tail(c, n = 8) {
  const e = lastNonBlank(c.rows);
  return c.rows.slice(Math.max(0, e - n + 1), e + 1).join('\n');
}

async function run() {
  const spec = VARIANTS[variant];
  if (!spec) {
    process.stdout.write(`unknown variant ${variant}; one of ${Object.keys(VARIANTS).join(', ')}\n`);
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const k of SESSION_VARS) delete env[k];
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  const proc = pty.spawn(spec.bin, spec.args, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: CWD, env });
  let last = Date.now();
  let exited = false;
  proc.onData((d) => { last = Date.now(); term.write(d); });
  proc.onExit(() => { exited = true; });
  term.onData((d) => { if (!exited) proc.write(d); });
  const flush = () => new Promise((r) => term.write('', r));
  const cap = () => {
    const b = term.buffer.active;
    const rows = [];
    const cells = [];
    for (let i = 0; i < term.rows; i++) {
      const l = b.getLine(b.baseY + i);
      rows.push(l ? l.translateToString(true) : '');
      cells.push(rowCells(l, term.cols));
    }
    return { rows, cells, cursorY: b.cursorY, cursorX: b.cursorX, alt: b.type === 'alternate' };
  };
  const tag = `${variant}${process.env.TAG || ''}@${COLS}x${ROWS}`;
  const save = (name, c) => {
    fs.writeFileSync(path.join(OUT_DIR, `${tag}-${name}.screen.txt`), c.rows.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT_DIR, `${tag}-${name}.cells.json`), JSON.stringify({ cursorY: c.cursorY, cursorX: c.cursorX, alt: c.alt, cells: c.cells }).replace(/\],\[/g, '],\n[') + '\n');
  };
  const log = { variant, cols: COLS, rows: ROWS, events: [] };
  const watch = async (name, ms, every = 100) => {
    const seen = new Map();
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await flush();
      const c = cap();
      const k = tail(c, 10);
      if (!seen.has(k)) {
        seen.set(k, Date.now() - t0);
        save(`${name}-${String(seen.size).padStart(3, '0')}`, c);
        log.events.push({ name, i: seen.size, dt: Date.now() - t0 });
      }
      await sleep(every);
    }
    return seen.size;
  };

  const readyBy = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyBy && !exited) {
    await sleep(300);
    await flush();
    const s = cap().rows.join('\n');
    if (/trust (this|the) (contents|folder|files|directory)|Do you trust/i.test(s) && Date.now() - last > 800) {
      if (/[❯›] (\d\. )?No\b/u.test(s)) { proc.write('\x1b[B'); await sleep(300); }
      proc.write('\r');
      last = Date.now();
      await sleep(1500);
      continue;
    }
    if (spec.ready.test(s) && !(spec.busy && spec.busy.test(s)) && Date.now() - last > 2500) { ready = true; break; }
  }
  log.ready = ready;
  if (!ready) save('notready', cap());
  await sleep(1500);
  await flush();
  if (ready && PLAN.includes('idle')) save('idle', cap());
  if (ready && PLAN.includes('wiggle')) log.wiggle = await watch('wiggle', 8000, 50);
  if (ready && PLAN.includes('draft')) {
    proc.write('\x1b[200~hello there\x1b[201~');
    await sleep(800);
    await flush();
    save('draft', cap());
    proc.write('\x15');
    for (let i = 0; i < 14; i++) { proc.write('\x7f'); await sleep(20); }
    await sleep(800);
    await flush();
    save('draft-cleared', cap());
  }
  if (ready && PLAN.includes('f2')) {
    proc.write('\x1bOQ');
    await sleep(1200);
    await flush();
    save('f2', cap());
    proc.write('\x1b');
    await sleep(800);
    await flush();
    save('f2-esc', cap());
  }
  if (ready && PLAN.includes('modes')) {
    for (let i = 1; i <= 6; i++) {
      proc.write('\x1b[Z');
      await sleep(900);
      await flush();
      save(`mode-${i}`, cap());
    }
  }
  if (ready && PLAN.includes('turn')) {
    proc.write(`\x1b[200~${process.env.PROMPT || DEFAULT_PROMPT}\x1b[201~`);
    await sleep(400);
    proc.write('\r');
    log.turn = await watch('turn', 40000, 100);
    await sleep(1500);
    await flush();
    save('after-turn', cap());
    log.after = await watch('after-wiggle', 6000, 50);
  }
  try {
    for (let i = 0; i < 3; i++) { proc.write('\x03'); await sleep(300); }
  } catch {}
  await sleep(800);
  try { proc.kill('SIGTERM'); } catch {}
  fs.writeFileSync(path.join(OUT_DIR, `${tag}.log.json`), JSON.stringify(log, null, 1));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.stdout.write(`${tag} ${JSON.stringify({ ready: log.ready, wiggle: log.wiggle, turn: log.turn, after: log.after })}\n`);
  process.exit(0);
}

run().catch((e) => { fs.rmSync(TMP, { recursive: true, force: true }); throw e; });
