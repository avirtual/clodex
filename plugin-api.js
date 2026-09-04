'use strict';
// plugin-api.js — the pure leaf both plugin-host halves share. Constants, id
// rules, the kill switch, and the invoke error envelope
// live HERE so the engine host, the renderer host, the loader, and the tests all
// agree by construction instead of by three copies of a string.
//
// Pure leaf, like api-contract.js / clodex-paths.js: no requires, no side
// effects, no environment assumptions — safe in the Electron preload, in a plain
// Node test, in the browser bundle, and (critically) inside a plugin's engine
// half, which must never reach core internals except through the host argument.

// The published host-API version. "1" is FROZEN. "0" — the explicitly-unstable
// predecessor — is gone; a plugin written against it names a version this host
// does not serve and is refused by name, which is the whole point of the field.
//
// WHAT A BUMP MEANS. A manifest whose `hostApi` doesn't match refuses to load
// with a named error rather than half-activating against a surface it predates,
// so this string is the compatibility gate for every plugin in existence.
// ADDITIVE changes — a new slot, a new `host`/`rhost` member, a new optional
// manifest field — do NOT bump it; they ship as "1.1 behaviour" that older
// plugins simply don't use, and plugins/plugin-api.md records when each arrived.
// Only a change that could break a conforming "1" plugin bumps to "2".
const HOST_API_VERSION = '1';

// Plugin ids and the tokens derived from them (intent verbs, dispatch methods,
// DOM `data-plugin` attributes, storage dir names). Deliberately narrower than
// the session-name regex: an id becomes a filesystem directory AND a CSS
// attribute selector AND an intent verb, so it stays lowercase-alnum with single
// separators and no leading/trailing punctuation.
const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Ids the regex would happily accept but the SETTINGS LAYOUT cannot afford.
// `uiSettings.plugins` is one object holding per-plugin settings under
// `plugins[<id>]` AND the enabled list under `plugins.enabled` — so a plugin
// literally named `enabled` writes its settings object over the user's enabled
// ARRAY on its first `host.settings.set`. `sanitizePlugins` then coerces the
// non-array to `[]`, `enabledSet()` reads `[]` as "the user turned everything
// off", and every OTHER plugin is silently disabled at the next launch.
//
// `_failures` — the quarantine shadow, the other key in that object — needs no
// entry here: PLUGIN_ID_RE forbids a leading underscore, so it is collision-proof
// by construction, exactly as `_host` is. This set is for keys the regex ALLOWS.
// Anything added to `uiSettings.plugins` under a regex-legal name belongs here.
const RESERVED_PLUGIN_IDS = new Set(['enabled']);

function isValidPluginId(id) {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id) && !RESERVED_PLUGIN_IDS.has(id);
}

// ── Scope (t190) ────────────────────────────────────────────────────────────
// `global` is the default and is today's behaviour exactly: the plugin's rows,
// grammar lines and per-session UI appear for every session.
//
// Additive by design (see HOST_API_VERSION above): an absent `scope` resolves to
// `global`, so every manifest written against "1" keeps working and the field
// costs no version bump. Retrofitting the gate LATER would, which is why the
// vocabulary is declared before anything ships that needs it.
const PLUGIN_SCOPES = Object.freeze(['global', 'session']);
const DEFAULT_PLUGIN_SCOPE = 'global';

function scopeOf(manifest) {
  const s = manifest && manifest.scope;
  return s === 'session' ? 'session' : DEFAULT_PLUGIN_SCOPE;
}

// Capabilities are separate grants because they carry different RISK, not
// because they name different plugins. Bash commands and Write contents are the
// sharpest thing on offer; sharing a grant with turn text would hand every turn
// archiver the full command history as a side effect.
//
// Order is the order they are offered in the UI, weakest first. It is not a
// hierarchy — holding `toolInputs` does not imply `turns`; each is independent
// and each defaults OFF.
const PLUGIN_CAPABILITIES = Object.freeze(['turns', 'thinking', 'toolInputs']);

// `:` is what makes a grant token unforgeable as an intent verb and vice versa:
// PLUGIN_VERB_RE admits no colon, so a grant list and an intents list can never
// be confused for one another even though they ride the same entry.
function grantToken(pluginId, capability) {
  return `${pluginId}:${capability}`;
}

function isValidCapability(capability) {
  return PLUGIN_CAPABILITIES.includes(capability);
}

// STRICT, exactly like intentEnabledFor's plugin branch: an absent list is a
// refusal, never the living all-enabled default. A scoped plugin that fell back
// to "granted" on a session created before the plugin existed would be a
// retroactive grant to every seat that ever existed.
function pluginGranted(pluginId, capability, grants) {
  if (!Array.isArray(grants)) return false;
  if (!isValidCapability(capability)) return false;
  return grants.includes(grantToken(pluginId, capability));
}

// The door filter for anything arriving from a renderer or over the wire. An
// unknown capability is already inert (pluginGranted refuses it), so this is
// about not PERSISTING junk that a later, wider vocabulary would silently
// activate: a `p:everything` token written today must not become a real grant
// the day `everything` is added.
function sanitizeGrants(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const at = raw.indexOf(':');
    if (at <= 0) continue;
    const id = raw.slice(0, at);
    const cap = raw.slice(at + 1);
    if (!isValidPluginId(id) || !isValidCapability(cap)) continue;
    seen.add(grantToken(id, cap));
  }
  return [...seen];
}

// The grants a grants EDITOR must carry forward untouched: those held for a
// plugin it drew no row for. The editor is offered only enabled, unquarantined
// plugins, and quarantine is AUTOMATIC on repeated failure — so a whole-list
// save would silently revoke every grant for a plugin that quarantined itself,
// with no operator action anywhere in the chain. Lives here rather than in the
// popover because the popover is DOM-bound and untestable, and this arithmetic
// is the whole fix.
function grantsForUnlistedPlugins(granted, listedPluginIds) {
  if (!Array.isArray(granted)) return [];
  const listed = new Set(listedPluginIds || []);
  return granted.filter((g) => {
    if (typeof g !== 'string') return false;
    const at = g.indexOf(':');
    return at > 0 && !listed.has(g.slice(0, at));
  });
}

// The other half of that fix, and here for the same reason: the union itself is
// what the editor SAVES, so a fix that computes the carry-forward correctly and
// then drops it on the way out is no fix at all. Both halves in the leaf means
// one mutant kills the shipped behaviour rather than a test's copy of it.
function mergeGrants(checked, unlisted) {
  return [...new Set([...(checked || []), ...(unlisted || [])])];
}

// The same hazard on the SURFACING axis: the checklist draws only registered,
// globally-enabled plugins, so a quarantined or globally-off one has no row, and
// saving the checked set alone drops it from the seat — the server then prunes
// its verbs and grants too, and re-enabling the plugin brings none of it back.
function pluginsForUnlistedPlugins(persisted, listedPluginIds) {
  if (!Array.isArray(persisted)) return [];
  const listed = new Set((listedPluginIds || []).map(String));
  return persisted.filter((id) => typeof id === 'string' && !listed.has(id));
}

// The union half, in the leaf for the reason mergeGrants states.
function mergePlugins(checked, unlisted) {
  return [...new Set([...(checked || []).map(String), ...(unlisted || []).map(String)])];
}

// The SURFACING predicate. An absent list is the living all-enabled default,
// NOT `pluginGranted`'s strict absent-=-none: flipping it strips every
// pre-upgrade seat of the shipped plugins with no migration back.
function seatHasPlugin(pluginId, pluginsList) {
  if (!Array.isArray(pluginsList)) return true;
  return pluginsList.includes(String(pluginId));
}


// Host-owned namespacing: every id a plugin registers — status
// bar action, session-menu act, dispatch method — is prefixed by the host, never
// by the plugin. `_host` is the reserved pseudo-plugin the renderer host uses for
// its own privileged calls (settings.set), so it can never collide with a real id
// (PLUGIN_ID_RE forbids a leading underscore).
const HOST_PSEUDO_ID = '_host';
function namespaced(pluginId, id) {
  return `${pluginId}:${id}`;
}

// The kill switch: `CLODEX_PLUGINS=0` skips the loader entirely,
// so the whole program stays globally reversible with an env var. Only the exact
// string '0' disables — an unset var, an empty var, or anything else is ON, so a
// typo fails safe toward today's behavior.
function pluginsEnabled(env = {}) {
  return String(env.CLODEX_PLUGINS ?? '') !== '0';
}

// ── Caller surface (t217) ───────────────────────────────────────────────────
// `plugin:invoke` is ONE multiplexed channel serving every plugin method, and
// it is registered unconditionally because the web renderer legitimately uses
// plugins. So the drawer's gate-by-non-registration (`enableDrawerServices`)
// cannot see plugin methods at all: registration is per-channel, and there is
// one channel. The surface therefore has to ride the CALL.
//
// Two vocabularies, and they are deliberately not the same one. A CALLER is
// 'desktop' or 'web' — where the invoke physically came from. A METHOD requires
// 'desktop' or 'any' — how much reach it needs. Collapsing them would make
// `surfaces: { "x": "web" }` writable, i.e. a method that the DESKTOP cannot
// call, which nothing wants and which would read as a grant.
const PLUGIN_SURFACES = Object.freeze(['desktop', 'web']);
const PLUGIN_METHOD_SURFACES = Object.freeze(['desktop', 'any']);
const DEFAULT_METHOD_SURFACE = 'desktop';

// Per-METHOD, and with no per-plugin default to inherit: a plugin-level "any"
// would hand every method added later the permission it never asked for, which
// is the shape of the defect this exists to close. An unlisted method is
// desktop-only, so a manifest that says nothing is fully restricted.
function methodSurfaceOf(manifest, method) {
  const table = manifest && manifest.surfaces;
  if (!table || typeof table !== 'object') return DEFAULT_METHOD_SURFACE;
  const want = table[String(method)];
  return want === 'any' ? 'any' : DEFAULT_METHOD_SURFACE;
}

// Anything that is not exactly the desktop token is untrusted — including
// undefined. A transport that forgets to declare itself must land in the
// restricted branch, because "caller unknown ⇒ trusted" IS the defect.
function surfaceAllows(callerSurface, requiredSurface) {
  if (callerSurface === 'desktop') return true;
  return requiredSurface === 'any';
}

// The invoke error envelope. A disabled plugin, an unknown id, or an
// unregistered method degrades LOUDLY — the caller gets a shaped refusal it can
// render — rather than silently resolving undefined, which is indistinguishable
// from "the call worked and returned nothing".
const NO_SUCH_METHOD = 'no such plugin method';
// A refusal for surface, not for existence. Distinct from NO_SUCH_METHOD so the
// operator-facing message can say why, but it rides the SAME envelope shape, so
// every caller's existing failure branch already handles it.
const NOT_ON_THIS_SURFACE = 'plugin method not available on this surface';
function errorEnvelope(error) {
  return { ok: false, error };
}

module.exports = {
  HOST_API_VERSION,
  PLUGIN_ID_RE,
  RESERVED_PLUGIN_IDS,
  isValidPluginId,
  PLUGIN_SCOPES,
  DEFAULT_PLUGIN_SCOPE,
  scopeOf,
  PLUGIN_CAPABILITIES,
  grantToken,
  isValidCapability,
  sanitizeGrants,
  grantsForUnlistedPlugins,
  pluginsForUnlistedPlugins,
  mergePlugins,
  mergeGrants,
  pluginGranted,
  seatHasPlugin,
  HOST_PSEUDO_ID,
  namespaced,
  pluginsEnabled,
  PLUGIN_SURFACES,
  PLUGIN_METHOD_SURFACES,
  DEFAULT_METHOD_SURFACE,
  methodSurfaceOf,
  surfaceAllows,
  NO_SUCH_METHOD,
  NOT_ON_THIS_SURFACE,
  errorEnvelope,
};
