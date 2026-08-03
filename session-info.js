'use strict';

// session-info.js — the ⓘ panel's data layer: everything Clodex already knows
// about one session, gathered on demand rather than polled.
//
// Three scopes of cost exist and they are NOT interchangeable (07-15 operator
// ruling, after three surfaces showed three different numbers under near-
// identical labels). This module names all three and never collapses them:
//   run       — wirescope's per-registration figure, zeroes when the CLI process
//               spawns (payload.costRun)
//   session   — the persisted ledger for the CURRENT session_id, additive across
//               app restarts, reset by /clear (which mints a new id)
//   agent     — every session_id this NAME has ever held, summed. The number
//               Bogdan asked for: monotonic from the seat's creation.
//
// Seams are injected (fs/readline/homedir/paths) so the whole thing is testable
// without booting Electron. Nothing here writes.

const path = require('path');

// The name→session_id history. `sessionIds` is appended by persistence.setSessionId
// on every CHANGE, so the CURRENT id is in it only if the session has rolled at
// least once — an entry that never cleared has a live sessionId and an empty
// history. Union, not concat.
function trackedSessionIds(entry) {
  const out = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id)) { seen.add(id); out.push(id); } };
  if (Array.isArray(entry && entry.sessionIds)) for (const id of entry.sessionIds) add(id);
  add(entry && entry.sessionId);
  return out;
}

// Sum the persisted per-session ledger across a name's whole history.
//
// `live` overrides the entry for the CURRENT id: wire-totals.json is written on
// a 1s debounce, so the file trails the payload by up to a turn — and the agent
// total is the one number that must never appear to go DOWN between two opens
// of the panel.
//
// `known` counts ids the ledger could actually answer for. It is reported rather
// than hidden because wire-totals.json keeps only the newest 500 sessions
// (wire-telemetry.js `_save`): an old seat's earliest spend is genuinely gone,
// and a total that silently omits it would read as authoritative.
function sumAgentCost(totals, sids, { currentId = null, live = null } = {}) {
  const sessions = (totals && totals.sessions) || {};
  let usd = 0, requests = 0, turns = 0, refusals = 0, known = 0;
  for (const sid of sids) {
    const useLive = live && sid === currentId;
    const v = useLive ? live : sessions[sid];
    if (!v) continue;
    known++;
    if (typeof v.cost === 'number') usd += v.cost;
    if (typeof v.requests === 'number') requests += v.requests;
    if (typeof v.turns === 'number') turns += v.turns;
    if (typeof v.refusals === 'number') refusals += v.refusals;
  }
  // round6 mirrors billing.js — summing round6 values keeps them exact.
  return { usd: Math.round(usd * 1e6) / 1e6, requests, turns, refusals, known, total: sids.length };
}

// Derived view of the compact boundaries a transcript scan found. `dropped` is
// read off the LAST boundary's cumulativeDroppedTokens rather than summed from
// pre−post: the CLI reports it as a running total, so summing double-counts.
function compactSummary(boundaries) {
  const n = boundaries.length;
  if (!n) return { count: 0, dropped: null, last: null, autoCount: 0 };
  const last = boundaries[n - 1];
  let autoCount = 0;
  for (const b of boundaries) if (b.trigger && b.trigger !== 'manual') autoCount++;
  return {
    count: n,
    dropped: typeof last.cumulativeDroppedTokens === 'number' ? last.cumulativeDroppedTokens : null,
    last: { pre: last.preTokens ?? null, post: last.postTokens ?? null, trigger: last.trigger || null, ts: last.ts || null },
    autoCount,
  };
}

function createSessionInfo({ fs, readline, homedir, pathFor, registryDir, userDataPath }) {
  const totalsFile = path.join(userDataPath, 'wire-totals.json');

  function readTotals() {
    try { return JSON.parse(fs.readFileSync(totalsFile, 'utf8')); }
    catch { return { sessions: {} }; }
  }

  function projectDir(cwd) {
    if (!cwd) return null;
    return path.join(homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));
  }

  // The live transcript, via the symlink Clodex owns rather than by composing
  // <slug>/<sessionId>.jsonl: the slug munge is the CLI's convention, and a
  // session resumed from another directory would compose a path that does not
  // exist. Falls back to the composed path when the symlink is missing (a
  // session restored but not yet respawned).
  function transcriptPath(name, entry) {
    try {
      const p = fs.realpathSync(pathFor(registryDir, name, 'transcript'));
      if (p) return p;
    } catch { /* no symlink yet */ }
    const dir = projectDir(entry && entry.cwd);
    if (!dir || !entry || !entry.sessionId) return null;
    return path.join(dir, `${entry.sessionId}.jsonl`);
  }

  // Streaming, NOT readFileSync: these transcripts reach 70MB and this runs on
  // the main thread with the UI waiting. Measured 157ms streamed for 70MB/31k
  // lines, against ~1.5s and a full copy in memory for the sync read.
  //
  // Only lines already containing the marker are parsed — JSON.parse on every
  // line of a 70MB file is the whole cost of the scan, and a substring test
  // rejects >99% of them. The marker is checked again after parsing because
  // the raw string also occurs inside assistant prose quoting it.
  function scanTranscript(file) {
    return new Promise((resolve) => {
      const out = { boundaries: [], lines: 0, bytes: null, firstTs: null, lastTs: null, ok: false };
      if (!file) return resolve(out);
      let stream;
      try {
        out.bytes = fs.statSync(file).size;
        stream = fs.createReadStream(file, { encoding: 'utf8' });
      } catch { return resolve(out); }
      stream.on('error', () => resolve(out));
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      // Held rather than parsed per line: the LAST timestamp needs exactly one
      // parse, at close, and parsing every line to keep it fresh would cost the
      // whole scan.
      let tail = null;
      rl.on('line', (line) => {
        if (!line) return;
        out.lines++;
        tail = line;
        if (line.includes('compact_boundary') || out.firstTs === null) {
          let o;
          try { o = JSON.parse(line); } catch { return; }
          if (out.firstTs === null && o.timestamp) out.firstTs = o.timestamp;
          if (o.type === 'system' && o.subtype === 'compact_boundary') {
            out.boundaries.push({ ...(o.compactMetadata || {}), ts: o.timestamp || null });
          }
        }
      });
      rl.on('close', () => {
        try { out.lastTs = (JSON.parse(tail) || {}).timestamp || null; } catch { /* a truncated tail costs one field */ }
        out.ok = true;
        resolve(out);
      });
      rl.on('error', () => resolve(out));
    });
  }

  // One record for the panel. `payload` is the live proxy/wire snapshot (may be
  // null — a Codex session, a session with no telemetry, a peer). Everything
  // degrades field-wise: a missing source costs its own rows, never the panel.
  async function collect({ name, entry, payload = null, live = null }) {
    const sids = trackedSessionIds(entry);
    const totals = readTotals();
    const currentId = (entry && entry.sessionId) || null;
    // The live ledger for the current id, preferred over the file. Under the
    // wire overlay payload.cost IS that ledger (wire-telemetry `_lifetime`);
    // on a raw poll it is wirescope's own per-registration figure, which is a
    // DIFFERENT scope and must not be summed into the agent total — hence the
    // explicit `live` argument rather than reaching into payload here.
    const agent = sumAgentCost(totals, sids, { currentId, live });
    const sessionLedger = (currentId && (live || totals.sessions[currentId])) || null;

    const scan = await scanTranscript(transcriptPath(name, entry));
    return {
      name,
      type: (entry && entry.type) || null,
      backend: (entry && entry.backend) || null,
      cwd: (entry && entry.cwd) || null,
      label: (entry && entry.label) || null,
      team: (entry && entry.team) || null,
      createdAt: (entry && entry.createdAt) || null,
      sessionId: currentId,
      sessionCount: sids.length,
      model: (payload && payload.model) || null,
      compact: compactSummary(scan.boundaries),
      transcript: scan.ok ? { bytes: scan.bytes, lines: scan.lines, firstTs: scan.firstTs, lastTs: scan.lastTs } : null,
      session: sessionLedger ? {
        usd: typeof sessionLedger.cost === 'number' ? sessionLedger.cost : null,
        requests: sessionLedger.requests ?? null,
        turns: sessionLedger.turns ?? null,
        refusals: sessionLedger.refusals ?? 0,
      } : null,
      agent,
      run: (payload && payload.costRun && typeof payload.costRun.usd === 'number')
        ? { usd: payload.costRun.usd, requests: payload.costRun.requests ?? null } : null,
      sinceCompact: (payload && payload.sinceCompact) || null,
      context: (payload && payload.context) || null,
      warmth: (payload && payload.warmth) || null,
      subagents: (payload && Array.isArray(payload.subagents)) ? payload.subagents.length : null,
      stripLevel: (entry && typeof entry.stripLevel === 'number') ? entry.stripLevel : null,
      linked: !!(payload && payload.linked),
    };
  }

  return { collect, scanTranscript, transcriptPath, readTotals };
}

module.exports = { createSessionInfo, trackedSessionIds, sumAgentCost, compactSummary };
