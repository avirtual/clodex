// Which memory units are LIVE in an agent's context right now — a fold over
// transitions Clodex already observes (digest delivery, recall, /clear,
// compaction), not an inference about what the model retained.
//
// The consumer is the contextual-hint injector: before a hint rides the
// wirescope tail, it asks whether the unit is already in context. That fixes
// the failure asymmetry this whole module is shaped around — a false "not
// loaded" costs a few hundred redundant tail tokens; a false "loaded"
// suppresses a hint the model needed, silently, with no signal anything was
// withheld. Every doubt resolves to NOT loaded.
//
// THREE STATES, not two. A unit whose BODY rode the digest is loaded. A unit
// that got only an index line is NOT: the model knows it exists and cannot
// read it, which makes TITLE units the best hint candidates in the store, not
// dedup candidates. Collapsing TITLE into "loaded" is the suppression bug.
//
// Wirescope tail hints are deliberately NOT recorded. They appear in the
// transcript zero times (verified 2026-07-31), so they are live for exactly
// one request; recording one as loaded would suppress every later hint for a
// unit the model saw once and can no longer see.

const fs = require('fs');
const path = require('path');
const { confine } = require('./path-confine');

// Mirrors memory-store's agent rule; a name that fails it gets no log file
// rather than a thrown error, because every caller here is observer-grade.
const AGENT_RE = /^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/;

function createMemoryLoad({ logDir, now = () => Date.now() } = {}) {
  // agent -> { sessionId, full:Set, title:Set }. In-memory and per-process on
  // purpose: a restarted session has no context to dedup against, so surviving
  // the process would be a source of false "loaded".
  const live = new Map();

  const stateFor = agent => {
    if (!live.has(agent)) live.set(agent, { sessionId: null, full: new Set(), title: new Set() });
    return live.get(agent);
  };

  const logFile = agent => {
    if (!logDir || !AGENT_RE.test(agent || '')) return null;
    const f = confine(logDir, `${agent}.jsonl`);
    return f;
  };

  return {
    // Tiers as digestTiers() reported them — the ids that actually rode, not
    // the ids that were eligible.
    noteDigest(agent, tiers) {
      if (!tiers) return;
      const s = stateFor(agent);
      for (const id of tiers.full || []) { s.full.add(id); s.title.delete(id); }
      for (const id of tiers.title || []) { if (!s.full.has(id)) s.title.add(id); }
    },

    // The highest-signal event in the scheme: an explicit delivery of one
    // body into the transcript. Persisted as well as recorded, because the log
    // is the evidence base for evidence-driven archival later — a unit that has
    // sat in the index across N sessions with zero recalls is an archival
    // candidate on evidence rather than on a model's judgement about staleness.
    noteRecall(agent, id, sessionId = null) {
      const s = stateFor(agent);
      s.full.add(id);
      s.title.delete(id);
      const f = logFile(agent);
      if (!f) return;
      try {
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        fs.appendFileSync(f, JSON.stringify({ id, at: new Date(now()).toISOString(), sessionId: sessionId || s.sessionId || null }) + '\n', { mode: 0o600 });
      } catch { /* observer-grade — a log failure must never break a delivery */ }
    },

    // /clear mints a new conversation id, which the transcript symlink repoint
    // reports. The SAME id is not a transition: this fires on first attach and
    // on every resume too, where a reset would wipe the digest just recorded.
    // A null recorded id is ADOPTED rather than treated as a change, because a
    // digest is baked before the conversation it rides has an id.
    noteSession(agent, sessionId) {
      if (!sessionId) return;
      const s = stateFor(agent);
      if (s.sessionId === sessionId) return;
      if (s.sessionId !== null) { s.full.clear(); s.title.clear(); }
      s.sessionId = sessionId;
    },

    // Compaction, including the CLI's own auto-compact. The live set resets to
    // EMPTY — no attempt to model what the summarizer preserved. "Possibly
    // evicted" resolving to "not loaded" is the correct policy for a dedup
    // consumer, not a lossy approximation of a better one.
    noteCompact(agent) {
      const s = stateFor(agent);
      s.full.clear();
      s.title.clear();
    },

    // The read API. 'full' is the only state that means "already in context".
    stateOf(agent, id) {
      const s = live.get(agent);
      if (!s) return 'absent';
      if (s.full.has(id)) return 'full';
      if (s.title.has(id)) return 'title';
      return 'absent';
    },

    liveSet(agent) {
      const s = live.get(agent);
      return {
        sessionId: s ? s.sessionId : null,
        full: s ? [...s.full] : [],
        title: s ? [...s.title] : [],
      };
    },

    recallLog(agent) {
      const f = logFile(agent);
      if (!f) return [];
      let raw;
      try { raw = fs.readFileSync(f, 'utf-8'); } catch { return []; }
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip garbled */ }
      }
      return out;
    },
  };
}

module.exports = { createMemoryLoad };
