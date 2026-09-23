'use strict';

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const CLAUDE = process.env.CLAUDE_BIN || '/Users/bogdan/.local/bin/claude';
const OUT_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'cli-captures');
const SCRATCH = process.env.CAPTURE_CWD || path.join(require('os').homedir(), '.clodex', 'projects', 'wb-wrap-ui-5bc8ce0a', 'tasks', 'explore-screen-mirror', 'scratch');
const MAX_BYTES = 500 * 1024;
const ARGS = ['--allowedTools', 'Bash(ls:*)', 'Bash(wc:*)', 'Bash(seq:*)'];

const SCENARIOS = {
  a: [['prompt'], ['type', 'run seq 1 30 and tell me the last number'], ['idle', 4000]],
  b: [['prompt'], ['type', 'run seq 1 30 and tell me the last number'], ['idle', 4000],
    ['key', '\x0f'], ['idle', 2000], ['key', '\x0f'], ['idle', 2000]],
  c: [['prompt'], ['key', '/'], ['idle', 2000], ['key', '\x1b'], ['idle', 2000]],
  d: [['prompt'], ['type', '/help'], ['idle', 2500], ['key', '\x1b'], ['idle', 2000]],
  e: [['prompt'], ['type', 'run ls, then wc -l on package.json, then seq 1 5'], ['idle', 5000]],
  f: [['prompt'], ['type', 'run seq 1 30 and tell me the last number'], ['idle', 4000],
    ['resize', 120, 60], ['idle', 2500], ['type', 'now run seq 1 3'], ['idle', 4000]],
  g: [['prompt'], ['type', 'run seq 1 30, then write the numbers 1 to 40 in your reply, one per line, nothing else'], ['idle', 4000],
    ['type', 'run seq 1 20 and tell me the last number'], ['idle', 4000],
    ['key', '\x0f'], ['idle', 2000], ['key', '\x0f'], ['idle', 2000]],
};

const NAMES = { a: 'a-seq-truncated', b: 'b-ctrl-o-expand', c: 'c-slash-menu', d: 'd-help', e: 'e-three-tools', f: 'f-resize-40-to-60', g: 'g-overflow-ctrl-o' };

function screenText(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.baseY + i);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows.join('\n');
}

const SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  for (const k of SESSION_VARS) delete env[k];
  return env;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run(spec) {
  const [key, rowsArg] = spec.split('@');
  const replies = process.env.CAPTURE_REPLIES === '1';
  const name = NAMES[key] + (rowsArg ? '-rows' + rowsArg : '') + (replies ? '-replies' : '');
  fs.mkdirSync(SCRATCH, { recursive: true });
  if (!fs.existsSync(path.join(SCRATCH, 'package.json'))) {
    fs.writeFileSync(path.join(SCRATCH, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0', private: true }, null, 2) + '\n');
  }
  let cols = 120; let rows = rowsArg ? +rowsArg : 40;
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const t0 = Date.now();
  const chunks = [];
  let total = 0;
  let last = Date.now();
  let truncated = false;
  const proc = pty.spawn(CLAUDE, ARGS, { name: 'xterm-256color', cols, rows, cwd: SCRATCH, env: childEnv() });
  proc.onData((d) => {
    last = Date.now();
    term.write(d);
    const b = Buffer.from(d, 'utf8');
    if (total + b.length > MAX_BYTES) { truncated = true; return; }
    total += b.length;
    chunks.push({ t: Date.now() - t0, bytes: b.toString('base64') });
  });
  let exited = false;
  proc.onExit(() => { exited = true; });
  if (replies) term.onData((d) => { if (!exited) proc.write(d); });
  const log = [];
  const mark = (what) => { log.push({ t: Date.now() - t0, step: what }); chunks.push({ t: Date.now() - t0, mark: what }); };
  mark('spawn:' + cols + 'x' + rows);

  async function waitQuiet(ms, max) {
    const deadline = Date.now() + max;
    while (Date.now() < deadline && !exited) {
      await sleep(200);
      if (Date.now() - last >= ms) return true;
    }
    return false;
  }

  for (const step of SCENARIOS[key]) {
    if (exited) break;
    const [op, a1, a2] = step;
    if (op === 'prompt') {
      const deadline = Date.now() + 60000;
      let ok = false;
      while (Date.now() < deadline && !exited) {
        await sleep(300);
        const s = screenText(term);
        if (/Yes, I trust this folder/.test(s) && Date.now() - last > 800) { mark('accept-trust'); proc.write('\x1b[B'); await sleep(300); proc.write('\r'); last = Date.now(); await sleep(1500); continue; }
        if (/Try the new fullscreen renderer/.test(s) && Date.now() - last > 800) { mark('dismiss-fullscreen-offer'); proc.write('\x1b'); last = Date.now(); await sleep(1500); continue; }
        if (s.includes('❯') && Date.now() - last > 1500) { ok = true; break; }
      }
      mark(ok ? 'prompt-ready' : 'prompt-timeout');
      if (!ok) break;
    } else if (op === 'type') {
      mark('type:' + a1);
      proc.write(a1);
      await sleep(400);
      proc.write('\r');
    } else if (op === 'key') {
      mark('key:' + JSON.stringify(a1));
      proc.write(a1);
    } else if (op === 'idle') {
      const ok = await waitQuiet(a1, 180000);
      mark(ok ? 'idle' : 'idle-timeout');
    } else if (op === 'resize') {
      cols = a1; rows = a2;
      mark('resize:' + a1 + 'x' + a2);
      proc.resize(a1, a2);
      term.resize(a1, a2);
    }
  }
  mark('sigterm');
  try { proc.kill('SIGTERM'); } catch {}
  await sleep(1000);
  const raw = Buffer.concat(chunks.filter((c) => c.bytes).map((c) => Buffer.from(c.bytes, 'base64')));
  fs.writeFileSync(path.join(OUT_DIR, name + '.raw'), raw);
  fs.writeFileSync(path.join(OUT_DIR, name + '.events.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, name + '.screen.txt'), screenText(term) + '\n');
  process.stdout.write(`${name}: ${raw.length} bytes, ${chunks.length} events${truncated ? ' (truncated)' : ''}\n` + log.map((l) => `  ${l.t}ms ${l.step}`).join('\n') + '\n');
}

(async () => {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
  for (const k of keys) await run(k);
  process.exit(0);
})();
