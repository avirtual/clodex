// ticket-refs.js — check a ticket's line references by CONTENT, not by whether
// they resolve.
//
// WHY THE OBVIOUS TOOL DOES NOT WORK. "Report which references no longer
// resolve" was built and measured against the four known defects in the
// registry-cluster tickets (t75/t76/t77): it passes ALL of them, because every
// cited line exists in a file that exists. The defect is never a dangling
// reference — it is a reference that still lands somewhere and lands on the
// WRONG thing: comment prose instead of the guard, the right statement four
// lines over, a symbol that is not in the file at all.
//
// So the check is: a ticket's line reference almost always sits next to a
// symbol naming what is supposedly there (`registry.cleanup()`, `rmSync`,
// `existsSync(socket) && isAlive(pid)`). Bind the symbol to the reference, then
// ask whether that symbol is actually at that line.
//
// ADVISORY AT DISPATCH TIME, NOT A GATE. Reference drift is normal and mostly
// harmless; this exists so a ticket that is about to be worked can be spot-
// checked, and MOVED findings carry the real line so the fix is mechanical.
//
// ── SCOPE LIMITS ───────────────────────────────────────────────────────────
// These are limits of the technique, not gaps to be closed later:
//
// 1. Only references that NAME A SYMBOL are checkable. A bare `:2366` whose
//    description is prose gets SKIPPED — there is nothing to grep for. Silence
//    on a reference is not a clean bill of health, and SKIPPED is reported
//    rather than dropped so the count is visible.
// 2. It cannot see the "invariant that was true and then deleted" class in
//    general. Nothing remains in the file to search for, so the reference looks
//    fine. One such case (t77) is caught only incidentally, because the ticket
//    happened to name `rmSync`. That class needs a human reading the code, and
//    no tool replaces that.
// 3. A symbol occurring many times in a file can resolve to the wrong
//    occurrence. WINDOW_LINES is deliberately tight to bound this; see below.
// 4. Tickets cite files by BASENAME (`peers-ui.js`, `transforms.py`), not by
//    repo-relative path. Resolving that needs the repo's file list, which this
//    leaf does not read — pass `opts.files` or every such reference reports
//    `no such file`. Where the basename is ambiguous the chosen path is
//    reported in the finding, so a wrong pick is visible rather than silent.
//
// `cli/` leaf: no upward imports, no I/O of its own. Callers supply the file
// text (see readPinned in the tests — the fixture reads are PINNED to a commit
// on purpose).

'use strict';

// Tolerance, in lines, for a symbol found near its cited line. Deliberately
// TIGHT: it absorbs a statement that wrapped or an off-by-one, nothing more.
// Widening this is the specific way this tool goes quietly useless — a symbol
// that occurs twice in a file starts resolving to the wrong occurrence and
// reports RESOLVED for a reference that is wrong. Two of the known defects sit
// within 6 lines of their real symbol, so a window of 6 stops seeing them.
const WINDOW_LINES = 2;

// A reference is `path/to/file.js:120` or `file.js:120-134`, and a bare
// `:120` inherits the most recently named file — ticket prose leans on that
// ("agent-transport.js:86 (listPeers) and :103 (cleanup)").
const REF_RE = /(?:([\w./-]+\.[a-z]{2,4}):)?:?\b(\d{1,6})(?:-(\d{1,6}))?\b/g;
// ANCHORED, and against a closed extension list. An unanchored `\.[a-z]{2,4}`
// matches INSIDE a dotted symbol — `sessions.delete` contains "sessions.dele"
// — so a symbol the ticket named would be discarded as a file path, and the
// reference reported against whatever other symbol it bound instead. The
// ticket's own design example, `registry.cleanup()`, is the same shape.
const FILE_TOKEN_RE = /^[\w./-]+\.(?:js|mjs|cjs|json|md|sh|ts|css|html|py|ya?ml)$/;

// A CITATION is not a symbol. Ticket prose backticks its own references
// (`prompt-rails.js:33`, `:856`, `session-manager.js:389, 404, 517-524`), and
// binding one as the symbol to look for guarantees a miss: the tool then
// reports that the ticket's own reference text does not occur in the file, or
// "found at :1" off some incidental substring. That is scope limit 1's case —
// a reference with nothing named next to it — so it must reach SKIPPED.
// Stripping is used only to DECIDE, never to substitute: a token that is a
// bare citation is dropped, not rewritten.
const CITATION_TAIL_RE = /(?::\d{1,6}(?:-\d{1,6})?)(?:\s*,\s*\d{1,6}(?:-\d{1,6})?)*$/;

// Backticks mark quoted PROSE as readily as code — "it deletes `# Heading`
// blocks", "reported as `no such file`". Bound as a symbol, such a span is a
// guaranteed miss reported against a real file, which reads exactly like drift.
// A multi-word span is code only if it carries code punctuation; every real
// multi-word symbol in ticket text does (`existsSync(socket) && isAlive(pid)`,
// `const wc = e.sender`, `entry.replyStderr === true`).
const CODE_PUNCT_RE = /[(){}[\]=<>&|;!+*/'"$._]/;

// A single code token anywhere in the span defeats the punctuation test —
// "`:856 does not occur in engine.js`" is a ticket quoting THIS TOOL's own
// output, and `engine.js` alone makes it look like code. Two more shapes,
// both measured on the live board rather than imagined:
//
// A line citation inside a multi-word span ("`prompt-rails.js:33 found at
// :1`"). A real multi-word symbol never contains one — a citation is prose's
// way of pointing AT code, not code.
const EMBEDDED_REF_RE = /(?:[\w./-]+\.[a-z]{2,4})?:\d{1,6}(?:-\d{1,6})?(?:\s|$)/;
// A run of three bare lowercase words. The multi-word symbols in ticket text
// interleave punctuation every token or two; English does not.
const WORD_RUN_RE = /\b[a-z]+ [a-z]+ [a-z]+\b/;

function isProse(symbol) {
  const s = symbol.trim();
  if (!/\s/.test(s)) return false;
  return !CODE_PUNCT_RE.test(s) || WORD_RUN_RE.test(s) || EMBEDDED_REF_RE.test(s);
}

function isCitation(symbol) {
  let s = symbol.trim().replace(CITATION_TAIL_RE, '');
  // Trailing prose punctuation. A `)` is only punctuation when nothing opened
  // it — `registry.cleanup()` is a symbol, `findings.md)` is a citation.
  while (s && /[,.;:]$/.test(s)) s = s.slice(0, -1);
  if (s.endsWith(')') && !s.includes('(')) s = s.slice(0, -1);
  return !s || FILE_TOKEN_RE.test(s);
}

// Which spans of ticket prose are worth treating as a symbol. Backticks are the
// strong signal; the bare-token cases are the shapes that read as code without
// them and appear in real ticket text (`sessions.delete`, `_cleanup`).
const BARE_TOKEN_RE = /\b(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\(?\)?|\b_[A-Za-z_$][\w$]*\b|\b[a-z][a-z0-9$]*[A-Z][\w$]*\b/g;

// Words that pass the camelCase/dotted shape test but name nothing in the code.
const NOT_SYMBOLS = new Set(['isStale', 'noOp']);

function extractRefs(text) {
  const refs = [];
  let lastFile = null;
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    const [whole, file, startStr, endStr] = m;
    // A bare number with no colon before it is prose ("300ms", "t57"), not a
    // reference. Only a `file.js:N` or an inheriting `:N` counts.
    if (!file && !whole.startsWith(':')) continue;
    const path = file || lastFile;
    if (!path) continue;
    lastFile = path;
    const start = Number(startStr);
    const end = endStr ? Number(endStr) : start;
    // A range whose end precedes its start is malformed prose, not a range.
    if (end < start) continue;
    refs.push({ path, start, end, index: m.index, text: whole });
  }
  return refs;
}

function extractCandidates(text) {
  const out = [];
  const backticked = /`([^`\n]+)`/g;
  let m;
  while ((m = backticked.exec(text)) !== null) {
    if (isCitation(m[1]) || isProse(m[1])) continue; // not a symbol
    out.push({ symbol: m[1], index: m.index, backticked: true });
  }
  BARE_TOKEN_RE.lastIndex = 0;
  while ((m = BARE_TOKEN_RE.exec(text)) !== null) {
    const sym = m[0];
    if (NOT_SYMBOLS.has(sym)) continue;
    if (isCitation(sym)) continue;
    // Already covered by a backticked span at the same place.
    if (out.some((c) => c.backticked && m.index >= c.index && m.index < c.index + c.symbol.length + 2)) continue;
    out.push({ symbol: sym, index: m.index, backticked: false });
  }
  return out.sort((a, b) => a.index - b.index);
}

// Bind each candidate to the NEAREST reference, then let that binding extend
// across the whole comma-run the reference sits in.
//
// Both halves are forced by real ticket text. Nearest-only is required because
// two references can sit in one sentence with one symbol each, and binding a
// symbol to both flags a correct reference. Run-extension is required because
// one symbol routinely governs a LIST of references ("all three kill+create
// pairs await `waitForSessionExit` — engine.js:1293, engine.js:1451,
// ipc-handlers.js:351"); without it, two of those three are never checked.
function bindSymbols(text, refs, candidates) {
  const bound = new Map(refs.map((r, i) => [i, []]));
  for (const cand of candidates) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < refs.length; i++) {
      if (crossesParagraph(text, refs[i], cand)) continue;
      const d = Math.abs(refs[i].index - cand.index);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best < 0) continue;
    for (const i of commaRun(text, refs, best)) {
      if (!bound.get(i).some((s) => s.symbol === cand.symbol)) bound.get(i).push(cand);
    }
  }
  return bound;
}

// A symbol annotates a reference only within the same PARAGRAPH. Ticket text
// mentions the same identifiers again in narrative that is not annotating
// anything ("t57's journal records listPeers/isAlive being kept synchronous as
// a deliberate scope boundary"), and by raw character distance that mention can
// be the nearest thing to a reference in the paragraph above it — which is how
// a correct reference gets flagged. Distance is the wrong unit across a
// paragraph break; a blank line ends the annotation's reach.
function crossesParagraph(text, ref, cand) {
  const [from, to] = ref.index < cand.index
    ? [ref.index + ref.text.length, cand.index]
    : [cand.index + cand.symbol.length, ref.index];
  return /\n[ \t]*\n/.test(text.slice(from, to));
}

// The run of references separated from each other by nothing but whitespace,
// commas, or "and" — i.e. a list that one symbol governs.
function commaRun(text, refs, start) {
  const run = [start];
  for (let i = start; i + 1 < refs.length; i++) {
    const gap = text.slice(refs[i].index + refs[i].text.length, refs[i + 1].index);
    if (!/^[\s,]*(and)?[\s,]*$/.test(gap)) break;
    run.push(i + 1);
  }
  for (let i = start; i - 1 >= 0; i--) {
    const gap = text.slice(refs[i - 1].index + refs[i - 1].text.length, refs[i].index);
    if (!/^[\s,]*(and)?[\s,]*$/.test(gap)) break;
    run.unshift(i - 1);
  }
  return run;
}

// A symbol matches a line when every IDENTIFIER in it appears there. Ticket
// prose paraphrases — `existsSync(socket) && isAlive(pid)` is written in the
// file as `fs.existsSync(info.socket) && isAlive(info.pid)` — so a literal
// substring test finds nothing and reports NOT-FOUND for a correct reference.
function identifiers(symbol) {
  return (symbol.match(/[A-Za-z_$][\w$]*/g) || []).filter((t) => !/^\d+$/.test(t));
}

function matchLines(lines, symbol) {
  const ids = identifiers(symbol);
  if (!ids.length) return [];
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (ids.every((id) => lines[i].includes(id))) hits.push(i + 1);
  }
  return hits;
}

// Resolve a cited path against the repo's file list. Tickets cite by basename
// far more often than by repo-relative path, and a literal join to the repo
// root turns every one of those into `no such file` — the largest noise class
// on a real board.
//
// The suffix match is on a PATH BOUNDARY, not a bare endsWith: `transport.js`
// must not match `agent-transport.js`. Without the boundary the unambiguous
// cases become ambiguous and the resolution stops being usable.
//
// Returns [] when nothing matches, and ALL matches — shallowest first — when
// several do. Resolving to a single path here would be a guess made before the
// only evidence that can settle it: `renderer.js:168` for `taskDir` means
// plugins/tickets-viewer/renderer.js, and picking the shallowest reports the
// symbol missing from a file that was never the referent. The SYMBOL
// disambiguates; see checkTicket.
function resolvePath(cited, files) {
  if (files.includes(cited)) return [cited];
  const suffix = `/${cited}`;
  const hits = files.filter((f) => f.endsWith(suffix));
  return hits.slice().sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

// Strongest outcome wins when one basename resolves to several files: a symbol
// found AT the line beats one found elsewhere, which beats absent.
const RANK = { 'NOT-FOUND': 0, MOVED: 1, RESOLVED: 2 };

// Check a reference's bound symbols against ONE file's text.
function checkAgainst(src, ref, symbols) {
  const lines = src.split('\n');
  const moved = [];
  const missing = [];
  for (const { symbol } of symbols) {
    const hits = matchLines(lines, symbol);
    if (!hits.length) { missing.push(symbol); continue; }
    const near = hits.find((h) => h >= ref.start - WINDOW_LINES && h <= ref.end + WINDOW_LINES);
    // ANY-wins: one confirmed symbol means the cited line is right. A sentence
    // can name several things and only one of them has to be AT the line.
    if (near) return { status: 'RESOLVED', symbol, detail: `\`${symbol}\` at :${near}` };
    const nearest = hits.reduce((a, b) => (Math.abs(b - ref.start) < Math.abs(a - ref.start) ? b : a));
    moved.push({ symbol, line: nearest });
  }
  if (moved.length) {
    // The NEAREST of the bound symbols, not the first one bound. A sentence
    // names several ("`sessions.delete` is the LAST statement in `_cleanup`");
    // the one closest to the cited line is the one the reference was aimed at,
    // and reporting the other sends the reader to a different function.
    const m = moved.reduce((a, b) => (Math.abs(b.line - ref.start) < Math.abs(a.line - ref.start) ? b : a));
    return {
      status: 'MOVED',
      symbol: m.symbol,
      foundAt: m.line,
      detail: `\`${m.symbol}\` found at :${m.line}, ticket says :${ref.start}`,
    };
  }
  return {
    status: 'NOT-FOUND',
    symbol: missing[0],
    detail: `\`${missing[0]}\` does not occur in %PATH%`,
  };
}

// Check one ticket's references against the files they cite.
//
// `readFile(path)` returns the file's text or null when the path does not
// exist. Pinning WHICH tree that read comes from is the caller's job and is
// load-bearing for any historical ticket — see the tests.
//
// `opts.files` is the repo's file list, enabling basename resolution. Omitted,
// every cited path is used verbatim — which is what the pinned fixture wants,
// since resolving against today's file list would not be a pinned read.
function checkTicket(id, text, readFile, opts = {}) {
  const files = opts.files || null;
  const refs = extractRefs(text);
  const bound = bindSymbols(text, refs, extractCandidates(text));
  const findings = [];
  const cache = new Map();

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    const symbols = bound.get(i);
    const where = `${ref.path}:${ref.start}${ref.end !== ref.start ? `-${ref.end}` : ''}`;
    const base = { ticket: id, ref: where, path: ref.path, start: ref.start, end: ref.end };

    if (!cache.has(ref.path)) {
      const paths = files ? resolvePath(ref.path, files) : [ref.path];
      cache.set(ref.path, paths.map((p) => ({ path: p, src: readFile(p) })).filter((c) => c.src != null));
    }
    const candidates = cache.get(ref.path);
    if (!candidates.length) {
      findings.push({ ...base, status: 'NOT-FOUND', detail: 'no such file' });
      continue;
    }
    // Scope limit 1: nothing named, nothing checkable. Reported, not dropped —
    // a silent skip would read as a clean check. Which of several same-basename
    // files it refers to is unknowable without a symbol, so report the citation.
    if (!symbols.length) {
      findings.push({ ...base, status: 'SKIPPED', detail: 'no symbol named next to the reference' });
      continue;
    }

    // The symbol picks the file. Where a basename is ambiguous the ONLY
    // evidence for which one the ticket meant is whether the named symbol is
    // in it, so check them all and keep the strongest outcome. Resolving on
    // path shape first (shallowest, say) reports a symbol missing from a file
    // that was never the referent — indistinguishable from real drift.
    const results = candidates.map((c) => ({ path: c.path, ...checkAgainst(c.src, ref, symbols) }));
    const best = results.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
    if (best.path !== ref.path) base.resolvedPath = best.path;
    const others = candidates.length - 1;
    if (others > 0) base.alternatives = others;
    findings.push({ ...base, ...best, detail: best.detail.replace('%PATH%', best.path) });
  }
  return findings;
}

// The findings worth a reader's attention. SKIPPED and RESOLVED are not
// problems; keeping them out of the flagged set is half of what makes this
// tool usable, since a checker that flags correct references trains its reader
// to ignore it.
const flagged = (findings) => findings.filter((f) => f.status === 'MOVED' || f.status === 'NOT-FOUND');

function formatFinding(f) {
  // The resolved path is part of the finding, not decoration: a basename match
  // is a guess, and a reader who cannot see WHICH file was read cannot tell a
  // real drift from a lookup that picked the wrong one of five `renderer.js`.
  const via = f.resolvedPath ? ` [${f.resolvedPath}${f.alternatives ? ` +${f.alternatives} other` : ''}]` : '';
  return `${f.status}: ${f.ticket} ${f.ref}${via} — ${f.detail}`;
}

module.exports = {
  WINDOW_LINES,
  checkTicket,
  flagged,
  formatFinding,
  extractRefs,
  extractCandidates,
  resolvePath,
  isCitation,
};
