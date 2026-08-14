'use strict';

// t379: a test that OPENS A SOCKET must dial a literal address, never a
// hostname.
//
// `listen(0)` does not hand out a free port — it hands out one free for the
// address family it BINDS. A wildcard bind (`::`, which is what `listen(port)`
// with no address gives here) does not conflict with a process holding the same
// port on `[::1]` specifically, so the allocator will happily return a port some
// other program is already listening on. A client that dials the NAME
// `localhost` resolves v6-first, the more specific bind wins, and the
// connection lands in that other program. On this box TextMate's rmate listener
// holds `[::1]:52698` and answers `220 ... RMATE`, which fails the HTTP parse.
//
// What makes it worth a guard rather than a memo is the failure SHAPE. Ephemeral
// ports here are 49152-65535 and handed out sequentially, so a full suite walks
// the range and eventually steps on the occupied port while a single-file run
// almost never does. The result is a parse error, in an unrelated file, at a
// probability set by where the allocator happened to be — and nobody debugging
// that starts at "TextMate". It cost this ticket a red board on a commit that
// had measured green minutes earlier.
//
// SCOPE, and it is deliberately narrow: only the FIRST ARGUMENT of a connecting
// call is examined. A URL containing a hostname is ordinary test DATA all over
// this suite — `openUrl(7810)`'s return value, a `global.location` stub, the
// rewrite assertions in api-shim/proxy-util — and none of those opens a socket.
// Matching on the hostname rather than on the construct that dials it would cry
// wolf on every one of them, and a guard that cries wolf gets deleted.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;

// The calls that actually open a socket. `fetch` is not used in this suite
// today; it is listed so the guard already covers the obvious next arrival.
const CONNECTORS = /(?:new\s+WebSocket|https?\.get|https?\.request|fetch)\s*\(/g;

// Addresses that name an interface rather than asking a resolver. `::1` is
// included because dialing it is explicit about the family, which is precisely
// what the hostname case fails to be.
const LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[?::1\]?|\[?::\]?|0\.0\.0\.0)$/;

// Take only the first argument of the call: the URL or the options object.
// Everything after the first top-level comma is the callback, whose body is
// unrelated code that would produce false positives if scanned.
function firstArg(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(' || c === '{' || c === '[') depth += 1;
    else if (c === ')' || c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, i);
    } else if (c === ',' && depth === 1) return src.slice(openParen + 1, i);
  }
  return src.slice(openParen + 1, Math.min(src.length, openParen + 400));
}

// The host a call will dial, or null when the argument names none (a variable,
// a helper's return value — not judgeable here, and not this guard's business).
function dialedHost(arg) {
  // Options-object form: { host: 'x' } / { hostname: 'x' }. The key must be
  // BARE, so a quoted `'Host':` request header is not mistaken for a target.
  const opt = arg.match(/(?:^|[{,\s])(hostname|host)\s*:\s*'([^']*)'/)
    || arg.match(/(?:^|[{,\s])(hostname|host)\s*:\s*"([^"]*)"/);
  if (opt) return opt[2];

  // URL form: the authority of a ws/wss/http/https literal. A `${...}` in the
  // host position is dynamic and skipped for the same reason as above.
  const url = arg.match(/['"`](?:wss?|https?):\/\/([^/'"`:$\s]+)/);
  if (url) return url[1];

  return null;
}

test('every test that opens a socket dials a literal address, not a hostname', () => {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.ok(files.length > 50,
    `ENTER: the scan found ${files.length} test files — a reduction that swept up nothing would make the empty result below vacuous`);

  const offenders = [];
  let connectSites = 0;

  for (const file of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    CONNECTORS.lastIndex = 0;
    let m;
    while ((m = CONNECTORS.exec(src)) !== null) {
      const host = dialedHost(firstArg(src, m.index + m[0].length - 1));
      if (host === null) continue;
      connectSites += 1;
      if (LITERAL.test(host)) continue;
      offenders.push(`${file}: ${m[0].replace(/\s*\($/, '')} dials '${host}'`);
    }
  }

  // ENTER, and the load-bearing one. This guard's whole risk is a matcher that
  // silently stops matching — a refactor to a helper, a renamed connector — at
  // which point `offenders` is empty because nothing was examined, and the
  // assertion below passes over an unmeasured suite. The count says the scan
  // reached real call sites. It is a floor, not a ratchet: it needs raising only
  // if it ever exceeds the real number, which would itself be the bug.
  assert.ok(connectSites >= 15,
    `ENTER: only ${connectSites} socket-opening call sites were resolved to a host — the matcher has stopped seeing this suite's clients, so an empty offender list below would mean nothing`);

  assert.deepStrictEqual(offenders, [],
    'these tests dial a hostname instead of a literal address. `listen(0)` only guarantees a port free for the family it binds, so a wildcard-bound test server can share a port with a loopback-only listener on the box; a hostname resolves v6-first and the connection lands in that other program. The failure surfaces as a protocol parse error, in whichever file the allocator happens to reach, at a rate nobody can reproduce on demand. Use 127.0.0.1');
});
