'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const CLAUDE = process.env.CLAUDE_BIN || '/Users/bogdan/.local/bin/claude';
const OUT_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'split-states');
const SCRATCH_ROOT = process.env.CAPTURE_ROOT || path.join(os.tmpdir(), 'clodex-split-capture');
const ROWS = 40;
const RUN_CAP_MS = 9 * 60 * 1000;

const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];

const SCENARIOS = {
  main: {
    args: ['--permission-mode', 'manual', '--setting-sources', 'project'],
    steps: [
      ['trust'],
      ['ready'],
      ['arm'], ['quiet', 1500], ['snap', 'idle'],
      ['arm'], ['key', '/'], ['quiet', 1500], ['snap', 'slash-menu'], ['key', '\x1b'], ['sleep', 300], ['key', '\x15'], ['quiet', 1500],
      ['arm'], ['type', '/help'], ['quiet', 2000], ['snap', 'help'], ['key', '\x1b'], ['sleep', 300], ['key', '\x15'], ['quiet', 1500],
      ['arm'], ['type', '/model'], ['quiet', 2000], ['snap', 'model'], ['key', '\x1b'], ['sleep', 300], ['key', '\x15'], ['quiet', 1500],
      ['arm'], ['type', 'Run this exact bash command and nothing else: touch perm-probe.txt'],
      ['wait', /Do you want to proceed/, 150000], ['quiet', 800], ['snap', 'permission'], ['key', '\r'], ['quiet', 4000],
    ],
  },
  rest: {
    args: ['--permission-mode', 'manual', '--setting-sources', 'project'],
    steps: [
      ['trust'], ['ready'],
      ['arm'], ['type', 'Run this exact bash command and nothing else: sleep 15'],
      ['wait', /Bash\(sleep 15\)/, 150000], ['sleep', 3000], ['snap', 'tool-running'], ['quiet', 4000],
      ['arm'], ['key', '\x0f'], ['quiet', 1500], ['snap', 'ctrl-o'], ['key', '\x0f'], ['quiet', 1500],
      ['arm'], ['type', 'Use the Edit tool to replace the word alpha with beta in edit-me.txt'],
      ['wait', /Do you want to make this edit/, 150000], ['quiet', 800], ['snap', 'edit-diff'], ['key', '\x1b'], ['quiet', 4000],
      ['arm'], ['type', 'Without using any tools, write about 600 words of plain prose on the history of canals.'],
      ['sleep', 8000], ['snap', 'thinking'], ['key', '\x1b'], ['quiet', 3000],
      ['cycle', /plan mode on/i, 'accept-edits-idle', /accept edits on/i],
      ['arm'], ['quiet', 1500], ['snap', 'plan-idle'],
      ['arm'], ['type', 'Plan how to create hello.txt containing the word hi. Keep the plan to two lines, then ask to exit plan mode.'],
      ['wait', /Would you like to proceed|ready to code|approve this plan/i, 200000], ['quiet', 800], ['snap', 'plan-approve'], ['key', '\x1b'], ['quiet', 3000],
    ],
  },
  stream: {
    args: ['--permission-mode', 'manual', '--setting-sources', 'project'],
    steps: [
      ['trust'], ['ready'],
      ['arm'], ['type', 'Without using any tools, write about 600 words of plain prose on the history of canals.'],
      ['wait', /\u276f Without using[\s\S]*\u23fa /, 150000], ['sleep', 1500], ['snap', 'streaming'], ['key', '\x1b'], ['quiet', 3000],
    ],
  },
  bypass: {
    args: ['--permission-mode', 'bypassPermissions'],
    steps: [['trust'], ['ready'], ['arm'], ['quiet', 1500], ['snap', 'bypass-idle']],
  },
  retry: {
    args: ['--permission-mode', 'manual'],
    env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
    steps: [['trust'], ['ready'], ['arm'], ['type', 'hi'], ['wait', /retry|retrying|attempt/i, 90000], ['sleep', 500], ['snap', 'api-retry']],
  },
};

function childEnv(extra) {
  const env = { ...process.env, TERM: 'xterm-256color', ...(extra || {}) };
  for (const k of SESSION_VARS) delete env[k];
  if (process.env.CAPTURE_DIRECT === '1') delete env.ANTHROPIC_BASE_URL;
  return env;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function screenRows(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows;
}

async function run(scenario, cols) {
  const spec = SCENARIOS[scenario];
  const cwd = fs.mkdtempSync(path.join(SCRATCH_ROOT, `${scenario}-${cols}-`));
  fs.writeFileSync(path.join(cwd, 'edit-me.txt'), 'alpha\n');
  const term = new Terminal({ cols, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  let upRun = 0; let maxUpRun = 0; let minLandAbs = Infinity;
  term.parser.registerCsiHandler({ final: 'A' }, (params) => {
    const n = (params && params[0]) || 1;
    upRun += n; maxUpRun = Math.max(maxUpRun, upRun);
    const b = term.buffer.active;
    minLandAbs = Math.min(minLandAbs, b.baseY + Math.max(0, b.cursorY - n));
    return false;
  });
  const resetRun = () => { upRun = 0; return false; };
  term.parser.registerCsiHandler({ final: 'B' }, resetRun);
  term.parser.registerCsiHandler({ final: 'H' }, (params) => {
    const b = term.buffer.active;
    const row = ((params && params[0]) || 1) - 1;
    minLandAbs = Math.min(minLandAbs, b.baseY + row);
    upRun = 0;
    return false;
  });
  term.onLineFeed(() => { upRun = 0; });
  let last = Date.now();
  const proc = pty.spawn(CLAUDE, spec.args, { name: 'xterm-256color', cols, rows: ROWS, cwd, env: childEnv(spec.env) });
  proc.onData((d) => { last = Date.now(); term.write(d); });
  let exited = false;
  proc.onExit(() => { exited = true; });
  const results = [];
  const log = [];
  const flush = () => new Promise((r) => term.write('', r));
  const screen = () => screenRows(term).join('\n');
  async function waitQuiet(ms, max) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline && !exited) {
      await sleep(200);
      if (Date.now() - last >= ms) return true;
    }
    return false;
  }
  async function waitFor(re, max) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline && !exited) {
      await sleep(250);
      if (re.test(screen())) return true;
    }
    return false;
  }
  async function snap(name) {
    await flush();
    const b = term.buffer.active;
    const rows = screenRows(term);
    const file = `${name}@${cols}.screen.txt`;
    fs.writeFileSync(path.join(OUT_DIR, file), rows.join('\n') + '\n');
    const reachRow = minLandAbs === Infinity ? null : minLandAbs - b.baseY;
    results.push({ file, cursorY: b.cursorY, maxUpRun, reachRow });
    log.push(`snap ${file} cursorY=${b.cursorY} up=${maxUpRun} reach=${reachRow}`);
  }
  const arm = () => { maxUpRun = 0; upRun = 0; minLandAbs = Infinity; };
  let aborted = false;
  for (const step of spec.steps) {
    if (exited) { log.push('exited'); break; }
    const [op, a1, a2, a3] = step;
    if (op === 'trust') {
      const ok = await waitFor(/trust this folder|Yes, I trust/i, 25000);
      if (ok) {
        await waitQuiet(800, 5000);
        arm();
        await snap('trust');
        proc.write('\x1b[B'); await sleep(300); proc.write('\r'); last = Date.now(); await sleep(1500);
      } else log.push('no trust dialog');
    } else if (op === 'ready') {
      const deadline = Date.now() + 60000;
      let ok = false;
      while (Date.now() < deadline && !exited) {
        await sleep(300);
        const s = screen();
        if (/Try the new fullscreen renderer/.test(s) && Date.now() - last > 800) { proc.write('\x1b'); last = Date.now(); await sleep(1500); continue; }
        if (/Bypass Permissions mode/i.test(s) && /Yes, I accept/i.test(s) && Date.now() - last > 800) {
          arm(); await snap('bypass-warning');
          proc.write('\x1b[B'); await sleep(300); proc.write('\r'); last = Date.now(); await sleep(1500); continue;
        }
        if (s.includes('❯') && Date.now() - last > 1500) { ok = true; break; }
      }
      log.push(ok ? 'ready' : 'ready-timeout');
      if (!ok) { aborted = true; break; }
    } else if (op === 'arm') arm();
    else if (op === 'quiet') await waitQuiet(a1, 240000);
    else if (op === 'sleep') await sleep(a1);
    else if (op === 'snap') await snap(a1);
    else if (op === 'type') { proc.write(a1); await sleep(400); proc.write('\r'); last = Date.now(); }
    else if (op === 'key') { proc.write(a1); last = Date.now(); }
    else if (op === 'wait') {
      const ok = await waitFor(a1, a2);
      log.push(`wait ${a1} ${ok ? 'ok' : 'TIMEOUT'}`);
      if (!ok) { await snap(`timeout-${results.length}`); aborted = true; break; }
    } else if (op === 'cycle') {
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        arm();
        proc.write('\x1b[Z'); last = Date.now();
        await waitQuiet(1200, 8000);
        const s = screen();
        if (a3.test(s)) await snap(a2);
        if (a1.test(s)) found = true;
      }
      log.push(found ? 'cycle ok' : 'cycle MISSED');
    }
  }
  try { proc.write('\x03'); await sleep(300); proc.write('\x03'); } catch {}
  await sleep(1000);
  try { proc.kill('SIGTERM'); } catch {}
  return { scenario, cols, cwd, aborted, results, log };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  const jobs = process.argv.slice(2).map((a) => { const [s, c] = a.split('@'); return [s, +c]; });
  const cap = setTimeout(() => { process.stdout.write('RUN CAP HIT\n'); process.exit(2); }, RUN_CAP_MS);
  const out = await Promise.all(jobs.map(([s, c]) => run(s, c)));
  clearTimeout(cap);
  const measFile = path.join(SCRATCH_ROOT, 'measurements.json');
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(measFile, 'utf8')); } catch {}
  const all = prev.filter((p) => !out.some((o) => o.results.some((r) => r.file === p.file))).concat(...out.map((o) => o.results));
  fs.writeFileSync(measFile, JSON.stringify(all, null, 1));
  for (const o of out) process.stdout.write(`${o.scenario}@${o.cols}${o.aborted ? ' ABORTED' : ''}\n  ${o.log.join('\n  ')}\n`);
  process.exit(0);
})();
