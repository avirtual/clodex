#!/usr/bin/env node
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

const NAME_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;
const CTX_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,64}$/;
const MAX_LINE = 200;
const MIN_TOKEN = 8;
const MIN = 60 * 1000;
const THROTTLE_MS = 30 * 1000;
const HEARTBEAT_MS = 5 * MIN;
const KILL_GRACE_MS = 5000;
const RESULT_TRIES = 6;
const RESULT_RETRY_MS = 10 * 1000;
const DM_MAX_LINES = 20;
const DM_MAX_CHARS = 3000;
const SWEEP_LOCKS = 50;
const SWEEP_RESULTS = 20;
const FROM = 'ctl-admin';

const V = 'value';
const B = 'bool';
const M = 'multi';
const VERB_TABLE = {
  deploy: {
    ceilingMs: 40 * MIN,
    flags: {
      branch: V, tag: V, image: V, set: M, param: M, subnets: V, 'security-group': V,
      'assign-public-ip': V, persistent: V, 'use-bedrock': B, 'no-wirescope': B, 'force-conflicts': B, 'dry-run': B,
    },
  },
  upgrade: {
    ceilingMs: 40 * MIN,
    flags: {
      tag: V, image: V, branch: V, set: M, subnets: V, 'security-group': V, 'assign-public-ip': V,
      persistent: V, force: B, 'dry-run': B, 'force-conflicts': B,
    },
  },
  restart: { ceilingMs: 3 * MIN, flags: {} },
  undeploy: { ceilingMs: 20 * MIN, flags: { 'keep-data': B, 'dry-run': B, wait: B } },
  delete: { ceilingMs: 3 * MIN, flags: {} },
};

const LOCATOR_FLAGS = ['ssh', 'ssm', 'host', 'url', 'ctx', 'remote-port', 'remotePort', 'tunnel', 'region', 'profile', 'target'];
const CREDENTIAL_FLAGS = ['token', 'src', 'repo', 'claude-token-file', 'env-file', 'ssh-opt', 'import', 'token-file'];

const MILESTONE_JSON_TYPES = new Set(['dry-run', 'preflight', 'command', 'inferred-flavor', 'need-sudo', 'sudo-cmd', 'status']);

class Refusal extends Error {}
const refuse = (msg) => { throw new Refusal(msg); };

function clip(s, n = MAX_LINE) {
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
const short = (s) => clip(s, 40);

function clodexHome() { return process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex'); }
function runsDir() { return path.join(clodexHome(), 'ctl-runs'); }
function contextsFile() { return path.join(os.homedir(), '.clodex', 'cli', 'contexts.json'); }

function loadStore(file = contextsFile()) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { contexts: obj && obj.contexts && typeof obj.contexts === 'object' ? obj.contexts : {} };
  } catch {
    return { contexts: {} };
  }
}

function redactionTokens(file = contextsFile()) {
  const seen = new Set();
  for (const rec of Object.values(loadStore(file).contexts)) {
    const t = rec && rec.token;
    if (typeof t === 'string' && t.length >= MIN_TOKEN) seen.add(t);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

const HEX_TOKEN_RE = /\b[0-9a-f]{48}\b/g;
const KEYED_TOKEN_RE = /((?:^|[\s"'{,(=])"?(?:token|wire[-_]?token|CLODEX_TOKEN|CLODEX_REMOTE_TOKEN|CLODEX_SANDBOX_TOKEN)"?\s*[=:]\s*"?)([^\s"',}]{8,})/gi;
const BEARER_RE = /(Authorization["']?\s*[:=]\s*["']?Bearer\s+)[^\s"']+/gi;

function redact(text, tokens = []) {
  let s = String(text);
  for (const t of tokens) {
    if (typeof t === 'string' && t.length >= MIN_TOKEN) s = s.split(t).join('***');
  }
  return s.replace(HEX_TOKEN_RE, '***').replace(KEYED_TOKEN_RE, '$1***').replace(BEARER_RE, '$1***');
}

function tokenize(line) {
  const out = [];
  let cur = '';
  let has = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) { cur += line[++i]; continue; }
      if (c === quote) { quote = null; continue; }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (quote) refuse(`refused: args: unbalanced ${quote === '"' ? 'double' : 'single'} quote`);
  if (has) out.push(cur);
  return out;
}

function allowedList(verb, dashes = true) {
  const names = Object.keys(VERB_TABLE[verb].flags);
  if (!names.length) return 'no flags';
  return names.map((n) => (dashes ? `--${n}` : n)).join(' ');
}

function gate(verb, tokens) {
  const spec = VERB_TABLE[verb].flags;
  const flags = [];
  const positionals = [];
  const seen = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith('-')) { positionals.push(tok); continue; }
    if (tok === '--' || !tok.startsWith('--')) {
      refuse(`refused: "${short(tok)}" — short flags and bare -- are not accepted; spell the long form`);
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    if (LOCATOR_FLAGS.includes(name)) refuse(`refused: --${name} comes from the context record and cannot be set here`);
    if (CREDENTIAL_FLAGS.includes(name)) {
      refuse(`refused: --${name} is operator-only on this tier (a credential, a local path, or a replication source)`);
    }
    const kind = Object.hasOwn(spec, name) ? spec[name] : null;
    if (!kind) refuse(`refused: --${clip(name, 20)} is not accepted by ${verb} here (allowed: ${allowedList(verb, false)})`);
    if (seen.has(name) && kind !== M) refuse(`refused: --${name} given twice`);
    seen.add(name);
    if (kind === B) {
      if (eq !== -1) refuse(`refused: --${name} takes no value`);
      flags.push(`--${name}`);
      continue;
    }
    let value;
    if (eq !== -1) value = tok.slice(eq + 1);
    else value = i + 1 < tokens.length ? tokens[++i] : '';
    if (value === '' || value.startsWith('-')) refuse(`refused: --${name} needs a value, got "${short(value)}"`);
    flags.push(`--${name}`, value);
  }
  return { flags, positionals };
}

function transportLabel(rec) {
  if (rec.tunnel) return 'tunnel';
  if (rec.gcloud) return 'gcloud';
  if (rec.az) return 'az';
  if (rec.ssm && rec.ssm.ecs) return 'ssm-ecs';
  return 'url';
}

function svcName(target) {
  return typeof target === 'string' && target.startsWith('svc/') && target.length > 4 ? target.slice(4) : null;
}

function clusterFromEcs(rec) {
  const ecs = rec && rec.ssm && rec.ssm.ecs;
  return typeof ecs === 'string' && ecs.includes('/') ? ecs.split('/')[0] : null;
}

function deployLocator(ctx, rec) {
  const dep = rec.deploy && typeof rec.deploy === 'object' && typeof rec.deploy.flavor === 'string' ? rec.deploy : null;
  const ssm = rec.ssm && typeof rec.ssm === 'object' ? rec.ssm : {};
  const kubectl = rec.kubectl && typeof rec.kubectl === 'object' ? rec.kubectl : {};
  const flavor = dep ? dep.flavor
    : typeof rec.ssh === 'string' ? 'ssh'
      : typeof ssm.target === 'string' ? 'ssm'
        : typeof kubectl.target === 'string' ? 'helm'
          : null;
  const port = /^\d+$/.test(String(rec.remotePort ?? '')) ? ['--port', String(rec.remotePort)] : [];
  const opt = (flag, v) => (typeof v === 'string' && v ? [flag, v] : []);
  const d = dep || {};
  if (flavor === 'ssh') {
    const host = d.host ?? rec.ssh;
    if (typeof host !== 'string' || !host) refuse(`refused: context "${ctx}" records deploy flavor ssh but no host — the operator re-stamps it with a deploy from a terminal`);
    return { name: ctx, flags: ['--ssh', host, ...port] };
  }
  if (flavor === 'ssm') {
    const target = d.target ?? ssm.target;
    if (typeof target !== 'string' || !target) refuse(`refused: context "${ctx}" records deploy flavor ssm but no target — the operator re-stamps it with a deploy from a terminal`);
    return {
      name: ctx,
      flags: ['--ssm', target, ...opt('--region', d.region ?? ssm.region), ...opt('--profile', d.profile ?? ssm.profile), ...port],
    };
  }
  if (flavor === 'docker') {
    return { name: ctx, flags: ['--docker', ...opt('--host', d.dockerHost), ...port] };
  }
  if (flavor === 'helm') {
    const release = d.release ?? svcName(kubectl.target) ?? ctx;
    if (release !== ctx) refuse(`refused: helm context "${ctx}" records release "${short(release)}" — deploy would save a context under the release name; use upgrade`);
    const ns = d.namespace ?? kubectl.namespace ?? 'clodex';
    return { name: ctx, flags: ['--helm', '--namespace', ns, ...opt('--kube-context', d.kubeContext ?? kubectl.context)] };
  }
  if (flavor === 'fargate') {
    const stack = d.stack ?? ctx;
    return {
      name: stack,
      flags: [
        '--fargate',
        ...(stack !== ctx ? ['--ctx', ctx] : []),
        ...opt('--region', d.region ?? ssm.region),
        ...opt('--profile', d.profile ?? ssm.profile),
        ...opt('--cluster', clusterFromEcs(rec)),
      ],
    };
  }
  if (dep) refuse(`refused: context "${ctx}" records deploy flavor "${short(dep.flavor)}", which this tier does not deploy — the operator runs it from a terminal`);
  return refuse(`refused: context "${ctx}" records no deploy flavor and its ${transportLabel(rec)} transport names no installer — the operator runs the first deploy`);
}

function buildArgv(verb, ctx, record, tokens) {
  if (!Object.hasOwn(VERB_TABLE, verb)) refuse(r4(verb));
  const { flags, positionals } = gate(verb, tokens);
  const flagsOnly = () => {
    if (positionals.length) refuse(`refused: ${verb} takes flags only — the node name and its locator come from the context record "${ctx}"`);
  };
  if (verb === 'deploy') {
    flagsOnly();
    const L = deployLocator(ctx, record);
    return ['deploy', 'node', L.name, ...L.flags, ...flags, '--force', '-o', 'json'];
  }
  if (verb === 'upgrade') {
    flagsOnly();
    return ['upgrade', 'node', ctx, ...flags, '-o', 'json'];
  }
  if (verb === 'undeploy') {
    flagsOnly();
    return ['undeploy', 'node', ctx, ...flags, '--force', '--keep-ctx', '-o', 'json'];
  }
  if (verb === 'restart') {
    if (!(positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'node'))) {
      refuse('refused: restart here is `restart node` (args empty or "node"); restart session is in clodex-ctl-seats');
    }
    return ['--ctx', ctx, 'restart', 'node', '--force', '-o', 'json'];
  }
  let name = null;
  const first = positionals[0] || '';
  if (first === 'session') {
    if (positionals.length !== 2) refuse(R17);
    name = positionals[1];
  } else if (first.startsWith('session/')) {
    if (positionals.length !== 1) refuse(R17);
    name = first.slice('session/'.length);
  } else {
    refuse('refused: delete here is `delete session <name>`; delete node is operator-only');
  }
  if (!NAME_RE.test(name)) refuse(R17);
  return ['--ctx', ctx, 'delete', 'session', name, '--force', '-o', 'json'];
}

const R17 = 'refused: delete session needs a plain session name ([A-Za-z0-9._-]{1,64})';
const r4 = (verb) => `refused: ${short(verb)} has no non-interactive spelling on this tier (verbs: help deploy upgrade restart; undeploy, delete by operator enum edit)`;

function helpWords(args) {
  const words = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 3 || !words.every((w) => /^[a-z][a-z-]*$/.test(w))) {
    refuse('refused: help takes up to three verb words ([a-z-]+), e.g. args "deploy"');
  }
  return words;
}

function helpTrailer(words) {
  const verb = words[0];
  if (verb && Object.hasOwn(VERB_TABLE, verb)) {
    return `[clodex-ctl-admin] on this tier ${verb} takes: ${allowedList(verb)}; the node and its locator come from the context record`;
  }
  return '[clodex-ctl-admin] verbs on this tier: help deploy upgrade restart (undeploy, delete session when the operator adds them to the enum)';
}

function childEnv(base) {
  const env = { ...base, ELECTRON_RUN_AS_NODE: '1' };
  delete env.CLODEX_URL;
  delete env.CLODEX_TOKEN;
  return env;
}

function renderMilestone(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return null;
  const s = (v) => (v == null ? '' : String(v));
  switch (ev.type) {
    case 'step': return `→ ${s(ev.name)} …`;
    case 'ok': return `${s(ev.name)} ok`;
    case 'fail': return `${s(ev.name)} FAILED — ${s(ev.reason)}`;
    case 'error': return `error: ${s(ev.reason)}${ev.message ? ` — ${s(ev.message)}` : ''}`;
    case 'verify': return `verified host=${s(ev.host)} version=${s(ev.version)}`;
    case 'context': return `context ${s(ev.action)} ${s(ev.name)}${ev.reason ? ` — ${s(ev.reason)}` : ''}`;
    case 'version': return `running ${s(ev.from ?? '?')} → target ${s(ev.to ?? ev.target ?? '?')}`;
    case 'no-op': return `no-op: ${s(ev.reason)} (${s(ev.version)})`;
    case 'upgrade': return 'upgrade ok';
    case 'warning': return `WARNING: ${s(ev.text ?? ev.message)}`;
    default:
      if (MILESTONE_JSON_TYPES.has(ev.type)) return `${ev.type}: ${clip(JSON.stringify(ev), 300)}`;
      return null;
  }
}

function milestoneOf(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try { return renderMilestone(JSON.parse(t)); } catch { return null; }
}

function packDm(head, lines) {
  const out = [];
  let size = head.length;
  let i = 0;
  for (; i < lines.length && out.length < DM_MAX_LINES; i++) {
    if (size + lines[i].length + 1 > DM_MAX_CHARS) break;
    out.push(lines[i]);
    size += lines[i].length + 1;
  }
  if (i < lines.length) out.push(`…(+${lines.length - i} more in the log)`);
  return [head, ...out].join('\n');
}

function elapsed(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(sec / 60);
  return m ? `${m}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
}

function hhmmss(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??:??' : d.toTimeString().slice(0, 8);
}

function isAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function updateRecord(dir, seq, patch) {
  const file = path.join(dir, `${seq}.json`);
  const rec = { ...(readJson(file) || {}), ...patch };
  writeJson(file, rec);
  return rec;
}

function seatSocket(seat) {
  const info = readJson(path.join(clodexHome(), 'run', seat, 'agent.json'));
  return info && typeof info.socket === 'string' ? info.socket : null;
}

function sendDm(seat, body, passive = false) {
  return new Promise((resolve) => {
    const sock = NAME_RE.test(String(seat)) ? seatSocket(seat) : null;
    if (!sock) { resolve(false); return; }
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const msg = { from: FROM, body, type: 'dm' };
    if (passive) msg.delivery = 'passive';
    const conn = net.createConnection(sock, () => conn.end(Buffer.from(JSON.stringify(msg), 'utf8'), () => done(true)));
    conn.on('error', () => done(false));
    conn.setTimeout(2000, () => { conn.destroy(); done(false); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logTail(logFile, n = 5) {
  let text = '';
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { return []; }
  const lines = [];
  for (const l of text.split('\n')) {
    const m = /^\d\d:\d\d:\d\d (?:out|err) (.*)$/.exec(l);
    if (m) lines.push(m[1]);
  }
  return lines.slice(-n);
}

function resultHead(rec, dir) {
  const log = path.join(dir, `${rec.seq}.log`);
  const ms = Date.parse(rec.endedAt) - Date.parse(rec.startedAt);
  const tag = `[run ${rec.seq} ${rec.verb} ${rec.ctx}]`;
  let what;
  if (rec.outcome === 'unknown') what = `outcome unknown (${rec.reason})`;
  else if (rec.signal) what = `killed (${rec.signal})`;
  else what = `exit ${rec.exitCode} (${rec.outcome}${rec.reason ? `: ${rec.reason}` : ''})`;
  return `${tag} ${what} after ${elapsed(Number.isFinite(ms) ? ms : 0)} — log ${log}`;
}

function resultBody(rec, dir, tail) {
  return [resultHead(rec, dir), ...tail.map((l) => clip(l, 300))].join('\n');
}

async function sweep(dir, { send = sendDm } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = () => new Date().toISOString();
  for (const f of names.filter((n) => n.endsWith('.lock')).slice(0, SWEEP_LOCKS)) {
    const lockFile = path.join(dir, f);
    const lock = readJson(lockFile) || {};
    if (isAlive(lock.pid)) continue;
    const ctx = f.slice(0, -'.lock'.length);
    const seq = Number.isInteger(lock.seq) ? lock.seq : null;
    const recFile = seq == null ? null : path.join(dir, `${seq}.json`);
    const rec = recFile ? readJson(recFile) : null;
    const running = seq != null && (!rec || rec.outcome === 'running');
    const childPid = rec && Number.isInteger(rec.childPid) && rec.childPid > 0 ? rec.childPid : null;
    if (running && childPid && isAlive(childPid)) {
      if (!rec.orphanNoticed) {
        try {
          fs.appendFileSync(path.join(dir, `${seq}.log`), `# worker pid ${lock.pid} gone; clodexctl pid ${childPid} still running — lock kept (swept ${now()})\n`, { mode: 0o600 });
          updateRecord(dir, seq, { orphanNoticed: true });
        } catch {}
      }
      continue;
    }
    if (running) {
      const reason = childPid
        ? `worker pid ${lock.pid} and clodexctl pid ${childPid} gone without a result`
        : `worker pid ${lock.pid} gone without a result`;
      try {
        updateRecord(dir, seq, {
          seq, ctx, seat: lock.seat, verb: lock.verb, ...(rec ? {} : { startedAt: lock.startedAt }),
          outcome: 'unknown', endedAt: now(), reason, notified: false,
        });
        fs.appendFileSync(path.join(dir, `${seq}.log`), `# outcome unknown — ${reason} (swept ${now()})\n`, { mode: 0o600 });
      } catch {}
      try { fs.unlinkSync(lockFile); } catch {}
      const ok = await send(lock.seat, `[run ${seq} ${lock.verb} ${ctx}] outcome UNKNOWN — ${reason}; nothing was re-run. log ${path.join(dir, `${seq}.log`)}`);
      if (ok) { try { updateRecord(dir, seq, { notified: true }); } catch {} }
      continue;
    }
    try { fs.unlinkSync(lockFile); } catch {}
  }
  const pending = [];
  for (const f of names.filter((n) => /^\d+\.json$/.test(n))) {
    const rec = readJson(path.join(dir, f));
    if (!rec || rec.notified !== false || rec.outcome === 'running' || isAlive(rec.workerPid)) continue;
    if (!['ok', 'failed', 'unknown'].includes(rec.outcome)) continue;
    pending.push(rec);
  }
  pending.sort((a, b) => b.seq - a.seq);
  for (const rec of pending.slice(0, SWEEP_RESULTS)) {
    const ok = await send(rec.seat, resultBody(rec, dir, logTail(path.join(dir, `${rec.seq}.log`))));
    if (ok) { try { updateRecord(dir, rec.seq, { notified: true }); } catch {} }
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

function die(msg) { process.stderr.write(clip(String(msg).replace(/\n/g, ' ')) + '\n'); process.exit(1); }

function allocSeq(dir, initial) {
  let n = 1;
  try { n = parseInt(fs.readFileSync(path.join(dir, 'next'), 'utf8').trim(), 10); } catch {}
  if (!(n > 0)) n = 1;
  for (;; n++) {
    let fd;
    try { fd = fs.openSync(path.join(dir, `${n}.json`), 'wx', 0o600); } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    fs.writeSync(fd, JSON.stringify({ seq: n, ...initial(n) }));
    fs.closeSync(fd);
    try { fs.writeFileSync(path.join(dir, 'next'), String(n + 1)); } catch {}
    return n;
  }
}

function orphanChild(dir, lock) {
  if (!lock || !Number.isInteger(lock.seq)) return null;
  const rec = readJson(path.join(dir, `${lock.seq}.json`));
  if (!rec || rec.outcome !== 'running' || !Number.isInteger(rec.childPid) || rec.childPid <= 0) return null;
  return isAlive(rec.childPid) ? rec.childPid : null;
}

function inflightRefusal(dir, lock, ctx, orphan = null) {
  const seq = lock.seq == null ? '?' : lock.seq;
  const tail = orphan
    ? `its clodexctl (pid ${orphan}) is still running; the worker (pid ${lock.pid}) is gone; log `
    : 'wait for its result dm; log ';
  const head = `refused: run ${seq} is in flight on ${ctx} (${lock.verb || '?'}, started ${hhmmss(lock.startedAt)}, seat ${lock.seat || '?'}) — ${tail}`;
  let log = path.join(dir, `${seq}.log`);
  if (head.length + log.length > MAX_LINE) log = '…' + log.slice(log.length - Math.max(0, MAX_LINE - head.length - 1));
  return head + log;
}

function claimLock(lockFile, seq, pid) {
  const held = readJson(lockFile);
  if (held && held.seq === seq && held.pid !== pid) writeJson(lockFile, { ...held, pid });
}

function takeLock(dir, ctx, lock) {
  const file = path.join(dir, `${ctx}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readJson(file);
      if (held && isAlive(held.pid)) refuse(inflightRefusal(dir, held, ctx));
      const orphan = orphanChild(dir, held);
      if (orphan) refuse(inflightRefusal(dir, held, ctx, orphan));
      if (attempt === 1) refuse(inflightRefusal(dir, held || {}, ctx));
      try { fs.unlinkSync(file); } catch {}
    }
  }
  return file;
}

function runHelp(args) {
  const words = helpWords(args);
  const r = childProcess.spawnSync(process.env.CLODEX_NODE, [process.env.CLODEX_CTL, 'help', ...words], {
    env: childEnv(process.env), encoding: 'utf8', timeout: 8000,
  });
  if (r.error) refuse(`refused: clodexctl help failed (${r.error.message})`);
  if (r.status !== 0) {
    const lines = String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    refuse(lines.length ? lines[lines.length - 1] : `refused: clodexctl help exited ${r.status == null ? r.signal : r.status}`);
  }
  process.stderr.write(`${String(r.stdout || '').replace(/\s+$/, '')}\n${helpTrailer(words)}\n`);
  process.exit(0);
}

async function runLauncher() {
  const env = process.env;
  const seat = env.CLODEX_SEAT;
  if (!seat || !env.CLODEX_NODE || !env.CLODEX_CTL || !path.isAbsolute(env.CLODEX_CTL) || !env.CLODEX_CTL.endsWith('.js') || !NAME_RE.test(seat)) {
    refuse('refused: this host does not pass CLODEX_SEAT/CLODEX_NODE/CLODEX_CTL to exec commands — restart Clodex on a build with the admin tier');
  }
  let p;
  try { p = JSON.parse(await readStdin()); } catch { p = undefined; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) refuse('refused: payload is not valid JSON');
  const ctx = p.ctx;
  if (typeof ctx !== 'string' || !CTX_RE.test(ctx)) refuse('refused: ctx must be a plain context name ([A-Za-z0-9._-]{1,64})');
  const verb = typeof p.verb === 'string' ? p.verb : String(p.verb);
  if (verb !== 'help' && !Object.hasOwn(VERB_TABLE, verb)) refuse(r4(verb));
  const args = p.args === undefined ? '' : p.args;
  if (typeof args !== 'string' || /[\x00-\x1f\x7f]/.test(args)) refuse('refused: args may not contain control characters');
  if (verb === 'help') return runHelp(args);

  const dir = runsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  await sweep(dir);

  const store = loadStore();
  if (!Object.hasOwn(store.contexts, ctx) || !store.contexts[ctx] || typeof store.contexts[ctx] !== 'object') {
    refuse(`refused: context "${ctx}" is not in ~/.clodex/cli/contexts.json — the enum names it, the operator creates it`);
  }
  const argv = buildArgv(verb, ctx, store.contexts[ctx], tokenize(args));
  const tokens = redactionTokens();
  const shownArgv = argv.map((a) => redact(a, tokens));

  const startedAt = new Date().toISOString();
  const lockFile = takeLock(dir, ctx, { seq: null, pid: process.pid, seat, verb, startedAt });
  let seq;
  try {
    seq = allocSeq(dir, (n) => ({
      ctx, seat, verb, argv: shownArgv, startedAt, launcherPid: process.pid, workerPid: null, childPid: null,
      endedAt: null, exitCode: null, signal: null, outcome: 'running', reason: null, notified: false,
      log: path.join(dir, `${n}.log`),
    }));
  } catch (e) {
    try { fs.unlinkSync(lockFile); } catch {}
    refuse(`refused: could not allocate a run record (${e.message})`);
  }
  const logFile = path.join(dir, `${seq}.log`);
  writeJson(lockFile, { seq, pid: process.pid, seat, verb, startedAt });

  let child;
  try {
    const logFd = fs.openSync(logFile, 'a', 0o600);
    child = childProcess.spawn(process.execPath, [__filename, '--worker'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...env,
        CTLA_SEQ: String(seq), CTLA_CTX: ctx, CTLA_SEAT: seat, CTLA_VERB: verb,
        CTLA_ARGV: JSON.stringify(argv), CTLA_CEILING_MS: String(VERB_TABLE[verb].ceilingMs), CTLA_LOG: logFile,
        CTLA_STARTED: startedAt,
      },
    });
    fs.closeSync(logFd);
    if (!(child.pid > 0)) throw new Error('no pid');
  } catch (e) {
    try { fs.unlinkSync(lockFile); } catch {}
    updateRecord(dir, seq, { outcome: 'failed', reason: `worker spawn failed: ${e.message}`, endedAt: new Date().toISOString(), notified: true });
    refuse(`refused: worker spawn failed (${e.message})`);
  }
  child.unref();
  claimLock(lockFile, seq, child.pid);
  process.stderr.write(
    `run ${seq} started: ${verb} on ${ctx} — progress and the result arrive as dms from ${FROM}; log ${logFile}\n`
    + `argv: clodexctl ${shownArgv.join(' ')}\n`,
  );
  process.exit(0);
}

async function runWorker() {
  const env = process.env;
  const seq = Number(env.CTLA_SEQ);
  const ctx = env.CTLA_CTX;
  const seat = env.CTLA_SEAT;
  const verb = env.CTLA_VERB;
  const argv = JSON.parse(env.CTLA_ARGV || '[]');
  const ceilingMs = Number(env.CTLA_CEILING_MS) || 3 * MIN;
  const logFile = env.CTLA_LOG;
  const dir = path.dirname(logFile);
  const started = Date.now();
  const tag = `[run ${seq} ${verb} ${ctx}]`;
  const heartbeatMs = Number(env.CTLA_HEARTBEAT_MS) > 0 ? Number(env.CTLA_HEARTBEAT_MS) : HEARTBEAT_MS;
  let tokens = redactionTokens();
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const append = (line) => { try { fs.appendFileSync(logFile, line + '\n', { mode: 0o600 }); } catch {} };

  try { updateRecord(dir, seq, { workerPid: process.pid }); } catch {}
  claimLock(path.join(dir, `${ctx}.lock`), seq, process.pid);
  append(`# run ${seq} · ${verb} on ${ctx} · seat ${seat} · started ${new Date(started).toISOString()}`);
  append(`# argv: clodexctl ${argv.map((a) => redact(a, tokens)).join(' ')}`);

  const tail = [];
  let lastLine = '';
  let queue = [];
  let lastSent = 0;
  let flushTimer = null;
  let heartbeatTimer = null;
  let forced = null;
  let spawnFailed = false;
  let closed = false;
  let finished = false;

  const sendPassive = async (body) => {
    lastSent = Date.now();
    armHeartbeat();
    await sendDm(seat, body, true);
  };
  const flush = async () => {
    flushTimer = null;
    if (!queue.length) return;
    const lines = queue;
    queue = [];
    await sendPassive(redact(packDm(tag, lines), tokens));
  };
  function armHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (closed) return;
      sendPassive(`${tag} still running — ${elapsed(Date.now() - started)}; last: ${clip(lastLine, 200)}`);
    }, heartbeatMs);
  }
  const milestone = (line) => {
    queue.push(line);
    if (flushTimer) return;
    flushTimer = setTimeout(flush, Math.max(0, lastSent + THROTTLE_MS - Date.now()));
  };
  const onLine = (stream, raw) => {
    const line = redact(raw, tokens);
    append(`${stamp()} ${stream} ${line}`);
    tail.push(line);
    if (tail.length > 5) tail.shift();
    lastLine = line;
    if (stream === 'out') {
      const m = milestoneOf(line);
      if (m) milestone(m);
    }
  };
  const lineSplitter = (stream) => {
    let buf = '';
    return {
      data: (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          onLine(stream, buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
        }
      },
      end: () => { if (buf) { onLine(stream, buf); buf = ''; } },
    };
  };

  let child = null;
  const killGroup = () => {
    if (!child || !(child.pid > 0)) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, KILL_GRACE_MS).unref();
  };

  let ceilingTimer = null;
  const finish = async (code, signal) => {
    if (finished) return;
    finished = true;
    closed = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    clearTimeout(ceilingTimer);
    tokens = redactionTokens();
    await flush();
    const outcome = spawnFailed ? 'failed' : forced ? 'unknown' : code === 0 ? 'ok' : 'failed';
    const endedAt = new Date().toISOString();
    append(`# exit ${signal || code} (${outcome}) at ${endedAt} after ${elapsed(Date.now() - started)}`);
    const rec = updateRecord(dir, seq, {
      endedAt, exitCode: code, signal: signal || null, outcome, reason: forced ? forced.reason : null, notified: false,
    });
    const lockFile = path.join(dir, `${ctx}.lock`);
    const lock = readJson(lockFile);
    if (lock && lock.seq === seq) { try { fs.unlinkSync(lockFile); } catch {} }
    const body = redact(resultBody(rec, dir, tail), tokens);
    for (let i = 0; i < RESULT_TRIES; i++) {
      if (await sendDm(seat, body)) {
        updateRecord(dir, seq, { notified: true });
        break;
      }
      if (i < RESULT_TRIES - 1) await sleep(RESULT_RETRY_MS);
    }
    process.exit(0);
  };

  const spawnFail = (e) => {
    spawnFailed = true;
    forced = { reason: `clodexctl spawn failed: ${e.message}` };
    finish(null, null);
  };
  try {
    child = childProcess.spawn(env.CLODEX_NODE, [env.CLODEX_CTL, ...argv], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env),
    });
  } catch (e) {
    spawnFail(e);
    return;
  }
  ceilingTimer = setTimeout(() => {
    if (!forced) forced = { reason: `killed at the ${Math.round(ceilingMs / MIN)}m ceiling — the remote may have finished` };
    killGroup();
  }, ceilingMs);
  updateRecord(dir, seq, { childPid: child.pid || null });
  armHeartbeat();
  process.on('SIGTERM', () => {
    if (!forced) forced = { reason: 'worker stopped (SIGTERM)' };
    killGroup();
  });
  const out = lineSplitter('out');
  const err = lineSplitter('err');
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', out.data);
  child.stderr.on('data', err.data);
  child.on('error', (e) => { if (!(child.pid > 0)) spawnFail(e); });
  child.on('close', (code, signal) => {
    out.end();
    err.end();
    finish(code, signal);
  });
}

module.exports = {
  VERB_TABLE, LOCATOR_FLAGS, CREDENTIAL_FLAGS, Refusal,
  tokenize, gate, deployLocator, buildArgv, redact, redactionTokens, renderMilestone, packDm,
  helpWords, helpTrailer, childEnv, sweep, resultBody, logTail, clip,
};
if (require.main !== module) return;

const fail = (e) => die(e instanceof Refusal ? e.message : `refused: ${e && e.message ? e.message : e}`);
if (process.argv.includes('--worker')) {
  runWorker().catch((e) => { process.stderr.write(`worker crashed: ${e && e.stack}\n`); process.exit(1); });
} else if (process.argv.includes('--sweep')) {
  sweep(runsDir()).then(() => process.exit(0), () => process.exit(0));
} else {
  runLauncher().catch(fail);
}
