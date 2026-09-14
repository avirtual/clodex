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

The curated skill keep-set, same source as the tool one, with
`DEFAULT_SKILL_DENY_FLOOR` derived from `CLAUDE_SKILLS` the same way.

The floor is STATIC-ONLY, and that is a real limit rather than an oversight.
`CLAUDE_SKILLS` is unioned at render time with skills discovered from the
transcript (plugin and project skills), so a floor derived from the static list
cannot name a discovered skill and a plugin's skills therefore arrive CHECKED in
optimized mode. The alternative semantic — deny anything not in
`OPTIMIZED_SKILLS` — cannot be expressed in the stored shape: `denySkills` is a
plain array of names, and "everything except these six" needs either a new
sentinel or a render-time computation against the live catalog. The `'*'`
sentinel that `refreshNewSessionSkills` already honours means ALL-off, not
all-except.

## DEFAULT_SKILL_DENY_FLOOR

Returned by `agentDefaults.getDefaultSkillDeny()` only when the `*` key is
ABSENT. Before this existed that reader returned `[]`, which made the Mode
selector a literal no-op for the whole skills category on any root without an
`agent-defaults.json`: `applyModeFields` passes the floor for optimized and an
empty set for standard, and with an empty floor those are the same set, so the
same render ran with the same input in both modes. It was invisible on a curated
root because an explicit `denySkills` key wins the tri-state.
