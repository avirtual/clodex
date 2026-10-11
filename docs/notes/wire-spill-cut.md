# wire/spill-cut notes

Line-level, no whitespace normalisation: across 272 captured response/request pairs
(team-avh wirescope logs, Sept 2026) the CLI re-sent every response text block byte-exact
as one block — 0 merges, 0 splits, 0 whitespace diffs — so uncut bytes are forwarded as is.

Live probe 2026-09-21 (`max_tokens:1`, the CLI's beta header incl.
`mid-conversation-system-2026-04-07`, messages `[user, system, user]`): HTTP 400,
"messages.1: role 'system' must precede an 'assistant' message or end the array". An
assistant message whose cut would drop it is therefore kept uncut when the surviving
predecessor is `role:"system"`, counted in `skipped`.

## expansionOf

Every over-limit intent body is filed (`SpillFilter._resolve`). The two NEWEST
intent stubs of each request whose spill file resolves (`resolveSpill`) are
rendered by the cut as the original intent — bare head, the filed body verbatim,
`[agent:end]` — as examples (Bogdan's rulings 2026-09-23 and 2026-09-24: a seat
that has only ever seen stand-ins learns the stand-in as the way a body is
written, and the rule is about the model's window, not host process lifetime).
A stub whose file is missing, unreadable or too large is not counted. The count
is per `cutSpillStubs` call and keeps no process state. A host relaunch grants nothing.
The proxy's sticky set (`sticky`) is what keeps the first two bodies after a compact
expanded until the next cold boundary; newest-two seeds an empty set and adds each
request's newest two to it.

A loop-minted seat (persistence `ephemeral: true`: a ticket hand, a cold reviewer)
is registered with `examples: 1`: only its newest resolvable stub is expanded. With zero examples, hand t1122 typed the
stand-in as the body of its rework-round `task done`, its only prior example of that verb.

Every remaining stub renders as the bare head line followed by `[agent:end]`,
with no body: a note in history is a shape the model can copy, an empty body is not
(2026-10-10 lead: seven turns of prose claiming an intent never emitted).

## STAND_INS are cuttable
On jarvis-lead (sid 1d05af56), 55 minutes after the old `PLACEHOLDER_LEGACY` sentence first stood in
behind a system row, the model emitted it verbatim as its whole reply (wirescope req 8336, 29 output
tokens), and the copy rode uncut in every later request. The cut never sees its own output (the CLI
re-sends its transcript; wirescope's request.json is post-cut, the jsonl carries only the model's copy),
so any `STAND_INS` line in incoming assistant text is model-authored: it is cut and counted as
`parroted`.
