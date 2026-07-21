// errors.js — the exit-code contract and the typed error that carries it.
//
// Exit codes are a public contract (CI lives on them); documented identically
// in bin/clodexctl.js --help and README.md. Keep the two in sync with EXIT.
'use strict';

// The exit-code map. 0 is success (never an error); every failure mode a
// script might branch on gets a distinct nonzero code.
const EXIT = {
  OK: 0,          // success
  SERVER: 1,      // server-side failure (5xx, or an ok:false the server chose)
  USAGE: 2,       // bad invocation — unknown verb, missing/!valid args, bad flag
  CONNECT: 3,     // couldn't reach the wire at all (DNS/ECONNREFUSED/tunnel dead)
  AUTH: 4,        // 401/403 — missing/wrong token, or not the control holder
  NOTFOUND: 5,    // 404 — unknown session / route
};

// A CliError carries the exit code it should terminate the process with, plus
// a human message. `code` is one of EXIT.*. Never put a token in `.message` —
// callers scrub, but the throw sites must not introduce one either.
class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CliError';
    this.exitCode = code;
  }
}

// Map an HTTP status onto an exit code for the read/write verbs. 2xx never
// reaches here (callers handle ok). 401/403 → AUTH, 404 → NOTFOUND,
// everything else 4xx → USAGE (the request was malformed), 5xx → SERVER.
function exitForStatus(status) {
  if (status === 401 || status === 403) return EXIT.AUTH;
  if (status === 404) return EXIT.NOTFOUND;
  if (status >= 500) return EXIT.SERVER;
  if (status >= 400) return EXIT.USAGE;
  return EXIT.SERVER; // an unexpected non-2xx we didn't special-case
}

module.exports = { EXIT, CliError, exitForStatus };
