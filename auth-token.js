// auth-token.js — the single operator-token predicate shared by both HTTP hosts
// (web-host.js and remote.js). One place decides "does this request carry the
// configured secret", so the two wires can't drift apart (remote-auth-plan.md [internal design doc, not in this repo]
// §1). Pure leaf: no electron, no I/O, no host state — just a token string in and
// a { check, fromReq } pair out. NEW module — deliberately NOT in the leak-scanner
// lists; it isn't a coordinator extraction, it's a fresh shared primitive.
'use strict';

const crypto = require('crypto');

// Build a gate for one configured token (or null/empty = "no token configured").
//   check(provided)  → does `provided` match the configured secret?
//     - no token configured → true (the caller layers its own trust policy on
//       top: web-host keeps localhost-trust; remote adds the fail-closed rule).
//     - token configured → a constant-time compare over equal-length buffers.
//       A length mismatch short-circuits to false WITHOUT a timingSafeEqual call
//       (it throws on unequal lengths), so the length is the only thing a timing
//       side-channel could learn — never a prefix of the secret.
//   fromReq(req)     → pull a candidate token off a Node http request, in
//     precedence order: `?token=` query, then `Authorization: Bearer`, then the
//     `clodex_remote_token` cookie. Same precedence for both hosts; only remote
//     ever SETS the cookie (web-host never issues it), but reading it here is
//     harmless and keeps the one extraction path identical.
//   configured       → whether a token is set, so a caller (remote's fail-closed
//     rule) can branch on presence without re-deriving it.
function makeTokenGate(token) {
  const configured = !!(token && String(token).length);
  const secret = configured ? Buffer.from(String(token), 'utf8') : null;

  function check(provided) {
    if (!configured) return true;
    if (provided == null) return false;
    const p = Buffer.from(String(provided), 'utf8');
    if (p.length !== secret.length) return false;   // no equal-length buffer → no compare
    return crypto.timingSafeEqual(p, secret);
  }

  function fromReq(req) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const q = u.searchParams.get('token');
      if (q) return q;
    } catch { /* malformed url — fall through to header/cookie */ }
    const auth = (req.headers && req.headers['authorization']) || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m) return m[1];
    const cookie = (req.headers && req.headers['cookie']) || '';
    const cm = /(?:^|;\s*)clodex_remote_token=([^;]+)/.exec(cookie);
    if (cm) { try { return decodeURIComponent(cm[1]); } catch { return cm[1]; } }
    return null;
  }

  return { check, fromReq, configured };
}

module.exports = { makeTokenGate };
