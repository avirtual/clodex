#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { request, CLIENT_TIMEOUT_MS } = require('./clodex.js');

const SUBAGENT_BROWSER_VERBS = ['open', 'read', 'click', 'type', 'select', 'key', 'scroll', 'back', 'forward', 'wait', 'download', 'screenshot', 'inspect', 'services', 'note'];
const SERVICE_PATTERN = '^[a-z][a-z0-9-]{0,31}$';
const SERVICE_RE = new RegExp(SERVICE_PATTERN);
const DEFAULT_PROTOCOL = '2025-06-18';
const PPID_POLL_MS = 5000;
const COMPLETION_UNKNOWN = 'completion unknown — do not retry';
const LIMITS = 'clodex-mcp: the browser tool cannot express a multi-line body (note and type take ONE line) or a " inside a --flag value (it is dropped)';
const ARG_KEYS = ['verb', 'service', 'bracket', 'body'];

const BROWSER_TOOL = {
  name: 'browser',
  description: [
    "Drive this seat's browser pane. Same verbs, replies and refusals as `clodex '[agent:browser …]'`.",
    'A call waits up to 500 s; a browser `wait` may take up to 30 min server-side, so a result starting `completion unknown — do not retry` means the action may still have run: read the page before repeating a click, type or download.',
    '`bracket` holds the tokens that go INSIDE the intent bracket after the service (element number, direction, --flag, --flag=value; for click/inspect --text=<text> as ONE item); `body` is the one-line text AFTER the bracket (the URL for open/download, the text for type, the option for select, the key name for key, the note text for note).',
    'A " inside a --flag value is dropped. No release, no close, no --confirm, no note --forget: those are the main agent\'s.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      verb: { type: 'string', enum: SUBAGENT_BROWSER_VERBS },
      service: { type: 'string', pattern: SERVICE_PATTERN },
      bracket: { type: 'array', items: { type: 'string' }, default: [] },
      body: { type: 'string', default: '' },
    },
    required: ['verb'],
    additionalProperties: false,
  },
};

function tok(t) {
  const m = /^(--[^=\s"]+=)([\s\S]*)$/.exec(t);
  if (!m || !/[\s"]/.test(m[2])) return t;
  return `${m[1]}"${m[2].replace(/"/g, '')}"`;
}

function toIntent({ verb, service, bracket = [], body = '' }) {
  const toks = bracket.map(tok).join(' ');
  return `[agent:browser ${verb}${service ? ' ' + service : ''}${toks ? ' ' + toks : ''}]${body ? ' ' + body : ''}\n[agent:end]`;
}

class InvalidParams extends Error {}
class InvalidRequest extends Error {}

function validate(params) {
  if (!params || params.name !== 'browser') throw new InvalidRequest(`unknown tool: ${params && params.name}`);
  const args = params.arguments == null ? {} : params.arguments;
  if (typeof args !== 'object' || Array.isArray(args)) throw new InvalidRequest('arguments must be an object');
  const extra = Object.keys(args).find((k) => !ARG_KEYS.includes(k));
  if (extra) throw new InvalidParams(`unknown argument: ${extra} (use ${ARG_KEYS.join(', ')})`);
  const { verb, service } = args;
  if (verb === 'release' || verb === 'close') throw new InvalidParams(verb === 'release' ? "release is for the seat's main agent" : 'close is for the seat\'s main agent — a subagent may ' + SUBAGENT_BROWSER_VERBS.join(', '));
  if (!SUBAGENT_BROWSER_VERBS.includes(verb)) throw new InvalidParams(`verb must be one of ${SUBAGENT_BROWSER_VERBS.join(', ')}`);
  if (service != null && (typeof service !== 'string' || !SERVICE_RE.test(service))) throw new InvalidParams(`service must match ${SERVICE_PATTERN}`);
  const bracket = args.bracket == null ? [] : args.bracket;
  if (!Array.isArray(bracket) || bracket.some((t) => typeof t !== 'string')) throw new InvalidParams('bracket must be an array of strings');
  if (bracket.some((t) => t === '' || /[[\]\n\r]/.test(t))) throw new InvalidParams('bracket tokens must be non-empty and contain no [, ], newline or carriage return');
  const body = args.body == null ? '' : args.body;
  if (typeof body !== 'string') throw new InvalidParams('body must be a string');
  if (/[\n\r]/.test(body)) throw new InvalidParams('body must be one line');
  if (body.trim().startsWith('[agent:')) throw new InvalidParams('body must not start with [agent:');
  return { verb, service: service || '', bracket, body };
}

function toolResult(r) {
  const text = (t) => ({ content: [{ type: 'text', text: t }], isError: true });
  if (r.res && r.res.ok) return { content: [{ type: 'text', text: String(r.res.reply ?? '') }], isError: r.res.status !== 'ok' };
  if (r.res) return text(r.res.error || 'failed');
  if (r.transport === 'timeout') return text(`${COMPLETION_UNKNOWN}: the seat did not answer within 500 s; the action may still have run — read the page before repeating it`);
  if (r.transport === 'no-socket') return text(`no seat channel: ${r.message}`);
  return text(`${COMPLETION_UNKNOWN}: unreadable reply from the seat socket`);
}

function statusOf(r) {
  if (r.res && r.res.ok) return ['ok', 'error', 'refused'].includes(r.res.status) ? r.res.status : 'error';
  if (r.res) return r.res.status === 'refused' ? 'refused' : 'error';
  return r.transport || 'bad-reply';
}

function createServer({
  env = process.env, input = process.stdin, output = process.stdout, errOut = process.stderr,
  connect, now = Date.now, setInterval = globalThis.setInterval, timeoutMs = CLIENT_TIMEOUT_MS,
  onExit = () => {}, fsImpl = fs,
} = {}) {
  let logFailed = false;
  let stopped = false;

  const send = (msg) => { if (!stopped) output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };

  const log = (verb, service, status, ms) => {
    if (!env.CLODEX_INTENT_SOCK) return;
    const v = SUBAGENT_BROWSER_VERBS.includes(verb) ? verb : '-';
    const s = typeof service === 'string' && SERVICE_RE.test(service) ? service.replace(/[^a-z0-9-]/g, '') : '-';
    try {
      fsImpl.appendFileSync(path.join(path.dirname(env.CLODEX_INTENT_SOCK), 'mcp.log'), `${new Date(now()).toISOString()} ${v} ${s} ${status} ${ms}ms\n`);
    } catch (e) {
      if (!logFailed) errOut.write(`clodex-mcp: cannot write mcp.log (${e.message})\n`);
      logFailed = true;
    }
  };

  async function callTool(params) {
    const start = now();
    const a = (params && params.arguments) || {};
    let args;
    try {
      args = validate(params);
    } catch (e) {
      if (e instanceof InvalidRequest) return { error: { code: -32602, message: e.message } };
      if (!(e instanceof InvalidParams)) throw e;
      if (e.message === 'body must be one line') errOut.write(LIMITS + '\n');
      log(a.verb, a.service, 'invalid', now() - start);
      return { result: { content: [{ type: 'text', text: e.message }], isError: true } };
    }
    if (!env.CLODEX_INTENT_SOCK || !env.CLODEX_INTENT_CRED) {
      return { error: { code: -32603, message: 'no seat channel (CLODEX_INTENT_SOCK / CLODEX_INTENT_CRED unset)' } };
    }
    const r = await request({
      sockPath: env.CLODEX_INTENT_SOCK,
      payload: { cred: env.CLODEX_INTENT_CRED, intent: toIntent(args) },
      timeoutMs,
      ...(connect ? { connect } : {}),
    });
    log(args.verb, args.service, statusOf(r), now() - start);
    return { result: toolResult(r) };
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return { id: msg && typeof msg === 'object' && !Array.isArray(msg) && 'id' in msg ? msg.id : null, error: { code: -32600, message: 'invalid request' } };
    }
    if (!('id' in msg)) return null;
    const { id, method, params } = msg;
    if (method === 'initialize') {
      const pv = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL;
      return { id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'clodex', version: env.CLODEX_VERSION || '0' } } };
    }
    if (method === 'ping') return { id, result: {} };
    if (method === 'tools/list') return { id, result: { tools: [BROWSER_TOOL] } };
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

  const parent = process.ppid;
  const poll = setInterval(() => { if (process.ppid !== parent) stop(); }, PPID_POLL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    onExit(0);
  }

  const rl = input ? readline.createInterface({ input, crlfDelay: Infinity }) : null;
  if (rl) {
    rl.on('line', onLine);
    rl.on('close', stop);
  }
  if (output && output.on) output.on('error', stop);

  return { handle, stop };
}

if (require.main === module) {
  createServer({
    env: { ...process.env },
    onExit: (code) => { process.stdout.write('', () => process.exit(code)); },
  });
}

module.exports = { SUBAGENT_BROWSER_VERBS, BROWSER_TOOL, toIntent, createServer };
