'use strict';

const adapters = require('./cli-adapters');

const { resolveModelId, stripModelArgs, DEFAULT_TYPE } = adapters;

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
