'use strict';

const path = require('path');

const SOX_MISSING = 'SoX is not installed on this machine';
const NO_DEVICE = 'no audio capture device on this machine';
const SND_DIR = '/dev/snd';

function soxOnPath(platform, env, fs) {
  const raw = typeof env.PATH === 'string' ? env.PATH : (typeof env.Path === 'string' ? env.Path : '');
  if (!raw) return false;
  const sep = platform === 'win32' ? ';' : ':';
  const names = platform === 'win32' ? ['sox.exe', 'sox'] : ['sox'];
  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      let hit = false;
      try { hit = fs.existsSync(path.join(dir, name)) === true; } catch { hit = false; }
      if (hit) return true;
    }
  }
  return false;
}

function hasCaptureDevice(fs) {
  let entries = null;
  try { entries = fs.readdirSync(SND_DIR); } catch { return false; }
  return Array.isArray(entries) && entries.length > 0;
}

function readVoiceCapability({ platform = process.platform, env = process.env, fs = require('fs') } = {}) {
  if (platform === 'darwin') return { capable: true, cause: null };
  if (!soxOnPath(platform, env, fs)) return { capable: false, cause: SOX_MISSING };
  if (platform === 'linux' && !hasCaptureDevice(fs)) return { capable: false, cause: NO_DEVICE };
  return { capable: true, cause: null };
}

let once = null;

function readVoiceCapabilityCached() {
  if (!once) once = readVoiceCapability();
  return once;
}

readVoiceCapability.cached = readVoiceCapabilityCached;

module.exports = { readVoiceCapability, readVoiceCapabilityCached, SOX_MISSING, NO_DEVICE };
