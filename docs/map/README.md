# Symbol-level module maps

`docs/architecture.md` says which module owns what. A map here goes one level
down: for one giant module it names the regions, the symbols that matter in
each, the state they touch, what they call, and the tests that pin them. Each
rule below is enforced by `checkMap` in `scripts/symbol-index.js`, run over
every map by `test/module-map-fresh.test.js`. If this page and the checker
disagree, the checker wins.

## Authoring

Run `node scripts/symbol-index.js <file.js>` to print the symbol table the
checker sees: `name · kind · depth · parent · start-end · lines`, sorted by
start line. Only names in that table count as symbols.

## File

- Name: `docs/map/<basename without .js>.md`, for example
  `docs/map/team-tickets.md`, or `docs/map/renderer.md` for
  `renderer/renderer.js`.
- Line 1: `# <module path relative to the repo root>`. The path must exist.
- Add the file name to `EXPECTED_MAPS` in `test/module-map-fresh.test.js`. A
  map on disk that is not listed there, or a listed map that is gone, fails.

## Regions

```
## <region name> — <firstSymbol> … <lastSymbol>
```

- The ellipsis is `…` (U+2026) or `...`. The separator is an em dash.
- Anchors are symbol names, never line numbers, and both must be recorded by
  the extractor (rule `forward`).
- Regions are listed in file order: each region's first anchor starts after
  the previous region's first anchor, and its last anchor does not end before
  its first begins (rule `order`).
- Aim for 8 to 20 regions per giant.

## Tables

Each region carries one table with exactly this header, then a `|---|`
separator row:

```
| symbol | purpose | state | calls | pins |
```

- `symbol` is a name the extractor records at depth 2 or less. Write
  `parent.method` to pick one of several same-named symbols by its `parent`
  column. Backticks around it are allowed. A name the extractor does not
  record fails rule `forward`.
- `purpose`, `state`, `calls` are free text. Do not use `|` inside a cell.
- `pins` is a space- or comma-separated list of test files, as a basename
  (`team-tickets.test.js`) or `test/`-relative path, or the single word
  `unpinned`. Every listed file must exist under `test/` and mention the
  symbol as a whole word (a handler is matched by its channel string), or
  rule `pin` fails.
- A malformed header, separator, row, heading or `EXEMPT` entry fails rule
  `format`.

## Invariants and hazards

Under a region, `### Invariants` and `### Hazards` hold `- ` bullets, one
sentence each, naming in backticks the symbol that enforces or exposes the
point. Each bullet must name at least one recorded symbol (rule `forward`).
No other `###` heading is allowed.

## EXEMPT

The last section, `## EXEMPT`, lists `- <symbol> — <reason>` for symbols
deliberately left out of the tables. Every recorded symbol of 40 lines or
more must appear in some table or here (rule `reverse`); an EXEMPT name must
itself be recorded (rule `forward`). No region may follow it.

## What the extractor records

acorn parses the file (latest ECMAScript, script first, then module; hashbang
and top-level `return` allowed). A symbol record is
`{ name, kind, depth, parent, start, end, lines, bytes, exported, owner }`,
lines 1-based and inclusive, sorted by start; `owner` is the index of the
enclosing recorded symbol, or null.

- Kinds: `function`, `var-function` (span is the whole declaration), `class`,
  `method`, `getter`, `setter`, `object-method`, `assigned-function`
  (`exports.x = fn`, `window.x = fn`, `this.x = fn`), `function-expression`
  (a named function expression), and `handler`.
- A handler is a call to `handle`, `on`, `ipcMain.handle`, `ipcMain.on` or
  `registerIntent` with a literal channel; it is named `handle:<channel>`,
  `on:<channel>` or `intent:<channel>`.
- Depth counts enclosing function, class and object-method bodies; module
  scope is 0. A class inside a factory is at depth 1, so its methods are at
  depth 2 (the `SessionManager` methods in `session-manager.js`). The methods
  of an object returned from a factory are at depth 1 (the ticket verbs in
  `team-tickets.js`).

Known gaps, so a missing name is not a surprise:

- Nothing deeper than depth 2 is recorded, e.g. helpers declared inside a
  `SessionManager` method.
- Functions in object literals that are neither returned nor assigned (call
  arguments, menu templates, nested option objects) are not recorded.
- Anonymous top-level registrations (`app.whenReady().then(...)`,
  `window.api.onX(...)`, `addEventListener`) carry no name.
- A handler whose channel is a variable is not recorded.
- `exported` is best effort: depth-0 names found in `module.exports`,
  `module.exports.x =` or `exports.x =`; factory-returned methods never are.
