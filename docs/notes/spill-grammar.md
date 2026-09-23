# spill-grammar.js

## FILED_SRC

Two agent-facing lines must stay OUTSIDE this grammar and outside every mimic
class, so neither is ever cut from the wire as if it were a stub:

- the live prose receipt (`spillAckLine`, session-manager.js), which opens with
  "the N B of prose you wrote after your last intent were removed";
- the runtime-note stand-in `SPILLED_BODY` (intent-spill.js) that the wire cut
  renders where a spilled body stood.

A cut body renders as the agent's own intent around the runtime-note marker:
head line with its title, `[Runtime note: Clodex filed this body in full; it is
not carried in the transcript.]`, `[agent:end]`. Nothing tells the agent a cut
happened — no receipt is enqueued for a spilled intent body, and the ordinary
confirmation that follows is the proof the action ran. Measured on the lead seat
2026-09-23 under the removal receipt: six phantom dispatches (t1099 ×1, t1100
×3, t1102 ×3) announced a ticket, bound a reminder to it, and typed no
`[agent:task add]` line at all. The marker IS a mimic kind (`mimicKindOf`
→ `spilled`) and a typed body ending in it is refused (`spilledBodyOf`): copied
back from the record it names no file, so the agent gets the pointer-mimic
bounce rather than a silent cut.

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
