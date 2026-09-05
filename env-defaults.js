'use strict';

const fs = require('fs');
const { envKeyError } = require('./env-scopes');

function loadEnvDefaults(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
    const value = rec.value;
    if (typeof value !== 'string') continue;
    if (envKeyError(key, value)) continue;
    out[key] = { value, note: typeof rec.note === 'string' ? rec.note : '' };
  }
  return out;
}

function planEnvSeed({ defaults = {}, global = {}, seeded = [] } = {}) {
  const already = new Set(Array.isArray(seeded) ? seeded.filter((k) => typeof k === 'string') : []);
  const writes = [];
  const nextSeeded = [...already];
  for (const [key, rec] of Object.entries(defaults)) {
    if (already.has(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(global, key)) writes.push({ key, value: rec.value });
    nextSeeded.push(key);
  }
  return { writes, seeded: nextSeeded };
}

module.exports = { loadEnvDefaults, planEnvSeed };
