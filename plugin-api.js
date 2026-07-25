'use strict';
// plugin-api.js — the pure leaf both plugin-host halves share (plugin-plan.md [internal design doc, not in this repo]
// §1, §3.1). Constants, id rules, the kill switch, and the invoke error envelope
// live HERE so the engine host, the renderer host, the loader, and the tests all
// agree by construction instead of by three copies of a string.
//
// Pure leaf, like api-contract.js / clodex-paths.js: no requires, no side
// effects, no environment assumptions — safe in the Electron preload, in a plain
// Node test, in the browser bundle, and (critically) inside a plugin's engine
// half, which must never reach core internals except through the host argument.

// The published host-API version. "1" is FROZEN (Phase 3, plan §3.1/§6): the
// workbench pilot proved the shapes, and the surface is now a published contract
// documented in docs/plugin-api.md rather than an internal one. "0" — the
// explicitly-unstable predecessor — is gone; a plugin written against it names a
// version this host does not serve and is refused by name, which is the whole
// point of the field.
//
// WHAT A BUMP MEANS. A manifest whose `hostApi` doesn't match refuses to load
// with a named error rather than half-activating against a surface it predates,
// so this string is the compatibility gate for every plugin in existence.
// ADDITIVE changes — a new slot, a new `host`/`rhost` member, a new optional
// manifest field — do NOT bump it; they ship as "1.1 behaviour" that older
// plugins simply don't use, and docs/plugin-api.md records when each arrived.
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
// off", and every OTHER plugin is silently disabled at the next launch. The
// comments in plugin-loader.js already called `enabled` reserved; nothing
// enforced it, and the only artifact was a const holding the key name.
//
// `_failures` — the quarantine shadow, the other key in that object — needs no
// entry here: PLUGIN_ID_RE forbids a leading underscore, so it is collision-proof
// by construction, exactly as `_host` is. This set is for keys the regex ALLOWS.
// Anything added to `uiSettings.plugins` under a regex-legal name belongs here.
const RESERVED_PLUGIN_IDS = new Set(['enabled']);

function isValidPluginId(id) {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id) && !RESERVED_PLUGIN_IDS.has(id);
}

// Host-owned namespacing (plan §2.1/§2.4): every id a plugin registers — status
// bar action, session-menu act, dispatch method — is prefixed by the host, never
// by the plugin. `_host` is the reserved pseudo-plugin the renderer host uses for
// its own privileged calls (settings.set), so it can never collide with a real id
// (PLUGIN_ID_RE forbids a leading underscore).
const HOST_PSEUDO_ID = '_host';
function namespaced(pluginId, id) {
  return `${pluginId}:${id}`;
}

// The kill switch (plan §3.1, §6): `CLODEX_PLUGINS=0` skips the loader entirely,
// so the whole program stays globally reversible with an env var. Only the exact
// string '0' disables — an unset var, an empty var, or anything else is ON, so a
// typo fails safe toward today's behavior.
function pluginsEnabled(env = {}) {
  return String(env.CLODEX_PLUGINS ?? '') !== '0';
}

// The invoke error envelope (plan §3.4). A disabled plugin, an unknown id, or an
// unregistered method degrades LOUDLY — the caller gets a shaped refusal it can
// render — rather than silently resolving undefined, which is indistinguishable
// from "the call worked and returned nothing".
const NO_SUCH_METHOD = 'no such plugin method';
function errorEnvelope(error) {
  return { ok: false, error };
}

module.exports = {
  HOST_API_VERSION,
  PLUGIN_ID_RE,
  RESERVED_PLUGIN_IDS,
  isValidPluginId,
  HOST_PSEUDO_ID,
  namespaced,
  pluginsEnabled,
  NO_SUCH_METHOD,
  errorEnvelope,
};
