// lib/gutter-scan.js — recognize the line-number gutter the CLI prints under a
// file-editing tool call, so those numbers become clickable. Pure leaf: no DOM,
// no fs, no resolution. Callers hand it plain strings and get offsets back.
//
// The output being matched looks like this (markers are `+`, `-`, or absent):
//
//   ● Update(CHANGELOG.md)
//     ⎿  Added 3 lines
//        25    starts with one (`node_modules/@babel/…`) still resolves
//        26 +  **The file peek can be dragged by its title bar**, so it
//        27 +  whatever it is covering instead of only resized.
//
// WHY THIS IS NOT PART OF path-scan.js. A `path:line` token carries its own
// filename and is decided by looking at one line. A gutter row carries ONLY a
// number — the filename is in a header several rows above — so the question is
// stateful across rows, and mixing that into the per-line path scan would make
// a pure function depend on its neighbours.
//
// WHY CONTIGUITY, NOT A LINE BUDGET. A bare integer at the start of a line is
// extremely common in ordinary prose ("3660 + 2 new tests", "609 + 894" — both
// real lines from this project's own notes), and every one of them matches any
// number-then-marker pattern worth writing. What separates a real gutter from
// prose is not its shape but its CONTEXT: a gutter is an unbroken run of gutter
// rows directly under its header. So the header search walks up and stops dead
// at the first row that is not part of such a block. Prose sitting under an
// `Update(...)` header is therefore rejected on the row between it and the
// header, not on the number itself — which is the only test that actually
// distinguishes the two.
'use strict';

// A gutter row: leading space, the line number, then whitespace. The number must
// be the first thing on the row — a number later in a line is prose.
const GUTTER_RE = /^(\s*)(\d+)(?=\s|$)/;

// The tool-call header that names the file. An allowlist rather than "any
// capitalized word before a paren", for the same reason path-scan allowlists
// extensions: the permissive version claims ordinary output like `Note(see
// below)`. Widening it is a deliberate act.
const HEADER_RE = /\b(?:Update|Edit|MultiEdit|Write|Create|Read|NotebookEdit)\(([^)\s][^)]*)\)/;

// The summary line between a header and its gutter (`⎿  Added 3 lines`), plus
// the tree glyphs the CLI draws the block with. These sit INSIDE a real block,
// so the upward walk has to step over them without treating them as a break.
const SUMMARY_RE = /^[\s⎿└├│╰─]*(?:Added|Removed|Updated|Wrote|Read)\b/;
const GLYPH_ONLY_RE = /^[\s⎿└├│╰─]*$/;

// Where the number sits on a gutter row: { start, end, line } with 0-based
// half-open offsets, matching scanPaths' coordinate space. null when the row is
// not a gutter row at all.
//
// `-` rows are matched too, and their number is the line in the file BEFORE the
// edit. Opening the current file at it lands near, not on, the removed text —
// which is the best answer available, since the line it names no longer exists.
function matchGutterRow(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = GUTTER_RE.exec(text);
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { start: m[1].length, end: m[1].length + m[2].length, line: n };
}

// Find the file a gutter row belongs to. `above` is the rows between the gutter
// row and the top of the search window, NEAREST FIRST — the caller reads them
// off whatever buffer it has.
//
// Returns { path, distance } or null. Nearest header wins, so a second edit of
// the same file later in the scrollback cannot claim an earlier block's rows.
function findGutterFile(above) {
  if (!Array.isArray(above)) return null;
  for (let i = 0; i < above.length; i += 1) {
    const row = above[i];
    if (typeof row !== 'string') return null;
    // A gutter row is CONTENT, and content that happens to contain
    // `Update(x.js)` is a quotation, not a header — a file whose text discusses
    // tool calls (this project's own changelog does) otherwise hijacks every row
    // below it and resolves them against a filename that was never edited. So
    // the gutter test comes FIRST; only a non-gutter row can be a header.
    if (matchGutterRow(row)) continue;
    const h = HEADER_RE.exec(row);
    if (h) return { path: h[1].trim(), distance: i + 1 };
    // Anything that is not another part of this block ends the search. This is
    // the whole false-positive defence — see the header comment.
    if (SUMMARY_RE.test(row) || GLYPH_ONLY_RE.test(row)) continue;
    return null;
  }
  return null;
}

module.exports = { matchGutterRow, findGutterFile, HEADER_RE, GUTTER_RE };
