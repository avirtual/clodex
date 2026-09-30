# Comment paydown

A paydown ticket removes existing comment stock from one source file. No code line changes: every hunk is comment-only.

## The rule

A block is a run of consecutive `//` lines, or one trailing `//` on a code line. Each block gets exactly one outcome:

1. **Delete** — narration, how it was found, ticket ids, dates, history, what another file or function does (point by symbol if needed, never explain it), rationale stated elsewhere, all-caps emphasis, anything the code beneath already says.
2. **Compress** — keep at most two lines naming the wrong change the comment prevents: an ordering that must hold, a duplication that must not be merged, a vendor quirk, a measured value, a security property an obvious refactor drops. If the wrong change does not fit one sentence, delete.
3. **Move** — a real invariant or hazard longer than two lines becomes one bullet under `### Invariants` or `### Hazards` of its section in `docs/map/<file>.md`, and the inline comment goes to zero. The bullet names a symbol from that section's table, and duplicates no bullet already there.

Directive comments (`eslint`, `@ts`, `prettier`) stay.

## Protocol

1. Chunk the file at the `## ` section seams of its module map. Move each seam up to the first line of the comment block above the section's first symbol, so a block stays with the code it describes.
2. Split the file into one chunk file per section and keep a pristine copy of each; concatenating the chunks must reproduce the file byte-for-byte. Subagents edit only their chunk files, never the live file, and never the map.
3. Dispatch about three sections per subagent in parallel. Each reports comment lines before and after per section, the outcome per block keyed by line, proposed map bullets, and an `unresolved:` list.
4. Before deciding on a comment that names a symbol outside its chunk, the subagent greps that symbol in the whole file and reads its lines. If that does not settle it, the comment stays unchanged and goes on the `unresolved:` list. A wrong delete is silent; a timid keep is visible.
5. The ticket's hand resolves every `unresolved:` entry, reviews at least ten compressions per subagent against the rule, and re-runs a chunk only where that sample shows the rule misapplied. No count target: the rule decides every block.
6. The hand reassembles the file, inserts the map bullets, and runs `test/module-map-fresh.test.js`.

## Identity check

`codeOnly()` from `comment-census.js` blanks comments and string contents to spaces and keeps newlines, so a deleted comment line removes one newline. Compare base and HEAD after dropping whitespace-only lines:

```sh
node -e 'const {codeOnly}=require("./comment-census.js");const s=require("fs").readFileSync(0,"utf8");process.stdout.write(codeOnly(s).split("\n").map(l=>l.trimEnd()).filter(Boolean).join("\n"))' < FILE | shasum
```

Run it on `git show <base>:FILE` and on the working file; the hashes must match. Because `codeOnly()` hides string contents, also compare the `acorn` token streams (type and value per token) of both versions; they must be identical.

Some tests read comment text from the source (exemption markers, backticked literals in a table's comments) or strip comments with a quote-counting scanner; run the branch's tests and restore any comment a test reads.

`node scripts/comment-delta.js` then reports `0 added`; it prints no per-file rows, so read the paid-down file's `{before, after}` from the `commentDelta()` export.
