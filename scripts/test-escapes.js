'use strict';

// test-escapes.js — find the failures `node --test` does NOT count.
//
// An error thrown on an async continuation that outlives its test escapes the
// per-test counters: the runner counts that test PASS and, at most, attributes
// one message-less failure to the FILE. When the file already has a real
// failure, Node emits no counter entry for the escape at all — which is how
// t25's four broken tests were reported as two.
//
// Node does say so, in a diagnostic that names the test, the file and the line.
// Every reporter carries it EXCEPT `dot`, which is the one our verification
// path used to run. This module is the parser; scripts/run-tests.js is the
// wrapper that runs the suite with a reporter that keeps the diagnostic, feeds
// it through here, and refuses to report green when anything escaped.
//
// Pure and dependency-free on purpose: it takes reporter text and returns
// structured escapes, so the suite can test it without running a suite.

// The one stable substring across the spec / tap / junit renderings. Both
// escape shapes (unhandled rejection and uncaught exception) contain it.
const MARK = 'generated asynchronous activity after the test ended';

// Reporter line decoration: tap prefixes `# `, spec prefixes `ℹ `, junit wraps
// the whole line in an XML comment. Strip whichever is present, then the
// `Error: ` the runner puts in front of its own diagnostic.
function undecorate(line) {
  return line
    .replace(/^\s*<!--\s*/, '')
    .replace(/\s*-->\s*$/, '')
    .replace(/^[\s#ℹ]*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

// text → [{ test, file, line, error, event, raw }]
//
// `test`/`file`/`line` are null for the unattributed shape — an escape that
// fires after every test in the file has finished belongs to no test, and Node
// says so ("A resource generated asynchronous activity…"). Reporting it with
// null attribution is honest; inventing an owner for it would not be.
function parseEscapes(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`parseEscapes needs the reporter text as a string, got ${typeof text}`);
  }
  const out = [];
  for (const raw of text.split('\n')) {
    if (!raw.includes(MARK)) continue;
    const line = undecorate(raw);
    const at = /Test "([\s\S]*?)" at (\S+?):(\d+):\d+ generated asynchronous/.exec(line);
    // The error message is quoted and may itself contain quotes, so anchor on
    // the two known continuations rather than on the closing quote.
    const err = /created the error "([\s\S]*?)"\s+(?:and would have caused|which triggered)/.exec(line);
    const ev = /triggered an (\w+) event/.exec(line);
    out.push({
      test: at ? at[1] : null,
      file: at ? at[2] : null,
      line: at ? Number(at[3]) : null,
      error: err ? err[1] : line,
      event: ev ? ev[1] : null,
      raw: line,
    });
  }
  return out;
}

// Escapes → the human report. Attribution is the payload: a wrapper that says
// "1 escape" and makes the reader go hunting has recreated the problem.
function formatEscapes(escapes) {
  if (!escapes.length) return 'ESCAPES: 0';
  const head = `ESCAPES: ${escapes.length} — counted PASS by the runner, listed here because they are not:`;
  const rows = escapes.map((e) => {
    const who = e.test === null
      ? '  ✖ ESCAPED (after every test in the file finished — no owning test)'
      : `  ✖ ESCAPED "${e.test}"`;
    const where = e.file === null ? null : `      at ${e.file}:${e.line}`;
    const what = `      ${e.error}${e.event ? ` (${e.event})` : ''}`;
    return [who, where, what].filter(Boolean).join('\n');
  });
  return [head, ...rows].join('\n');
}

module.exports = { parseEscapes, formatEscapes, MARK };
