#!/usr/bin/env node
// Contextual memory hints, end to end, outside the app: score the user's draft
// against an agent's memory units and arm the best match as an ephemeral tail
// hint. Exists so the loop can be exercised against a live agent before any of
// it is wired into pty-input.
//
// usage: hint-probe.js <agent> "<draft text>" [--proxy=URL] [--route=GLOB]
//                      [--dry-run] [--max=N] [--loaded=id,id]

const { createMemoryStore } = require('../memory-store');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const MEMORY_ROOT = process.env.CLODEX_MEMORY_ROOT
  || path.join(os.homedir(), '.clodex', 'library', 'memory');

// The ranker takes records, not memory units: {id, text, tags, scope, source}.
// Memories are the first source, not the only intended one — project facts and
// docs are meant to feed the same ranker, so nothing below may reach for a
// memory-store API.
function unitsAsRecords(units) {
  return units.map((u) => ({
    id: u.id, text: u.body, tags: u.tags || '', scope: u.scope || '', source: 'memory',
  }));
}

// A hint costs tail budget on a request the user is already paying for, so the
// bar is "clearly about this", not "shares a word with this".
const MIN_SCORE = 2;
const TTL_S = 180;

// Terms that co-occur with everything in an agent's store carry no signal;
// matching on them surfaces a random unit with high confidence.
const STOP = new Set(('a an and are as at be but by for from had has have how i if in into is it its me my '
  + 'not of on or our so that the their them then there these they this to was we were what when where which '
  + 'who why will with you your do does did can could should would about get got make made just like now new '
  + 'more most some any all one two been being over under out up down no yes than also very much many via per')
  .split(' '));

function terms(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

// scope and tags are the curated topic labels — the shortest path from a
// question's subject to a record about it, and they cost nothing to index.
// Omitting them made "tell me about the family" miss a record whose scope is
// literally `family`.
function haystack(rec) {
  return `${rec.text} ${rec.tags} ${rec.scope}`;
}

// Document frequency: a term in half the store cannot discriminate between
// units, so weight by rarity rather than counting raw hits.
function score(queryTerms, rec, df, total) {
  const body = new Set(terms(haystack(rec)));
  let s = 0;
  const hits = [];
  for (const q of new Set(queryTerms)) {
    if (!body.has(q)) continue;
    const n = df.get(q) || 1;
    const w = Math.log(1 + total / n);
    if (w < 0.35) continue; // present in most units — no discrimination
    s += w;
    hits.push(q);
  }
  return { score: s, hits };
}

function rank(records, draft, { loaded = new Set(), max = 1 } = {}) {
  const q = terms(draft);
  if (!q.length) return [];
  const df = new Map();
  for (const r of records) {
    for (const t of new Set(terms(haystack(r)))) df.set(t, (df.get(t) || 0) + 1);
  }
  return records
    .filter((r) => !loaded.has(r.id))
    .map((r) => ({ unit: r, ...score(q, r, df, records.length) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}

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

// Two shapes by size. A short unit rides in full because reading it costs less
// than the round trip to fetch it; a long one is offered by title so the model
// spends the tokens only if it wants them.
const FULL_BODY_CAP = 700;

function compose(results) {
  const parts = ['This may relate to what the user is asking. If it does not, ignore it.'];
  for (const r of results) {
    const b = String(r.unit.text || '').trim();
    if (b.length <= FULL_BODY_CAP) {
      parts.push(`\n${r.unit.id}:\n${b}`);
    } else {
      const title = b.split('\n')[0].slice(0, 180);
      parts.push(`\n${r.unit.id}: ${title}...`
        + `\n(truncated — emit [agent:memory recall] ${r.unit.id} on its own line to load it in full)`);
    }
  }
  return parts.join('\n');
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
  let results = rank(pool, draft, { loaded, max });
  // A topic verdict is a stronger relevance signal than word overlap, so it
  // must not be overridden by the lexical floor that exists only to filter an
  // unfiltered corpus. Without this, the semantic pass finds the right record
  // and the ranker then discards it for sharing no words with the question --
  // the exact failure the pass was added to fix.
  if (flags.get('semantic') && !results.length && pool.length) {
    results = pool.filter((r) => !loaded.has(r.id)).slice(0, max)
      .map((r) => ({ unit: r, score: 0, hits: ['topic match only'] }));
    console.log('  (no lexical overlap — carried on the topic verdict alone)');
  }
  if (!results.length) { console.log('no match above threshold — nothing armed (correct outcome for an unrelated draft)'); return; }
  for (const r of results) console.log(`  match ${r.unit.id}  score=${r.score.toFixed(2)}  on [${r.hits.join(', ')}]`);

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
