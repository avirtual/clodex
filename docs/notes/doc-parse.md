# doc-parse.js

The markdown leaf behind the Help window (t981 / S2 of tasks/help-window). Pure:
no DOM, no fs, no requires. It covers exactly the subset the shipped corpus was
measured to use (DESIGN.md §2) and treats everything outside it as literal text —
the operator's ruling was no markdown dependency, and a closed corpus is what
makes that safe. It is NOT a CommonMark implementation and must not grow into
one: anything the 17 pages do not contain is out of scope by construction.

## parseInline

Precedence is fixed and load-bearing: code spans, then links, then strong, then
em, recursing into strong/em/link text. Parsing em before code italicizes
`AGENT_NAME_RE, DEFAULT_WORKSPACE_ID` (docs/architecture.md:864) and prints
literal backticks inside ``[`x`](y)`` — both are live hazards in the corpus and
both are the reason render-markdown.js could not be reused.

## readEmphasis

`_` opens emphasis only at a word boundary (no preceding `[A-Za-z0-9]`) and
closes only when the character after the run is not one either. `*` has no such
rule. This is what keeps snake_case identifiers in running prose intact.

## decodeEntities

Five named entities plus `&#NN;`, decoded in TEXT RUNS ONLY. A code span keeps
its bytes: `` `&lt;name&gt;` `` renders the six characters, because doc authors
write entity examples inside code. A backslash-escaped `&` also survives — the
escape splits the run, so `\&lt;` never reaches the decoder.

## htmlLine

The corpus has exactly two raw-HTML shapes. `<a name="x">` becomes an `anchor`
block (30 same-doc links depend on those two ids resolving). A line made only of
`<details>`/`<summary>` tags is DROPPED, by tag NAME, not by "a line that is only
tags": `<details><summary>x</summary>` carries visible text and must still
vanish, while `<b>hi</b>` and `<script>…</script>` must stay literal text. An
allowlist is the only reading that gives both, and it fails in the safe
direction — an unknown tag is shown, never executed.

## parseList

A continuation or child line is one indented at least 2 columns past the parent
marker's own indent; a sibling marker may sit 0 or 1 column off (docs use both).
Child lines are dedented by the parent's content indent before recursing, which
is what turns the 5-space `1.`/`2.`/`3.` block at docs/messaging.md:230-250 into
an ordered child list rather than three paragraphs. A tab counts as 4 columns.

## sectionSlice

Returns raw markdown from the named heading through the line before the next
heading of EQUAL OR HIGHER level, so `## A` keeps its `### A1` subsections and an
H1 slice is the whole page. Returns null for an unknown slug. This is the token
lever for agents reading over the node API: a page is 10-25k tokens, a section
usually under 2k.

## slugify

GitHub's rule, and it has to be: the corpus already ships 30 `#anchor` links
written against GitHub's rendering. Lowercase, drop everything outside
`[a-z0-9 -]`, spaces to `-`. An em dash drops rather than becoming a hyphen,
which is why `4.1 `inject` is typing, not messaging — four rules` slugs with a
DOUBLE hyphen. Duplicates within one document take `-1`, `-2` in document order.

## buildSearchIndex

One entry per heading section, so an H1 entry's text spans its whole page and
overlaps every H2 entry under it. That overlap is deliberate: it is what lets a
query whose terms live in two different subsections still match the page.

## search

Every whitespace-separated term must match somewhere in ONE section — an
any-term match turns a two-word query into noise across the whole corpus. Rank
is `1e6 × terms-in-title + 1e3 × terms-in-heading + body occurrences` (body
capped at 999 so it can never outweigh a heading), ties broken by name then slug
for a stable order. `limit` is clamped to 1..100, default 20.
