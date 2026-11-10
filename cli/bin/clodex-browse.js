#!/usr/bin/env node
'use strict';

const net = require('net');

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, REFUSED: 3, NO_SOCKET: 4, TIMEOUT: 5 };
const DEFAULT_SERVICE = 'web';
const CLIENT_TIMEOUT_MS = 120 * 1000;
const SERVICE_RE = /^[a-z0-9][a-z0-9:-]{0,64}$/;

function checkUrl(raw) {
  const text = String(raw || '');
  if (!text || /\s/.test(text)) return 'not a URL';
  let u;
  try { u = new URL(text); } catch { return 'not a URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `only http: and https: URLs open in the browser pane, not ${u.protocol}`;
  return null;
}

function serviceFrom(env) {
  const s = env.CLODEX_BROWSE_SERVICE;
  return s == null || s === '' ? DEFAULT_SERVICE : String(s);
}

function openIntent(service, url) {
  return `[agent:browser open ${service} --show] ${url}\n[agent:end]`;
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
      try { finish({ res: JSON.parse(buf.split('\n')[0]) }); } catch { finish({ transport: 'bad-reply' }); }
    });
  });
}

async function main(argv, { env = process.env, err = process.stderr, connect, timeoutMs } = {}) {
  const fail = (code, reason, url) => { err.write(`clodex-browse: ${reason}\n${url == null ? '' : `${url}\n`}`); return code; };
  if (argv.length !== 1) return fail(EXIT.USAGE, 'usage: clodex-browse <http(s) url>', argv.length ? argv.join(' ') : null);
  const url = argv[0];
  const bad = checkUrl(url);
  if (bad) return fail(EXIT.USAGE, bad, url);
  const service = serviceFrom(env);
  if (!SERVICE_RE.test(service)) return fail(EXIT.USAGE, `bad CLODEX_BROWSE_SERVICE: ${JSON.stringify(service)}`, url);
  const sockPath = env.CLODEX_INTENT_SOCK;
  const cred = env.CLODEX_INTENT_CRED;
  if (!sockPath || !cred) return fail(EXIT.NO_SOCKET, 'no seat channel (CLODEX_INTENT_SOCK / CLODEX_INTENT_CRED unset); open this URL yourself:', url);
  const r = await request({ sockPath, payload: { cred, intent: openIntent(service, url) }, connect, ...(timeoutMs ? { timeoutMs } : {}) });
  if (r.transport === 'no-socket') return fail(EXIT.NO_SOCKET, `cannot reach ${sockPath} (${r.message}); open this URL yourself:`, url);
  if (r.transport === 'timeout') return fail(EXIT.TIMEOUT, 'timeout; open this URL yourself:', url);
  if (r.transport) return fail(EXIT.ERROR, 'unreadable reply from the seat socket; open this URL yourself:', url);
  const res = r.res || {};
  if (res.ok && (res.status == null || res.status === 'ok')) return EXIT.OK;
  const reason = res.ok ? String(res.reply == null ? res.status : res.reply).split('\n')[0] : String(res.error || res.status || 'failed');
  return fail(res.status === 'refused' || res.error === 'unauthorized' ? EXIT.REFUSED : EXIT.ERROR, `${reason}; open this URL yourself:`, url);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`clodex-browse: fatal: ${(e && e.message) || e}\n${process.argv.slice(2).join(' ')}\n`);
    process.exitCode = EXIT.ERROR;
  });
}

module.exports = { EXIT, DEFAULT_SERVICE, CLIENT_TIMEOUT_MS, checkUrl, serviceFrom, openIntent, request, main };
