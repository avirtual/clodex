# docs/notes/memory-store.md

## serializeMemoryUnit
Frontmatter values are single-line: `parseMemoryUnit` splits on `\n`, so a value carrying a line break would forge keys such as `operator_pinned`; `remember` collapses `\r \n U+0085 U+2028 U+2029` to a space and the serializer refuses them.
