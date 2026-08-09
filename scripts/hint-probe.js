#!/usr/bin/env node
// Contextual memory hints, end to end, outside the app: score the user's draft
// against an agent's memory units and arm the best match as an ephemeral tail
// hint. The loop IS wired into pty-input now, so this exists to answer what the
// app would do with a given draft — which is why the ranker is imported from
// hint-retrieve rather than reproduced here.
//
// usage: hint-probe.js <agent> "<draft text>" [--proxy=URL] [--route=GLOB]
//                      [--dry-run] [--max=N] [--loaded=id,id]

const { createMemoryStore } = require('../memory-store');
// The ranker is IMPORTED, never copied. A probe whose job is to answer "what
// would the app do with this draft" is worthless the moment its copy drifts,
// and it had: this file carried MIN_SCORE=2, tuned at N=4, while production
// derives the floor from corpus size because at N=179 a single rare term scores
// 5.19 on its own and clears any small constant. The probe was reporting armed
// hints the app would have rejected.
const { rank, compose, unitsAsRecords } = require('../hint-retrieve');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const MEMORY_ROOT = process.env.CLODEX_MEMORY_ROOT
  || path.join(os.homedir(), '.clodex', 'library', 'memory');

const TTL_S = 180;

// Lexical ranking cannot answer "son" -> a record scoped `family`: the two
// share no characters, and stemming does not close a semantic gap. Ask a fast
// model which topics the draft touches, then rank inside those. The catalog is
// tags+scopes the store already carries, so this reuses the tagging pass rather
// than adding an index to maintain.
function topicsFor(draft, records, model) {
  const catalog = [...new Set(records.flatMap(
    (r) => [...String(r.tags).split(','), r.scope].map((s) => s.trim()).filter(Boolean)))].sort();
  if (!catalog.length) return { topics: [], catalog };
  const prompt = `Topics available:\n${catalog.join('\n')}\n\n`
    + `User's message: ${JSON.stringify(draft)}\n\n`
    + 'Which topics could hold information that helps answer this message? '
    + 'Reply with matching topic names, one per line, nothing else. '
    + 'Reply with the single word NONE if none are plausibly relevant. '
    + 'Be inclusive about meaning (a question about a son relates to a family topic) '
    + 'but do not list a topic merely because it is adjacent in subject matter.';
  const out = execFileSync('claude', ['-p', prompt, '--model', model], {
    encoding: 'utf-8', timeout: 60000,
  });
  const valid = new Set(catalog);
  const topics = out.split('\n').map((l) => l.trim().replace(/^[-*\d.\s]+/, ''))
    .filter((l) => valid.has(l));
  return { topics, catalog, raw: out.trim() };
}

function withinTopics(records, topics) {
  const want = new Set(topics);
  return records.filter((r) => {
    if (want.has(r.scope)) return true;
    return String(r.tags).split(',').map((s) => s.trim()).some((t) => want.has(t));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map(args.filter((a) => a.startsWith('--'))
    .map((a) => { const i = a.indexOf('='); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
  const pos = args.filter((a) => !a.startsWith('--'));
  const agent = pos[0];
  const draft = pos.slice(1).join(' ');
  if (!agent || !draft) {
    console.error('usage: hint-probe.js <agent> "<draft text>" [--route=GLOB] [--dry-run] [--max=N] [--loaded=id,id]');
    process.exit(64);
  }

  const store = createMemoryStore(MEMORY_ROOT);
  const units = store.list(agent);
  if (!units.length) { console.error(`no memory units for agent "${agent}"`); process.exit(1); }

  const loaded = new Set(String(flags.get('loaded') || '').split(',').filter(Boolean));
  const all = unitsAsRecords(units);

  console.log(`draft: ${JSON.stringify(draft)}`);
  console.log(`corpus: ${all.length} records, ${loaded.size} excluded as already loaded`);

  let pool = all;
  if (flags.get('semantic')) {
    const t0 = Date.now();
    const { topics, catalog, raw } = topicsFor(draft, all, flags.get('model') || 'claude-haiku-4-5-20251001');
    console.log(`semantic pass: ${Date.now() - t0}ms, ${catalog.length} topics offered`
      + ` -> [${topics.join(', ') || 'none'}]${topics.length ? '' : ` (raw: ${JSON.stringify((raw || '').slice(0, 60))})`}`);
    if (!topics.length) { console.log('no relevant topic — nothing armed'); return; }
    pool = withinTopics(all, topics);
    console.log(`  ${pool.length} records within those topics`);
  }

  const max = Number(flags.get('max') || 1);
  // exclude/limit, and a flattened record carrying `evidence` — the production
  // ranker's shape, adopted here rather than adapted back, so this prints what
  // the app would actually do.
  let results = rank(pool, draft, { exclude: loaded, limit: max });
  // A topic verdict is a stronger relevance signal than word overlap, so it
  // must not be overridden by the lexical floor that exists only to filter an
  // unfiltered corpus. Without this, the semantic pass finds the right record
  // and the ranker then discards it for sharing no words with the question --
  // the exact failure the pass was added to fix.
  if (flags.get('semantic') && !results.length && pool.length) {
    results = pool.filter((r) => !loaded.has(r.id)).slice(0, max)
      .map((r) => ({ ...r, confidence: 0, evidence: { score: 0, hits: ['topic match only'], corpus: pool.length, floor: 0, coverage: 0 } }));
    console.log('  (no lexical overlap — carried on the topic verdict alone)');
  }
  if (!results.length) { console.log('no match above threshold — nothing armed (correct outcome for an unrelated draft)'); return; }
  for (const r of results) {
    const ev = r.evidence || {};
    console.log(`  match ${r.id}  score=${(ev.score || 0).toFixed(2)}  floor=${(ev.floor || 0).toFixed(2)}`
      + `  coverage=${(ev.coverage || 0).toFixed(2)}  conf=${r.confidence}  on [${(ev.hits || []).join(', ')}]`);
  }

  const text = compose(results);
  console.log(`\n--- hint text (${text.length} chars) ---\n${text}\n---`);
  if (flags.get('dry-run')) { console.log('(dry run — nothing armed)'); return; }

  const proxy = flags.get('proxy') || 'http://127.0.0.1:7800';
  const route = flags.get('route') || `clodex-${agent}-*`;
  const res = await fetch(`${proxy}/_hints?agent=${encodeURIComponent(route)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge',
      // `once` is the one-shot field. An unknown key is accepted and dropped
      // silently, so posting `pop:true` registers a STANDING hint that reads
      // like a pop in every log — verify one-shot by reading `once` back.
      hints: [{ id: 'memory-context', text, ttl_s: TTL_S, once: true, turn_start_only: true }],
    }),
  });
  console.log(`\nPOST /_hints?agent=${route} -> ${res.status}`);
  console.log((await res.text()).slice(0, 400));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
