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

The first two over-limit intent bodies of a session are never spilled: they
ride the transcript exactly as typed, no file, no `onSpill` (Bogdan's ruling
2026-09-23: a seat that has only ever seen stand-ins learns the stand-in as the
way a body is written; two real examples early teach the shape). The rule is
decided at the moment the body first appears (`SpillFilter._resolve`, counter
`intentSpills.count` on the proxy registration, owned by the session record)
and never revisited: re-rendering an older message on a later request rewrites
every byte behind it and busts the prompt cache. The prose arm (`_resolveTail`)
is neither counted nor exempt. The counter lives in process memory only, so a
restart (`--resume`, reload) grants two more full bodies — accepted.

From the third spill on, the wire cut renders the stand-in; the FIRST
stub-bearing assistant message of a request gets the long form
`[Runtime note: Clodex kept your first two long intent bodies in full as
examples and files later ones; this body was delivered in full and is not
carried in the transcript. Every new intent still needs its complete body;
never write this note.]`, every later one `SPILLED_BODY`. Message order is
fixed within a transcript, so the same message is first on every request until
a compact — cache-stable. Both literals are the `spilled` mimic kind and both
are refused as a typed body (`spilledBodyOf`), on the same bounce path.
