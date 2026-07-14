// Per-origin DM outbox for peer federation (box side).
//
// Why this exists: the peer wire is one-directional. A consumer (laptop) reaches
// the box over its tunnel; the box can NEVER dial back. So a box→consumer DM
// can't be pushed — it's written HERE, into a per-origin mailbox, and the
// consumer CLAIMS it on its hello cadence (worst-case one hello interval of
// latency, fine for agent traffic the cost gate already holds for minutes).
//
// Store shape mirrors pending-store's zero-loss discipline, one dir per ORIGIN
// (the consumer's self-reported label) instead of per agent, one file per
// message (<seq>.json = {from,to,body,urgent,ts}):
//   * enqueue — write a hidden .tmp then rename into place, so a claimer never
//               sees a partial file (atomic write-then-rename per message).
//   * claim   — CLAIM the whole origin dir with one atomic rename, then read the
//               snapshot. Enqueue-after-claim lands in a fresh dir and is picked
//               up on the next claim, so nothing is dropped and none delivered
//               twice.
//
// Pure fs helpers, dependency-free, so federation is unit-testable without a
// live tunnel. `origin` is the consumer's label; it's validated to the session
// name charset before it ever touches the path (and '.'/'..' rejected) so a wire
// value can't traverse out of the outbox root.

const fs = require('fs');
const path = require('path');

const ORIGIN_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// A wire-supplied origin is safe as a single path segment only if it matches the
// name charset AND isn't a dot-entry (`.`/`..` pass the charset but would escape
// the root). Everything downstream trusts this gate.
function validOrigin(origin) {
  return typeof origin === 'string' && ORIGIN_RE.test(origin) && origin !== '.' && origin !== '..';
}

function originDir(root, origin) { return path.join(root, origin); }

// A transient claim entry at ROOT level (sibling of the origin dirs), created by
// claimOutbox (`.claiming.`). Skipped when listing origins so a mid-flight claim
// can't masquerade as a real mailbox.
function isClaimEntry(name) { return /\.claiming\./.test(name); }

// Publish one message to `origin`'s mailbox. `seq` is a lexically-sortable,
// monotonic string (arrival order); filenames sort by it, so a claim reads in
// order. Returns { ok:true, file } or { ok:false, error } (bad origin). Retries
// once into a fresh dir if the mailbox was claimed away mid-publish (delivered on
// the next claim, not lost).
function enqueueOutbox(root, origin, msg, seq) {
  if (!validOrigin(origin)) return { ok: false, error: 'bad origin' };
  const dir = originDir(root, origin);
  const base = `${seq}.json`;
  const tmp = path.join(dir, `.${base}.tmp`);
  const fin = path.join(dir, base);
  const payload = JSON.stringify({
    from: String(msg && msg.from != null ? msg.from : ''),
    to: String(msg && msg.to != null ? msg.to : ''),
    body: String(msg && msg.body != null ? msg.body : ''),
    urgent: !!(msg && msg.urgent),
    ts: Number.isFinite(msg && msg.ts) ? msg.ts : Date.now(),
    // Hub-relay envelope fields — carried through ONLY when present, so a plain
    // direct-DM outbox record stays byte-identical. Their ABSENCE is what marks a
    // record as a direct DM (isRelayEnvelope keys on finalTarget), so dropping
    // them here silently demotes a relay DM to a direct one — the claiming hub
    // then can't tell it should relay and delivers it to a nonexistent local
    // agent. Preserve them or spoke↔spoke relay never routes.
    ...(msg && typeof msg.finalTarget === 'string' && msg.finalTarget ? { finalTarget: msg.finalTarget } : {}),
    ...(msg && Number.isInteger(msg.hops) ? { hops: msg.hops } : {}),
    ...(msg && Number.isInteger(msg.rv) ? { rv: msg.rv } : {}),
  });
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
  return { ok: true, file: base };
}

// Atomically claim and read every message queued for `origin`, in arrival order.
// Returns [] when the mailbox is empty, the origin is bad, or another claimer won
// the race. The claim directory is removed before returning, so returned
// messages are gone from the store (single delivery).
function claimOutbox(root, origin) {
  if (!validOrigin(origin)) return [];
  const dir = originDir(root, origin);
  const claim = `${dir}.claiming.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(dir, claim);
  } catch (e) {
    if (e && e.code === 'ENOENT') return []; // nothing queued, or lost the race
    throw e;
  }
  let files = [];
  try { files = fs.readdirSync(claim); } catch { /* vanished under us */ }
  const out = [];
  for (const f of files.filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(claim, f), 'utf8'));
      if (obj && typeof obj.to === 'string') {
        out.push({
          from: obj.from || '', to: obj.to, body: obj.body || '', urgent: !!obj.urgent, ts: obj.ts || 0,
          // Carry the relay envelope fields back out (see enqueueOutbox) — only
          // when present, so a direct DM's readback is unchanged and
          // isRelayEnvelope still discriminates on finalTarget's presence.
          ...(typeof obj.finalTarget === 'string' && obj.finalTarget ? { finalTarget: obj.finalTarget } : {}),
          ...(Number.isInteger(obj.hops) ? { hops: obj.hops } : {}),
          ...(Number.isInteger(obj.rv) ? { rv: obj.rv } : {}),
        });
      }
    } catch { /* skip a corrupt entry rather than abort the whole claim */ }
  }
  try { fs.rmSync(claim, { recursive: true, force: true }); } catch {}
  return out;
}

// Does `origin` have at least one queued message right now? Cheap peek, not a
// claim — feeds the outbound-routing "known origin" fallback after a restart
// (the runtime seen-Set is empty, but an undelivered mailbox lingers on disk).
function outboxHasOrigin(root, origin) {
  if (!validOrigin(origin)) return false;
  try {
    return fs.readdirSync(originDir(root, origin))
      .some((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return false;
  }
}

// Origins with a non-empty mailbox right now — the set the hello payload
// advertises as `dmOrigins` (so a consumer only bothers to claim when there's
// something waiting). Skips transient claim dirs and empty/leftover dirs.
function listOutboxOrigins(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (isClaimEntry(name) || !validOrigin(name)) continue;
    if (outboxHasOrigin(root, name)) out.push(name);
  }
  return out;
}

module.exports = {
  enqueueOutbox, claimOutbox, outboxHasOrigin, listOutboxOrigins,
  validOrigin, ORIGIN_RE,
};
