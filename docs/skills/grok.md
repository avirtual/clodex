---
name: grok
description: Answer a code question about THIS repo in the fewest tokens that stay honest — a two-lane router (deterministic grep for structured lookups, a fresh subagent for synthesis) that returns FILE:LINE pointers + minimal excerpts, never prose paraphrase. Use before re-reading a large file you've already walked, or when you catch yourself about to read a whole module to find one symbol. Claude Code only (no Codex skill-injection yet).
---
You are about to spend tokens learning something about the current repo. Route the
question into ONE of two lanes by its SHAPE, answer in the lane's format, and stop.
The whole point is to NOT carry a large file into context to answer a small question —
carriage you'd pay for again on the next turn.

## Lane 1 — STRUCTURED lookup → deterministic grep over the LIVE tree
Use this lane when the question is one of these shapes. Answer with `grep`/`Read` over
the ACTUAL current files (never memory), and return a FILE:LINE pointer + the minimal
excerpt (the signature line, the export line, the requested range). NEVER paraphrase
code into prose — a paraphrase gets re-verified against the source, so it pays twice.

- `def <symbol>` / `sig <symbol>` — the definition site and its signature line(s).
  `grep -rn "function <symbol>\|<symbol> = \|<symbol>(" -- <paths>`, then Read the few
  lines AT the hit. Answer: `path/file.js:NNN` + the signature line, nothing more.
- `exports <file>` — the `module.exports` / `export` line(s). Read just those lines.
- `lines <file>:<a>-<b>` — Read exactly that range and quote it. No surrounding context
  unless asked.
- `home <symbol>` — where a symbol lives (its defining file:line), for when you only need
  the location, not the body.

Structured answers must be STABLE and APPEND-ONLY: the same question over an unchanged
tree returns the same bytes (deterministic grep guarantees this), so a future cache can
key on them. Don't editorialize; don't re-summarize on repeat asks — point again.

## Lane 2 — SYNTHESIS → a fresh, stateless subagent
Use this lane for anything that ISN'T a structured lookup: `how does X work`,
`why is Y done this way`, `what happens when Z`, `trace <flow>`, `explain <module>`.
Also route these two here EVEN THOUGH they look structural, because static grep
confidently LIES about them in this codebase (factory modules + injected seams mean a
name's callers/writers aren't where the text says):

- `callers of <symbol>` — who invokes it (seams hide real call sites).
- `dataflow <symbol>` — where a value is written/read across the injection boundary.

Spawn a FRESH stateless subagent so the synthesis cost lands in a throwaway context, not
yours (Task tool, `subagent_type: "Explore"` for read-only tracing, or `"general-purpose"`
if it must run tooling). Put these as the first lines of its prompt so it inherits a clean,
cheap context:

```
[wirescope:agent-name grok-synth]
[wirescope:omit claudemd,useremail]
```

Instruct the subagent to answer the SAME way: FILE:LINE pointers + minimal excerpts for
every claim, and a short pointer-list conclusion — NOT an essay. You relay its pointer
list; you do not re-read the files it cites unless you're about to change them.

## The one rule under all of it
Return the smallest honest thing that answers the question: a location and the line, not a
retelling. If you find yourself pasting a whole function or a whole file to "explain" it,
you're in the wrong lane — point, don't paraphrase.
