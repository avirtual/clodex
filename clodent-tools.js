'use strict';

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { CLODENT_TOOLS } = require('./catalogs');
const { adapterFor } = require('./cli-adapters');

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_TOOLS = 64;
const LIST_TOOLS_TIMEOUT_MS = 3000;
const MAX_OUTPUT_BYTES = 256 * 1024;

function builtinTools(reason) {
  return { source: 'builtin', reason, names: CLODENT_TOOLS.slice(), tools: CLODENT_TOOLS.map((name) => ({ name, kind: null })) };
}

function parseListTools(stdout) {
  const text = String(stdout).replace(/\r?\n$/, '');
  if (!text || text.includes('\n')) return { reason: 'output is not one line' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { reason: 'unparsable output' }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { reason: 'output is not a JSON object' };
  if (doc.v !== 1) return { reason: `unsupported v ${JSON.stringify(doc.v)}` };
  if (!Array.isArray(doc.tools) || !doc.tools.length) return { reason: 'tools is not a non-empty array' };
  if (doc.tools.length > MAX_TOOLS) return { reason: `${doc.tools.length} tools, over ${MAX_TOOLS}` };
  const seen = new Set();
  for (const t of doc.tools) {
    const name = t && typeof t === 'object' ? t.name : undefined;
    if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return { reason: `invalid tool name ${JSON.stringify(name)}` };
    if (seen.has(name)) return { reason: `duplicate tool name ${name}` };
    seen.add(name);
  }
  const tools = doc.tools
    .filter((t) => !t.name.startsWith('mcp__'))
    .map((t) => ({ name: t.name, kind: typeof t.kind === 'string' ? t.kind : null }));
  if (!tools.length) return { reason: 'no tools left after dropping mcp__ names' };
  return { tools };
}

function resolveOnPath(cmd, env, fsImpl) {
  if (cmd.includes('/')) return cmd;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try {
      if (fsImpl.statSync(p).isFile()) { fsImpl.accessSync(p, fs.constants.X_OK); return p; }
    } catch {}
  }
  return null;
}

function runListTools(bin, { env, spawn, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(bin, ['--list-tools'], { env, shell: false, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      resolve({ reason: `spawn error ${err.code || err.message}` });
      return;
    }
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done({ reason: `timeout after ${timeoutMs}ms` }); }, timeoutMs);
    child.on('error', (err) => done({ reason: `spawn error ${err.code || err.message}` }));
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_OUTPUT_BYTES) { try { child.kill('SIGKILL'); } catch {} done({ reason: `output over ${MAX_OUTPUT_BYTES} bytes` }); return; }
      chunks.push(c);
    });
    child.on('close', (code, signal) => {
      if (signal) return done({ reason: `killed by ${signal}` });
      if (code === 2) return done({ reason: 'exit 2 (clodent 0.9.0 or older)' });
      if (code !== 0) return done({ reason: `exit ${code}` });
      done(parseListTools(Buffer.concat(chunks).toString('utf-8')));
    });
  });
}

function createClodentTools({ env = process.env, spawn = childProcess.spawn, fsImpl = fs, log = null, cmd = adapterFor('clodent').cmd, timeoutMs = LIST_TOOLS_TIMEOUT_MS } = {}) {
  const cache = new Map();
  const settled = new Map();

  function current() {
    const bin = resolveOnPath(cmd, env, fsImpl);
    let st = null;
    if (bin) { try { st = fsImpl.statSync(bin); } catch {} }
    return { bin: st ? bin : null, key: st ? `${bin}\0${st.mtimeMs}\0${st.size}` : `missing\0${cmd}` };
  }

  function list() {
    const { bin, key } = current();
    if (cache.has(key)) return cache.get(key);
    const p = (bin ? runListTools(bin, { env, spawn, timeoutMs }) : Promise.resolve({ reason: 'not on PATH' }))
      .then((r) => {
        let out;
        if (r.tools) out = { source: 'clodent', reason: null, names: r.tools.map((t) => t.name), tools: r.tools };
        else {
          if (log) log.info('clodent', `${bin || cmd} --list-tools: using the built-in tool list (${r.reason})`);
          out = builtinTools(r.reason);
        }
        settled.set(key, out);
        return out;
      });
    cache.set(key, p);
    return p;
  }

  function peek() {
    const { key } = current();
    if (settled.has(key)) return settled.get(key);
    list();
    return null;
  }

  return { list, peek };
}

module.exports = { createClodentTools, parseListTools, TOOL_NAME_RE, MAX_TOOLS, LIST_TOOLS_TIMEOUT_MS };
