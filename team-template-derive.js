'use strict';

const MODEL_ALIASES = {
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
};

const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

function resolveModelId(v) {
  if (typeof v !== 'string' || !v) return null;
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, v)) return MODEL_ALIASES[v];
  return MODEL_ID_RE.test(v) ? v : null;
}

function stripModelArgs(extraArgs) {
  const rest = [];
  const src = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < src.length; i += 1) {
    const tok = src[i];
    if (tok === '--model') { i += 1; continue; }
    if (typeof tok === 'string' && tok.startsWith('--model=')) continue;
    rest.push(tok);
  }
  return rest;
}

const LISTING_KEYS = ['id', 'shadowedBy', 'plugin', 'pluginName'];

function deriveModelTemplate(base, roleName, modelId) {
  const out = { ...base };
  for (const k of LISTING_KEYS) delete out[k];
  out.name = roleName;
  out.extraArgs = ['--model', modelId, ...stripModelArgs(base && base.extraArgs)];
  return out;
}

module.exports = { resolveModelId, deriveModelTemplate };
