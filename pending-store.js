// Store shape: one directory per agent (<root>/<name>/), one file per message.
// Zero-loss and order-preserving without a shared lock (Node has no flock):
//   * publish — write a hidden .tmp then rename into place, so a reader never
//                sees a partial file.
//   * drain   — CLAIM the whole directory with one atomic rename before reading
//                it. Concurrent drainers are thus mutually exclusive: whoever
//                renames first owns every message then present, so nothing is
//                delivered twice. A message parked after the claim lands in a
//                fresh directory and drains next turn.

const fs = require('fs');
const path = require('path');

function agentDir(root, name) { return path.join(root, name); }

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

// `born` is the createdAt of the session this mail is FOR — the addressee's birth
// stamp, not the sender's and not now(). The store is keyed by NAME and a name
// outlives the session that held it, so without it a fresh seat with a recycled
// name inherits its predecessor's parked mail (see drainPending). It lives in the
// PAYLOAD rather than the path so the `<seq>[.<id>].json` grammar and
// parkFileHasId's segment split stay exactly as they are.
function parkDelivery(root, name, text, seq, id = null, passive = false, born = null) {
  const dir = agentDir(root, name);
      // `.passive.` occupies the id segment slot (4 dot-segments) — safe from
      // parkFileHasId collisions because minted resend ids are 5 or 10 base36
      // chars, never the 7-char literal "passive". Passive parks take no id.
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

// `expectedBorn` is the DRAINER'S OWN session createdAt. The comparison against
// each entry's `born` is DIRECTIONAL:
//   born <  expected — mail for a dead predecessor of this name. Discard.
//   born >  expected — mail for a successor; *I* am the stale drainer (a hook
//                      subprocess descheduled across its parent's death and the
//                      next create()). PUT IT BACK — not mine to consume.
//   born undefined, or expectedBorn omitted — deliver. Unstamped is the
//                      pre-upgrade shape; the safe direction is never to drop.
// Restoring rather than merely refusing is required because THE CLAIM IS
// DESTRUCTIVE: the dir was renamed away before the first byte was read, so an
// entry we decline to return and decline to restore is destroyed.
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
        if (obj.born > expectedBorn) restoreParked(dir, f, raw);
        continue;
      }
      texts.push(obj.text);
    } catch { /* skip a corrupt entry rather than abort the whole drain */ }
  }
  try { fs.rmSync(claim, { recursive: true, force: true }); } catch {}
  return texts;
}

// Restore under the ORIGINAL basename so seq order and the resend handle survive.
// Best-effort: a throwing restore would lose every other message in the batch.
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

function hasActivePending(root, name) {
  try {
    return fs.readdirSync(agentDir(root, name))
      .some((f) => f.endsWith('.json') && !f.startsWith('.') && !f.endsWith('.passive.json'));
  } catch {
    return false;
  }
}

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

// Read-only. The caller is the spill GC: a delivery over the spill threshold was
// parked as a POINTER to a file in ~/.clodex/messages/, and age-based collection
// would delete that file out from under the still-parked pointer. Returning raw
// text lets the GC see which files are still referenced.
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
