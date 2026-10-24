'use strict';

const nodeFs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MCP_NAME_RE = /^(?!.*__)[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_MCP_NAMES = Object.freeze(['clodex', 'claude_design']);
const MCP_TYPES = Object.freeze(['stdio', 'http', 'sse']);
const MCP_PLATFORMS = Object.freeze(['claude', 'codex', 'muse']);
const MCP_TOOL_RE = /^mcp__(.+?)__/;
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ONLY_REF_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const SECRET_HEADER_RE = /authorization|api-?key|token/i;
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|API_KEY)$/i;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrMap = (v) => isObj(v) && Object.values(v).every((x) => typeof x === 'string');
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const DENY_TOOL_RE = /^(?!.*__)[A-Za-z0-9_-]+$/;

function mcpNameError(name) {
  if (typeof name !== 'string' || !MCP_NAME_RE.test(name)) return `invalid MCP server name: ${name}`;
  if (RESERVED_MCP_NAMES.includes(name)) return `reserved MCP server name: ${name}`;
  return null;
}

function entryType(entry) {
  return entry && entry.type !== undefined ? entry.type : 'stdio';
}

function hasLiteral(value) {
  return typeof value === 'string'
    && value.replace(REF_RE, '').replace(/^\s*(bearer|basic|token)\b/i, '').trim().length > 0;
}

function secretLintErrors(entry) {
  const errors = [];
  if (isObj(entry.headers)) {
    for (const [k, v] of Object.entries(entry.headers)) {
      if (SECRET_HEADER_RE.test(k) && hasLiteral(v)) errors.push(`header ${k} carries a literal value; write it as \${NAME}`);
    }
  }
  if (isObj(entry.env)) {
    for (const [k, v] of Object.entries(entry.env)) {
      if (SECRET_ENV_RE.test(k) && hasLiteral(v)) errors.push(`env ${k} carries a literal value; write it as \${NAME}`);
    }
  }
  return errors;
}

function validateMcpEntry(entry) {
  const errors = [];
  if (!isObj(entry)) return { ok: false, errors: ['entry must be a JSON object'] };
  const type = entryType(entry);
  if (!MCP_TYPES.includes(type)) errors.push(`type must be one of ${MCP_TYPES.join('|')}`);
  if (type === 'stdio') {
    if (typeof entry.command !== 'string' || !entry.command.trim()) errors.push('stdio needs a command string');
    if (entry.args !== undefined && !isStrList(entry.args)) errors.push('args must be an array of strings');
    if (entry.env !== undefined && !isStrMap(entry.env)) errors.push('env must be an object of strings');
    if (entry.cwd !== undefined && entry.cwd !== null && typeof entry.cwd !== 'string') errors.push('cwd must be a string');
  }
  if (type === 'http' || type === 'sse') {
    if (typeof entry.url !== 'string' || !entry.url.trim()) errors.push(`${type} needs a url string`);
    if (entry.headers !== undefined && !isStrMap(entry.headers)) errors.push('headers must be an object of strings');
  }
  if (entry.description !== undefined && typeof entry.description !== 'string') errors.push('description must be a string');
  if (entry.tags !== undefined && !isStrList(entry.tags)) errors.push('tags must be an array of strings');
  if (entry.platforms !== undefined
    && !(isStrList(entry.platforms) && entry.platforms.every((p) => MCP_PLATFORMS.includes(p)))) {
    errors.push(`platforms must be a subset of ${MCP_PLATFORMS.join('|')}`);
  }
  if (entry.denyTools !== undefined
    && !(isStrList(entry.denyTools) && entry.denyTools.every((t) => DENY_TOOL_RE.test(t)))) {
    errors.push('denyTools must be an array of tool names of letters, digits, _ and -, without __');
  }
  errors.push(...secretLintErrors(entry));
  return { ok: errors.length === 0, errors };
}

function refsIn(value, out) {
  if (typeof value !== 'string') return;
  for (const m of value.matchAll(REF_RE)) out.add(m[1]);
}

function secretRefs(entry) {
  const out = new Set();
  if (!isObj(entry)) return [];
  if (isObj(entry.env)) Object.values(entry.env).forEach((v) => refsIn(v, out));
  if (isObj(entry.headers)) Object.values(entry.headers).forEach((v) => refsIn(v, out));
  refsIn(entry.url, out);
  if (Array.isArray(entry.args)) entry.args.forEach((v) => refsIn(v, out));
  return [...out].sort();
}

function cliShape(entry) {
  const type = entryType(entry);
  if (type === 'stdio') {
    const out = { type, command: entry.command };
    if (Array.isArray(entry.args)) out.args = [...entry.args];
    if (isObj(entry.env)) out.env = { ...entry.env };
    if (typeof entry.cwd === 'string' && entry.cwd) out.cwd = entry.cwd;
    return out;
  }
  const out = { type, url: entry.url };
  if (isObj(entry.headers)) out.headers = { ...entry.headers };
  return out;
}

function resolveMcpEntry(entry, env) {
  const vars = env && typeof env === 'object' ? env : {};
  const missing = secretRefs(entry).filter((n) => typeof vars[n] !== 'string' || vars[n] === '');
  if (missing.length) return { resolved: null, missing };
  const sub = (v) => (typeof v === 'string' ? v.replace(REF_RE, (_m, n) => vars[n]) : v);
  const shape = cliShape(entry);
  if (shape.args) shape.args = shape.args.map(sub);
  if (shape.env) shape.env = Object.fromEntries(Object.entries(shape.env).map(([k, v]) => [k, sub(v)]));
  if (shape.headers) shape.headers = Object.fromEntries(Object.entries(shape.headers).map(([k, v]) => [k, sub(v)]));
  if (shape.url) shape.url = sub(shape.url);
  return { resolved: shape, missing: [] };
}

function denyToolsOf(entry) {
  return isObj(entry) && isStrList(entry.denyTools) ? [...new Set(entry.denyTools)].sort() : [];
}

function digestShape(entry) {
  const shape = cliShape(entry);
  const deny = denyToolsOf(entry);
  return deny.length ? { ...shape, denyTools: deny } : shape;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function mcpDigest(shapes) {
  const rows = Object.keys(shapes).sort().map((n) => [n, shapes[n]]);
  return crypto.createHash('sha256').update(canonical(rows)).digest('hex');
}

function libraryMap(library) {
  const map = new Map();
  for (const row of Array.isArray(library) ? library : []) {
    if (row && typeof row.name === 'string' && isObj(row.entry)) map.set(row.name, row.entry);
  }
  return map;
}

function claudeMcpServers({ selected, library, env, cli = 'claude' } = {}) {
  const servers = {};
  const shapes = {};
  const warnings = [];
  const denied = {};
  const lib = libraryMap(library);
  const picked = [...new Set((Array.isArray(selected) ? selected : []).filter((n) => typeof n === 'string'))];
  for (const n of picked) {
    const nameErr = mcpNameError(n);
    if (nameErr) { warnings.push(`MCP ${n}: ${nameErr}`); continue; }
    const entry = lib.get(n);
    if (!entry) { warnings.push(`MCP ${n}: not in the library`); continue; }
    if (Array.isArray(entry.platforms) && !entry.platforms.includes(cli)) {
      warnings.push(`MCP ${n}: not available on ${cli}`);
      continue;
    }
    const check = validateMcpEntry(entry);
    if (!check.ok) { warnings.push(`MCP ${n}: invalid library entry — ${check.errors.join('; ')}`); continue; }
    const { resolved, missing } = resolveMcpEntry(entry, env);
    if (!resolved) {
      warnings.push(`MCP ${n}: not loaded — ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set (Preferences ▸ Environment)`);
      continue;
    }
    servers[n] = resolved;
    shapes[n] = digestShape(entry);
    const deny = denyToolsOf(entry);
    if (deny.length) denied[n] = deny;
  }
  const names = Object.keys(servers).sort();
  const denyRules = names.flatMap((n) => (denied[n] || []).map((t) => `mcp__${n}__${t}`));
  const applied = { names, digest: mcpDigest(shapes), denyRules };
  if (Object.keys(denied).length) applied.denied = denied;
  return { servers, warnings, applied };
}

function tomlString(s) {
  return `"${String(s).replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    if (c === '\\') return '\\\\';
    if (c === '"') return '\\"';
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  })}"`;
}

const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const tomlKey = (k) => (TOML_BARE_KEY_RE.test(k) ? k : tomlString(k));
const tomlArray = (list) => `[${list.map(tomlString).join(',')}]`;
const tomlTable = (rows) => `{${rows.map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`).join(',')}}`;
const BEARER_REF_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const WHOLE_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function codexBlocker(entry) {
  const type = entryType(entry);
  if (type === 'sse') return { sse: true };
  if (type === 'stdio') {
    return Array.isArray(entry.args) && entry.args.some((a) => typeof a === 'string' && a.includes('${'))
      ? { why: 'args reference an env var' } : null;
  }
  if (typeof entry.url === 'string' && entry.url.includes('${')) return { why: 'url references an env var' };
  for (const h of Object.keys(isObj(entry.headers) ? entry.headers : {}).sort()) {
    const v = entry.headers[h];
    if (typeof v !== 'string' || !v.includes('${')) continue;
    if (h.toLowerCase() === 'authorization' && BEARER_REF_RE.test(v)) continue;
    if (WHOLE_REF_RE.test(v)) continue;
    return { why: `header ${h} mixes text and an env var` };
  }
  return null;
}

function codexExpressible(entry) {
  return isObj(entry) && codexBlocker(entry) === null;
}

function codexServerPairs(n, entry, resolved, env) {
  const blocker = codexBlocker(entry);
  if (blocker && blocker.sse) return { omit: `MCP ${n}: not available on codex (sse)` };
  if (blocker) return { omit: `MCP ${n}: not expressible on Codex — ${blocker.why}` };
  const type = entryType(entry);
  const pairs = [];
  const seatEnv = {};
  if (type === 'stdio') {
    const args = Array.isArray(entry.args) ? entry.args : [];
    pairs.push(['command', tomlString(resolved.command)]);
    pairs.push(['args', tomlArray(args)]);
    if (resolved.cwd) pairs.push(['cwd', tomlString(resolved.cwd)]);
    const plain = [];
    const names = [];
    for (const k of Object.keys(isObj(entry.env) ? entry.env : {}).sort()) {
      if (entry.env[k].includes('${')) {
        seatEnv[k] = resolved.env[k];
        names.push(k);
      } else plain.push([k, entry.env[k]]);
    }
    if (plain.length) pairs.push(['env', tomlTable(plain)]);
    if (names.length) pairs.push(['env_vars', tomlArray(names)]);
  } else {
    pairs.push(['url', tomlString(entry.url)]);
    const literal = [];
    const fromEnv = [];
    for (const h of Object.keys(isObj(entry.headers) ? entry.headers : {}).sort()) {
      const v = entry.headers[h];
      const bearer = h.toLowerCase() === 'authorization' ? BEARER_REF_RE.exec(v) : null;
      const whole = WHOLE_REF_RE.exec(v);
      if (bearer) {
        pairs.push(['bearer_token_env_var', tomlString(bearer[1])]);
        seatEnv[bearer[1]] = env[bearer[1]];
      } else if (whole) {
        fromEnv.push([h, whole[1]]);
        seatEnv[whole[1]] = env[whole[1]];
      } else literal.push([h, v]);
    }
    if (literal.length) pairs.push(['http_headers', tomlTable(literal)]);
    if (fromEnv.length) pairs.push(['env_http_headers', tomlTable(fromEnv)]);
  }
  const deny = denyToolsOf(entry);
  if (deny.length) pairs.push(['disabled_tools', tomlArray(deny)]);
  pairs.push(['enabled', 'true']);
  return { pairs, seatEnv };
}

function codexMcpArgs({ servers, library, env, userOwn, configNames } = {}) {
  if (userOwn) {
    return { args: [], seatEnv: {}, warnings: ["MCP: selection not applied — the seat's extra args carry their own -c mcp_servers"], applied: null };
  }
  const lib = libraryMap(library);
  const vars = isObj(env) ? env : {};
  const args = [];
  const seatEnv = {};
  const warnings = [];
  const shapes = {};
  const denied = {};
  const inConfig = new Set(Array.isArray(configNames) ? configNames : []);
  for (const n of Object.keys(isObj(servers) ? servers : {}).sort()) {
    const entry = lib.get(n);
    if (!entry) continue;
    const out = codexServerPairs(n, entry, servers[n], vars);
    if (out.omit) { warnings.push(out.omit); continue; }
    const clash = Object.keys(out.seatEnv).find((k) => (k in seatEnv && seatEnv[k] !== out.seatEnv[k])
      || (typeof vars[k] === 'string' && vars[k] !== out.seatEnv[k]));
    if (clash) {
      warnings.push(`MCP ${n}: not expressible on Codex — env ${clash} collides with another server's or the seat's value`);
      continue;
    }
    for (const [k, v] of out.pairs) args.push('-c', `mcp_servers.${n}.${k}=${v}`);
    Object.assign(seatEnv, out.seatEnv);
    shapes[n] = digestShape(entry);
    const deny = denyToolsOf(entry);
    if (deny.length) denied[n] = deny;
    if (inConfig.has(n)) warnings.push(`MCP ${n}: also in config.toml — Codex merges Clodex's keys over it; stale keys survive`);
  }
  for (const c of [...inConfig].sort()) {
    if (!shapes[c]) args.push('-c', `mcp_servers.${c}.enabled=false`);
  }
  const names = Object.keys(shapes).sort();
  const applied = { names, digest: mcpDigest(shapes), denyRules: names.flatMap((n) => (denied[n] || []).map((t) => `mcp__${n}__${t}`)) };
  if (Object.keys(denied).length) applied.denied = denied;
  applied.residue = [];
  return { args, seatEnv, warnings, applied };
}

function mcpArgvPlan({ userMcp, userStrict, mcpPath }) {
  const unavailable = 'MCP: the clodex MCP tools are not available to this session — ';
  if (userMcp) {
    return { push: [], writeConfig: false, unmanaged: true, notice: `${unavailable}the seat's extra args carry their own --mcp-config.` };
  }
  if (userStrict) {
    return { push: [], writeConfig: false, unmanaged: true, notice: `${unavailable}the seat's extra args carry --strict-mcp-config with no config, which is the empty set.` };
  }
  return { push: ['--strict-mcp-config', '--mcp-config', mcpPath], writeConfig: true, unmanaged: false, notice: null };
}

function mcpServerOf(toolName) {
  const m = MCP_TOOL_RE.exec(typeof toolName === 'string' ? toolName : '');
  return m ? m[1] : null;
}

function mcpLeaks({ rosterServers, selected, implicit = ['clodex'] } = {}) {
  const allowed = new Set([...(Array.isArray(implicit) ? implicit : []), ...(Array.isArray(selected) ? selected : [])]);
  const out = [];
  for (const s of Array.isArray(rosterServers) ? rosterServers : []) {
    if (typeof s === 'string' && s && !allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

function readJson(fs, file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function serversOf(source, obj, out) {
  if (!isObj(obj)) return;
  for (const [name, entry] of Object.entries(obj)) {
    if (isObj(entry)) out.push({ source, name, entry });
  }
}

function discoverMcpSources({ home, cwd, claudeConfigDir, fs = nodeFs } = {}) {
  const out = [];
  const base = claudeConfigDir || home;
  if (base) {
    const userFile = path.join(base, '.claude.json');
    const cfg = readJson(fs, userFile);
    if (isObj(cfg)) {
      serversOf(`claude:user ${userFile}`, cfg.mcpServers, out);
      const proj = cwd && isObj(cfg.projects) ? cfg.projects[cwd] : null;
      if (isObj(proj)) serversOf(`claude:local ${userFile}`, proj.mcpServers, out);
    }
  }
  if (cwd) {
    const projFile = path.join(cwd, '.mcp.json');
    const cfg = readJson(fs, projFile);
    if (isObj(cfg)) serversOf(`claude:project ${projFile}`, cfg.mcpServers, out);
  }
  return out;
}

function secretName(key) {
  const up = String(key).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Z_]/.test(up) ? up : `MCP_${up}`;
}

function normaliseDiscovered(entry) {
  const out = isObj(entry) ? JSON.parse(JSON.stringify(entry)) : {};
  const secrets = {};
  const claim = (base, value) => {
    let n = base;
    for (let i = 2; secrets[n] !== undefined && secrets[n] !== value; i++) n = `${base}_${i}`;
    secrets[n] = value;
    return n;
  };
  if (isObj(out.env)) {
    for (const [k, v] of Object.entries(out.env)) {
      if (SECRET_ENV_RE.test(k) && hasLiteral(v)) out.env[k] = `\${${claim(secretName(k), v)}}`;
    }
  }
  if (isObj(out.headers)) {
    for (const [k, v] of Object.entries(out.headers)) {
      if (!SECRET_HEADER_RE.test(k) || !hasLiteral(v)) continue;
      const m = /^(bearer|basic|token)(\s+)(.*)$/i.exec(v);
      if (m && !ONLY_REF_RE.test(m[3])) out.headers[k] = `${m[1]}${m[2]}\${${claim(secretName(k), m[3])}}`;
      else out.headers[k] = `\${${claim(secretName(k), v)}}`;
    }
  }
  return { entry: out, secrets };
}

module.exports = {
  MCP_NAME_RE, RESERVED_MCP_NAMES, MCP_TYPES, MCP_PLATFORMS, MCP_TOOL_RE,
  mcpNameError, validateMcpEntry, secretRefs, resolveMcpEntry, cliShape, digestShape, mcpDigest,
  claudeMcpServers, tomlString, codexMcpArgs, codexExpressible, mcpArgvPlan, mcpServerOf, mcpLeaks, discoverMcpSources, normaliseDiscovered,
};
