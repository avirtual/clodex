// peer-import.js — seed Clodex PEERS from clodexctl's contexts file (t32 step 4).
// The mirror of cli/src/import.js, which seeds contexts from the GUI's peers.
// Read-only on the CLI's file: this module never writes contexts.json, and the
// CLI changes by zero lines.
//
// IMPORT IS A COPY, NOT A LINK. An imported peer keeps NO relationship to the
// context it came from — no back-reference, not even a provenance field. A
// stored context NAME is a pointer that can go stale and lie (`ctx rm prod &&
// ctx add prod --url …` would leave a peer claiming a lineage that now points at
// a different box), and every behaviour a link could have is worse than the
// copy: re-syncing would make the GUI write on the CLI's schedule, inverting the
// ownership contexts.js:2 states; and "don't re-import this one" is dedupe,
// which belongs on the destination (see sameDestination) where it stays true
// after the operator renames the peer. So: a later edit to a context does NOT
// reach the peer imported from it, and the UI says so.
//
// TOKENS. Both files already hold tokens at 0600 under the same user, so the
// copy does not widen who can read one — the set of principals (the owning user,
// root) is unchanged. What the copy must NOT do is route the value through the
// RENDERER: getSettings has always stripped peer tokens to a `hasToken` boolean,
// so applying an import dialog-side would be a first-time widening. Hence this
// module runs main-side and reports `tokenState: 'set'|'none'` — token state,
// never a value, the same discipline cli/src/import.js:206 keeps.
//
// NEVER-TUNNEL INVARIANT, in the other direction. cli/src/import.js refuses to
// export an argv INTO the contexts file; this refuses to import one OUT of it. A
// `tunnel` entry is CODE, and a peer record is written from the renderer and
// editable in a dialog — persisting an argv there would be strictly worse than
// the same string in a CLI file. Refused with a reason, never silently dropped.
'use strict';

const crypto = require('crypto');
const { load, contextsPath } = require('./cli/src/contexts');
// The kind table lives with the supervisor that dials these blocks, so "which
// cloud kinds can a peer hold, and which fields identify the destination" has
// ONE answer. Re-listing them here is exactly the drift this ticket has spent
// two steps designing out.
const { CLOUD_KINDS } = require('./peer-tunnel');

// The peer store's own admission rules (stores.js sanitizePeers), restated here
// so a candidate cannot PREVIEW as importable and then be dropped on write. They
// are duplicated deliberately and narrowly: sanitizePeers is private (stores.js
// exports only initStores), so the apply path verifies by READING BACK what the
// store kept rather than trusting either copy — a candidate that previewed `add`
// and is missing from the read-back is a reported failure, not a silent one.
const URL_RE = /^https?:\/\//;
const SSH_RE = /^[a-zA-Z0-9._@-]{1,128}$/;

// Classify one contexts entry for import. Returns { kind, transport } for
// something a peer can hold, or { kind: null, reason } naming why not. `reason`
// is operator-facing: it says what to do, not merely what failed.
function classifyEntry(entry) {
  if (!entry || typeof entry !== 'object') return { kind: null, reason: 'not a context object' };
  if (entry.tunnel != null) {
    return { kind: null, reason: 'raw tunnel argv — not importable (a peer record is dialog-editable; a command line is not data)' };
  }
  if (entry.url != null) {
    const url = String(entry.url);
    if (!URL_RE.test(url)) return { kind: null, reason: `url must start with http:// or https:// — got "${url}"` };
    return { kind: 'url', transport: { url } };
  }
  if (entry.ssh != null) {
    const ssh = String(entry.ssh);
    if (!SSH_RE.test(ssh)) return { kind: null, reason: `ssh host "${ssh}" is outside the characters a peer accepts ([a-zA-Z0-9._@-], up to 128)` };
    return { kind: 'ssh', transport: { sshHost: ssh } };
  }
  for (const kind of Object.keys(CLOUD_KINDS)) {
    if (entry[kind] == null) continue;
    const block = entry[kind];
    if (!block || typeof block !== 'object' || Array.isArray(block)) return { kind: null, reason: `${kind} transport is not an object` };
    // ssm.ecs resolves a task ARN with two awaited `aws` calls before an argv
    // exists, and the tunnel supervisor is synchronous by design. Say what the
    // operator should do rather than importing a peer that could never dial.
    if (kind === 'ssm' && block.ecs != null && String(block.ecs) !== '') {
      return { kind: null, reason: 'ssm ECS family — a peer needs a concrete instance target; use clodexctl for CLUSTER/FAMILY destinations' };
    }
    const spec = CLOUD_KINDS[kind];
    const out = {};
    for (const f of spec.fields) {
      const v = block[f];
      if (v == null || String(v) === '') continue;
      out[f] = String(v);
    }
    const missing = spec.required.filter((f) => !out[f]);
    if (missing.length) return { kind: null, reason: `${kind} transport is missing ${missing.join(', ')}` };
    return { kind, transport: { [kind]: out } };
  }
  return { kind: null, reason: 'no transport this side can dial' };
}

// A one-line human target for the preview. Deliberately NOT verbs.js's
// entryTarget: the peer side supports a different subset (no tunnel, no ECS), so
// borrowing that renderer would let it describe kinds this path refuses.
function describeTransport(kind, transport) {
  if (kind === 'url') return transport.url;
  if (kind === 'ssh') return transport.sshHost;
  const b = transport[kind] || {};
  if (kind === 'ssm') return `${b.target}${b.region ? ` (${b.region})` : ''}`;
  if (kind === 'kubectl') return `${b.target}${b.namespace ? ` -n ${b.namespace}` : ''}`;
  if (kind === 'gcloud') return `${b.instance}${b.zone ? ` (${b.zone})` : ''}`;
  if (kind === 'az') return `${b.bastion} → ${String(b.target || '').split('/').pop()}`;
  return '';
}

// Do two records point at the same box? DESTINATION is the identity an import
// carries: a peer's label is operator-editable free text and its id is a UUID
// minted here, so neither survives as a match key. First kind present on BOTH
// decides — a url-vs-ssh pair is simply two different destinations.
function sameDestination(a, b) {
  if (!a || !b) return false;
  if (a.url && b.url) return a.url === b.url;
  if (a.sshHost && b.sshHost) return a.sshHost === b.sshHost;
  for (const kind of Object.keys(CLOUD_KINDS)) {
    if (!a[kind] || !b[kind]) continue;
    return CLOUD_KINDS[kind].fields.every((f) => (a[kind][f] || null) === (b[kind][f] || null));
  }
  return false;
}

// Build the candidate list from a loaded contexts store against the CURRENT
// peers. Each candidate:
//   { name, kind, target, tokenState:'set'|'none', action:'add'|'skip', reason,
//     peer? }   — `peer` present only for action 'add'.
// `peer` is the record to persist; the caller decides whether to write it.
// makeId is injectable so tests get stable ids.
function collectCandidates(store, peers, { makeId = () => crypto.randomUUID() } = {}) {
  const existing = Array.isArray(peers) ? peers : [];
  const out = [];
  const contexts = (store && store.contexts && typeof store.contexts === 'object') ? store.contexts : {};
  // Candidates collide with each other too, not just with existing peers: two
  // contexts can name the same box, and importing both would make a duplicate
  // in one pass that no later run could tell apart.
  const staged = [];
  for (const name of Object.keys(contexts)) {
    const entry = contexts[name];
    const token = (entry && typeof entry.token === 'string' && entry.token) ? entry.token : null;
    const tokenState = token ? 'set' : 'none';
    const { kind, transport, reason } = classifyEntry(entry);
    if (!kind) { out.push({ name, kind: null, target: '', tokenState, action: 'skip', reason }); continue; }
    const target = describeTransport(kind, transport);
    const clash = existing.find((p) => sameDestination(p, transport)) || staged.find((p) => sameDestination(p, transport));
    if (clash) {
      out.push({
        name, kind, target, tokenState, action: 'skip',
        reason: `already a peer${clash.label && clash.label !== name ? ` ("${clash.label}")` : ''}`,
      });
      continue;
    }
    const peer = {
      id: makeId(),
      // The context NAME becomes the label. Labels are not unique (peers are
      // keyed by UUID, unlike sessions) so a collision is cosmetic and is kept
      // rather than de-conflicted — two peers called `prod` pointing at
      // different boxes is a thing the operator did.
      label: name,
      ...transport,
      ...(Number.isInteger(entry.remotePort) ? { remotePort: entry.remotePort } : {}),
      ...(token ? { token } : {}),
    };
    staged.push(peer);
    out.push({ name, kind, target, tokenState, action: 'add', reason: null, peer });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// Load the contexts store for import. Absent file → an empty store (importing
// from nothing is a legitimate empty result, not an error); unreadable or
// malformed → { error } so the caller can say WHICH file and why. The CLI's
// loader owns the mode check, so its warning still fires here.
function loadContexts({ file = contextsPath(), warn = () => {} } = {}) {
  try { return { store: load(file, { warn }), file }; }
  catch (e) { return { error: e && e.message ? e.message : String(e), file }; }
}

// The peers array to persist: existing peers untouched, then every 'add'.
// Appended rather than merged — a skip already covers the collision case, so
// nothing here can overwrite a peer the operator configured by hand.
function applyCandidates(peers, candidates, { names = null } = {}) {
  const chosen = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && c.action === 'add' && c.peer)
    .filter((c) => !names || names.includes(c.name));
  return [...(Array.isArray(peers) ? peers : []), ...chosen.map((c) => c.peer)];
}

module.exports = {
  classifyEntry, describeTransport, sameDestination,
  collectCandidates, loadContexts, applyCandidates,
  URL_RE, SSH_RE,
};
