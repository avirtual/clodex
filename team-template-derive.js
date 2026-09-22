'use strict';

const adapters = require('./cli-adapters');

const { stripModelArgs, DEFAULT_TYPE, ADAPTERS, adapterFor } = adapters;

function resolveModelId(type, v) {
  const a = adapterFor(type);
  if (a && typeof v === 'string' && !Object.prototype.hasOwnProperty.call(a.model.aliases, v)) {
    for (const other of Object.values(ADAPTERS)) {
      if (other !== a && Object.prototype.hasOwnProperty.call(other.model.aliases, v)) return null;
    }
  }
  return adapters.resolveModelId(type, v);
}

const LISTING_KEYS = ['id', 'shadowedBy', 'plugin', 'pluginName'];

function deriveModelTemplate(base, roleName, modelId) {
  const out = { ...base };
  for (const k of LISTING_KEYS) delete out[k];
  out.name = roleName;
  const type = (base && base.type) || DEFAULT_TYPE;
  out.extraArgs = ['--model', modelId, ...stripModelArgs(type, base && base.extraArgs)];
  return out;
}

module.exports = { resolveModelId, deriveModelTemplate, LISTING_KEYS };
