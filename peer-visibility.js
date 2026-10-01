'use strict';

function nextVisibleWithName(sel, name) {
  if (!Array.isArray(sel) || sel.includes(name)) return null;
  return [...sel, name];
}

function nextVisibleWithoutName(sel, name, liveNames) {
  if (Array.isArray(sel)) return sel.includes(name) ? sel.filter((n) => n !== name) : null;
  if (!Array.isArray(liveNames)) return null;
  return [...new Set(liveNames)].filter((n) => n !== name);
}

module.exports = { nextVisibleWithName, nextVisibleWithoutName };
