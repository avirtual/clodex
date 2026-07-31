# t127 — frontmatter passthrough + searchable tags

Two blocking prerequisites for the tagging work. Both make a LATER feature fail
silently, which is why they land alone.

## Repro, before any change

    node -e '...serialize(parse(withTags)).includes("tags:")'   →  false

## Cause (verified in source)

`serializeMemoryUnit` (`:31`) emitted a fixed allowlist; `parseMemoryUnit`
(`:42`) read every `\w+:` line. `setPinned` (`:114`) round-trips parse →
serialize, so any key outside the allowlist was **deleted by pinning** — on a
file the user never asked to edit. The comment at `:113` claimed the opposite.

`recall` (`:103`) matched `scope + '\n' + body`. Frontmatter is not in `body`,
so a tag would have been written but unsearchable.

Confirmed `serializeMemoryUnit` has no callers outside this module, and no
`tags` support exists anywhere in the tree yet — so nothing downstream depended
on the drop.

## Implemented

1. **`serializeMemoryUnit`** — core keys (extracted to `CORE_META_KEYS`, order
   unchanged because the byte-pinned tests depend on it), then any remaining
   meta keys, then `pinned` last if set.
2. **`list()`** — surfaces `tags` on the unit alongside the existing fields.
   Needed because `recall` reads units from `list`, not from disk. Every other
   frontmatter key stays on disk only.
3. **`recall()`** — haystack is now `scope + tags + body`. The rest of the
   frontmatter stays out: ids are digits and `learned_at` is an ISO timestamp,
   so admitting them makes short queries match on digits.
4. **`:113` comment** — the false "preserving all other meta" clause deleted.

## Tests (3 new)

- `an unknown frontmatter key survives the setPinned ROUND TRIP` — the
  load-bearing one, named for the round trip per the spec. Drives `setPinned`,
  not `parseMemoryUnit`: parse was never the broken half, so a parse-only test
  passes against the broken serializer. Also pins the full key ORDER.
- `a unit with no unknown keys is byte-identical after pin+unpin` — the
  property the passthrough must not cost.
- `recall matches a tag, and not an id or timestamp` — both halves. The
  negative half queries substrings genuinely present in the file (a 4-digit
  year, `mem-`) and requires them to still miss.

## Mutants

| # | mutant | result |
|---|---|---|
| (a) | serializer reverted to the allowlist | 1 fail — `pin deleted the tags key` |
| (b) | unknown keys emitted but `pinned` no longer last | 1 fail — key-order deep-equal |
| (c) | recall haystack reverted to `scope+body` | 1 fail — `a tag in the frontmatter was not searchable` |

Product restored byte-identical after each (`diff` against a pristine copy).

### A red that proved nothing, caught and fixed

Mutant (c) first failed by **`TypeError: Cannot read properties of null
(reading 'id')`** — I had written `store.recall(...).id` inline, so a miss
crashed instead of failing by message. Rewritten to read the unit out, assert
it is truthy with a message, then compare the id. Now fails on
`a tag in the frontmatter was not searchable`.

This is the house rule (prove by MESSAGE, never by crash) catching my own test,
and it is the second dereference-inline instance I have written — worth noting
that `x(...).id` in an assertion is the shape to watch for.

## Result

Full suite **3211/3211, ESCAPES: 0** (3208 + 3 new). Repro prints `true`.

No `build:web` — nothing bundled was touched. Two files: `memory-store.js`,
`test/memory-store.test.js`.
