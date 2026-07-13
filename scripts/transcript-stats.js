#!/usr/bin/env node
'use strict';
// transcript-stats — read-only analyzer for Claude Code transcripts of the
// project it's run from. Reports tool-usage patterns per agent and combined:
// tool counts (main-line vs sidechain), hot Read/Edit targets, Bash command
// heads, redundant re-reads (segmented on compact boundaries), token usage,
// first-turn fixed payload, and the "every-session tax" (files Read in the
// most distinct sessions).
//
// Data source: ~/.claude/projects/<munged-cwd>/*.jsonl (munge: "/" and "."
// become "-"). Subagent (sidechain) traffic lives in
// <dir>/<sessionId>/subagents/agent-*.jsonl. Filenames containing ".bak" are
// point-in-time snapshots of live sessions and are excluded. Files are
// streamed line-by-line — they reach tens of MB.
//
// Transcript facts this relies on (verified empirically, 2026-07):
// - Assistant records repeat the same requestId + usage once per content
//   block; token sums and request counts MUST dedupe by requestId.
// - Compact boundary marker: {type:"system", subtype:"compact_boundary"}.
//   A user record with isCompactSummary:true also starts a fresh context
//   (resumed post-compact), so both reset the re-read segment.
// - The agent name arrives via the SessionStart hook as the literal text
//   "You are the clodex agent named '<name>'".
// - CLAUDE.md is persisted as a nested_memory attachment
//   (attachment.content.content) by older CLI versions only; newer versions
//   inject it at request time without writing it to the transcript, so the
//   claudeMd payload figure reports how many sessions actually recorded it.
//
// Usage: node scripts/transcript-stats.js [--top N] [--json] [--agent NAME] [--dir PATH]

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const AGENT_NAME_RE = /You are the clodex agent named '([^']+)'/;
const PROJECT_ROOT = process.cwd();
const BASH_SUBCOMMAND_HEADS = new Set(['git', 'npm', 'node', 'npx']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function parseArgs(argv) {
  const opts = { top: 10, json: false, agent: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--top') opts.top = parseInt(argv[++i], 10);
    else if (a === '--agent') opts.agent = argv[++i];
    else if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: transcript-stats.js [--top N] [--json] [--agent NAME] [--dir PATH]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(opts.top) || opts.top < 1) {
    console.error('--top requires a positive integer');
    process.exit(1);
  }
  return opts;
}

function defaultTranscriptsDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
}

function newSession(id) {
  return {
    id,
    agent: null,
    tools: new Map(),           // tool name -> count (main-line)
    sideTools: new Map(),       // tool name -> count (sidechain)
    reads: new Map(),           // file_path -> Read count
    edits: new Map(),           // file_path -> Edit/Write count
    bash: new Map(),            // command head -> count
    // Same-file re-Reads within a compact segment, classified: pagination
    // (new offset = new bytes) is legitimate, not waste — only identical-args
    // and full-after-prior count as redundant.
    rereadPaginated: 0,         // offset differs from every prior read of the file
    rereadIdentical: 0,         // exact same offset/limit slice again
    rereadFullAfterPrior: 0,    // whole-file read when the file was already read
    compacts: 0,
    userTurns: 0,
    bashCalls: 0,
    cdRoot: 0,                  // Bash commands that cd into the project root
    usageByReq: new Map(),      // requestId -> usage (last write wins)
    sideRequests: 0,
    sideUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    claudeMdBytes: 0,           // nested_memory CLAUDE.md payload, when persisted
    firstTurnHookBytes: 0,      // SessionStart hook payloads before the first user turn
    firstTurnListingBytes: 0,   // skill/agent listings before the first user turn
    _seenReads: new Map(),      // file_path -> Set of "offset|limit" slices read
    _sideReqs: new Set(),
    _sawAssistant: false,
  };
}

function bump(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

function bashHead(command) {
  const tokens = command.trim().split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (!tokens.length) return '(empty)';
  let head = tokens[0];
  if (BASH_SUBCOMMAND_HEADS.has(head) && tokens[1] && !tokens[1].startsWith('-')) {
    head += ` ${tokens[1]}`;
  }
  return head;
}

// A "user turn" is a real prompt: not meta, not a tool_result round-trip, not
// a slash-command echo, not a compact summary.
function isUserTurn(rec) {
  if (rec.isMeta || rec.isCompactSummary) return false;
  const content = rec.message && rec.message.content;
  if (typeof content === 'string') {
    return !content.startsWith('<command-') && !content.startsWith('<local-command');
  }
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return false;
    const text = content.find((b) => b && b.type === 'text');
    return !!text && !text.text.startsWith('<command-') && !text.text.startsWith('<local-command');
  }
  return false;
}

function recordToolUse(s, block, sidechain, root) {
  bump(sidechain ? s.sideTools : s.tools, block.name || '(unnamed)');
  if (sidechain) return; // file/bash detail is tracked main-line only
  const input = block.input || {};
  if (block.name === 'Read' && typeof input.file_path === 'string') {
    bump(s.reads, input.file_path);
    const slice = `${input.offset ?? ''}|${input.limit ?? ''}`;
    const prior = s._seenReads.get(input.file_path);
    if (prior) {
      if (prior.has(slice)) s.rereadIdentical += 1;
      else if (input.offset == null) s.rereadFullAfterPrior += 1;
      else s.rereadPaginated += 1;
      prior.add(slice);
    } else {
      s._seenReads.set(input.file_path, new Set([slice]));
    }
  } else if (EDIT_TOOLS.has(block.name) && typeof input.file_path === 'string') {
    bump(s.edits, input.file_path);
  } else if (block.name === 'Bash' && typeof input.command === 'string') {
    s.bashCalls += 1;
    bump(s.bash, bashHead(input.command));
    if (cdIntoRoot(input.command, root)) s.cdRoot += 1;
  }
}

// True when the command starts by cd-ing into the project root ("cd <root>"
// or "cd <root> && ..."), the no-op pattern that re-bills as tokens. The
// root is the record's own cwd (the Bash tool starts every command there).
function cdIntoRoot(command, root) {
  const m = /^\s*cd\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  if (!m) return false;
  let target = (m[2] || m[3] || m[4] || '').replace(/[;&|]+$/, '');
  if (!target || target.startsWith('-')) return false;
  if (target === '~' || target.startsWith('~/')) target = os.homedir() + target.slice(1);
  return path.resolve(root, target) === root;
}

function handleRecord(s, rec, sidechain) {
  const { type } = rec;
  if (type === 'system') {
    if (rec.subtype === 'compact_boundary') {
      s.compacts += 1;
      s._seenReads.clear();
    }
    return;
  }
  if (type === 'attachment') {
    if (sidechain) return;
    const att = rec.attachment || {};
    if (att.type === 'nested_memory') {
      // CLAUDE.md payload; not position-gated — some CLI versions write it
      // after the first assistant record.
      const body = att.content && att.content.content;
      if (typeof body === 'string') {
        s.claudeMdBytes = Math.max(s.claudeMdBytes, Buffer.byteLength(body, 'utf8'));
      }
    } else if (!s._sawAssistant) {
      // hook payloads and listings attached to the first turn (they land
      // between the first user record and the first assistant response)
      if (att.type === 'hook_success' || att.type === 'hook_additional_context') {
        s.firstTurnHookBytes += Buffer.byteLength(JSON.stringify(att.content ?? att.stdout ?? ''), 'utf8');
      } else if (att.type === 'skill_listing' || att.type === 'agent_listing_delta') {
        s.firstTurnListingBytes += Buffer.byteLength(JSON.stringify(att), 'utf8');
      }
    }
    return;
  }
  if (type === 'user') {
    if (rec.isCompactSummary) s._seenReads.clear();
    if (!sidechain && isUserTurn(rec)) s.userTurns += 1;
    return;
  }
  if (type !== 'assistant') return;
  if (!sidechain) s._sawAssistant = true;
  const msg = rec.message || {};
  if (msg.usage) {
    // Assistant records repeat requestId + usage once per content block —
    // dedupe on requestId (falling back to the API message id).
    const reqKey = rec.requestId || msg.id || rec.uuid;
    if (sidechain) {
      if (reqKey && !s._sideReqs.has(reqKey)) {
        s._sideReqs.add(reqKey);
        s.sideRequests += 1;
        for (const k of Object.keys(s.sideUsage)) s.sideUsage[k] += msg.usage[k] || 0;
      }
    } else if (reqKey) {
      s.usageByReq.set(reqKey, msg.usage);
    }
  }
  if (Array.isArray(msg.content)) {
    const root = rec.cwd || PROJECT_ROOT;
    for (const block of msg.content) {
      if (block && block.type === 'tool_use') recordToolUse(s, block, sidechain, root);
    }
  }
}

function scanFile(file, s, sidechain) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!s.agent && line.includes('agent named')) {
        const m = AGENT_NAME_RE.exec(line);
        if (m) s.agent = m[1];
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return; // torn/partial line in a live transcript
      }
      handleRecord(s, rec, sidechain);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

function listTranscripts(dir) {
  const main = [];
  const side = []; // { file, sessionId }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.bak')) {
      main.push({ file: path.join(dir, entry.name), sessionId: entry.name.slice(0, -'.jsonl'.length) });
    } else if (entry.isDirectory()) {
      const subDir = path.join(dir, entry.name, 'subagents');
      let subs;
      try {
        subs = fs.readdirSync(subDir);
      } catch {
        continue;
      }
      for (const name of subs) {
        if (name.endsWith('.jsonl') && !name.includes('.bak')) {
          side.push({ file: path.join(subDir, name), sessionId: entry.name });
        }
      }
    }
  }
  return { main, side };
}

function sessionRequests(s) {
  return s.usageByReq.size;
}

function sessionUsage(s) {
  const sum = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  for (const usage of s.usageByReq.values()) {
    for (const k of Object.keys(sum)) sum[k] += usage[k] || 0;
  }
  return sum;
}

function newAggregate() {
  return {
    sessions: 0,
    userTurns: 0,
    requests: 0,
    sideRequests: 0,
    compacts: 0,
    rereadPaginated: 0,
    rereadIdentical: 0,
    rereadFullAfterPrior: 0,
    totalReads: 0,
    bashCalls: 0,
    cdRoot: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    sideUsage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    tools: new Map(),
    sideTools: new Map(),
    reads: new Map(),
    edits: new Map(),
    bash: new Map(),
    claudeMdSessions: 0,
    claudeMdMaxBytes: 0,
    hookBytesMax: 0,
    listingBytesMax: 0,
  };
}

function mergeInto(agg, s) {
  agg.sessions += 1;
  agg.userTurns += s.userTurns;
  agg.requests += sessionRequests(s);
  agg.sideRequests += s.sideRequests;
  agg.compacts += s.compacts;
  agg.rereadPaginated += s.rereadPaginated;
  agg.rereadIdentical += s.rereadIdentical;
  agg.rereadFullAfterPrior += s.rereadFullAfterPrior;
  agg.bashCalls += s.bashCalls;
  agg.cdRoot += s.cdRoot;
  const usage = sessionUsage(s);
  for (const k of Object.keys(agg.usage)) {
    agg.usage[k] += usage[k];
    agg.sideUsage[k] += s.sideUsage[k];
  }
  for (const [map, from] of [[agg.tools, s.tools], [agg.sideTools, s.sideTools], [agg.reads, s.reads], [agg.edits, s.edits], [agg.bash, s.bash]]) {
    for (const [k, v] of from) bump(map, k, v);
  }
  for (const v of s.reads.values()) agg.totalReads += v;
  if (s.claudeMdBytes) {
    agg.claudeMdSessions += 1;
    agg.claudeMdMaxBytes = Math.max(agg.claudeMdMaxBytes, s.claudeMdBytes);
  }
  agg.hookBytesMax = Math.max(agg.hookBytesMax, s.firstTurnHookBytes);
  agg.listingBytesMax = Math.max(agg.listingBytesMax, s.firstTurnListingBytes);
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function shortPath(p, cwd) {
  if (p.startsWith(cwd + path.sep)) return p.slice(cwd.length + 1);
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.slice(home.length);
  return p;
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function aggregateJson(agg, cwd) {
  const shortKeys = (map) => {
    const out = {};
    for (const [k, v] of [...map.entries()].sort((a, b) => b[1] - a[1])) out[shortPath(k, cwd)] = v;
    return out;
  };
  return {
    sessions: agg.sessions,
    userTurns: agg.userTurns,
    apiRequests: agg.requests,
    sidechainApiRequests: agg.sideRequests,
    compacts: agg.compacts,
    usage: agg.usage,
    sidechainUsage: agg.sideUsage,
    cacheReadPerRequest: agg.requests ? Math.round(agg.usage.cache_read_input_tokens / agg.requests) : 0,
    tools: mapToObject(agg.tools),
    sidechainTools: mapToObject(agg.sideTools),
    reads: shortKeys(agg.reads),
    edits: shortKeys(agg.edits),
    bash: mapToObject(agg.bash),
    rereads: {
      paginated: agg.rereadPaginated,
      identicalArgs: agg.rereadIdentical,
      fullAfterPrior: agg.rereadFullAfterPrior,
      redundant: agg.rereadIdentical + agg.rereadFullAfterPrior,
    },
    totalReads: agg.totalReads,
    bashCalls: agg.bashCalls,
    cdIntoRoot: agg.cdRoot,
    firstTurnPayload: {
      claudeMdMaxBytes: agg.claudeMdMaxBytes,
      claudeMdPersistedSessions: agg.claudeMdSessions,
      hookMaxBytes: agg.hookBytesMax,
      listingMaxBytes: agg.listingBytesMax,
    },
  };
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function printAggregate(label, agg, top, cwd) {
  const mainToolCalls = [...agg.tools.values()].reduce((a, b) => a + b, 0);
  console.log(`=== ${label}: ${agg.sessions} session(s), ${agg.userTurns} user turns, ${fmt(agg.requests)} api requests, ${fmt(mainToolCalls)} main-line tool calls ===`);
  if (agg.requests) {
    const u = agg.usage;
    console.log(`  tokens: in=${fmt(u.input_tokens)} out=${fmt(u.output_tokens)} cache_read=${fmt(u.cache_read_input_tokens)} cache_write=${fmt(u.cache_creation_input_tokens)} (cache_read/req=${fmt(Math.round(u.cache_read_input_tokens / agg.requests))})`);
  }
  if (agg.tools.size) {
    console.log('  tools: ' + topN(agg.tools, top).map(([n, c]) => `${n}=${c}`).join(', '));
  }
  if (agg.sideTools.size) {
    const su = agg.sideUsage;
    console.log(`  sidechain (${fmt(agg.sideRequests)} requests, out=${fmt(su.output_tokens)} tok): ` + topN(agg.sideTools, top).map(([n, c]) => `${n}=${c}`).join(', '));
  }
  if (agg.totalReads) {
    const redundant = agg.rereadIdentical + agg.rereadFullAfterPrior;
    console.log(`  re-reads (same file, same compact segment; ${agg.compacts} compacts): `
      + `paginated=${agg.rereadPaginated} (new bytes, not waste), `
      + `redundant=${redundant} of ${fmt(agg.totalReads)} Reads `
      + `(identical-args=${agg.rereadIdentical}, full-after-prior=${agg.rereadFullAfterPrior})`);
    console.log('  top reads: ' + topN(agg.reads, top).map(([f, c]) => `${shortPath(f, cwd)}×${c}`).join(', '));
  }
  if (agg.cdRoot) {
    console.log(`  cd-into-project-root (no-op): ${agg.cdRoot} of ${fmt(agg.bashCalls)} Bash calls`);
  }
  if (agg.edits.size) {
    console.log('  top edits: ' + topN(agg.edits, top).map(([f, c]) => `${shortPath(f, cwd)}×${c}`).join(', '));
  }
  if (agg.bash.size) {
    console.log('  bash: ' + topN(agg.bash, top).map(([h, c]) => `${h}×${c}`).join(', '));
  }
  const payload = [];
  if (agg.claudeMdMaxBytes) payload.push(`claudeMd ~${fmt(agg.claudeMdMaxBytes)}B (persisted in ${agg.claudeMdSessions}/${agg.sessions} sessions; newer CLIs don't write it)`);
  if (agg.hookBytesMax) payload.push(`SessionStart hooks ~${fmt(agg.hookBytesMax)}B`);
  if (agg.listingBytesMax) payload.push(`skill/agent listings ~${fmt(agg.listingBytesMax)}B`);
  if (payload.length) console.log('  first-turn fixed payload (max/session): ' + payload.join(', '));
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const dir = opts.dir ? path.resolve(opts.dir) : defaultTranscriptsDir(cwd);
  if (!fs.existsSync(dir)) {
    console.error(`Transcripts dir not found: ${dir}`);
    process.exit(1);
  }

  const { main: mainFiles, side: sideFiles } = listTranscripts(dir);
  const sessions = new Map();
  const getSession = (id) => {
    if (!sessions.has(id)) sessions.set(id, newSession(id));
    return sessions.get(id);
  };

  for (const { file, sessionId } of mainFiles) {
    await scanFile(file, getSession(sessionId), false);
  }
  for (const { file, sessionId } of sideFiles) {
    await scanFile(file, getSession(sessionId), true);
  }

  let all = [...sessions.values()];
  if (opts.agent) {
    all = all.filter((s) => (s.agent || '(unlabeled)') === opts.agent);
    if (!all.length) {
      console.error(`No sessions labeled '${opts.agent}'`);
      process.exit(1);
    }
  }

  const byAgent = new Map();
  const combined = newAggregate();
  for (const s of all) {
    const label = s.agent || '(unlabeled)';
    if (!byAgent.has(label)) byAgent.set(label, newAggregate());
    mergeInto(byAgent.get(label), s);
    mergeInto(combined, s);
  }

  // every-session tax: files Read in the most distinct sessions
  const fileSessions = new Map();
  for (const s of all) {
    for (const f of s.reads.keys()) bump(fileSessions, f);
  }
  const tax = topN(fileSessions, opts.top).map(([file, count]) => ({
    file: shortPath(file, cwd),
    sessions: count,
    reads: all.reduce((sum, s) => sum + (s.reads.get(file) || 0), 0),
  }));

  // per-session top offenders — aggregates hide single-session grooves
  const MIN_SAMPLE = 10;
  const sessionLabel = (s) => ({ session: s.id, agent: s.agent || '(unlabeled)' });
  const totalReads = (s) => [...s.reads.values()].reduce((a, b) => a + b, 0);
  const worstReread = all
    .filter((s) => totalReads(s) >= MIN_SAMPLE)
    .map((s) => {
      const redundant = s.rereadIdentical + s.rereadFullAfterPrior;
      return { ...sessionLabel(s), redundant, identicalArgs: s.rereadIdentical,
        fullAfterPrior: s.rereadFullAfterPrior, paginated: s.rereadPaginated,
        reads: totalReads(s), rate: redundant / totalReads(s), compacts: s.compacts };
    })
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
  const worstCdRoot = all
    .filter((s) => s.bashCalls >= MIN_SAMPLE)
    .map((s) => ({ ...sessionLabel(s), cdRoot: s.cdRoot, bashCalls: s.bashCalls, rate: s.cdRoot / s.bashCalls }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);

  const agentOrder = [...byAgent.entries()].sort((a, b) => {
    const calls = (agg) => [...agg.tools.values()].reduce((x, y) => x + y, 0);
    return calls(b[1]) - calls(a[1]);
  });

  if (opts.json) {
    const out = {
      dir,
      transcripts: mainFiles.length,
      subagentTranscripts: sideFiles.length,
      agents: Object.fromEntries(agentOrder.map(([name, agg]) => [name, aggregateJson(agg, cwd)])),
      combined: aggregateJson(combined, cwd),
      everySessionTax: tax,
      worstRereadSessions: worstReread,
      worstCdRootSessions: worstCdRoot,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`${mainFiles.length} transcript(s) + ${sideFiles.length} subagent transcript(s) in ${dir}\n`);
  for (const [name, agg] of agentOrder) printAggregate(name, agg, opts.top, cwd);
  if (agentOrder.length > 1) printAggregate('(combined)', combined, opts.top, cwd);
  console.log(`=== every-session tax: files Read in the most distinct sessions (of ${all.length}) ===`);
  for (const { file, sessions: n, reads } of tax) {
    console.log(`  ${String(n).padStart(3)} session(s)  ${file}  (${reads} Reads total)`);
  }
  if (worstReread.length && worstReread[0].redundant > 0) {
    console.log(`\n=== worst sessions by redundant re-read rate (identical-args + full-after-prior; min ${MIN_SAMPLE} Reads) ===`);
    for (const w of worstReread) {
      if (!w.redundant) continue;
      console.log(`  ${(w.rate * 100).toFixed(0).padStart(3)}%  ${w.redundant}/${w.reads} Reads (identical=${w.identicalArgs}, full-after-prior=${w.fullAfterPrior}, paginated=${w.paginated}), ${w.compacts} compacts  ${w.session}  [${w.agent}]`);
    }
  }
  if (worstCdRoot.length && worstCdRoot[0].cdRoot > 0) {
    console.log(`\n=== worst sessions by cd-into-project-root rate (min ${MIN_SAMPLE} Bash calls) ===`);
    for (const w of worstCdRoot) {
      if (!w.cdRoot) continue;
      console.log(`  ${(w.rate * 100).toFixed(0).padStart(3)}%  ${w.cdRoot}/${w.bashCalls} Bash calls  ${w.session}  [${w.agent}]`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
