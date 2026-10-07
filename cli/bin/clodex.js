#!/usr/bin/env node
'use strict';

const net = require('net');
const nodeFs = require('fs');
const path = require('path');

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, DENIED: 3, NO_SOCKET: 4, TIMEOUT: 5 };
const CLIENT_TIMEOUT_MS = 500 * 1000;

const HELP_HEAD = [
  'usage: clodex \'<[agent:…] intent line>\' [more words…]',
  '       clodex -            read the intent (and a multi-line body) from stdin',
  'Remaining args are joined with spaces into ONE line; use - for a multi-line body.',
  '',
  'Sends ONE Clodex intent as this seat ($CLODEX_SEAT) and prints the reply.',
  'A body is closed with [agent:end] automatically when you leave it open.',
  'Asynchronous answers (a dm reply, an exec run result) arrive in the seat\'s',
  'main conversation, not here.',
  '',
];

const HELP_TAIL = [
  '',
  'A long-running tool call (a wait, a download) answers here when it ends (up to ~8 min): give the',
  'calling tool a timeout that covers it (Claude Code\'s Bash tool defaults to 120 s).',
  'A terminal command ([agent:term exec]) answers here with its exit code and output, up to 130 s:',
  'give Bash a 150 s timeout for a long one.',
  '',
  'stdout: the intent\'s reply. stderr: this verb\'s own lines, each `clodex: <reason>`.',
  'exit codes: 0 ok, 1 error (the reply, or stderr `clodex: …`), 2 usage,',
  '            3 refused (stderr `clodex: …`), 4 no socket, 5 timeout',
];

const HELP_DESC_MAX = 100;
const HELP_WRAP_COLS = 90;

function readCatalogTools(env, fsImpl) {
  if (!env || !env.CLODEX_INTENT_SOCK) return [];
  try {
    const c = JSON.parse(fsImpl.readFileSync(path.join(path.dirname(env.CLODEX_INTENT_SOCK), 'mcp-tools.json'), 'utf8'));
    return c && c.v === 1 && Array.isArray(c.tools) ? c.tools.filter((t) => t && typeof t.name === 'string') : [];
  } catch { return []; }
}

function wrapList(items, first, rest) {
  const lines = [];
  let cur = first;
  let fresh = true;
  items.forEach((it, i) => {
    const piece = it + (i < items.length - 1 ? ',' : '');
    if (!fresh && (cur + ' ' + piece).length > HELP_WRAP_COLS) { lines.push(cur); cur = rest + piece; } else { cur += (fresh ? '' : ' ') + piece; }
    fresh = false;
  });
  lines.push(cur);
  return lines;
}

function toolLines(t) {
  const desc = String(t.description || '').split('\n')[0].slice(0, HELP_DESC_MAX);
  const name = String(t.name || '').split('\n')[0].slice(0, 64);
  const lines = [`  ${name}  ${desc}`.replace(/\s+$/, '')];
  const props = t.inputSchema && t.inputSchema.properties;
  const en = props && props.verb && props.verb.enum;
  if (Array.isArray(en) && en.length && en.every((v) => typeof v === 'string')) lines.push(...wrapList(en, '    verbs: ', '    '));
  return lines;
}

function helpText(env, fsImpl) {
  const tools = readCatalogTools(env, fsImpl);
  const mid = tools.length
    ? [`This seat's MCP tools (name, then the first ${HELP_DESC_MAX} characters of its description):`, ...tools.flatMap(toolLines),
      '  Call a tool by its MCP name, or send the intent its description names through this verb.']
    : ['No MCP tools on this seat: the plugins that declare one are not enabled for it.'];
  return [...HELP_HEAD, ...mid, 'Everything else is refused to a subagent: return and let the seat\'s main agent do it.', ...HELP_TAIL].join('\n');
}

const HELP = helpText({}, nodeFs);

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

function resolveIdent(env, sockPath, fs, err) {
  const v = env.CLODEX_HOOK_IDENT || null;
  if (!v || !v.startsWith('@')) return v;
  const nonce = v.slice(1);
  try {
    if (!/^[0-9a-f]{16}$/.test(nonce)) throw new Error('bad nonce');
    const file = path.join(path.dirname(sockPath), 'ident', nonce);
    const stamp = fs.readFileSync(file, 'utf8').trim();
    fs.unlinkSync(file);
    if (!stamp) throw new Error('empty');
    return stamp;
  } catch {
    err.write('clodex: identity stamp missing (hook not installed?)\n');
    return null;
  }
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

async function main(argv, { env = process.env, stdin = process.stdin, out = process.stdout, err = process.stderr, connect, timeoutMs, fs = nodeFs } = {}) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    (argv.length ? out : err).write(helpText(env, fs) + '\n');
    return argv.length ? EXIT.OK : EXIT.USAGE;
  }
  const text = buildIntentText(argv, argv.length === 1 && argv[0] === '-' ? await readStdin(stdin) : '');
  if (!text) { err.write('clodex: empty intent\n' + helpText(env, fs) + '\n'); return EXIT.USAGE; }
  const sockPath = env.CLODEX_INTENT_SOCK;
  const cred = env.CLODEX_INTENT_CRED;
  if (!sockPath || !cred) {
    err.write('clodex: no seat channel (CLODEX_INTENT_SOCK / CLODEX_INTENT_CRED unset) — run inside a Clodex seat\n');
    return EXIT.NO_SOCKET;
  }
  const agentId = agentIdFrom(env);
  const ident = resolveIdent(env, sockPath, fs, err);
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

module.exports = { EXIT, CLIENT_TIMEOUT_MS, HELP, helpText, buildIntentText, agentIdFrom, resolveIdent, exitFor, request, main };
