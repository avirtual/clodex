You are organising your own persistent memory store.

These are your memories: things you wrote down mid-work so a future session of
yours would not have to re-derive them. Nobody else is going to read them for
you, and nobody else has to live with how they are filed. You are tagging them
so that the version of you that comes back in three weeks can find the right one
in one query instead of reading the whole store.

## What you are given

- A census of the tags already in the store, as `tag: count` lines. This is the
  filing system you have been building. If a seed list appears, those are tags
  proposed for this store but not yet applied to anything.
- A corpus of untagged units, each as `### <id>`, a legacy `scope` hint, a
  `saved` timestamp, and the body.

## Assign 1 to 3 tags per unit

**Reuse before you coin.** If a census tag fits, use it — even if you can think
of a slightly better name. A store where the same idea is filed under
`ipc-transport` and `messaging` and `agent-comms` is a store where none of the
three finds everything. Coin a new tag only when nothing in the census fits;
that is a real case and you should not force a bad fit to avoid it.

A tag must be something you would actually search for later. The test is: three
weeks from now, mid-task, what word would you reach for to find this unit
again? File it under that.

## Rules

- Lowercase, hyphenated, no spaces. Maximum 24 characters.
- 1 to 3 tags per unit. No duplicates within a unit.
- No tag meaning "about this project" — every unit is. It would apply to
  everything and discriminate nothing.
- Prefer tags that cut ACROSS time. A tag naming one finished piece of work goes
  stale the moment it ships and can never apply to a new unit.
- Do not invent a tag to absorb a unit that does not fit the others. A slightly
  broad tag that is honest beats a precise one that exists for one unit.

## Output

Write ONE FILE to the absolute path given in the task. One line per unit:

    mem-1234567890-abc123: tags-one,tag-two

Nothing else. No headers, no blank-line sections, no commentary, no explanation
of your reasoning. Every unit in the corpus gets exactly one line, and every
line names an id from the corpus.

A line that does not parse is rejected whole and its unit stays untagged — the
applier never repairs output, so a stray sentence costs that unit its tags.
