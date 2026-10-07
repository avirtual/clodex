#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { request, CLIENT_TIMEOUT_MS } = require('./clodex.js');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const PPID_POLL_MS = 5000;
const CATALOG_POLL_MS = 2000;
const LOOP_WINDOW_MS = 60 * 1000;
const LOOP_RING = 12;
const LOOP_MAX = 3;
const COMPLETION_UNKNOWN = 'completion unknown — do not retry';
const TOOL_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const LOG_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LOG_VAL_RE = /^[a-z][a-z0-9_:.-]{0,31}$/;

class InvalidRequest extends Error {}

function readCatalog(env, fsImpl = fs) {
  if (!env.CLODEX_INTENT_SOCK) return { rev: null, tools: [] };
  try {
    const c = JSON.parse(fsImpl.readFileSync(path.join(path.dirname(env.CLODEX_INTENT_SOCK), 'mcp-tools.json'), 'utf8'));
    if (!c || c.v !== 1 || !Array.isArray(c.tools)) return { rev: null, tools: [] };
    return { rev: typeof c.rev === 'string' ? c.rev : null, tools: c.tools.filter((t) => t && typeof t.name === 'string').map(({ name, description, inputSchema, logKeys }) => ({ name, description, inputSchema, logKeys: Array.isArray(logKeys) ? logKeys.filter((k) => typeof k === 'string' && LOG_KEY_RE.test(k)).slice(0, 4) : [] })) };
  } catch { return { rev: null, tools: [] }; }
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
}

function toolResult(r) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  if (r.res && r.res.ok) return text(String(r.res.reply ?? ''));
  if (r.res && r.res.status === 'invalid') return text(`invalid: ${r.res.error}`);
  if (r.res) return text(r.res.error || 'failed');
  if (r.transport === 'timeout') return text(`${COMPLETION_UNKNOWN}: the seat did not answer within 500 s; the action may still have run — read the page before repeating it`);
  if (r.transport === 'no-socket') return text(`no seat channel: ${r.message}`);
  return text(`${COMPLETION_UNKNOWN}: unreadable reply from the seat socket`);
}

function statusOf(r) {
  if (r.res && r.res.ok) return ['ok', 'error', 'refused'].includes(r.res.status) ? r.res.status : 'error';
  if (r.res) return r.res.status === 'refused' || r.res.status === 'invalid' ? r.res.status : 'error';
  return r.transport || 'bad-reply';
}

function createServer({
  env = process.env, input = process.stdin, output = process.stdout, errOut = process.stderr,
  connect, now = Date.now, setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, timeoutMs = CLIENT_TIMEOUT_MS,
  onExit = () => {}, fsImpl = fs, catalogPollMs = CATALOG_POLL_MS,
} = {}) {
  let logFailed = false;
  let stopped = false;
  let initialized = false;
  let lastRev = readCatalog(env, fsImpl).rev;
  const fails = new Map();
  const failed = (key, text) => { const t = now(); const f = fails.get(key); const n = f && t - f.at < LOOP_WINDOW_MS ? f.n + 1 : 1; fails.set(key, { n, at: t, text }); if (fails.size > LOOP_RING) fails.delete(fails.keys().next().value); return n; };

  const send = (msg) => { if (!stopped) output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };

  const log = (name, status, ms, args) => {
    if (!env.CLODEX_INTENT_SOCK) return;
    const n = typeof name === 'string' && TOOL_RE.test(name) ? name : '-';
    const tool = n === '-' ? null : readCatalog(env, fsImpl).tools.find((t) => t.name === n);
    const own = (k) => args && typeof args === 'object' && Object.hasOwn(args, k) ? args[k] : null;
    const cols = tool ? tool.logKeys.map((k) => typeof own(k) === 'string' && LOG_VAL_RE.test(own(k)) ? own(k) : '-') : [];
    try {
      fsImpl.appendFileSync(path.join(path.dirname(env.CLODEX_INTENT_SOCK), 'mcp.log'), `${new Date(now()).toISOString()} ${[n, ...cols, status].join(' ')} ${ms}ms\n`);
    } catch (e) {
      if (!logFailed) errOut.write(`clodex-mcp: cannot write mcp.log (${e.message})\n`);
      logFailed = true;
    }
  };

  function argsOf(params) {
    if (!params || typeof params.name !== 'string') throw new InvalidRequest('tool name must be a string');
    const args = params.arguments == null ? {} : params.arguments;
    if (typeof args !== 'object' || Array.isArray(args)) throw new InvalidRequest('arguments must be an object');
    return args;
  }

  async function callTool(params) {
    const start = now();
    let args;
    try {
      args = argsOf(params);
    } catch (e) {
      if (e instanceof InvalidRequest) return { error: { code: -32602, message: e.message } };
      throw e;
    }
    const name = params.name;
    const { ident, ...sent } = args;
    const stamp = typeof ident === 'string' && ident ? ident : null;
    const key = JSON.stringify([name, canon(sent)]);
    const f = fails.get(key);
    if (f && f.n >= LOOP_MAX - 1 && now() - f.at < LOOP_WINDOW_MS) {
      fails.set(key, { ...f, n: f.n + 1, at: now() });
      log(name, 'looped', now() - start, sent);
      return { result: { content: [{ type: 'text', text: `the same call failed ${LOOP_MAX} times — stop retrying: ${f.text}` }] } };
    }
    if (!env.CLODEX_INTENT_SOCK || !env.CLODEX_INTENT_CRED) {
      return { error: { code: -32603, message: 'no seat channel (CLODEX_INTENT_SOCK / CLODEX_INTENT_CRED unset)' } };
    }
    const r = await request({
      sockPath: env.CLODEX_INTENT_SOCK,
      payload: { cred: env.CLODEX_INTENT_CRED, tool: name, args: sent, ...(stamp ? { ident: stamp } : {}) },
      timeoutMs,
      ...(connect ? { connect } : {}),
    });
    const st = statusOf(r);
    log(name, st, now() - start, sent);
    if (st === 'ok') fails.delete(key); else if (st !== 'invalid') failed(key, toolResult(r).content[0].text);
    return { result: toolResult(r) };
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return { id: msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
    }
    if (!('id' in msg)) return null;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      const asked = params && params.protocolVersion;
      initialized = true;
      return { id, result: { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'clodex', version: env.CLODEX_VERSION || '0' } } };
    }
    if (method === 'ping') return { id, result: {} };
    if (method === 'tools/list') return { id, result: { tools: readCatalog(env, fsImpl).tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } };
    if (method === 'tools/call') return { id, ...(await callTool(params)) };
    return { id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  function onLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    handle(msg).then((res) => { if (res) send(res); }, (e) => {
      errOut.write(`clodex-mcp: ${(e && e.message) || e}\n`);
      if (msg && 'id' in msg) send({ id: msg.id, error: { code: -32603, message: 'internal error' } });
    });
  }

  function pollCatalog() {
    const { rev } = readCatalog(env, fsImpl);
    if (rev !== lastRev) {
      lastRev = rev;
      if (initialized) send({ method: 'notifications/tools/list_changed' });
    }
  }

  const parent = process.ppid;
  const poll = setInterval(() => { if (process.ppid !== parent) stop(); }, PPID_POLL_MS);
  const catalogPoll = setInterval(pollCatalog, catalogPollMs);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearInterval(catalogPoll);
    onExit(0);
  }

  const rl = input ? readline.createInterface({ input, crlfDelay: Infinity }) : null;
  if (rl) {
    rl.on('line', onLine);
    rl.on('close', stop);
  }
  if (output && output.on) output.on('error', stop);

  return { handle, stop, pollCatalog };
}

if (require.main === module) {
  createServer({
    env: { ...process.env },
    onExit: (code) => { process.stdout.write('', () => process.exit(code)); },
  });
}

module.exports = { createServer, readCatalog, PROTOCOLS };
