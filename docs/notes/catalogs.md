# catalogs.js

## OPTIMIZED_TOOLS

The set "Clodex optimized" keeps: the core harness — read, edit, search, shell,
web, subagents, skills. It is what the operator's own curated root keeps, not an
invented list.

Expressed as an ALLOW list, with `DEFAULT_TOOL_DENY_FLOOR` derived from it,
because the deny direction is what let the floor decay. A tool added to
`CLAUDE_TOOLS` is now off-by-default in optimized instead of silently on; under
the old deny-list shape 33 of 44 tools had accumulated on the checked side, and
the Mode selector promised a curated subset while delivering nearly the whole
catalog.

On 2.1.183 a denied tool's schema is omitted from the wire `tools[]` (verified on
live bytes), so a uniform deny set both shrinks the request and shares the first
cache segment. The earlier floor was kept deliberately narrow to hold override
probability near zero (an override re-fragments that shared segment); the reason
that trade is no longer the right one is that the floor became a user-visible
promise when the Mode selector shipped on top of it.

Reclaim notes worth keeping from the old hand-picked floor: `Workflow` is ~5.2k
tokens, the single biggest one. `TaskOutput` is self-described DEPRECATED and
ships ~1.6k chars of "don't call me" every request, while its redirected paths
(Read on the output file, task notifications) predate the deprecation, so denying
it breaks nothing even for orchestration-heavy agents. `SendFeedback` is ~4.7k
chars of prose plus a 27-value enum schema every request, to draft a report that
is queued locally and needs the operator's approval to go anywhere. `Artifact`
uploads local content to claude.ai hosting, so it is egress as well as tokens.
`EndConversation` carries one of the largest always-shipped descriptions in the
roster and is pointless in a managed console where the operator kills sessions
from the UI.

The floor stays an editable floor, not a ceiling: Preferences sets the stored
default and the per-session Advanced checklists widen it for one seat.

## OPTIMIZED_SKILLS

The curated skill keep-set, same source as the tool one. `OPTIMIZED_SKILLS` is
what the floor EXEMPTS rather than a subtrahend: the floor is
`deferredSkillDeny(OPTIMIZED_SKILLS)`, so it is still derived from the keep list
and a name added to `CLAUDE_SKILLS` is off-by-default in optimized.

The curation is measured against what the shipping CLI offers a seat, not
against what reads well: `design`, `artifact-design` and `artifact-capabilities`
are Artifact-publishing flows (canvases, polls, viewer identity) and are denied;
`dataviz` and `artifact-diagramming` are charts and inline SVG, which is
ordinary repo work, and are kept. Before t918 the keep list named six skills
this box has never observed the CLI offer, while the deny floor named only real
ones — the curation pointed away from what a seat actually loads. Those six are
still KEPT: never observed here is not evidence they do not exist.

The seed exists because a skill disabled at a LOWER layer never reaches the
injected roster, so the transcript cannot surface it; it is also the only thing
`*` has to expand against on a fresh root, where `skills-seen.json` does not
exist yet.

## DEFAULT_SKILL_DENY_FLOOR

Returned by `agentDefaults.getDefaultSkillDeny()` only when the `*` key is
ABSENT. Before this existed that reader returned `[]`, which made the Mode
selector a literal no-op for the whole skills category on any root without an
`agent-defaults.json`: `applyModeFields` passes the floor for optimized and an
empty set for standard, and with an empty floor those are the same set, so the
same render ran with the same input in both modes. It was invisible on a curated
root because an explicit `denySkills` key wins the tri-state.

The floor is a DEFERRED denial (t918), not a list of names: `['*', '!keep', …]`,
resolved at SPAWN by `expandSkillsOff` against `knownSkillNames()`, the same
mechanism a lean template's `['*']` already used. A materialised floor could
only name what was known while the dialog was open, so every skill the CLI
announces on the seat's first turn arrived ENABLED and the operator paid a
create → first turn → edit skills → reload cycle to remove skills that were
always going to appear.

What this does NOT change: the checkbox list still renders what is KNOWN now.
Unknown skills become DENIED, not visible. One residual class survives — a skill
in neither the seed nor `skills-seen.json` when the seat spawns cannot be denied
at spawn — but the CLI honours a layer-4 `skillOverrides` "off" mid-session, so
recovering from that is one toggle in the per-session popover with no restart.
That is the "off" direction only and says nothing about `SKILL_REENABLE_CONFIRMED`,
which gates the opposite question.
