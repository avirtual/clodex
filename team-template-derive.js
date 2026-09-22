'use strict';

const adapters = require('./cli-adapters');

const resolveModelId = (v) => adapters.resolveModelId('claude', v);
const stripModelArgs = (extraArgs) => adapters.stripModelArgs('claude', extraArgs);

const LISTING_KEYS = ['id', 'shadowedBy', 'plugin', 'pluginName'];

function deriveModelTemplate(base, roleName, modelId) {
  const out = { ...base };
  for (const k of LISTING_KEYS) delete out[k];
  out.name = roleName;
  out.extraArgs = ['--model', modelId, ...stripModelArgs(base && base.extraArgs)];
  return out;
}

module.exports = { resolveModelId, deriveModelTemplate, LISTING_KEYS };
