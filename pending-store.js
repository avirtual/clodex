// Layer-3 delivery parking (Claude sessions).
//
// Why this exists: when the operator is composing a prompt, injecting a DM
// types Ctrl-U + text into the pane and eats the draft. The inject quiet-gate
// defers that, but a long draft eventually trips the max-wait cap and splices
// mid-word anyway (observed live). Parking is the real fix: while the operator
// is typing, a delivery is written HERE instead of injected, and a
// UserPromptSubmit hook drains it as additionalContext on the operator's next
// submit — so it arrives WITH the prompt, never through the draft.
//
// Store shape: one directory per agent (<root>/<name>/), one file per message
// (<seq>.json = {text}). Two disciplines make it zero-loss and order-preserving
// without a shared lock (Node has no native flock):
//   * publish  — write a hidden .tmp then rename into place, so a reader never
//                sees a partial file (atomic write-then-rename per message).
//   * drain    — CLAIM the whole directory with one atomic rename
//                (<name> -> <name>.draining.<tag>), then read the snapshot. The
//                hook drain and the Node cap-fire drain are thus mutually
//                exclusive: whoever renames first owns every message then
//                present, so nothing is delivered twice. A message parked after
//                the claim lands in a fresh directory and drains next turn.
// This is the atomic discipline the ack channel's lossy read+truncate lacks —
// dropping a DM is not acceptable, dropping a bookkeeping ack is.
//
// Pure fs helpers, dependency-free, so parking/draining are unit-testable
// without a live CLI. The Python UserPromptSubmit hook mirrors drainPending's
// claim discipline exactly (same atomic dir-rename), so the two drainers stay
// single-source-of-truth.

const fs = require('fs');
const path = require('path');

function agentDir(root, name) { return path.join(root, name); }

// A transient claim entry at ROOT level (sibling of the agent dirs), created by
// drainPending (`.draining.`) or claimParkedById (`.resend.`). Skipped when
// scanning for agent dirs so a mid-flight claim can't masquerade as one.
function isClaimEntry(name) { return /\.draining\.|\.resend\./.test(name); }

// Does parked file `f` carry resend id `id`? STRUCTURAL match, not a suffix
// endsWith: an id-tagged basename is `<ts>.<counter>.<id>.json` (4 dot-segments,
// id at index 2); a no-id typing-park is `<ts>.<counter>.json` (3 segments).
// A suffix `.<id>.json` test would misfire on the 9-digit counter of a no-id
// park (a valid `[a-z0-9]+` token), letting `[agent:resend <counter>]` claim an
// operator-typing park that was never advertised. The 4-vs-3 segment split
// assumes seq is the standard `<ts>.<counter>` form main.js's _nextParkSeq mints
// (one internal dot); the drain stays oblivious to the id either way.
function parkFileHasId(f, id) {
  if (!f.endsWith('.json') || f.startsWith('.')) return false;
  const parts = f.split('.');
  return parts.length === 4 && parts[2] === id;
}

// Publish one delivery for `name`. `seq` is a lexically-sortable, monotonic
// string (arrival order); filenames sort by it, so the drain reads in order.
// `id` (optional) is a short resend handle: when present the filename becomes
// `<seq>.<id>.json` — still `*.json` and still seq-sorted, so the drain (hook +
// drainPending) is oblivious to it, while claimParkedById can find the file by
// id for an [agent:resend]. Returns the published basename. Retries once into a
// fresh dir if the store was claimed away mid-publish (drains next turn, not lost).
function parkDelivery(root, name, text, seq, id = null) {
  const dir = agentDir(root, name);
  const base = id ? `${seq}.${id}.json` : `${seq}.json`;
  const tmp = path.join(dir, `.${base}.tmp`);
  const fin = path.join(dir, base);
  const payload = JSON.stringify(id ? { text, id } : { text });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, payload);
  try {
    fs.renameSync(tmp, fin);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, fin);
    } else {
      throw e;
    }
  }
  return base;
}

// Atomically claim and read every parked delivery for `name`, in arrival order.
// `claimTag` disambiguates concurrent drainers (e.g. 'hook' vs 'cap.<pid>').
// Returns [] when nothing is parked or another drainer won the claim. The claim
// directory is removed before returning, so returned texts are gone from the
// store (single delivery).
function drainPending(root, name, claimTag) {
  const dir = agentDir(root, name);
  const claim = `${dir}.draining.${claimTag}`;
  try {
    fs.renameSync(dir, claim);
  } catch (e) {
    if (e && e.code === 'ENOENT') return []; // nothing parked, or lost the race
    throw e;
  }
  let files = [];
  try { files = fs.readdirSync(claim); } catch { /* vanished under us */ }
  const texts = [];
  for (const f of files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(claim, f), 'utf8'));
      if (obj && typeof obj.text === 'string') texts.push(obj.text);
    } catch { /* skip a corrupt entry rather than abort the whole drain */ }
  }
  try { fs.rmSync(claim, { recursive: true, force: true }); } catch {}
  return texts;
}

// Cheap peek (not a claim): does `name` have any parked deliveries right now?
function hasPending(root, name) {
  try {
    return fs.readdirSync(agentDir(root, name))
      .some((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

// Cheap count (not a claim): how many parked deliveries does `name` have right
// now? Drives the sidebar's parked-message badge. A mid-flight drain has renamed
// the agent dir out to a `<name>.draining.<tag>` sibling, so agentDir ENOENTs and
// we report 0 — claimed means committed for delivery, no longer "waiting".
function countPending(root, name) {
  try {
    return fs.readdirSync(agentDir(root, name))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

// Is `id` already used by any parked delivery, in any agent's store? Resend
// carries only the id (not the target), so ids must be unique ACROSS dirs, not
// just within one — mint checks this to guarantee a resend resolves to exactly
// one file. Cheap: pending dirs hold at most a handful of files.
function parkIdInUse(root, id) {
  let names;
  try { names = fs.readdirSync(root); } catch { return false; }
  for (const name of names) {
    if (isClaimEntry(name)) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, name)); } catch { continue; }
    if (files.some((f) => parkFileHasId(f, id))) return true;
  }
  return false;
}

// Claim a single parked delivery by its resend `id`, across all agent stores.
// Single-file rename-claim (mirrors drainPending's atomicity at file grain): the
// matched file is renamed OUT to a root-level `.resend.` sibling before it's
// read, so it can't also be swept up by a concurrent whole-dir drain. Returns
// { name, text } on success, or null when no file matches OR the rename ENOENTs
// (the next-turn drain already claimed the whole dir — a success outcome, so the
// caller reports "already delivered", not an error). The claimed file is removed.
function claimParkedById(root, id) {
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  for (const name of names) {
    if (isClaimEntry(name)) continue;
    const dir = path.join(root, name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    const match = files.find((f) => parkFileHasId(f, id));
    if (!match) continue;
    const claim = path.join(root, `.resend.${id}.${process.pid}.${Date.now()}`);
    try {
      fs.renameSync(path.join(dir, match), claim);
    } catch (e) {
      if (e && e.code === 'ENOENT') return null; // whole-dir drain won the race
      throw e;
    }
    try {
      const obj = JSON.parse(fs.readFileSync(claim, 'utf8'));
      const text = (obj && typeof obj.text === 'string') ? obj.text : null;
      return text != null ? { name, text } : null;
    } catch {
      return null; // corrupt entry — treat as gone rather than throw
    } finally {
      try { fs.rmSync(claim, { force: true }); } catch {}
    }
  }
  return null;
}

module.exports = { parkDelivery, drainPending, hasPending, countPending, parkIdInUse, claimParkedById, agentDir };
