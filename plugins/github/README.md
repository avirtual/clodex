# github — `[agent:gh]`

An engine-only plugin. No UI, no settings, no renderer half. It exists to make
an **agent** shorter-winded: four sub-commands, each collapsing a workflow the
agent would otherwise fumble through in six commands and two wrong guesses.

## Before it does anything

**The verb is privileged, like every plugin verb** (`docs/plugin-api.md` §7). A
freshly installed plugin's verb is inert on every existing seat, and the failure
is *silent* — the line is not parsed as your verb, nothing is logged, and to the
agent it reads as an unrecognised intent.

> Session ⚙ menu → intent checklist → tick **GitHub (status / PR / CI /
> review)**. Per seat. Every user hits this once.

**And `gh` must be installed and logged in — by the operator, in a terminal.**

```
gh auth login
```

## The verbs

| Line | What it collapses |
|---|---|
| `[agent:gh status]` | `git rev-parse` · `git status` · `git rev-list` · `gh repo view` · `gh pr view` · `gh pr checks` · a GraphQL `reviewThreads` query → one paragraph. **Ask this before opening, updating or merging anything.** |
| `[agent:gh pr]` | Work out the base · confirm there is something to review · refuse the states that would make a misleading PR · write a real description from the commits · push with an upstream · create · hand back the URL. |
| `[agent:gh pr --dry]` | The same, stopping before the push. For showing an operator what you are about to open. |
| `[agent:gh ci]` | Find the failing checks · resolve each to its workflow run · pull only the failed steps' logs · **distil the lines that name a failure** out of tens of thousands of lines of build chatter. |
| `[agent:gh review]` | The GraphQL query an agent gets wrong twice, rendered as a `file:line` worklist. Resolved threads dropped, outdated ones flagged. |

`[agent:gh pr]` takes an optional prose body, terminated by `[agent:end]`:

```
[agent:gh pr]
Session rows now carry a PR status chip. Refresh is bounded by a 30s TTL.
[agent:end]
```

The body leads the description; the commits and diffstat follow it as evidence.
Without one, the description is still real — it is just missing the *why*.

### What `[agent:gh pr]` refuses, and why

Each is a state in which the PR would exist but be wrong, and the agent could
not tell afterwards: on the default branch · detached HEAD · unborn HEAD ·
nothing ahead of base · **uncommitted changes** (the PR would be missing the
work it is named after) · a PR already open (a duplicate, and the second one
takes the reviews).

Refusing is the point. A verb that opened a wrong PR and reported success would
be worse than no verb.

## Credentials: there are none

`host.storage` is plaintext JSON with no mode bits, and `host.settings` lives in
the user's UI settings. So **this plugin holds no secret at all**: no token
setting, no token in storage, no token argument on any method, none in argv,
none in the environment it constructs, and a scrubber (`proc.js`) on every byte
that reaches a log or an agent, for the case where `gh` echoes one back.

Authentication is `gh`'s own, in the operator's keychain. If `gh` is not logged
in, the answer the agent gets is *"the operator must run `gh auth login`"* — not
a prompt for a token this plugin has nowhere safe to put.

## Freshness, stated as `docs/plugin-api.md` §14 asks

**Nothing is cached.** Every call shells out. `status` is true as of the moment
it answered and stale immediately afterwards — a check can go red a second
later. The one deliberate staleness: `status` compares against the *local copy*
of `origin/<base>` and does **not** fetch, because a network write against the
operator's repository is not something a status call should do behind their
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

Verbs are one flat global namespace (`docs/plugin-sources.md` §4a) and a
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
workflows.js     the four workflows. Nothing here rejects.
proc.js          every spawn. No shell, no credentials, everything scrubbed.
```

No `renderer.js`, so **no `npm run build:web` step** — an engine-only plugin
needs none. It is also therefore invisible to the browser frontend, which is
correct: it shells out to a local binary that a browser has no access to anyway.
