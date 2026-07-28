#!/usr/bin/env node
'use strict';

// clodex-team.js — teams control plane over the exec intent
// (teams-design.md [internal design doc, not in this repo], docs/exec-tools.md). Second clodex tool after
// clodex-monitor; same v1 identity convention (the agent self-supplies its
// name as `agent`).
//
// Verbs (message discipline per exec-tools.md — queries reply, command
// success is silent, failures are loud):
//   roster — QUERY. Resolve the team from the requester's cwd (registry
//            entry, payload override) by scanning ~/.clodex/teams/*/team.json
//            for the one whose `root` contains cwd; list roles + the live
//            agents whose registered cwd falls inside that root. One
//            replyStderr line.
//   retire — COMMAND. Deliver a `team-retire` envelope to the TARGET's own
//            socket; the core validates (requester running, same project,
//            no self-retire), archives (resumable), and confirms PASSIVELY.
//            Success here is byte-silent — the confirmation DM is the ack.
//   tickets — QUERY. Ground-truth read of the team's ticket registry
//            (teams/<team>/tickets.json), one line per ticket (id, state,
//            assignee, age, title). Mirrors the [agent:task list] intent but as
//            an on-demand pull (Task 25). One replyStderr line (multi-line body).
//
// Spawn deliberately has no verb: [agent:spawn name:X template:Y] already
// exists and duplicating it here would be ceremony.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');

const CLODEX_HOME = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
// Teams live entirely under ~/.clodex (Bogdan ruling 2026-07-19: zero clodex
// droppings inside project repos). teams/<name>/team.json carries a REQUIRED
// absolute `root` — the project it manages. See team-manifest.js for the model.
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

// Resolve the team owning `cwd`: scan teams/<name>/team.json, keep those whose
// absolute `root` contains cwd, pick the DEEPEST root. Returns
// { name, root, manifest } or null. Mirrors team-manifest.resolveTeam but kept
// dependency-free (exec scripts run standalone; no require() of app modules).
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

// --- verbs ------------------------------------------------------------------

function requesterCwd(payload) {
  // Prefer the registry (written by core at spawn — authoritative); fall back
  // to a payload-supplied cwd for old-core registries without the field.
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
  // Per-role annotation so a lead can resolve role → template and spawn it with
  // the existing [agent:spawn name:X template:Y] intent (spawn stays an intent —
  // no verb here). Compact: `<role>[*](tmpl=<t>,<instantiate>)`. The lead is
  // starred. Parens appear only when there's something beyond the session
  // default — a template and/or a non-session instantiate; a bare session role
  // with no template is just its name. E.g. `lead* worker(tmpl=hand,session)
  // reviewer(subagent)`.
  const roles = Object.entries(manifest.roles || {})
    .map(([r, def]) => {
      const star = r === manifest.lead ? '*' : '';
      const inst = (def && def.instantiate) || 'session';
      const tmpl = def && typeof def.template === 'string' ? def.template : null;
      const parts = [];
      if (tmpl) parts.push(`tmpl=${tmpl}`);
      if (tmpl || inst !== 'session') parts.push(inst);
      return `${r}${star}${parts.length ? `(${parts.join(',')})` : ''}`;
    })
    .join(' ') || '(none)';
  // Live agents in this project: iterate registrations, join by cwd-in-root.
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
// (pot-bin.js materializeExecScripts) and may require node builtins ONLY, so a
// shared module would not resolve at run time.
const TICKET_FILTERS = ['open', 'done', 'cancelled', 'all'];

// Recently-closed window on the default board — MUST match session-manager.js
// RECENT_DONE_MS / RECENT_DONE_CAP, duplicated for the same flat-copy reason.
// The cap is load-bearing: one real day on this team closed 19 tickets, so an
// uncapped 24h window puts back exactly the bloat the open-only default
// removed. Overflow folds into the count line.
const RECENT_DONE_MS = 24 * 60 * 60 * 1000;
const RECENT_DONE_CAP = 10;

// ── Stale-host check (t93) ─────────────────────────────────────────────────
// Duplicated from host-stamp.js for the SAME strict-leaf reason as
// TICKET_FILTERS above: this file is flat-copied into run/bin/, so `require`ing
// a repo module would not resolve at run time. Keep the digest grammar in sync
// with host-stamp.js computeModuleDigest or the two will always disagree and
// report a permanent false stale.
//
// This surface exists SEPARATELY from the task-reply suffix on purpose: this
// script is a fresh process that reads disk on every invocation, so a host too
// old to emit the in-host suffix cannot suppress this line.
//
// But that is a claim about WHO PRINTS the line, not about what it can know.
// An earlier version of this comment said this surface "reports correctly even
// when the running host is itself too old to know this check exists". That was
// FALSE (t94, observed live): the stamp is written by the host at boot, so a
// host that predates t93 leaves no stamp, and with no stamp there is nothing to
// compare — this surface went silent on the exact host whose staleness
// motivated t93. Silence read as "fresh", which is how the wrong conclusion got
// drawn in the first place.
//
// Hence the stamp-less fallback below: it substantiates what it can from the
// live process and says plainly when it cannot.
// Flat top-level *.js only — subdirectories are never descended, so test/,
// renderer/ and the rest are out by construction. (An ignore list here was dead
// code: a directory never passes `\.js$`, and `test.js` never equals `test`.)
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

// ── Stamp-less fallback (t94) ──────────────────────────────────────────────
// Mirrors host-stamp.js bootstrapNotice/changedSince. Duplicated for the same
// strict-leaf reason as the digest above; keep the two in sync.
//
// WHAT THIS MAY AND MAY NOT CLAIM. It is tempting to say a module newer than
// the process start time cannot be loaded by it. That is FALSE here — require()
// is lazy and the main process pulls modules inside function bodies all over
// (session-manager.js's wire/ stack, main.js's ipc-handlers, peer-wiring), so a
// file edited after boot but before its first require IS live. This reports the
// weaker fact it can actually stand behind: the bytes changed after the process
// started, therefore staleness is UNCONFIRMED rather than proven. Do not
// "tighten" the wording into a claim about what the host loaded.
//
// macOS `ps` has no `etimes` and there is no /proc, so `lstart` it is; LC_ALL=C
// because that format carries month and day NAMES.
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
  // The tree the host RUNS FROM, taken from its own argv rather than guessed: a
  // dev host execs electron out of its own checkout. No match means a PACKAGED
  // host, whose sources sit in an immutable asar — genuinely never stale, so
  // the caller stays silent rather than reporting "unknown".
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

// One line, or '' when there is nothing to say.
//
// SILENCE MEANS FRESH, and only fresh. Before t94 it also meant "no stamp, so
// no idea", which is how this surface went quiet on the 14h-old host that
// motivated t93 — the reader took silence as reassurance. The three states are
// now distinct: stamped-and-stale, unstamped-with-evidence, and cannot-tell.
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

// The evidence line for an already-identified host. Split from the discovery
// above so it can be driven directly against a fixture: with discovery baked
// in, the only reachable state is whatever the developer's own machine happens
// to be in, and the speaking path cannot be exercised at all.
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
// SCOPE OF THAT PARITY: it is over what this FUNCTION RENDERS, not over what an
// exec caller receives. The dispatcher delivers only the last stderr line,
// sliced to 200 chars (session-manager.js:3838, pinned at
// test/session-manager.test.js:4231-4243), so an agent running
// [agent:exec clodex-team] {"action":"tickets"} gets the tail line and nothing
// else — no head, no rows, no recent section. That has been true of this
// listing since t80; the rows below are written for a reader who can see the
// whole string, which today means the terminal and the test suite.
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
  const row = (t) =>
    `${t.id} [${t.state}] ${t.assignee || '—'} ${humanizeAge(now - (t.openedAt || now))} — ${t.title || '(untitled)'}`;
  // Sorted by closedAt, so it shows closedAt — see _taskList.
  const closedRow = (t) =>
    `${t.id} [${t.state}] ${t.assignee || '—'} closed ${humanizeAge(now - t.closedAt)} ago — ${t.title || '(untitled)'}`;
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
    ? `\n(${over > 0 ? `+${over} more done in the last 24h; ` : ''}${doneAll.length} done, ${cancelledAll.length} cancelled`
      + ' — ask for filter "done", "cancelled" or "all")'
    : '';
  const head = filter === 'open' ? `team ${team.name} tickets` : `team ${team.name} tickets [${filter}]`;
  // The stale notice goes BEFORE the tail, not after it. The exec dispatcher
  // delivers only the LAST stderr line (session-manager.js:3838), so whatever
  // ends this string is the entire reply the caller sees — and appending the
  // notice meant a stale host cost them the counts as well.
  //
  // KNOWN CONSEQUENCE, and it is a trade rather than a fix: the notice is now
  // the line that gets dropped instead. Both orderings lose something because
  // one line cannot carry two messages; only a multi-line reply removes the
  // choice. doRoster has the identical shape and is deliberately left alone.
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
  if (!target || !/^[a-zA-Z0-9._-]{1,64}$/.test(target)) die('retire needs "target": a session name');
  let info;
  try {
    info = registryEntry(target);
  } catch {
    die(`no live registration for "${target}" — not running (already retired?)`);
  }
  try {
    // Core validates project membership and confirms passively; a refusal
    // arrives as a waking DM from clodex-team. Silence here = request sent.
    await sendEnvelope(info.socket, { from: payload.agent, body: '', type: 'team-retire' });
  } catch (e) {
    die(`could not reach "${target}" socket: ${e.message}`);
  }
  process.exit(0);
}

// --- main -------------------------------------------------------------------

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
  if (!agent || !/^[a-zA-Z0-9._-]{1,64}$/.test(agent)) die('payload needs "agent": your session name');
  if (action === 'roster') return doRoster(payload);
  if (action === 'tickets') return doTickets(payload);
  if (action === 'retire') return doRetire(payload);
  die(`unknown action "${action}" (roster|tickets|retire)`);
})().catch((e) => die(e.message));
