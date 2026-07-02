'use strict';

// Capture-corpus replay: the TS half of the Clodeux verification oracle
// (CLODEUX-PLAN.md, W2 gate). Feeds proxy-lab captures — the
// <stem>.request.json body + <stem>.response.sse raw bytes — through the
// SAME observer pipeline the live tee uses (role classification incl. the
// per-session fingerprint state, SSE framing, text accumulation, usage
// collection), and prints one JSON line per pair. The Python driver in
// proxy-lab tools/ diffs those lines against the corpus's recorded
// verdicts (<stem>.response.json: role/session_id/usage/meta) and its own
// re-parse of the SSE text.
//
// Adversarial chunking (reviewer condition — byte-boundary fuzzing):
//   --chunk-size N     fixed N-byte chunks
//   --fuzz-seed N      deterministic pseudo-random chunk sizes (1..4096),
//                      so a mismatch is reproducible by seed
// Default: whole body in one chunk.
//
// Usage: node wire/replay.js [options] <capture-session-dir>...
// Pairs replay in seq order per directory — the role classifier is
// stateful (main-line fingerprint before subagent turns), same as live.

const fs = require('fs');
const path = require('path');

const { WireProxy } = require('./proxy');
const { RoleClassifier, isSubagentRole, isTitleCall, isProbeCall } = require('./role');
const { WarmthStore } = require('./warmth');

function parseArgs(argv) {
  const opts = { chunkSize: 0, fuzzSeed: 0, warmth: false, dirs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chunk-size') opts.chunkSize = Number(argv[++i]) || 0;
    else if (a === '--fuzz-seed') opts.fuzzSeed = Number(argv[++i]) || 0;
    else if (a === '--warmth') opts.warmth = true;
    else opts.dirs.push(a);
  }
  return opts;
}

// Warmth replay clock: stamps and expiry reads run on CAPTURE time (the
// request.json ts, local ISO — same wall-clock base the Python driver
// uses via time.mktime), not on replay wall-clock, or every TTL in the
// corpus would read as lapsed-decades or never-lapsed. One shared store
// across all dirs: the ledger is content-addressed and cross-session
// sharing (sibling sessions warming each other's tools/system segments)
// is exactly what the state-for-state gate must exercise.
const replayClock = { t: 0 };

function parseTs(ts) {
  const ms = Date.parse(ts); // local time — matches Python's time.mktime(strptime(...))
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// Deterministic PRNG (mulberry32) — reproducible adversarial boundaries.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* chunksOf(buf, opts, rng) {
  if (opts.chunkSize > 0) {
    for (let off = 0; off < buf.length; off += opts.chunkSize) {
      yield buf.slice(off, off + opts.chunkSize);
    }
    return;
  }
  if (rng) {
    let off = 0;
    while (off < buf.length) {
      const n = 1 + Math.floor(rng() * 4096);
      yield buf.slice(off, off + n);
      off += n;
    }
    return;
  }
  yield buf;
}

// Mirrors WireProxy._forward's observation block (classify → note main
// fingerprint on main-line non-side-call turns). Kept in lockstep by the
// corpus diff itself: if this drifts from the live path, replay verdicts
// drift from live shadow logs.
function observeRequest(classifier, obj, headers) {
  const uid = (obj.metadata && obj.metadata.user_id) || '';
  let sessionId = null;
  try {
    const inner = JSON.parse(uid);
    if (inner && typeof inner.session_id === 'string') sessionId = inner.session_id;
  } catch { /* older shapes handled by the header fallback below */ }
  if (!sessionId) {
    const m = /session[_-]([0-9a-f-]{36})/i.exec(uid);
    sessionId = m ? m[1] : null;
  }
  const agentId = (headers && headers['x-claude-code-agent-id']) || null;
  const sideCall = isTitleCall(obj) || isProbeCall(obj);
  const role = classifier.classify(obj, sessionId, agentId);
  if (!sideCall && !isSubagentRole(role)) classifier.noteMainFingerprint(sessionId, obj);
  return { sessionId, role, sideCall };
}

function replayPair(proxy, classifier, stem, reqPath, ssePath, opts) {
  const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  const obj = req.body || {};
  // Codex captures replay through the openai pipeline: no billing header,
  // no role taxonomy (matches live: classification is anthropic-only).
  const p = (req.path || '').split('?')[0];
  const provider = (p.endsWith('/responses') || p.endsWith('/chat/completions')) ? 'openai' : 'anthropic';
  const { sessionId, role, sideCall } = provider === 'anthropic'
    ? observeRequest(classifier, obj, req.request_headers)
    : { sessionId: null, role: null, sideCall: false };

  const ts = parseTs(req.ts);
  if (ts != null) replayClock.t = ts;

  const out = {
    stem, agent: req.agent || null, provider, sessionId, role, sideCall,
    turn: null, usage: null, billing: null, stop: null, warmth: null,
    teeFailure: null,
  };
  if (!fs.existsSync(ssePath)) {
    out.note = 'no sse capture';
    return out;
  }

  const onTurn = (t) => {
    out.turn = { text: t.text, truncated: t.truncated };
    out.billing = t.billing || null;
    out.stop = t.stop || null;
    out.warmth = t.warmth || null;
  };
  const onUsage = (u) => { out.usage = u.usage; };
  const onFail = (f) => { out.teeFailure = f.error; };
  proxy.on('turn.completed', onTurn);
  proxy.on('usage', onUsage);
  proxy.on('tee-failure', onFail);
  try {
    const tee = proxy._buildTee(
      { agent: out.agent, provider, reqId: stem, sessionId, role, sideCall,
        model: typeof obj.model === 'string' ? obj.model : null,
        bodyObj: obj, requestId: null },
      null, // .response.sse is stored decoded
    );
    const sse = fs.readFileSync(ssePath);
    const rng = opts.fuzzSeed ? mulberry32(opts.fuzzSeed + stemSeed(stem)) : null;
    for (const c of chunksOf(sse, opts, rng)) tee.feed(c);
    tee.close(); // passthrough decompressor → synchronous emission
  } finally {
    proxy.removeListener('turn.completed', onTurn);
    proxy.removeListener('usage', onUsage);
    proxy.removeListener('tee-failure', onFail);
  }
  return out;
}

// Per-stem seed offset so every pair gets its own boundary pattern while
// staying reproducible from the one --fuzz-seed.
function stemSeed(stem) {
  let h = 0;
  for (const ch of stem) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h >>> 0;
}

function replayDir(dir, opts, warmth) {
  const reqs = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.request.json'))
    // total order: leading seq, then full name — duplicate seq numbers
    // exist in real captures and the warmth ledger is order-sensitive
    .sort((a, b) => ((parseInt(a, 10) || 0) - (parseInt(b, 10) || 0))
      || (a < b ? -1 : a > b ? 1 : 0));
  const proxy = new WireProxy({ warmth: warmth || null }); // never listens — tee pipeline only
  const classifier = new RoleClassifier();
  for (const f of reqs) {
    const stem = f.replace(/\.request\.json$/, '');
    let line;
    try {
      line = replayPair(proxy, classifier, stem,
        path.join(dir, f), path.join(dir, `${stem}.response.sse`), opts);
    } catch (e) {
      line = { stem, error: e.message };
    }
    process.stdout.write(JSON.stringify({ dir: path.basename(dir), ...line }) + '\n');
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dirs.length) {
    console.error('usage: node wire/replay.js [--chunk-size N | --fuzz-seed N] [--warmth] <capture-session-dir>...');
    process.exit(2);
  }
  const warmth = opts.warmth
    ? new WarmthStore({ now: () => replayClock.t }) // in-memory, capture-clocked
    : null;
  for (const d of opts.dirs) replayDir(d, opts, warmth);
}

module.exports = { observeRequest, replayDir, chunksOf, mulberry32, replayClock };
