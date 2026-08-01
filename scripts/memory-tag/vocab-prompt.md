You are analysing one agent's persistent memory store to design a tag
vocabulary for it. You are NOT tagging anything in this pass. Your only job is
to propose the vocabulary, grounded in what the corpus actually contains.

## What the corpus is

Every unit is something an agent chose to write down mid-work so a future
session would not have to re-derive it. The store has grown for a month with no
organising scheme. Each unit shows:

- `### <id>` — its identifier
- `scope(legacy, unreliable)` — a free-text field set at write time and never
  revised. On this store it is 38 distinct values over 191 units; 51% of it is
  either empty or the agent's own name. Treat it as a weak hint that is often
  absent or meaningless. Do NOT reuse its values as your vocabulary, and do not
  assume two units sharing a scope belong together.
- `saved` — an ISO timestamp
- the body

## Method — cluster first, name second

This ordering is not stylistic. Naming categories before reading the corpus is
how the existing scope field ended up with buckets of one named `demo`,
`people`, and `workflow`: plausible category names that do not match how the
material actually divides.

So: read everything, group units that would be USEFUL TOGETHER, and only then
name the groups you found. A name must describe a group you actually observed.

## What the tags are for

Two consumers, and a tag earns its place by serving at least one:

1. **Consolidation.** Someone will later read one tag's units together and ask
   "does the newest contradict the oldest, and can the old ones be retired?"
   That question is only answerable if a bucket holds units that make competing
   claims about the same thing. A bucket of 1 cannot contain a contradiction; a
   bucket of 60 cannot be reviewed in one sitting.
2. **Retrieval.** Later, tags will be matched against what a user is typing, to
   surface relevant memories. That favours vocabulary drawn from the language of
   the memories themselves over invented abstractions.

Where the two disagree, favour consolidation.

## Constraints

- **12 to 20 tags.** Fewer and buckets are unreviewable; more and you have
  rebuilt the 38-value problem.
- **Every tag must apply to at least 4 units.** If a group is smaller than
  that, it is not a tag — fold it into a broader one or leave those units to
  other tags.
- **Multi-valued.** A unit will carry 1-3 tags. Design for overlap rather than
  forcing a single home; this is the main thing the old single-string field got
  wrong.
- **Lowercase, hyphenated, no spaces.** Max 24 characters.
- Do not create a tag that means "about this project" — every unit is. It would
  apply to everything and discriminate nothing, which is exactly what the
  legacy value `clodex` (40% of the store) does.
- Prefer tags that cut ACROSS time. A tag naming one finished piece of work
  goes stale the moment it ships and can never apply to a new unit.

## Output

Write your proposal to the absolute path given in the task, as markdown:

1. **The vocabulary** — a table: tag | one-line definition | how many units you
   estimate it covers.
2. **For each tag, 3 example unit ids** you would assign it, so the estimate can
   be spot-checked against the corpus.
3. **Overlap notes** — any two tags a reader might confuse, and the rule that
   separates them. This is what a later mechanical pass needs in order to be
   consistent.
4. **What did not fit.** Units you could not place under any proposed tag, by
   id, with a one-line reason. Do not pad the vocabulary to reach zero
   leftovers — an honest leftover list is more useful than a tag invented to
   absorb it.
5. **What the corpus told you about itself** — anything you noticed that a tag
   vocabulary cannot express: duplication, units that appear obsolete, claims
   that contradict each other. Be specific and cite ids. This section is
   directly useful to the consolidation work that follows.

That file is your only output. Do not write anything else.
