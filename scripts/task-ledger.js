#!/usr/bin/env node
'use strict';
// task-ledger — read-only per-task cost attribution over Claude Code
// transcripts (docs/teams-design.md, "Making the number real"). Third clodex
// analysis tool after transcript-stats + clodex-monitor; shares transcript-
// stats' corpus facts and dedup discipline.
//
// The convention it reads (teams v1; Bogdan ruling 2026-07-19 — NO clodex
// resource lives inside project repos, so task artifacts moved OUT of the repo
// into the team dir under ~/.clodex): a team is ~/.clodex/teams/<name>/, its
// task artifacts live in ~/.clodex/teams/<name>/tasks/<task-id>/ (spec.md,
// report.md, verdict.md, notes …). A directory under tasks/ = a task exists;
// its name = the task id. The team's manifest (team.json) carries a REQUIRED
// absolute `root` — the project path it manages; the ledger picks the team by
// matching --project against that root (deepest wins), or takes --team.
//
// Attribution v1 — the simplest honest thing: a transcript (a session OR a
// subagent context) counts toward task <id> if any of its tool inputs mention
// the path "teams/<name>/tasks/<id>/" — Read/Write/Edit/MultiEdit file_path or
// a Bash command. Each such context contributes its FULL token usage to the
// task. A context that touches N tasks is counted in each (per-task token sums
// can therefore exceed the corpus total — v1 makes no attempt to split a
// shared context, since a well-shaped task = one context lifecycle and the
// shared case is the exception worth seeing, not hiding). Contexts touching no
// known task land in an (unattributed) bucket — the honesty check on how much
// of the corpus is untraced.
//
// Data source (same as transcript-stats): ~/.claude/projects/<munged-cwd>/*.jsonl
// (munge: "/" and "." → "-"), with subagent (sidechain) traffic in
// <dir>/<sessionId>/subagents/agent-*.jsonl — NOT inline. Each .jsonl file is
// one context. ".bak" snapshots are excluded. Files stream line-by-line
// (they reach tens of MB). The default transcripts dir derives from the team's
// project root; sessions run from a subdir land under a different munge, so
// pass --dir to point at the right corpus in that case.
//
// Transcript facts this relies on (verified 2026-07, shared with
// transcript-stats): assistant records repeat requestId + usage once per
// content block — token sums MUST dedupe by requestId or they inflate 2-3x;
// the model tier is message.model per assistant record.
//
// REOPENED flag (v1 detection, kept deliberately dumb): a task dir contains a
// file named "reopened", OR its spec.md references another task id as a token.
// REOPENED is the honesty check on the routing table — a task re-entering
// after "verified done" carries none of its cost back to the tier choice that
// caused it unless flagged.
//
// Usage: node scripts/task-ledger.js [--project PATH] [--team NAME] [--dir PATH] [--json]

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CLODEX_HOME = process.env.CLODEX_HOME || path.join(os.homedir(), '.clodex');
const TEAMS_DIR = path.join(CLODEX_HOME, 'teams');
const AGENT_NAME_RE = /You are the clodex agent named '([^']+)'/;
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function parseArgs(argv) {
  const opts = { project: process.cwd(), team: null, dir: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--team') opts.team = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: task-ledger.js [--project PATH] [--team NAME] [--dir PATH] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function defaultTranscriptsDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

// --- team resolution --------------------------------------------------------
// Kept dependency-free (matches the sibling exec/analysis scripts, which don't
// require() app modules); mirrors team-manifest.resolveTeam.

function readManifest(name) {
  return JSON.parse(fs.readFileSync(path.join(TEAMS_DIR, name, 'team.json'), 'utf-8'));
}

function cwdInProject(cwd, root) {
  if (!cwd || !root) return false;
  const rel = path.relative(path.resolve(root), path.resolve(cwd));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolve by explicit --team, else the team whose absolute `root` contains
// `project` (deepest wins). Returns { name, root } or null.
function resolveTeam(opts) {
  if (opts.team) {
    let m;
    try { m = readManifest(opts.team); } catch (e) {
      console.error(`--team ${opts.team}: cannot read ${path.join(TEAMS_DIR, opts.team, 'team.json')}: ${e.message}`);
      process.exit(1);
    }
    if (typeof m.root !== 'string' || !path.isAbsolute(m.root)) {
      console.error(`--team ${opts.team}: team.json "root" must be an absolute path`);
      process.exit(1);
    }
    return { name: opts.team, root: m.root };
  }
  const project = path.resolve(opts.project);
  let names;
  try { names = fs.readdirSync(TEAMS_DIR); } catch { return null; }
  let best = null;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let m;
    try { m = readManifest(name); } catch { continue; }
    const root = m && m.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) continue;
    if (cwdInProject(project, root) && (!best || root.length > best.root.length)) best = { name, root };
  }
  return best;
}

// --- task discovery ---------------------------------------------------------

function listTaskDirs(teamName) {
  const base = path.join(TEAMS_DIR, teamName, 'tasks');
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // no tasks/ dir — a team with no tasks yet
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

// Match an id as a whole token so task-1 doesn't hit inside task-12. Id chars
// are the tasks-dir naming set; a match must not abut another id char.
function referencesId(text, id) {
  const esc = id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9._-])${esc}(?![A-Za-z0-9._-])`).test(text);
}

// v1 REOPENED: a "reopened" marker file, or spec.md naming another task id.
function detectReopened(teamName, id, allIds) {
  const dir = path.join(TEAMS_DIR, teamName, 'tasks', id);
  if (fs.existsSync(path.join(dir, 'reopened'))) return true;
  let spec;
  try {
    spec = fs.readFileSync(path.join(dir, 'spec.md'), 'utf8');
  } catch {
    return false;
  }
  return allIds.some((other) => other !== id && referencesId(spec, other));
}

// --- transcript scanning ----------------------------------------------------

function listTranscripts(dir) {
  const main = [];
  const side = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.bak')) {
      main.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name, 'subagents');
      let subs;
      try {
        subs = fs.readdirSync(subDir);
      } catch {
        continue;
      }
      for (const name of subs) {
        if (name.endsWith('.jsonl') && !name.includes('.bak')) side.push(path.join(subDir, name));
      }
    }
  }
  return { main, side };
}

function newContext(file, kind) {
  return {
    file,
    kind,                 // 'session' | 'subagent'
    agent: null,
    mentions: new Set(),  // every tasks/<id> mentioned (id may lack a dir)
    usageByReq: new Map(),// requestId -> { model, usage } (last write wins)
  };
}

// Pull the strings a tool_use exposes for path matching: file_path (read/edit
// family) and command (Bash). Kept to the tools the spec names.
function toolStrings(block) {
  const input = block.input || {};
  const out = [];
  if (FILE_PATH_TOOLS.has(block.name) && typeof input.file_path === 'string') out.push(input.file_path);
  if (block.name === 'Bash' && typeof input.command === 'string') out.push(input.command);
  return out;
}

function collectMentions(ctx, str, taskRe) {
  taskRe.lastIndex = 0;
  let m;
  while ((m = taskRe.exec(str))) ctx.mentions.add(m[1]);
}

function handleRecord(ctx, rec, taskRe) {
  if (rec.type !== 'assistant') return;
  const msg = rec.message || {};
  if (msg.usage) {
    // Dedupe on requestId (fall back to the API message id / uuid) — usage is
    // repeated once per content block.
    const reqKey = rec.requestId || msg.id || rec.uuid;
    if (reqKey) ctx.usageByReq.set(reqKey, { model: msg.model || '(unknown-model)', usage: msg.usage });
  }
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && block.type === 'tool_use') {
        for (const s of toolStrings(block)) collectMentions(ctx, s, taskRe);
      }
    }
  }
}

// Build the path matcher for a resolved team: "teams/<name>/tasks/<id>/" in
// any tool-input string. The <id> capture is bounded by the trailing slash, so
// it's a whole path segment (task-1 can't bleed into task-12). The team name
// is escaped so a regex-special char in it stays literal.
function taskPathRe(teamName) {
  const esc = teamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`teams/${esc}/tasks/([A-Za-z0-9._-]+)/`, 'g');
}

function scanFile(file, ctx, taskRe) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!ctx.agent && line.includes('agent named')) {
        const m = AGENT_NAME_RE.exec(line);
        if (m) ctx.agent = m[1];
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return; // torn/partial line in a live transcript
      }
      handleRecord(ctx, rec, taskRe);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// --- aggregation ------------------------------------------------------------

function newModels() {
  return new Map(); // model -> { input, output, cacheRead, cacheWrite, requests }
}

function bumpModel(models, model, usage) {
  const a = models.get(model) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
  a.input += usage.input_tokens || 0;
  a.output += usage.output_tokens || 0;
  a.cacheRead += usage.cache_read_input_tokens || 0;
  a.cacheWrite += usage.cache_creation_input_tokens || 0;
  a.requests += 1;
  models.set(model, a);
}

function mergeModels(into, from) {
  for (const [model, u] of from) {
    const a = into.get(model) || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    a.input += u.input;
    a.output += u.output;
    a.cacheRead += u.cacheRead;
    a.cacheWrite += u.cacheWrite;
    a.requests += u.requests;
    into.set(model, a);
  }
}

function contextModels(ctx) {
  const models = newModels();
  for (const { model, usage } of ctx.usageByReq.values()) bumpModel(models, model, usage);
  return models;
}

function tierTotal(u) {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

function modelsTotal(models) {
  let n = 0;
  for (const u of models.values()) n += tierTotal(u);
  return n;
}

function requestsOf(models) {
  let n = 0;
  for (const u of models.values()) n += u.requests;
  return n;
}

// --- formatting -------------------------------------------------------------

function fmt(n) {
  return n.toLocaleString('en-US');
}

// claude-haiku-4-5-20251001 -> haiku-4-5 ; keep the version, drop the vendor
// prefix and the trailing date so the tier reads at a glance without lying.
function shortModel(model) {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

function tierStr(models) {
  const parts = [...models.entries()]
    .sort((a, b) => tierTotal(b[1]) - tierTotal(a[1]))
    .map(([m, u]) => `${shortModel(m)}=${fmt(tierTotal(u))}`);
  return parts.length ? parts.join(' ') : '(none)';
}

function modelsJson(models) {
  const out = {};
  for (const [m, u] of [...models.entries()].sort((a, b) => tierTotal(b[1]) - tierTotal(a[1]))) {
    out[shortModel(m)] = {
      total: tierTotal(u), input: u.input, output: u.output,
      cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, requests: u.requests,
    };
  }
  return out;
}

function taskJson(t) {
  return {
    id: t.id,
    reopened: t.reopened,
    contexts: t.contexts,
    requests: requestsOf(t.models),
    tokens: modelsTotal(t.models),
    models: modelsJson(t.models),
  };
}

// --- main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const team = resolveTeam(opts);
  if (!team) {
    console.error(`No team found: no ~/.clodex/teams/*/team.json has a root containing ${path.resolve(opts.project)} (use --team NAME or --project PATH)`);
    process.exit(1);
  }
  // Default corpus derives from the team's project root; sessions run from a
  // subdir munge to a different dir, so --dir overrides.
  const dir = opts.dir ? path.resolve(opts.dir) : defaultTranscriptsDir(team.root);
  if (!fs.existsSync(dir)) {
    console.error(`Transcripts dir not found: ${dir}`);
    process.exit(1);
  }

  const taskRe = taskPathRe(team.name);
  const ids = listTaskDirs(team.name);
  const known = new Set(ids);
  const tasks = new Map();
  for (const id of ids) {
    tasks.set(id, { id, reopened: detectReopened(team.name, id, ids), contexts: 0, models: newModels() });
  }

  const { main: mainFiles, side: sideFiles } = listTranscripts(dir);
  const contexts = [];
  for (const file of mainFiles) {
    const ctx = newContext(file, 'session');
    await scanFile(file, ctx, taskRe);
    contexts.push(ctx);
  }
  for (const file of sideFiles) {
    const ctx = newContext(file, 'subagent');
    await scanFile(file, ctx, taskRe);
    contexts.push(ctx);
  }

  const unattributed = { contexts: 0, models: newModels() };
  const orphanMentions = new Set();
  for (const ctx of contexts) {
    const models = contextModels(ctx);
    const touched = [...ctx.mentions].filter((id) => {
      if (known.has(id)) return true;
      orphanMentions.add(id);
      return false;
    });
    if (!touched.length) {
      unattributed.contexts += 1;
      mergeModels(unattributed.models, models);
      continue;
    }
    for (const id of touched) {
      const t = tasks.get(id);
      t.contexts += 1;
      mergeModels(t.models, models);
    }
  }

  const taskList = [...tasks.values()].sort((a, b) => modelsTotal(b.models) - modelsTotal(a.models) || a.id.localeCompare(b.id));

  if (opts.json) {
    console.log(JSON.stringify({
      team: team.name,
      project: team.root,
      transcriptsDir: dir,
      transcripts: mainFiles.length,
      subagentTranscripts: sideFiles.length,
      contexts: contexts.length,
      tasks: taskList.map(taskJson),
      unattributed: {
        contexts: unattributed.contexts,
        requests: requestsOf(unattributed.models),
        tokens: modelsTotal(unattributed.models),
        models: modelsJson(unattributed.models),
      },
      orphanMentions: [...orphanMentions].sort(),
    }, null, 2));
    return;
  }

  console.log(`team ${team.name} (root ${team.root}) — ${ids.length} task(s), ${mainFiles.length} transcript(s) + ${sideFiles.length} subagent transcript(s) in ${dir}\n`);
  if (!taskList.length) {
    console.log(`  (no task dirs under ~/.clodex/teams/${team.name}/tasks/)`);
  }
  for (const t of taskList) {
    const flag = t.reopened ? ' [REOPENED]' : '';
    const body = t.contexts ? `${tierStr(t.models)}  ctx=${t.contexts}` : '(no attributed contexts)';
    console.log(`  ${t.id}${flag}  ${body}`);
  }
  if (unattributed.contexts) {
    console.log(`\n  (unattributed): ${tierStr(unattributed.models)}  ctx=${unattributed.contexts}`);
  }
  if (orphanMentions.size) {
    console.log(`\n  note: ${orphanMentions.size} task id(s) mentioned in transcripts have no dir: ${[...orphanMentions].sort().join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
