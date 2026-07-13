// claude-env.js — read a Claude session's EFFECTIVE process environment by
// merging process.env (base) with the `env` blocks of the settings layers the
// CLI loads (user < project < local, per-key later-wins), and classify whether
// that env routes the CLI to a TEE-BLIND backend (AWS Bedrock / GCP Vertex).
//
// Why it exists: the in-process wire tee only sees traffic that honors the
// ANTHROPIC_BASE_URL our hook injects. A session whose settings set
// CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX makes Claude Code route to
// AWS/GCP and IGNORE that base URL, so its bytes never traverse the tee: no
// turn.completed ever fires and the wire intent scanner goes dark. The
// transcript-recovery fallback doesn't catch it either (it arms on a tee
// FAILURE; Bedrock traffic never enters the tee, so nothing fails). At spawn,
// SessionManager consults this to force intentSource='jsonl' for such sessions —
// the JsonlWatcher reads the transcript, which is written regardless of backend,
// so for a tee-blind session jsonl is the CORRECT intent owner, not a fallback.
//
// Pure fs/os/path — no electron, no main.js state — mirroring main.js's
// readEffectiveSkillState/readEffectiveToolState over the same settings chain.

const path = require('path');
const os = require('os');
const { readJsonSafe } = require('./fs-util');

// CLI env truthiness: an env var is OFF when unset, "", "0", or "false"
// (case-insensitive), and ON for any other non-empty string — matching how a
// shell-exported flag or the CLI reads a boolean-ish env value.
function isEnvTruthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

// Merge process.env (base) < user < project < local `env` blocks, per-key
// later-wins, into a plain object. baseEnv and homeDir are injectable for
// hermetic tests; a layer with no `env` object is skipped. Folding process.env
// in as the base means a shell-exported global Bedrock flag correctly marks
// EVERY claude session tee-blind, not just ones with a settings-file entry.
function readEffectiveClaudeEnv(cwd, { baseEnv = process.env, homeDir = os.homedir() } = {}) {
  const merged = { ...baseEnv };
  const layers = [
    path.join(homeDir, '.claude', 'settings.json'),
    cwd ? path.join(cwd, '.claude', 'settings.json') : null,
    cwd ? path.join(cwd, '.claude', 'settings.local.json') : null,
  ];
  for (const file of layers) {
    if (!file) continue;
    const data = readJsonSafe(file);
    const env = data && data.env;
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) merged[k] = v;
    }
  }
  return merged;
}

// Which tee-blind backend (if any) a merged env selects: 'bedrock' | 'vertex' |
// null. Bedrock is checked first so a (nonsensical) both-set env is still
// classified deterministically — either way the session is tee-blind.
function teeBlindBackend(env) {
  if (!env) return null;
  if (isEnvTruthy(env.CLAUDE_CODE_USE_BEDROCK)) return 'bedrock';
  if (isEnvTruthy(env.CLAUDE_CODE_USE_VERTEX)) return 'vertex';
  return null;
}

module.exports = { isEnvTruthy, readEffectiveClaudeEnv, teeBlindBackend };
