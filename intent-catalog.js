// intent-catalog.js — the single source of truth for the GATEABLE intent set:
// which `[agent:…]` verbs a session can be allowed or denied, in the order they
// appear in the IPC prompt. Three consumers across two processes read this — the
// fire-time gate in session-manager.js (_handleIntent), the renderer checklist
// (New/Edit dialog + template editor), and the per-session prompt builder
// (ipc-prompt.buildIpcPrompt) — so the list lives in ONE pure leaf, not spread
// across a parser, a UI, and a prompt assembler that could drift apart.
//
// Pure string/array work over its own const + an injected list — no electron, no
// main.js state, no IO — so it's unit-tested in isolation and leak-scanned.
//
// NOT gateable (deliberately absent from the catalog):
//   * name  — identity. An agent must always be able to answer "who am I"; there
//             is no coherent session that can't name itself.
// Everything the scanner parses that ISN'T here is ungateable by omission:
// intentEnabled returns true for any type not in the catalog, so adding a new
// PARSED-but-not-gateable verb needs no catalog change.

// Ordered to match the IPC prompt's grammar-line order (the prompt builder walks
// this to decide which lines to include). `label` is the checklist row text.
// `resend` is gateable but has NO prompt line — its instruction rides the dm
// park-bounce notice, not the manual (see the resend bounce copy in
// _handleIntent) — so the prompt builder skips it while the gate still honors it.
const GATEABLE_INTENTS = [
  { type: 'dm', label: 'Direct messages (dm)' },
  { type: 'who', label: 'List peers (who)' },
  { type: 'context', label: 'Self context control (compact/clear)' },
  { type: 'memory', label: 'Memory management (remember/recall)' },
  { type: 'spawn', label: 'Spawn peer sessions (spawn)' },
  { type: 'file', label: 'Surface files on screen (file)' },
  { type: 'resend', label: 'Escalate a parked dm (resend)' },
  { type: 'exec', label: 'Run exec commands (exec)' },
  { type: 'remind', label: 'Durable self-reminders (remind)' },
  { type: 'notify-user', label: 'Operator inbox notes (notify-user)' },
  // Privileged (Task 27) — see PRIVILEGED_INTENTS. Gateable like the rest, but
  // OFF unless explicitly granted (absence does NOT enable it), and an
  // agent-initiated grant is stripped at the mint/wire boundary.
  { type: 'reboot', label: 'Relaunch the app (reboot) — privileged, off by default' },
];

// PRIVILEGED intents (Task 27): gateable verbs that INVERT the "absent = enabled"
// default — they fire ONLY when the seat's `intents` allowlist explicitly lists
// them. `reboot` (full app relaunch) is the first. Two invariants ride this set:
//   * intentEnabled: an absent/all-enabled seat does NOT get a privileged intent.
//   * withoutPrivilegedIntents: agent-initiated grants (spawn-intent templates,
//     the peer wire) are stripped of these — only an operator's local GUI may grant.
const PRIVILEGED_INTENTS = new Set(['reboot']);

// The bare type set, for O(1) "is this gateable at all?" checks.
const GATEABLE_TYPES = new Set(GATEABLE_INTENTS.map((i) => i.type));

// Is `type` enabled for a session whose persisted allowlist is `intentsList`?
//   * intentsList absent (null/undefined/non-array) → TRUE for everything. This
//     is the back-compat default: a session created before gating existed, or one
//     with every box checked (we omit the field rather than freeze an array), has
//     no list and so can use any intent — including intents added AFTER it was
//     created. "Absent = the living all-enabled default."
//   * type NOT gateable (name, or any parsed-but-uncatalogued verb) → TRUE always,
//     regardless of the list. Identity and non-gateable verbs can't be denied.
//   * PRIVILEGED type with an absent list → FALSE. This INVERTS the living default
//     for reboot & friends: "absent = all-enabled" covers the ordinary verbs, but a
//     privileged capability must be granted explicitly, never ridden in by default.
//   * otherwise → membership: TRUE iff the list contains the type. An empty array
//     is a real value meaning "everything gated" (no intents), distinct from absent.
function intentEnabled(type, intentsList) {
  if (!GATEABLE_TYPES.has(type)) return true;
  if (!Array.isArray(intentsList)) return !PRIVILEGED_INTENTS.has(type);
  return intentsList.includes(type);
}

// Strip privileged intents from a REQUESTED allowlist (Task 27). Applied at every
// agent-initiated / over-the-wire writer of `intents` (the spawn-intent template
// path, the peer create/edit endpoints) so a self-authored template or a remote
// viewer can't mint itself a privileged capability — only an operator's LOCAL GUI
// grant survives. A non-array (null/undefined = the all-enabled default, which
// already excludes privileged via intentEnabled) passes through untouched; an
// array is filtered. `[]` and privileged-only `['reboot']` both collapse to a real
// "everything gated" value, never null.
function withoutPrivilegedIntents(intentsList) {
  if (!Array.isArray(intentsList)) return intentsList;
  return intentsList.filter((t) => !PRIVILEGED_INTENTS.has(t));
}

// Turn the CHECKED gateable types from the UI checklist into the value to persist
// as a session's `intents` allowlist — the send-side companion of `intentEnabled`.
// Every gateable box checked → NULL (omit the field): the all-enabled state is
// stored as ABSENCE, never a frozen array, so a future intent lights up in this
// seat by default (see the "living default" note above). Otherwise → the enabled
// subset in CATALOG ORDER (deterministic, and stray/unknown values are dropped
// since only catalog types are counted). An empty result ([]) is a real value —
// "everything gated" — distinct from the null all-enabled case.
function intentsAllowlistFromChecked(checkedTypes) {
  const checked = new Set(checkedTypes);
  const enabled = GATEABLE_INTENTS.filter((i) => checked.has(i.type)).map((i) => i.type);
  // Collapse to null (the living all-enabled default) ONLY when the selection is
  // exactly what ABSENCE already means: every NON-privileged intent enabled and no
  // privileged one. A privileged grant (reboot checked) can't be represented by
  // absence — intentEnabled reads absent as "privileged off" — so it forces an
  // explicit array. Without this, checking every box including reboot would
  // collapse to null and SILENTLY drop the grant.
  const nonPrivCount = GATEABLE_INTENTS.filter((i) => !PRIVILEGED_INTENTS.has(i.type)).length;
  const isDefault = enabled.length === nonPrivCount && enabled.every((t) => !PRIVILEGED_INTENTS.has(t));
  return isDefault ? null : enabled;
}

// How many gateable intents a session/template with allowlist `intentsList`
// has DENIED — the complement of intentEnabled over the catalog. Reuses
// intentEnabled per-type so the semantics never drift: absent/null → 0 (the
// living all-enabled default), `[]` → all of them (everything gated), a subset
// → the count outside it. Drives the templates preview "🔒N intents" chip.
// PRIVILEGED intents are EXCLUDED from the tally: they're off by default, so
// counting reboot would slap a "🔒1" chip on every ordinary seat — a privileged
// verb being absent is the baseline, not a restriction the operator imposed.
function deniedIntentCount(intentsList) {
  return GATEABLE_INTENTS.filter(
    (i) => !PRIVILEGED_INTENTS.has(i.type) && !intentEnabled(i.type, intentsList),
  ).length;
}

module.exports = { GATEABLE_INTENTS, GATEABLE_TYPES, PRIVILEGED_INTENTS, intentEnabled, intentsAllowlistFromChecked, withoutPrivilegedIntents, deniedIntentCount };
