#!/usr/bin/env node
'use strict';

// clodex-team.js — teams control plane over the exec intent
// (docs/teams-design.md, docs/exec-tools.md). Second clodex tool after
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
  say(`team ${team.name} (root ${team.root}) — roles: ${roles} (*=lead) — live: ${live.length ? live.sort().join(',') : '(none)'}`);
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
  if (action === 'retire') return doRetire(payload);
  die(`unknown action "${action}" (roster|retire)`);
})().catch((e) => die(e.message));
