'use strict';

// wire/claude-auth.js — read the CLI's CURRENT Claude OAuth access token.
//
// Why this exists: a keep-warm ping replays the seat's last request with the
// headers captured at that turn (wire/hold.js), and those headers carry a
// bearer that lives ~8 hours. The CLI refreshes it on its own turns and writes
// the new one here. On an IDLE seat — the only case a perpetual hold exists for
// — no turn happens, so the captured bearer ages out mid-hold and the ping
// 401s. Measured 2026-08-15: two 401s a minute apart struck out a perpetual
// hold that then sat dead for ten hours.
//
// Two stores, in the order the CLI prefers them: the plaintext file if it is
// there (linux, containers, and a Mac where the CLI was told not to use the
// keychain), otherwise the login keychain. The keychain item's ACL already
// trusts /usr/bin/security with export_clear, so this never prompts — but the
// timeout is here because a LOCKED keychain would otherwise block the main
// process on a GUI dialog nobody asked for.
//
// Returns nulls for every failure. A caller that cannot read a token must
// DECLINE its ping, never send the stale one: a decline costs no failure
// strike, and the 2-strike rule still has to mean "this credential is dead".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CRED_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function shape(raw) {
  const o = (raw && raw.claudeAiOauth) || {};
  return {
    accessToken: typeof o.accessToken === 'string' && o.accessToken ? o.accessToken : null,
    // epoch MILLISECONDS, as the CLI writes it.
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
  };
}

function readClaudeAuth() {
  try {
    if (fs.existsSync(CRED_FILE)) return shape(JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')));
  } catch { /* fall through to the keychain */ }
  if (process.platform !== 'darwin') return { accessToken: null, expiresAt: null };
  try {
    const out = execFileSync('/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return shape(JSON.parse(out));
  } catch {
    return { accessToken: null, expiresAt: null };
  }
}

module.exports = { readClaudeAuth, CRED_FILE, KEYCHAIN_SERVICE };
