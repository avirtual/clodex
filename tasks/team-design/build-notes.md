# Build notes for `tasks/team-design/design.md` §8

Decisions taken by the lead at landing, plus edges raised after the artifact
closed. Specs not written yet. Past tense, pinned.

## Decisions (2026-08-04)

- **Backlog verb split promoted from optional to build.** Design §9.3 ruling 3
  marked it optional; the lead upgraded it. Reason: it is the only near-miss in
  the eight-instance set that reached toward work product under *active
  review* (an intended-backlog dispatch, sent in the assigning form, would have
  edited files inside a diff a reviewer was judging). Every other instance cost
  coordination among agents. Form-mechanism, not prose, because the rule's own
  author violated it while carrying it on every turn.
  Shape: `task add <role>` always delivers now; `task queue` opens backlog.

- **Closing judgment accepted** (§8): further design against this evidence base
  is near-zero value. The next unit of evidence is a second team, foreign
  project, different operator.

  Lead's addition, which the designer asked be kept: the shrunk default makes
  that experiment **readable**, not merely cheap. A stranger starting at a team
  of one, adding a seat when they can name its purpose, produces an
  interpretable first failure. A stranger handed three seeded roles they cannot
  evaluate produces noise. Cost was the supporting argument; legibility is the
  actual one.

- **The economic claim gets deleted from the hand prompt** (§1.4). Lines 7-9,
  "that asymmetry is the point — it is why the team costs less than one agent
  doing everything." Written by the lead, never measured, stated as identity.
  Replaced by a per-task discriminator in the lead's delegation rules.

## Edge for the verb-split spec

From clodex-designer, after the artifact closed:

> `task queue` followed by a later `task assign` must reproduce the delivery
> semantics of a direct `add <role>` **exactly**, or the two paths into a seat
> will drift and the category collapse comes back at the store level.

That is the failure the split exists to prevent, re-entering through the back
door: two ways to reach an assigned-and-delivered ticket, differing in what the
seat actually receives. Whatever the spec says about `add <role>` delivery must
be stated once and shared by both paths, not written twice.
