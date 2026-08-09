#!/usr/bin/env node
// Embed the operator basket into the append-only vector store.
//
// RESUMABLE BY CONSTRUCTION, because the first pass is not short: 13,926
// records at ~16ms each is roughly six minutes, and a job that has to start over
// after an interruption is a job that never finishes on a laptop. Every record
// already in the store is skipped, and the sidecar is flushed periodically, so
// killing this at any point loses at most the current flush window.
//
// Run it again after new messages land and it embeds only the delta — at ~97
// records/day that is under two seconds.
//
//   node scripts/embed-basket.js [--limit N] [--file PATH] [--dry-run] [--compact]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVectorStore } = require('../vector-store');
const { createEmbedder, keyOf, DEFAULT_MODEL } = require('../hint-embed');

const HOME = os.homedir();
const BASKET = path.join(HOME, '.clodex/library/basket/operator.jsonl');
const STORE = path.join(HOME, '.clodex/library/basket/vectors.bin');
const DIMS = 768; // nomic-embed-text

// Flush the sidecar every N records. Too small and the run is dominated by
// sidecar writes; too large and an interruption throws away real work. At ~16ms
// per embed this is roughly every 3 seconds.
const FLUSH_EVERY = 200;

const USAGE = 'usage: embed-basket.js [--limit N] [--file PATH] [--dry-run] [--compact]';

// The cap must not fail OPEN, which is what made a typo here expensive.
//
// `--limit --dry-run` used to bind `--dry-run` as --limit's operand, and the two
// consequences landed together: `Number('--dry-run')` is NaN, and `n >= NaN` is
// false for every n, so the cap below stopped capping instead of erroring —
// while `out.dry` never became true. The command typed to PREVIEW a bounded run
// performed an unbounded real one, six minutes of embedding against a live
// daemon.
//
// Rejecting the dashy operand is therefore only half the fix: `--limit abc` and
// a trailing `--limit` reach the identical NaN with no dashy token involved. So
// the VALUE is validated, not just the token carrying it — the cap is only ever
// Infinity (unset, explicit) or a positive integer, never NaN.
//
// This is the rule `cli/src/args.js:62` already applies to the shipped CLI. It
// is restated rather than required because this script's entire dependency
// surface is three node builtins and two repo modules, and args.js pulls in the
// CliError/EXIT machinery to express an exit code a dev script does not have.
// The threshold differs deliberately: args.js rejects only `--`-prefixed values
// because it has passthrough flags where `-x` is a legitimate operand; this
// parser has none, so a single dash is rejected too and `--limit -5` cannot
// silently bind.
function needsValue(flag, v) {
  if (v === undefined || v.startsWith('-')) throw new Error(`${flag} needs a value\n${USAGE}`);
  return v;
}

function positiveInt(flag, v) {
  if (!/^\d+$/.test(v) || Number(v) < 1) {
    throw new Error(`${flag} needs a positive integer, got ${JSON.stringify(v)}\n${USAGE}`);
  }
  return Number(v);
}

function parseArgs(argv) {
  const out = { limit: Infinity, file: BASKET, dry: false, compact: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = positiveInt(a, needsValue(a, argv[++i]));
    else if (a === '--file') out.file = needsValue(a, argv[++i]);
    else if (a === '--dry-run') out.dry = true;
    else if (a === '--compact') out.compact = true;
    // An unrecognised token was silently ignored, which meant `--dryrun` — the
    // same plausible typo, one character shorter — also performed a real run.
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  return out;
}

function readBasket(file) {
  const out = [];
  let bad = 0;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.text) out.push(o);
    } catch { bad++; }
  }
  return { records: out, bad };
}

// The record shape the memory retriever uses, so keyOf() produces the same
// content-addressed key on both sides and one implementation covers both
// corpora. The reply is part of the embedded text for the same reason it is
// part of the lexical haystack: a question is routinely findable by words that
// appear only in the answer.
function asRecord(r) {
  return {
    id: r.id,
    text: r.reply ? `${r.text}\n\n${r.reply}` : r.text,
    tags: '',
    scope: r.cwd || '',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) {
    console.error(`no basket at ${args.file} — run scripts/mine-operator-messages.js first`);
    process.exit(1);
  }

  const { records, bad } = readBasket(args.file);
  console.log(`basket: ${records.length} records${bad ? ` (${bad} unparseable lines skipped)` : ''}`);

  const store = createVectorStore({ file: STORE, dims: DIMS, model: DEFAULT_MODEL });
  const embedder = createEmbedder({});

  const todo = [];
  for (const r of records) {
    const rec = asRecord(r);
    if (!store.has(keyOf(rec))) todo.push(rec);
    if (todo.length >= args.limit) break;
  }

  const stats = store.stats();
  console.log(`store:  ${stats.live} live rows, ${stats.garbage} garbage, ${(stats.bytes / 1e6).toFixed(1)}MB`);

  if (args.compact) {
    const r = store.compact();
    console.log(`compacted: ${r.before} -> ${r.after} rows (${r.reclaimed} reclaimed)`);
    if (!todo.length) return;
  }
  console.log(`todo:   ${todo.length} to embed`);
  if (args.dry) return;
  if (!todo.length) { console.log('nothing to do'); return; }

  // A daemon that is down fails on every record; stop rather than grind through
  // thousands of timeouts.
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  for (const rec of todo) {
    const v = await embedder.embedDoc(rec);
    if (!v) {
      failed++;
      if (failed >= 3) {
        console.error(`\nembedding failed ${failed} times — is ollama running? (ollama serve)`);
        break;
      }
      continue;
    }
    failed = 0;
    store.add(keyOf(rec), v);
    done++;
    if (done % FLUSH_EVERY === 0) {
      store.flush();
      const rate = done / ((Date.now() - t0) / 1000);
      const left = (todo.length - done) / rate;
      process.stdout.write(`\r  ${done}/${todo.length}  ${rate.toFixed(0)}/s  eta ${(left / 60).toFixed(1)}min   `);
    }
  }
  store.flush();

  const s = store.stats();
  console.log(`\ndone: embedded ${done} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`store: ${s.live} live rows, ${s.garbage} garbage, ${(s.bytes / 1e6).toFixed(1)}MB at ${STORE}`);
  if (s.garbage > s.live * 0.25) {
    console.log('garbage is over 25% of the store — rerun with --compact to reclaim it');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

// parseArgs is exported for the tests: it guards a write that costs six minutes
// against a live daemon, and until it was exported the only way to reach it was
// to perform that write.
module.exports = { asRecord, readBasket, parseArgs };
