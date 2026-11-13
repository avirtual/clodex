'use strict';

function resolveFs(load = require) {
  try { return load('original-fs'); } catch { return load('fs'); }
}

module.exports = { resolveFs };
