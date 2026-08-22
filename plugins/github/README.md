# github — `[agent:gh]`

An engine-only plugin. No UI, no settings, no renderer half. It exists to make
an **agent** shorter-winded: three read verbs and a dry run, each collapsing a
workflow the agent would otherwise fumble through in six commands and two wrong
guesses.

**It is read-only.** Nothing here pushes, creates or mutates anything. See
[Why there is no `pr`](#why-there-is-no-real-pr) — that is a decision, not a gap.

## Before it does anything

**The verb is privileged, like every plugin verb** (`plugins/plugin-api.md` §7). A
freshly installed plugin's verb is inert on every existing seat, and the failure
is *silent* — the line is not parsed as your verb, nothing is logged, and to the
agent it reads as an unrecognised intent.

> Session ⚙ menu → intent checklist → tick **GitHub (status / CI / review / PR
> dry run)**. Per seat. Every user hits this once.

**And `gh` must be installed and logged in — by the operator, in a terminal.**

```
gh auth login
```

## The verbs

| Line | What it collapses |
|---|---|
| `[agent:gh status]` | `git rev-parse` · `git status` · `git rev-list` · `gh repo view` · `gh pr view` · `gh pr checks` · a GraphQL `reviewThreads` query → one paragraph. **Ask this before opening or merging anything.** |
| `[agent:gh ci]` | Find the failing checks · resolve each to its workflow run · pull only the failed steps' logs · **distil the lines that name a failure** out of tens of thousands of lines of build chatter. |
| `[agent:gh review]` | The GraphQL query an agent gets wrong twice, rendered as a `file:line` worklist. Resolved threads dropped, outdated ones flagged. |
| `[agent:gh pr --dry]` | Work out the base · confirm there is something to review · write a real description from the commits · render title, description and diffstat. **Nothing is pushed and no PR is created.** |

`[agent:gh pr --dry]` takes an optional prose body, terminated by `[agent:end]`:

```
[agent:gh pr --dry]
Session rows now carry a PR status chip. Refresh is bounded by a 30s TTL.
[agent:end]
```

The body leads the description; the commits and diffstat follow it as evidence.
Without one, the description is still real — it is just missing the *why*.

## Why there is no real `pr`

**A bare `[agent:gh pr]` refuses.** It does not fall back to `--dry`, because a
verb that quietly does less than its name says is worse than one that declines —
an agent told "opened" when nothing was opened will report that to its operator.

Pushing is the operator's action. A verb that opens a real pull request is
outward-facing and hard to reverse, and this project's standing rule is that
nobody but the operator pushes. So the useful half ships: the agent renders the
PR it *would* open, shows the operator, and the operator opens it.

### What `[agent:gh pr --dry]` still refuses, and why

Each is a state in which the rendered PR would be misleading, and a preview of a
wrong PR is a wrong preview: on the default branch (it would be main←main) ·
detached HEAD · unborn HEAD · nothing ahead of base (an empty PR) · a PR already
open (the description would duplicate a live one).

A **dirty tree** is the one that changed shape with the cut. It used to be a
refusal, because the PR would have been missing the work it was named after.
Nothing is created now, so it is a stated NOTE on the rendering instead: the
description is still useful, and the uncommitted files are named as ones that
would be left out.

Refusing is the point. A verb that rendered a wrong PR and called it accurate
would be worse than no verb.

## Credentials: there are none

`host.storage` is plaintext JSON with no mode bits, and `host.settings` lives in
the user's UI settings. So **this plugin holds no secret at all**: no token
setting, no token in storage, no token argument on any method, none in argv,
none in the environment it constructs, and a scrubber (`proc.js`) on every byte
that reaches a log or an agent, for the case where `gh` echoes one back.

Authentication is `gh`'s own, in the operator's keychain. If `gh` is not logged
in, the answer the agent gets is *"the operator must run `gh auth login`"* — not
a prompt for a token this plugin has nowhere safe to put.

## Freshness, stated as `plugins/plugin-api.md` §14 asks

**Nothing is cached.** Every call shells out. `status` is true as of the moment
it answered and stale immediately afterwards — a check can go red a second
later. The one deliberate staleness: `status` compares against the *local copy*
of `origin/<base>` and does **not** fetch, because a network round trip against
the operator's repository is not something a status call should do behind their
back. It says which ref it used and that it did not fetch, so an agent that
needs a fresher answer knows to ask for a `git fetch` first.

## Failure handling

Nine failure modes get nine different sentences, because they have nine
different remedies: `gh` missing · not authenticated · not a repo · no GitHub
remote · repo not visible · network down · 401 · 403 (rate limit / SSO / scope)
· 404. Anything unrecognised is reported verbatim rather than guessed at. An
agent acting on a wrong answer is worse than one told plainly that the call
failed.

## Why the verb is `gh`

Verbs are one flat global namespace (`plugins/plugin-sources.md` §4a) and a
collision means a plugin **does not load**. `gh` is short — it lands in every
granted seat's system prompt and in every line an agent writes — and it is the
literal name of the tool it fronts, so a second plugin wanting it is by
definition another GitHub plugin. That is correct signal, unlike two authors
independently reaching for `run` or `notes`.

One verb with sub-commands rather than four verbs: four would take four slots
out of that namespace **and** need four separate ticks in every seat's checklist.

## Files

```
manifest.json    engine-only, enabledByDefault false (it shells out — opt in)
engine.js        the verb: parse, dispatch, reply. Synchronous handler.
workflows.js     the four workflows. Nothing here rejects, and nothing writes.
proc.js          every spawn. No shell, no credentials, everything scrubbed.
```

No `renderer.js`, so **no `npm run build:web` step** — an engine-only plugin
needs none. It is also therefore invisible to the browser frontend, which is
correct: it shells out to a local binary that a browser has no access to anyway.
