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
