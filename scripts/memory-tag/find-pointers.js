#!/usr/bin/env node
// Pre-pass: find units that declare their OWN obsolescence in prose, and put
// them in a bucket with whatever they point at.
//
// Why this exists: tag buckets can only surface a contradiction between units
// that SHARE a tag, and a unit is tagged for what it is about. The known live
// contradiction (a "contrarian is retired" clause inside a boot pin, reversed
// two weeks later by a unit about team delegation) has DISJOINT tags — the two
// never meet in a bucket, so the tag pass cannot see it however good the model
// is. But the newer unit says in plain prose that it supersedes the older one:
// the judgement was already made by a past session and only lacked a structure
// to be recorded in.
//
// READ-ONLY. This emits a bucket in build-buckets' own format, so the same
// prompt and the same archive.js verdict flow apply with no second writer and
// no second renderer to drift.
//
// Usage: node find-pointers.js [--agent=NAME] [--root=DIR] [--out=DIR]
//        with no --out, prints the candidates report to stdout.
// Exit: 0 with candidates, 1 with none.

const fs = require('fs');
const path = require('path');
const { createMemoryStore } = require(path.join(__dirname, '..', '..', 'memory-store'));
const { resolveRoot, agentFrom } = require(path.join(__dirname, 'unit-file'));
const { render } = require(path.join(__dirname, 'build-buckets'));

// Bias here is toward RECALL, deliberately: a false positive costs one unit in
// a bucket a model reads anyway, a false negative costs the entire point of the
// pass. Precision is bought back at target resolution, not here.
//
// `override` is deliberately ABSENT despite reading like the others: in this
// corpus it is a domain term (per-agent hint override, strip-level override)
// and fires on units about wire configuration that declare nothing.
const PATTERNS = [
  /supersed\w*/i, /retract\w*/i, /rescind\w*/i, /revok\w*/i, /overturn\w*/i,
  /deprecat\w*/i, /obsolete/i, /\bamend(s|ed|ment|ments)?\b/i,
  /\bretired\b/i, /\bretires\b/i, /\bno longer\b/i, /\breplaces?\b/i,
  /\breplaced by\b/i, /\breverses?\b/i, /\breversed\b/i, /\bwas wrong\b/i,
  /\bis wrong\b/i, /\bchanged my mind\b/i, /\bdoes not hold\b/i,
  /\bnot true anymore\b/i, /\bstale now\b/i, /\bcorrects the earlier\b/i,
  /\bcorrection to\b/i, /\brefines\b/i,
];

// Text either side of a match. The claim about WHAT is superseded lives in the
// same clause, not in the unit at large: widening this pulls in the unit's
// other topics and the distinctive terms stop being distinctive.
const CONTEXT_BEFORE = 90;
const CONTEXT_AFTER = 170;

const ID_RE = /\bmem-\d+-[a-z0-9]+\b/gi;
// `07-10`, `2026-07-10`, `07/10`. Dates in these bodies are as often written
// INSIDE the prose of the target unit as they are its learned_at stamp, so a
// date is used to narrow candidates, never to pick one.
const DATE_RE = /\b(?:\d{4}-)?(\d{2})[-/](\d{2})\b/g;

// A term in more than this share of units says nothing about which unit is
// meant. Derived from the corpus each run rather than a hand-kept stopword
// list, which would drift as the store's vocabulary does.
const COMMON_DF = 0.2;
const MIN_TERM_LEN = 4;
// A resolution needs this many distinctive terms in common AND this much of a
// lead over the runner-up. Both are required: a high score with a close second
// means two units say the same thing and the pass cannot tell which is meant,
// which is exactly the case that must come out UNRESOLVED rather than as a
// coin-flip pair.
const MIN_SCORE = 3;
const MIN_MARGIN = 2;
// When the top candidates are too close to call, they go in the bucket TOGETHER
// and the candidate stays unresolved. Co-locating is not guessing: nothing is
// archived without a model verdict, and the alternative — dropping the target
// entirely — is what loses the pair this whole pass exists to catch. Capped so
// a vague declaration cannot drag the store in behind it.
const SHORTLIST_MAX = 3;
// Declaring units per chunk. Counted in DECLARERS, not total units, because the
// companions are what a chunk cannot be allowed to split — so they are pulled
// in whole and a chunk lands somewhat above this number.
const CHUNK_DECLARERS = 20;

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [];
}

// tokens -> share of units containing them.
function docFreq(units) {
  const df = new Map();
  for (const u of units) {
    for (const t of new Set(tokens(u.body))) df.set(t, (df.get(t) || 0) + 1);
  }
  return { df, n: units.length };
}

function distinctiveTerms(context, { df, n }) {
  const out = new Set();
  for (const t of new Set(tokens(context))) {
    if (t.length < MIN_TERM_LEN) continue;
    const share = (df.get(t) || 0) / (n || 1);
    if (share > COMMON_DF) continue;
    out.add(t);
  }
  return out;
}

function matchesIn(body) {
  const hits = [];
  for (const re of PATTERNS) {
    const g = new RegExp(re.source, 'gi');
    let m;
    while ((m = g.exec(body)) !== null) {
      hits.push({ index: m.index, text: m[0] });
      if (m.index === g.lastIndex) g.lastIndex++;
    }
  }
  hits.sort((a, b) => a.index - b.index);
  // One candidate per unit per CLAUSE, not per pattern: "supersedes ...
  // retired ... consult" is one declaration and three patterns.
  const merged = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.index - prev.index < CONTEXT_AFTER) { prev.text += `, ${h.text}`; continue; }
    merged.push({ ...h });
  }
  return merged;
}

function contextAt(body, index) {
  return body.slice(Math.max(0, index - CONTEXT_BEFORE), index + CONTEXT_AFTER)
    .replace(/\s+/g, ' ').trim();
}

function datesIn(text) {
  const out = new Set();
  let m;
  const g = new RegExp(DATE_RE.source, 'g');
  while ((m = g.exec(text)) !== null) out.add(`${m[1]}-${m[2]}`);
  return out;
}

// A date hint matches a unit if it appears in the unit's learned_at OR anywhere
// in its body. Both, because a unit's body routinely dates itself ("rev
// 2026-07-10") on a day other than the one it was saved.
function unitMatchesDate(unit, dates) {
  if (!dates.size) return false;
  const stamp = String(unit.learned_at || '').slice(0, 10);
  const stampMd = stamp.slice(5);
  for (const d of dates) {
    if (stampMd === d) return true;
    if (String(unit.body).includes(d)) return true;
  }
  return false;
}

// Ladder: explicit id, then distinctive-term overlap, then unresolved.
//
// A date reference is NOT a rung. The one pair known to be a true positive in
// the live store cites "the 07-10 rule" against a unit stamped 07-08 (07-10 is
// in its body), and ten units share that stamp — so date alone is both too
// weak to pick one and looking in the wrong place. It narrows an already-scored
// field and only when that narrowing leaves something.
function resolve(decl, context, units, freq) {
  const others = units.filter(u => u.id !== decl.id);

  const cited = [...new Set(context.match(ID_RE) || [])].filter(id => id !== decl.id);
  if (cited.length) {
    const live = cited.filter(id => others.some(u => u.id === id));
    // A cited id that is not an active unit is a DEAD POINTER, not a licence to
    // go looking for something that resembles it. Say so and stop.
    if (!live.length) return { target: null, how: 'id', why: `cites ${cited[0]}, which is not an active unit` };
    if (live.length > 1) return { target: null, how: 'id', why: `cites ${live.length} ids; ambiguous` };
    return { target: live[0], how: 'id', why: '' };
  }

  const terms = distinctiveTerms(context, freq);
  if (terms.size < MIN_SCORE) return { target: null, how: 'terms', why: 'declaration has too few distinctive terms' };

  let scored = others.map(u => {
    const have = new Set(tokens(u.body));
    let n = 0;
    for (const t of terms) if (have.has(t)) n++;
    return { id: u.id, n, unit: u };
  }).filter(s => s.n > 0);

  const dates = datesIn(context);
  const narrowed = scored.filter(s => unitMatchesDate(s.unit, dates));
  if (narrowed.length) scored = narrowed;

  scored.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const top = scored[0];
  const runner = scored[1];
  if (!top || top.n < MIN_SCORE) {
    return { target: null, how: 'terms', why: `best overlap ${top ? top.n : 0} of ${terms.size}, below ${MIN_SCORE}` };
  }
  if (runner && top.n - runner.n < MIN_MARGIN) {
    const tied = scored.filter(s => top.n - s.n < MIN_MARGIN).slice(0, SHORTLIST_MAX);
    return {
      target: null,
      shortlist: tied.map(s => s.id),
      how: 'terms',
      why: `${tied.map(s => `${s.id}:${s.n}`).join(', ')} of ${terms.size}; no clear winner`,
    };
  }
  return { target: top.id, how: `terms ${top.n}/${terms.size}`, why: '' };
}

function findPointers(root, agent) {
  const units = createMemoryStore(root).list(agent);
  const byId = new Map(units.map(u => [u.id, u]));
  const freq = docFreq(units);
  const candidates = [];

  for (const u of units) {
    for (const hit of matchesIn(String(u.body))) {
      const context = contextAt(u.body, hit.index);
      const r = resolve(u, context, units, freq);
      candidates.push({
        id: u.id, match: hit.text, context,
        target: r.target, shortlist: r.shortlist || [], how: r.how, why: r.why,
      });
    }
  }

  // The bucket carries declaring units and resolved targets, oldest first —
  // the order render()'s header promises and the consolidate prompt reads for.
  //
  // Direction is deliberately NOT decided here. "X supersedes Y", "this is
  // superseded by Y" and "RETRACTED" put a different unit on the block, and
  // this pass only CO-LOCATES the pair so the model reads them side by side.
  // Choosing a victim from the pattern that matched would be a judgement made
  // on weaker evidence than the model will have.
  const involved = new Set();
  for (const c of candidates) {
    involved.add(c.id);
    if (c.target) involved.add(c.target);
    for (const id of c.shortlist) involved.add(id);
  }
  const bucket = [...involved].map(id => byId.get(id)).filter(Boolean)
    .sort(byAge);

  return { candidates, bucket, chunks: chunkBucket(candidates, byId) };
}

function byAge(a, b) { return String(a.learned_at).localeCompare(String(b.learned_at)); }

// Everything one declaring unit needs read alongside it. Several candidates can
// come from the same unit (one per clause), and they are merged here: the unit
// appears in exactly one chunk, carrying every companion any of its clauses
// named.
function companionsByDeclarer(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    if (!groups.has(c.id)) groups.set(c.id, new Set());
    const set = groups.get(c.id);
    if (c.target) set.add(c.target);
    for (const id of c.shortlist) set.add(id);
  }
  return groups;
}

// Split the pointer bucket into model-sized chunks.
//
// THE INVARIANT: a declaring unit and every companion it named land in the SAME
// chunk. Splitting a pair across chunks means neither call ever sees both, and
// the pass reports success having silently destroyed the one thing it exists to
// find — so chunking is by DECLARER, with companions pulled in whole, never a
// slice of a flat unit list.
//
// A unit companion to two declarers therefore appears in two chunks. That is
// correct and not deduplicated: archive.js rejects the second verdict for an id
// that is no longer active, so the duplicate costs a rejection line, while
// deduplicating would drop it out of a pair it belongs to.
function chunkBucket(candidates, byId, size = CHUNK_DECLARERS) {
  const groups = companionsByDeclarer(candidates);
  const declarers = [...groups.keys()]
    .map(id => byId.get(id)).filter(Boolean).sort(byAge).map(u => u.id);

  const chunks = [];
  for (let i = 0; i < declarers.length; i += size) {
    const slice = declarers.slice(i, i + size);
    const ids = new Set();
    for (const d of slice) {
      ids.add(d);
      for (const c of groups.get(d)) ids.add(c);
    }
    chunks.push({
      declarers: slice,
      units: [...ids].map(id => byId.get(id)).filter(Boolean).sort(byAge),
    });
  }
  return chunks;
}

// Human-readable, and deliberately NOT part of the bucket: annotating units
// inside the bucket would change the format the existing reader and prompt
// depend on.
function renderCandidates(candidates) {
  const out = [`# pointer candidates (${candidates.length})`, ''];
  for (const c of candidates) {
    out.push(`## ${c.id}`);
    out.push(`matched: ${c.match}`);
    out.push(c.target ? `target: ${c.target} (by ${c.how})` : `target: UNRESOLVED (${c.why || 'no candidate'})`);
    if (c.shortlist.length) out.push(`shortlisted (in bucket, undecided): ${c.shortlist.join(', ')}`);
    out.push(`context: ${c.context}`);
    out.push('');
  }
  return out.join('\n');
}

function main(argv) {
  const root = resolveRoot(argv);
  const agent = agentFrom(argv);
  const outDir = (argv.find(a => a.startsWith('--out=')) || '').slice(6);

  const { candidates, bucket, chunks } = findPointers(root, agent);
  if (!candidates.length) {
    process.stderr.write(`no self-declared supersession found for ${agent}\n`);
    process.exit(1);
  }

  const resolved = candidates.filter(c => c.target).length;
  if (!outDir) {
    process.stdout.write(renderCandidates(candidates));
    process.stderr.write(`${candidates.length} candidates, ${resolved} resolved, `
      + `${bucket.length} units in ${chunks.length} chunk(s)\n`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'pointers.candidates.md'), renderCandidates(candidates));
  const names = [];
  for (let i = 0; i < chunks.length; i++) {
    const name = `pointers.${i + 1}`;
    names.push(name);
    fs.writeFileSync(path.join(outDir, `bucket.${name}.md`), render(name, chunks[i].units));
    process.stderr.write(`bucket ${name}: ${chunks[i].units.length} units `
      + `(${chunks[i].declarers.length} declaring)\n`);
  }
  process.stderr.write(`${candidates.length} candidates, ${resolved} resolved\n`);
  // stdout is the bucket names, matching build-buckets, so the shell can consume
  // both the same way.
  process.stdout.write(`${names.join('\n')}\n`);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = {
  findPointers, renderCandidates, matchesIn, resolve, chunkBucket,
  // contextAt/docFreq are exported for archive.js's refutation guard: it runs
  // the same detection over one unit at a time rather than reimplementing it.
  contextAt, docFreq,
  PATTERNS, CHUNK_DECLARERS,
};
