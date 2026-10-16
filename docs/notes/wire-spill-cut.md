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

Every over-limit intent body is filed (`SpillFilter._resolve`). The first two
resolvable intent stubs (`resolveSpill`) after the sticky set was last cleared are
rendered by the cut as the original intent — bare head, the filed body verbatim,
`[agent:end]` — as examples (Bogdan's rulings 2026-09-23 and 2026-09-24: a seat
that has only ever seen stand-ins learns the stand-in as the way a body is
written). A stub whose file is missing, unreadable or too large takes no slot.
A stub expands iff its key is in `sticky` or `sticky.size` plus the keys seeded in
this call is below `examples`; "first" is document order (`collectStubs`). The proxy
adds every expanded key to `sticky`, so the examples stay in full until the next
cold boundary and every later body is the bare head from its first resend
(Bogdan 2026-10-11: a body keeps one shape from its first resend to the next
compact, since a shape change on a settled turn rewrites the cache behind it).

A loop-minted seat (persistence `ephemeral: true`: a ticket hand, a cold reviewer)
is registered with `examples: 1`: only its first resolvable stub is expanded. With zero examples, hand t1122 typed the
stand-in as the body of its rework-round `task done`, its only prior example of that verb.

Every remaining stub renders as its head line followed by `SPILLED_INTENT_NOTE`
and no `[agent:end]`. The earlier head + `[agent:end]` shape was a complete, valid,
body-less intent: wirescope 2026-10-16 (n=61 lead add/respec) found 48% title-only
filings in requests whose history held one, 0 of 13 where none did.

## isRenderedNote
Keeps the note directly under a head line so cut(cut(x)) equals cut(x); a note
anywhere else is a parroted stand-in.

## STAND_INS are cuttable
On jarvis-lead (sid 1d05af56), 55 minutes after the old `PLACEHOLDER_LEGACY` sentence first stood in
behind a system row, the model emitted it verbatim as its whole reply (wirescope req 8336, 29 output
tokens), and the copy rode uncut in every later request. The cut never sees its own output (the CLI
re-sends its transcript; wirescope's request.json is post-cut, the jsonl carries only the model's copy),
so any `STAND_INS` line in incoming assistant text is model-authored: it is cut and counted as
`parroted`.

## headOf

The head keeps the body's whole first line (up to `HEAD_TITLE_MAX` bytes, with the `tasks/` token kept) because the agent copies the shape it sees: a head that has been cut teaches it to file ticket titles cut the same way.
