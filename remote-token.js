// remote-token.js — the operator's remote-wire token, GUI-managed and persisted
// in <userData>/remote.env (a 0600 single-key CLODEX_REMOTE_TOKEN env file), so
// the peer-wire gate (remote.js makeTokenGate) survives restarts WITHOUT the
// CLODEX_REMOTE_TOKEN env var an operator has to remember.
//
// DELIBERATELY separate from sandbox/auth.env: that file's CLODEX_REMOTE_TOKEN is
// the sandbox CONTAINER's auto-provisioned wire token — coupling the host gate to
// sandbox provisioning would surprise. Two files, one shared atomic primitive
// (env-file.js). Dependency-free (path + env-file only) so it unit-tests plainly.
const path = require('path');
const { readEnvFile, writeEnvFile } = require('./env-file');

const TOKEN_KEY = 'CLODEX_REMOTE_TOKEN';

const remoteEnvPath = (userDataPath) => path.join(userDataPath, 'remote.env');

// The stored operator token, or null when absent/empty. Single-key read.
function readRemoteEnvToken(userDataPath) {
  const t = readEnvFile(remoteEnvPath(userDataPath))[TOKEN_KEY];
  return t && t.length ? t : null;
}

// Set (non-empty string, trimmed) or clear (empty/null) the operator token.
// Reads the file first so a future second key survives, though today it's the
// only one. Returns the resulting hasToken boolean. Never returns the value.
function writeRemoteEnvToken(userDataPath, token) {
  const file = remoteEnvPath(userDataPath);
  const env = readEnvFile(file);
  const t = token == null ? '' : String(token).trim();
  if (t) env[TOKEN_KEY] = t; else delete env[TOKEN_KEY];
  writeEnvFile(file, env);
  return !!t;
}

function hasRemoteEnvToken(userDataPath) {
  return !!readRemoteEnvToken(userDataPath);
}

// Effective gate token, precedence per docs/remote-auth-plan.md §2 and the brief:
// an explicit process.env.CLODEX_REMOTE_TOKEN WINS (operator override; also keeps
// every existing env-var deployment working), else the GUI-managed file token,
// else null (localhost-trust). A named helper so the precedence is test-pinnable
// and can't silently drift.
function resolveRemoteToken(envToken, fileToken) {
  return envToken || fileToken || null;
}

module.exports = {
  TOKEN_KEY, remoteEnvPath,
  readRemoteEnvToken, writeRemoteEnvToken, hasRemoteEnvToken, resolveRemoteToken,
};
