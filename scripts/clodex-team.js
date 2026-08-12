#!/usr/bin/env node
'use strict';


const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const CLODEX_HOME = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
const TEAMS_DIR = path.join(CLODEX_HOME, 'teams');

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}
function say(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(0);
}

function registryEntry(agent) {
  const regPath = path.join(CLODEX_HOME, 'run', agent, 'agent.json');
  return JSON.parse(fs.readFileSync(regPath, 'utf-8'));
}

function cwdInProject(cwd, root) {
  if (!cwd || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveTeam(cwd) {
  if (!cwd) return null;
  let names;
  try { names = fs.readdirSync(TEAMS_DIR); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, name, 'team.json'), 'utf-8'));
    } catch { continue; } // absent/unreadable/invalid — not a candidate
    const root = manifest && manifest.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    if (cwdInProject(cwd, root) && (!best || root.length > best.root.length)) {
      best = { name, root, manifest };
    }
  }
  return best;
}

// Deliver one envelope to an agent's socket. Envelope shape must match what
// Transport's receiver decodes: single JSON write, then end.
function sendEnvelope(socketPath, envelope) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath, () => {
      conn.end(JSON.stringify(envelope));
    });
    conn.on('close', resolve);
    conn.on('error', reject);
  });
}


function requesterCwd(payload) {
  try {
    const cwd = registryEntry(payload.agent).cwd;
    if (cwd) return cwd;
  } catch { /* fall through */ }
  return payload.cwd || null;
}

function doRoster(payload) {
  const cwd = requesterCwd(payload);
  if (!cwd) die(`cannot resolve your cwd — registry has no cwd field (app predates it); pass "cwd" in the payload`);
  const team = resolveTeam(cwd);
  if (!team) say(`no project: no team under ${TEAMS_DIR} has a root containing ${cwd}`);
  const manifest = team.manifest;
  const roles = Object.entries(manifest.roles || {})
    .map(([r, def]) => {
      const star = r === manifest.lead ? '*' : '';
      const tmpl = def && typeof def.template === 'string' ? def.template : null;
      return `${r}${star}${tmpl ? `(tmpl=${tmpl})` : ''}`;
    })
    .join(' ') || '(none)';
  const live = [];
  let runDirs = [];
  try { runDirs = fs.readdirSync(path.join(CLODEX_HOME, 'run')); } catch {}
  for (const name of runDirs) {
    if (name.startsWith('.')) continue;
    try {
      const info = registryEntry(name);
      if (info.cwd && cwdInProject(info.cwd, team.root)) live.push(info.name);
    } catch { /* not a registration */ }
  }
  say(`team ${team.name} (root ${team.root}) — roles: ${roles} (*=lead) — live: ${live.length ? live.sort().join(',') : '(none)'}${staleHostLine()}`);
}

function humanizeAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

// Filter vocabulary — MUST match session-manager.js TICKET_FILTERS. Duplicated,
// not shared: this script is materialized into run/bin/ as a flat basename copy
// (bin-materialize.js materializeExecScripts) and may require node builtins ONLY, so a
// shared module would not resolve at run time.
const TICKET_FILTERS = ['open', 'done', 'cancelled', 'all'];

// Recently-closed window on the default board — MUST match session-manager.js
// RECENT_DONE_MS / RECENT_DONE_CAP, duplicated for the same flat-copy reason.
// The cap is load-bearing: one real day on this team closed 19 tickets, so an
// uncapped 24h window puts back exactly the bloat the open-only default
// removed. Overflow folds into the count line.
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;
const RECENT_DONE_LABEL = `${RECENT_DONE_MS / (60 * 60 * 1000)}h`;

    // Digest grammar must stay in sync with host-stamp.js computeModuleDigest —
    // this file is flat-copied into run/bin/ and cannot require it, and any
    // divergence reports a permanent false stale. Flat top-level *.js only;
    // subdirectories are never descended.
function hostModuleDigest(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const parts = [];
  for (const name of names.sort()) {
    if (!/\.js$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) parts.push(`${name}:${Math.round(st.mtimeMs)}:${st.size}`);
    } catch { /* vanished mid-scan */ }
  }
  return parts.length ? parts.join('|') : null;
}

    // macOS `ps` has no `etimes` and there is no /proc, so `lstart` it is; LC_ALL=C
    // because that format carries month and day NAMES.
    // A module newer than the process start time may still be live — require() is
    // lazy — so this evidence means UNCONFIRMED, never proven, staleness.
function hostProcess(pid) {
  let out;
  try {
    out = require('child_process').execFileSync('ps', ['-o', 'lstart=,args=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' },
    });
  } catch { return null; } // dead pid or no ps — no evidence either way
  const m = /^\s*(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(String(out).trim());
  if (!m) return null;
  const startedAt = new Date(m[1]).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const root = /^(.*?)\/node_modules\/electron\/dist\//.exec(m[2]);
  return { pid, startedAt, root: root ? root[1] : null, packaged: !root };
}

// The one live host, found WITHOUT its cooperation: every agent registration
// records the main process's pid (agent-transport.js), and a pre-t93 host
// cooperated in nothing else.
function liveHost() {
  let names = [];
  try { names = fs.readdirSync(path.join(CLODEX_HOME, 'run')); } catch { return null; }
  const seen = new Set();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(path.join(CLODEX_HOME, 'run', name, 'agent.json'), 'utf8')).pid;
    } catch { continue; }
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    const proc = hostProcess(pid);
    if (proc) return proc;
  }
  return null;
}

function staleHostLine() {
  try {
    let stamp = null;
    try {
      stamp = JSON.parse(fs.readFileSync(path.join(CLODEX_HOME, 'run', '.host.json'), 'utf8'));
    } catch { /* no stamp — fall through to the evidence path */ }

    if (stamp && typeof stamp.digest === 'string' && typeof stamp.dir === 'string') {
      const current = hostModuleDigest(stamp.dir);
      if (!current || current === stamp.digest) return '';
      const age = typeof stamp.bootedAt === 'number' ? ` ${humanizeAge(Date.now() - stamp.bootedAt)} ago` : '';
      return `\n(STALE HOST: pid ${stamp.pid} booted${age} from OLDER code than is on disk`
        + ' — merged fixes are NOT live until the app is restarted)';
    }

    return staleHostLineFor(liveHost());
  } catch { return ''; }
}

function staleHostLineFor(host) {
  if (!host) return '';           // no running host at all: nothing can be stale
  if (host.packaged) return '';   // asar bytes cannot change post-boot
  let names;
  try { names = fs.readdirSync(host.root); } catch {
    return `\n(HOST UNKNOWN: pid ${host.pid} has no boot stamp and ${host.root} could not be read`
      + ' — cannot tell whether it is running current code)';
  }
  const changed = [];
  for (const name of names.sort()) {
    if (!/\.js$/.test(name)) continue;
    try {
      const st = fs.statSync(path.join(host.root, name));
      if (st.isFile() && st.mtimeMs > host.startedAt) changed.push(name);
    } catch { /* vanished mid-scan */ }
  }
  if (!changed.length) return '';
  const shown = changed.slice(0, 3).join(', ');
  return `\n(HOST MAY BE STALE: ${changed.length} module${changed.length === 1 ? '' : 's'} changed since`
    + ` pid ${host.pid} started ${humanizeAge(Date.now() - host.startedAt)} ago`
    + ` — ${shown}${changed.length > 3 ? ', ...' : ''}.`
    + ' No boot stamp (this host predates the check), so staleness is UNCONFIRMED;'
    + ' restart the app if a fix you expect to be live is not)';
}

// Mirror of session-manager.js _taskList — same default (open, plus a capped
// recently-closed-done section and a tail counting done and cancelled
// separately), same filter set, same bounce. The two must change together or
// the intent path and the exec pull disagree about what the board looks like.
//
// Identical CONTENT, not identical bytes: each names the query for the rest in
// its own caller's vocabulary (intent syntax there, payload syntax here). Which
// tickets appear, in which section, and the counts — that is the parity.
//
// An exec caller receives this listing WHOLE only because the def opts into a
// widened reply (`replyMaxBytes` in resources/library/exec/clodex-team.json);
// the dispatcher's default is the last stderr line sliced to 200 chars, which
// for a board is the footer and nothing else. So the rows below are written for
// a reader who sees the whole string, and that is only true while the def keeps
// its cap above what this renders — `filter: "all"` already exceeds it and comes
// back clamped: head rows, a dropped-lines note, and this function's LAST line,
// which is why the counts belong there and the stale notice ahead of them.
//
// Cited by NAME, not by line: this comment carried a line range for exactly one
// commit before the range pointed at unrelated code (t105).
function doTickets(payload) {
  const cwd = requesterCwd(payload);
  if (!cwd) die(`cannot resolve your cwd — registry has no cwd field (app predates it); pass "cwd" in the payload`);
  const team = resolveTeam(cwd);
  if (!team) say(`no project: no team under ${TEAMS_DIR} has a root containing ${cwd}`);
  const filter = payload.filter || 'open';
  if (!TICKET_FILTERS.includes(filter)) {
    die(`unknown filter "${filter}" — use one of: ${TICKET_FILTERS.join(', ')}`);
  }
  let tickets = [];
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, team.name, 'tickets.json'), 'utf-8'));
    if (Array.isArray(arr)) tickets = arr;
  } catch { /* no registry yet — empty */ }
  if (!tickets.length) say(`team ${team.name}: no tickets`);
  tickets.sort((a, b) => {
    const na = Number(String(a.id).replace(/^t/, '')) || 0;
    const nb = Number(String(b.id).replace(/^t/, '')) || 0;
    return na - nb;
  });
  const shown = filter === 'all' ? tickets : tickets.filter((t) => t.state === filter);
  const now = Date.now();
  // Mirrors _taskList's `shownFor`: `assignee` is a delivery-time pin to a
  // concrete seat, while the ROLE is what the lead filed the ticket under and
  // what the board reads as. Rendering the pin here would make this leaf and the
  // intent board name different things for the same ticket.
  const shownFor = (t) => t.role || t.assignee || '—';
  const row = (t) =>
    `${t.id} [${t.state}${t.parked ? ' parked' : ''}] ${shownFor(t)} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}`;
  const closedRow = (t) =>
    `${t.id} [${t.state}] ${shownFor(t)} closed ${humanizeAge(now - t.closedAt)} ago — ${t.title || '(untitled)'}`;
  const lines = shown.map(row);
  const closed = filter === 'open' ? tickets.filter((t) => t.state !== 'open') : [];
  const doneAll = closed.filter((t) => t.state === 'done');
  const recentAll = doneAll
    .filter((t) => t.closedAt && now - t.closedAt < RECENT_DONE_MS)
    .sort((a, b) => b.closedAt - a.closedAt);
  const recent = recentAll.slice(0, RECENT_DONE_CAP);
  const over = recentAll.length - recent.length;
  const recentBlock = recent.length ? `\nrecently closed:\n${recent.map(closedRow).join('\n')}` : '';
  const cancelledAll = closed.filter((t) => t.state === 'cancelled');
  const tail = closed.length
    ? `\n(${over > 0 ? `+${over} more done in the last ${RECENT_DONE_LABEL}; ` : ''}${doneAll.length} done, ${cancelledAll.length} cancelled`
      + ' — ask for filter "done", "cancelled" or "all")'
    : '';
  const head = filter === 'open' ? `team ${team.name} tickets` : `team ${team.name} tickets [${filter}]`;
      // Stale notice goes BEFORE the tail so the counts stay last: the clamp
      // retains the final line, so the counts survive a board that overflows.
  const stale = staleHostLine();
  if (!shown.length) {
    say(closed.length
      ? `team ${team.name}: no open tickets${recentBlock}${stale}${tail}`
      : `team ${team.name}: no ${filter} tickets${stale}`);
  }
  say(`${head}:\n${lines.join('\n')}${recentBlock}${stale}${tail}`);
}

async function doRetire(payload) {
  const target = payload.target;
  if (!target || !/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(target)) die('retire needs "target": a session name');
  let info;
  try {
    info = registryEntry(target);
  } catch {
    die(`no live registration for "${target}" — not running (already retired?)`);
  }
  try {
    await sendEnvelope(info.socket, { from: payload.agent, body: '', type: 'team-retire' });
  } catch (e) {
    die(`could not reach "${target}" socket: ${e.message}`);
  }
  process.exit(0);
}


(async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    die(`payload is not JSON: ${e.message}`);
  }
  const { action, agent } = payload;
  if (!agent || !/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/.test(agent)) die('payload needs "agent": your session name');
  if (action === 'roster') return doRoster(payload);
  if (action === 'tickets') return doTickets(payload);
  if (action === 'retire') return doRetire(payload);
  die(`unknown action "${action}" (roster|tickets|retire)`);
})().catch((e) => die(e.message));
