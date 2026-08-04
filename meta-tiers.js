// meta-tiers.js — the shared vocabulary for sidebar-meta refreshes: which keys
// belong to which cost tier, and how a refresh merges into what the renderer
// already holds. Pure leaf, required by BOTH session-meta.js (producer) and
// renderer/renderer.js (consumer) — it lives here rather than in session-meta.js
// because that module pulls in fs + child_process, which the renderer must not
// drag into the web bundle.
//
// The problem it exists to solve: `sidebar:meta` is served at two tiers (the
// cheap 30s timer omits the slow git/gh work), and a spread merge cannot tell
// "this tier had no answer" from "this tier's answer is none". Both readings
// have shipped as bugs, in opposite directions — a null-filled key read as news
// wiped the boot tier's real PR answer 30s after launch; an omitted key read as
// unchanged left a revoked grant painted forever. A tier marker names which
// questions the payload actually asked, so both readings become decidable.

// Tier -> the keys that tier is authoritative for. A payload claiming a tier is
// the last word on ALL of its keys, including by omission.
const META_TIERS = {
  activity: ['lastActivityTs'],
  pr: ['branch', 'prState', 'prNumber'],
  // One tier, not four: these are read together off the persistence entry by a
  // single synchronous loop, so no payload can ever answer some of them and not
  // the rest. Named for what it answers rather than for the handler that
  // decorates them, since a later producer may fill them elsewhere.
  record: ['createdAt', 'archivedAt', 'team', 'pluginGrants'],
};

const TIER_OF_KEY = new Map();
for (const [tier, keys] of Object.entries(META_TIERS)) {
  for (const key of keys) TIER_OF_KEY.set(key, tier);
}

// Merge one refresh row into the row the renderer holds.
//
// When the payload carries `_tiers`, the marker — not key presence — is the
// only authority on what it answered. Keys of every CLAIMED tier are cleared
// before the payload is applied, so a key the producer stopped sending lands as
// absent rather than stale; keys of UNCLAIMED tiers are dropped from the
// payload entirely, so a cheap tier can neither overwrite nor be trusted about
// an expensive tier's answer even if it spells the keys out. That second half
// is what makes a half-applied version of this fix — a producer that marks its
// tiers but still null-fills the ones it skipped — inert rather than a
// regression. A key in no tier keeps plain-spread semantics — every key
// `sidebar:meta` sends is tiered today, but the branch is not dead code: it is
// how a key added by a NEWER main process crosses to a web/peer frontend whose
// bundled table predates it. Dropping it would silently discard that key.
//
// An incoming row with NO `_tiers` claims nothing and is a plain spread: that is
// what an older main process across a peer/web connection sends, and it must
// neither delete keys nor have its own dropped.
function mergeMeta(prev, incoming) {
  const out = { ...(prev || {}) };
  const marked = Array.isArray(incoming && incoming._tiers);
  const claimed = marked ? incoming._tiers : [];
  for (const tier of claimed) {
    // hasOwnProperty, not a bare lookup: `_tiers: ['constructor']` would
    // otherwise resolve off the prototype to a truthy non-iterable, and the
    // TypeError lands inside refreshSidebarMeta's bare `catch {}` — every later
    // refresh of that row dies silently. An unknown tier must be inert.
    if (!Object.prototype.hasOwnProperty.call(META_TIERS, tier)) continue;
    for (const key of META_TIERS[tier]) delete out[key];
  }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (key === '_tiers') continue;
    const tier = TIER_OF_KEY.get(key);
    if (marked && tier && !claimed.includes(tier)) continue;
    out[key] = value;
  }
  return out;
}

module.exports = { META_TIERS, mergeMeta };
