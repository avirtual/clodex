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

// Publish one delivery for `name`. `seq` is a lexically-sortable, monotonic
// string (arrival order); filenames sort by it, so the drain reads in order.
// Returns the published basename. Retries once into a fresh dir if the store
// was claimed away mid-publish (delivery drains next turn rather than lost).
function parkDelivery(root, name, text, seq) {
  const dir = agentDir(root, name);
  const base = `${seq}.json`;
  const tmp = path.join(dir, `.${base}.tmp`);
  const fin = path.join(dir, base);
  const payload = JSON.stringify({ text });
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

module.exports = { parkDelivery, drainPending, hasPending, agentDir };
