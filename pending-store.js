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
//
// `born` (optional) is the createdAt of the session this mail is FOR — the
// addressee's birth stamp, not the sender's and not now(). The store is keyed by
// NAME, and a name outlives the session that held it: kill a seat and spawn a new
// one with the same name and the successor inherits its predecessor's parked mail.
// Stamping the payload is what lets a drain tell "mine" from "my predecessor's"
// (see drainPending). It lives in the PAYLOAD rather than the path so the whole
// `<seq>[.<id>].json` grammar, parkFileHasId's 4-vs-3 segment split and
// claimParkedById's `{ name, text }` routing (which reads the DIRECTORY as the
// session name) all stay exactly as they are.
function parkDelivery(root, name, text, seq, id = null, passive = false, born = null) {
  const dir = agentDir(root, name);
  // Passive parks are ride-along notifications (monitor ticks etc.): drained by
  // the organic carriers (hook drains, or any claim that was happening anyway)
  // but never worth a turn of their own — the turn-generating drains gate on
  // hasActivePending below. Marked in the FILENAME so the gate is a cheap peek;
  // the drains themselves stay oblivious (still `*.json`, still seq-sorted).
  // `.passive.` occupies the id segment slot (4 dot-segments) — safe from
  // parkFileHasId collisions because minted resend ids are 5 or 10 base36
  // chars, never the 7-char literal "passive". Passive parks take no id: they
  // are not conversational deliveries, so there is nothing to [agent:resend].
  const base = passive ? `${seq}.passive.json` : (id ? `${seq}.${id}.json` : `${seq}.json`);
  const tmp = path.join(dir, `.${base}.tmp`);
  const fin = path.join(dir, base);
  const payload = JSON.stringify(Object.assign({ text }, id ? { id } : null,
    typeof born === 'number' ? { born } : null));
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
//
// `expectedBorn` (optional) is the DRAINER'S OWN session createdAt. The store is
// keyed by name and a name outlives its session, so a claim can turn up mail
// addressed to a different generation of this name. The comparison against each
// entry's `born` is DIRECTIONAL, and the two directions want opposite handling:
//
//   born <  expected — mail for a DEAD PREDECESSOR of this name. Discard: the
//                      addressee is gone, and handing it to the successor is how
//                      a fresh seat starts its life reading a stranger's mail.
//   born >  expected — mail for a SUCCESSOR; *I* am the stale drainer (a hook
//                      subprocess descheduled across its parent's death and the
//                      next create()). PUT IT BACK — it is not mine to consume.
//   born === expected — mine. Deliver.
//   born undefined   — parked before this stamp existed, so the generation is
//                      unknowable. DELIVER: unstamped is the pre-upgrade shape,
//                      and dropping real mail to enforce a rule the sender never
//                      played by is the wrong error. Self-expiring — the store is
//                      drained continuously, so unstamped entries vanish within a
//                      turn or two of the upgrade and never come back.
//   expectedBorn omitted — no expectation, deliver everything. The default is the
//                      SAFE direction (never silently drop), the same reasoning
//                      create()'s `mint = false` default uses.
//
// WHY PUT BACK RATHER THAN JUST REFUSE. Refusing a non-matching entry reads like
// the symmetric, conservative choice, and it is not: THE CLAIM IS DESTRUCTIVE.
// The dir was renamed away before the first byte was read, so an entry we decline
// to return and decline to restore is DESTROYED — and it would be destroyed in
// exactly the race this stamp exists to fix. Symmetric-looking guards are not
// symmetric when the operation they guard is. Restoring costs a write on a path
// that should essentially never run; refusing costs a lost message.
function drainPending(root, name, claimTag, expectedBorn = null) {
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
      const raw = fs.readFileSync(path.join(claim, f), 'utf8');
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.text !== 'string') continue;
      if (typeof expectedBorn === 'number' && typeof obj.born === 'number' && obj.born !== expectedBorn) {
        // Not this generation's mail. Restore the successor's, drop the
        // predecessor's; see the directional table above.
        if (obj.born > expectedBorn) restoreParked(dir, f, raw);
        continue;
      }
      texts.push(obj.text);
    } catch { /* skip a corrupt entry rather than abort the whole drain */ }
  }
  try { fs.rmSync(claim, { recursive: true, force: true }); } catch {}
  return texts;
}

// Put one claimed entry back in the store under its ORIGINAL basename, so seq
// order and the `<seq>.<id>.json` resend handle both survive the round trip.
// Same write-then-rename publish discipline parkDelivery uses (a concurrent
// reader never sees a partial file); best-effort, because the alternative to a
// failed restore is a thrown drain that loses every other message in the batch.
function restoreParked(dir, base, raw) {
  const tmp = path.join(dir, `.${base}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, raw);
    fs.renameSync(tmp, path.join(dir, base));
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

// Cheap peek (not a claim): does `name` have any NON-passive parked delivery?
// The gate for turn-GENERATING drains (idle edge): a store holding only passive
// notifications isn't worth a turn — leave them for an organic carrier (a hook
// drain riding a turn that happens anyway). Mixed stores return true, and the
// subsequent whole-dir claim sweeps the passives along with the actives — which
// is exactly the ride-along semantics passive wants.
function hasActivePending(root, name) {
  try {
    return fs.readdirSync(agentDir(root, name))
      .some((f) => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.passive.json'));
  } catch {
    return false;
  }
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

// Cheap peek (not a claim): the parked deliveries for `name` as
// [{ from, snippet }], in arrival order, for the sidebar ✉ tooltip. Read-only —
// no rename, no delivery side effect. `max` caps how many entries are parsed
// (the tooltip shows a few and summarizes the rest); `snipLen` clamps each
// snippet. The parked TEXT is the full delivery bytes _buildDeliveryText mints:
// it starts `[agent:from <sender>] <body>` (or a `… attached: @path` spill
// pointer for a big body). We recover the sender from that prefix and take the
// body's first line as the snippet — never the whole body, so no full message
// text leaves the store. A line that doesn't match the prefix (a system notice)
// falls back to from='?' with the whole first line as snippet.
function peekPending(root, name, { max = 5, snipLen = 60 } = {}) {
  let files;
  try {
    files = fs.readdirSync(agentDir(root, name))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files.slice(0, max)) {
    let text;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(agentDir(root, name), f), 'utf8'));
      if (!obj || typeof obj.text !== 'string') continue;
      text = obj.text;
    } catch { continue; }
    const m = text.match(/^\[agent:from ([^\]]+)\]\s?([\s\S]*)$/);
    const from = m ? m[1] : '?';
    let body = (m ? m[2] : text).split('\n')[0].trim();
    if (body.length > snipLen) body = body.slice(0, snipLen - 1).trimEnd() + '…';
    out.push({ from, snippet: body });
  }
  return out;
}

// Every parked delivery's TEXT, across every agent store, as a flat array.
// Read-only — no rename, no claim, no delivery side effect.
//
// The caller is the spill GC (engine.cleanupOldMessages): a delivery whose body
// exceeded the spill threshold was parked as a POINTER to a file in
// ~/.clodex/messages/, and age-based collection would delete that file out from
// under the pointer while the parked entry waits (parking is unbounded in time;
// the spill file is not). Handing out the texts lets the GC see which files are
// still referenced. We return raw text and take no view on what a pointer looks
// like — the path grammar belongs to whoever mints it, not to the store.
//
// Mid-flight claims are skipped (isClaimEntry) exactly as parkIdInUse skips
// them, and that is the SAFE direction here: a claimed entry is committed for
// delivery, so its spill file is about to be read within the turn, long before
// the next 5-minute sweep.
function allParkedTexts(root) {
  const out = [];
  let names;
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (isClaimEntry(name)) continue;
    const dir = path.join(root, name);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (obj && typeof obj.text === 'string') out.push(obj.text);
      } catch { /* corrupt/vanished entry — skip, same as every other reader */ }
    }
  }
  return out;
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

module.exports = { parkDelivery, drainPending, hasPending, hasActivePending, countPending, peekPending, allParkedTexts, parkIdInUse, claimParkedById, agentDir };
