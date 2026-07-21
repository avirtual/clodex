// contexts.js — the kubeconfig for clodexctl. ~/.clodex/cli/contexts.json,
// CLI-owned (deliberately separate from the GUI's peers array). Holds tokens,
// so it is created 0600 and its mode is checked on read (warn, don't fail, if
// group/world-readable — the operator may have reasons, but they should know).
//
// Resolution precedence (kubectl-style): file(current or --ctx) < env
// (CLODEX_URL/CLODEX_TOKEN) < flags(--url/--token). A url from env or a flag
// switches the transport to DIRECT (drops any ssh/tunnel from the file entry);
// token overlays independently of transport.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CliError, EXIT } = require('./errors');

function cliDir() { return path.join(os.homedir(), '.clodex', 'cli'); }
function contextsPath() { return path.join(cliDir(), 'contexts.json'); }

// Load the raw file, or an empty store if absent. Warns (once) on a loose mode.
function load(file = contextsPath(), { warn = defaultWarn } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { current: null, contexts: {} };
    throw new CliError(EXIT.USAGE, `cannot read contexts file: ${e.message}`);
  }
  // Chmod check: warn if group/world can read the token file.
  try {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) warn(`contexts file ${file} is mode ${mode.toString(8)} — tokens are group/world-readable; run: chmod 600 ${file}`);
  } catch {}
  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { throw new CliError(EXIT.USAGE, `contexts file is not valid JSON: ${e.message}`); }
  if (!obj || typeof obj !== 'object') throw new CliError(EXIT.USAGE, 'contexts file must be a JSON object');
  return { current: obj.current || null, contexts: obj.contexts && typeof obj.contexts === 'object' ? obj.contexts : {} };
}

// Persist the store 0600. Creates ~/.clodex/cli with 0700 if needed.
function save(store, file = contextsPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ current: store.current || null, contexts: store.contexts || {} }, null, 2) + '\n';
  // Write then chmod: mkdirSync mode is umask-masked and an existing file keeps
  // its old mode, so assert 0600 explicitly rather than trust the open mode.
  fs.writeFileSync(file, body, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

// Validate + normalize one context entry (as stored). Exactly one transport.
// Cloud kinds (ssm/kubectl/gcloud/az) are typed OBJECTS validated per-kind; ssh
// stays a scalar string and tunnel a raw argv array. Unknown sibling fields
// inside a kind object are IGNORED (forward compat), never rejected.
const TRANSPORT_KINDS = ['url', 'ssh', 'tunnel', 'ssm', 'kubectl', 'gcloud', 'az'];
function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') throw new CliError(EXIT.USAGE, 'context entry must be an object');
  const kinds = TRANSPORT_KINDS.filter((k) => entry[k] != null);
  if (kinds.length === 0) throw new CliError(EXIT.USAGE, 'context needs one transport: --url, --ssh, --tunnel, or a cloud kind (--ssm/--ssm-ecs/--kubectl/--gcloud-iap/--az-bastion)');
  if (kinds.length > 1) throw new CliError(EXIT.USAGE, `context has conflicting transports (${kinds.join(', ')}) — pick one`);
  if (entry.tunnel != null && (!Array.isArray(entry.tunnel) || entry.tunnel.length === 0)) {
    throw new CliError(EXIT.USAGE, 'tunnel must be a non-empty argv array');
  }
  if (entry.tunnel != null && !entry.tunnel.some((a) => String(a).includes('{port}'))) {
    throw new CliError(EXIT.USAGE, 'tunnel argv must contain a {port} placeholder');
  }
  if (entry.ssm != null) validateSsm(entry.ssm);
  if (entry.kubectl != null) validateObjKind(entry.kubectl, 'kubectl', 'target', '--kubectl');
  if (entry.gcloud != null) validateObjKind(entry.gcloud, 'gcloud', 'instance', '--gcloud-iap');
  if (entry.az != null) validateAz(entry.az);
  return entry;
}

// ssm: an object taking EXACTLY ONE of target | ecs. An ecs spec must parse as
// CLUSTER/FAMILY (validated at add time, not just at open).
function validateSsm(ssm) {
  if (!ssm || typeof ssm !== 'object') throw new CliError(EXIT.USAGE, 'ssm transport must be an object');
  const has = ['target', 'ecs'].filter((k) => ssm[k] != null && String(ssm[k]) !== '');
  if (has.length === 0) throw new CliError(EXIT.USAGE, 'ssm needs one of --ssm TARGET or --ssm-ecs CLUSTER/FAMILY');
  if (has.length > 1) throw new CliError(EXIT.USAGE, 'ssm takes exactly one of --ssm / --ssm-ecs, not both');
  if (ssm.ecs != null && String(ssm.ecs) !== '') {
    const s = String(ssm.ecs);
    const slash = s.indexOf('/');
    if (slash < 0 || slash !== s.lastIndexOf('/') || slash === 0 || slash === s.length - 1) {
      throw new CliError(EXIT.USAGE, `--ssm-ecs must be CLUSTER/FAMILY (one slash, both halves non-empty), got "${s}"`);
    }
  }
}

// A single-required-field object kind (kubectl.target, gcloud.instance).
function validateObjKind(obj, kind, field, flag) {
  if (!obj || typeof obj !== 'object') throw new CliError(EXIT.USAGE, `${kind} transport must be an object`);
  if (obj[field] == null || String(obj[field]) === '') throw new CliError(EXIT.USAGE, `${kind} needs ${flag} — a non-empty ${field}`);
}

// az: all three of bastion / resourceGroup / target required; name each missing.
function validateAz(az) {
  if (!az || typeof az !== 'object') throw new CliError(EXIT.USAGE, 'az transport must be an object');
  const need = { bastion: '--az-bastion', resourceGroup: '--az-resource-group', target: '--az-target' };
  const missing = Object.keys(need).filter((k) => az[k] == null || String(az[k]) === '');
  if (missing.length) throw new CliError(EXIT.USAGE, `az transport needs ${missing.map((k) => need[k]).join(', ')}`);
}

// Resolve the effective context: pick the named/current file entry, then layer
// env, then flags. Returns { url? , ssh?, tunnel?, remotePort?, token, name }.
// `name` is the source label for messages ('(flags)' / '(env)' / ctx name).
function resolve(store, { ctxName = null, env = process.env, flags = {} } = {}) {
  let entry = null;
  let label = null;

  // Base: a named context, or the current one (only if neither --url nor env
  // URL fully overrides — but we still honor an explicit --ctx even alongside
  // flags, to allow "this context but a different token").
  const wanted = ctxName || store.current;
  if (wanted) {
    entry = store.contexts[wanted];
    if (ctxName && !entry) throw new CliError(EXIT.USAGE, `no such context: ${ctxName}`);
    if (entry) { entry = { ...entry }; label = wanted; }
  }

  // Env layer (CLODEX_URL / CLODEX_TOKEN). A URL switches transport to direct.
  const envUrl = env.CLODEX_URL && String(env.CLODEX_URL).trim();
  const envToken = env.CLODEX_TOKEN && String(env.CLODEX_TOKEN).trim();
  if (envUrl) { entry = { url: envUrl }; label = '(env)'; }
  if (envToken) { entry = { ...(entry || {}), token: envToken }; if (!envUrl && !label) label = '(env)'; }

  // Flag layer (highest). --url wins over everything and forces direct.
  // --url and --ssh together is a contradiction (two transports, one call) —
  // reject rather than let code order silently pick a winner.
  if (flags.url && flags.ssh) {
    throw new CliError(EXIT.USAGE, 'pass either --url or --ssh, not both (one transport per call)');
  }
  if (flags.url) { entry = { url: String(flags.url) }; label = '(flags)'; }
  if (flags.ssh) { entry = { ssh: String(flags.ssh), ...(flags.remotePort ? { remotePort: flags.remotePort } : {}) }; label = '(flags)'; }
  if (flags.token) { entry = { ...(entry || {}), token: String(flags.token) }; if (!label) label = '(flags)'; }
  if (flags.remotePort && entry && entry.ssh && !flags.ssh) entry.remotePort = flags.remotePort;

  if (!entry) {
    throw new CliError(EXIT.USAGE,
      'no context selected — set one with `clodexctl ctx add … && clodexctl ctx use …`, or pass --url/--token (or CLODEX_URL/CLODEX_TOKEN)');
  }
  validateEntry(entry);
  return { ...entry, name: label };
}

function defaultWarn(msg) { process.stderr.write(`clodexctl: warning: ${msg}\n`); }

module.exports = {
  cliDir, contextsPath, load, save, validateEntry, resolve,
};
