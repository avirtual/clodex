'use strict';

const CAP_KEYS = ['injectSkills', 'skillRoster', 'plugins', 'agents', 'tools', 'strip', 'autoCompact', 'noWire'];

const PROVIDER_CAPS = {
  claude: {
    injectSkills: true,
    skillRoster: true,
    plugins: true,
    agents: true,
    tools: true,
    strip: true,
    autoCompact: true,
    noWire: true,
  },
  codex: {
    injectSkills: true,
    skillRoster: false,
    plugins: true,
    agents: false,
    tools: false,
    strip: false,
    autoCompact: false,
    noWire: false,
  },
};

const NO_CAPS = Object.freeze(Object.fromEntries(CAP_KEYS.map((k) => [k, false])));

function capsFor(type) {
  return PROVIDER_CAPS[type] || NO_CAPS;
}

module.exports = { PROVIDER_CAPS, CAP_KEYS, capsFor };
