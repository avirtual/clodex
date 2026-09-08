'use strict';

const LIBRARY_REPO = 'avirtual/clodex-plugins';

const ORIGIN_GLYPHS = {
  core: '◆',
  library: '▣',
  remote: '↗',
  local: '▪',
};

function pluginOrigin(p) {
  const row = p || {};
  if (row.root === 'core') {
    return { kind: 'core', glyph: ORIGIN_GLYPHS.core, label: 'Built in' };
  }
  const repo = (row.source && row.source.repo) || '';
  if (repo === LIBRARY_REPO) {
    return { kind: 'library', glyph: ORIGIN_GLYPHS.library, label: 'From the clodex-plugins library' };
  }
  if (repo) {
    return { kind: 'remote', glyph: ORIGIN_GLYPHS.remote, label: `From github.com/${repo}` };
  }
  const linked = row.linkedFrom || '';
  return {
    kind: 'local',
    glyph: ORIGIN_GLYPHS.local,
    label: linked ? `Local, registered from ${linked}` : 'Local',
  };
}

module.exports = { pluginOrigin, ORIGIN_GLYPHS, LIBRARY_REPO };
