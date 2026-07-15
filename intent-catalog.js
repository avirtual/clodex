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
];

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
//   * otherwise → membership: TRUE iff the list contains the type. An empty array
//     is a real value meaning "everything gated" (no intents), distinct from absent.
function intentEnabled(type, intentsList) {
  if (!Array.isArray(intentsList)) return true;
  if (!GATEABLE_TYPES.has(type)) return true;
  return intentsList.includes(type);
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
  return enabled.length === GATEABLE_INTENTS.length ? null : enabled;
}

// How many gateable intents a session/template with allowlist `intentsList`
// has DENIED — the complement of intentEnabled over the catalog. Reuses
// intentEnabled per-type so the semantics never drift: absent/null → 0 (the
// living all-enabled default), `[]` → all of them (everything gated), a subset
// → the count outside it. Drives the templates preview "🔒N intents" chip.
function deniedIntentCount(intentsList) {
  return GATEABLE_INTENTS.filter((i) => !intentEnabled(i.type, intentsList)).length;
}

module.exports = { GATEABLE_INTENTS, GATEABLE_TYPES, intentEnabled, intentsAllowlistFromChecked, deniedIntentCount };
