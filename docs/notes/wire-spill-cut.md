# wire/spill-cut notes

Line-level, no whitespace normalisation: across 272 captured response/request pairs
(team-avh wirescope logs, Sept 2026) the CLI re-sent every response text block byte-exact
as one block — 0 merges, 0 splits, 0 whitespace diffs — so uncut bytes are forwarded as is.

Live probe 2026-09-21 (`max_tokens:1`, the CLI's beta header incl.
`mid-conversation-system-2026-04-07`, messages `[user, system, user]`): HTTP 400,
"messages.1: role 'system' must precede an 'assistant' message or end the array". An
assistant message whose cut would drop it is therefore kept uncut when the surviving
predecessor is `role:"system"`, counted in `skipped`.

## SPILLED_BODY_FIRST

Every over-limit intent body is filed (`SpillFilter._resolve`). The two OLDEST
intent stubs of each request whose spill file resolves (`resolveSpill`) are
rendered by the cut as the original intent — bare head, the filed body verbatim,
`[agent:end]` — as examples (Bogdan's rulings 2026-09-23 and 2026-09-24: a seat
that has only ever seen stand-ins learns the stand-in as the way a body is
written, and the rule is about the model's window, not host process lifetime).
A stub whose file is missing, unreadable or too large is not counted. The count
is per `cutSpillStubs` call and keeps no process state: message order is fixed
within a transcript, so the same two are expanded on every request until a
compact drops them (the compact busts the cache anyway) and the next two are
promoted. A host relaunch grants nothing.

Of the remaining stubs, the first rendered gets the long form
`[Runtime note: Clodex carries your two oldest long intent bodies in full as
examples and replaces later ones with this note; this body was delivered and
filed in full. Every new intent still needs its complete body; never write this
note.]`, every later one `SPILLED_BODY`. Both literals are the `spilled` mimic kind and both
are refused as a typed body (`spilledBodyOf`), on the same bounce path.
