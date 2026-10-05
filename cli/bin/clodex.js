#!/usr/bin/env node
'use strict';

const net = require('net');

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, DENIED: 3, NO_SOCKET: 4, TIMEOUT: 5 };
const CLIENT_TIMEOUT_MS = 500 * 1000;

const HELP = [
  'usage: clodex \'<[agent:…] intent line>\' [more words…]',
  '       clodex -            read the intent (and a multi-line body) from stdin',
  'Remaining args are joined with spaces into ONE line; use - for a multi-line body.',
  '',
  'Sends ONE Clodex intent as this seat ($CLODEX_SEAT) and prints the reply.',
  'A body is closed with [agent:end] automatically when you leave it open.',
  'Asynchronous answers (a dm reply, an exec run result) arrive in the seat\'s',
  'main conversation, not here.',
  '',
  'Available to a subagent:',
  '  [agent:dm <target>] <message>   delivered as <seat>/agent',
  '  [agent:who]                     list reachable peers',
  '  [agent:name]                    this seat\'s name',
  '  [agent:task list] [filter]      the board',
  '  [agent:exec <cmd>] {json}       only commands granted to this seat',
  '  [agent:memory recall] <query>   and [agent:memory list]',
  '  [agent:browser <sub> …]         open, read, click, type, select, key, wait,',
  '                                  download, screenshot, inspect, services — as the',
  '                                  seat, when the seat has the browser plugin; not',
  '                                  release, and never --confirm',
  '    e.g. clodex \'[agent:browser open wiki] https://en.wikipedia.org/wiki/Iceland\'',
  '    the URL follows the closing bracket, never inside it',
  'Everything else (task add/accept/…, shout, spawn, reboot, term, team, context,',
  'remind, memory remember/forget, scratch, file) is refused to a subagent.',
  '',
  'A browser wait or download answers here when it ends (up to ~8 min): give the',
  'calling tool a timeout that covers it (Claude Code\'s Bash tool defaults to 120 s).',
  '',
  'stdout: the intent\'s reply. stderr: this verb\'s own lines, each `clodex: <reason>`.',
  'exit codes: 0 ok, 1 error (the reply, or stderr `clodex: …`), 2 usage,',
  '            3 refused (stderr `clodex: …`), 4 no socket, 5 timeout',
].join('\n');

function hasEnd(text) {
  return text.split('\n').some((l) => /^\s*\[agent:end\]\s*$/.test(l));
}

function buildIntentText(argv, stdinText) {
  const text = argv.length === 1 && argv[0] === '-' ? String(stdinText || '') : argv.join(' ');
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed.trim()) return null;
  return hasEnd(trimmed) ? trimmed : `${trimmed}\n[agent:end]`;
}

function agentIdFrom(env) {
  return env.CLODEX_AGENT_ID || env.CODEX_THREAD_ID || null;
}

function exitFor(res) {
  const status = res && res.status;
  if (status === 'refused') return EXIT.DENIED;
  if (status === 'error') return EXIT.ERROR;
  if (res && res.ok) return EXIT.OK;
  const err = String((res && res.error) || '');
  if (err === 'unauthorized' || err.startsWith('not available to a subagent')) return EXIT.DENIED;
  if (err === 'timeout') return EXIT.TIMEOUT;
  return EXIT.ERROR;
}

function request({ sockPath, payload, timeoutMs = CLIENT_TIMEOUT_MS, connect = net.createConnection }) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const sock = connect(sockPath);
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} finish({ transport: 'timeout' }); }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('error', (e) => finish({ transport: 'no-socket', message: e.message }));
    sock.on('close', () => {
      const line = buf.split('\n')[0];
      try { finish({ res: JSON.parse(line) }); } catch { finish({ transport: 'bad-reply' }); }
    });
  });
}

function readStdin(stdin) {
  return new Promise((resolve) => {
    let s = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (d) => { s += d; });
    stdin.on('end', () => resolve(s));
  });
}

async function main(argv, { env = process.env, stdin = process.stdin, out = process.stdout, err = process.stderr, connect, timeoutMs } = {}) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    (argv.length ? out : err).write(HELP + '\n');
    return argv.length ? EXIT.OK : EXIT.USAGE;
  }
  const text = buildIntentText(argv, argv.length === 1 && argv[0] === '-' ? await readStdin(stdin) : '');
  if (!text) { err.write('clodex: empty intent\n' + HELP + '\n'); return EXIT.USAGE; }
  const sockPath = env.CLODEX_INTENT_SOCK;
  const cred = env.CLODEX_INTENT_CRED;
  if (!sockPath || !cred) {
    err.write('clodex: no seat channel (CLODEX_INTENT_SOCK / CLODEX_INTENT_CRED unset) — run inside a Clodex seat\n');
    return EXIT.NO_SOCKET;
  }
  const agentId = agentIdFrom(env);
  const ident = env.CLODEX_HOOK_IDENT || null;
  const payload = { cred, intent: text, ...(agentId ? { agentId } : {}), ...(ident ? { ident } : {}) };
  const r = await request({ sockPath, payload, connect, ...(timeoutMs ? { timeoutMs } : {}) });
  if (r.transport === 'no-socket') { err.write(`clodex: cannot reach ${sockPath} (${r.message})\n`); return EXIT.NO_SOCKET; }
  if (r.transport === 'timeout') { err.write('clodex: timeout\n'); return EXIT.TIMEOUT; }
  if (r.transport) { err.write('clodex: unreadable reply from the seat socket\n'); return EXIT.ERROR; }
  const code = exitFor(r.res);
  if (r.res.ok) out.write(String(r.res.reply == null ? '' : r.res.reply) + '\n');
  else err.write(`clodex: ${r.res.error || 'failed'}\n`);
  return code;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`clodex: fatal: ${(e && e.message) || e}\n`);
    process.exitCode = EXIT.ERROR;
  });
}

module.exports = { EXIT, CLIENT_TIMEOUT_MS, HELP, buildIntentText, agentIdFrom, exitFor, request, main };
