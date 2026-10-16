# spill-grammar.js

## FILED_SRC

One agent-facing line must stay OUTSIDE this grammar and outside every mimic
class, so it is never cut from the wire as if it were a stub:

- the live prose receipt (`spillAckLine`, session-manager.js), which opens with
  "the N B of prose you wrote after your last intent were removed".

A cut body renders as the agent's own intent head line with its title, then
`[agent:end]`, with no body. Nothing tells the agent a cut
happened — no receipt is enqueued for a spilled intent body, and the ordinary
confirmation that follows is the proof the action ran. Measured on the lead seat
2026-09-23 under the removal receipt: six phantom dispatches (t1099 ×1, t1100
×3, t1102 ×3) announced a ticket, bound a reminder to it, and typed no
`[agent:task add]` line at all. The old `SPILLED_BODY` marker IS a mimic kind (`mimicKindOf`
→ `spilled`) and a typed body ending in it is refused (`spilledBodyOf`): copied
back from the record it names no file, so the agent gets `spillMimicBounce`
(intent-spill.js) rather than a silent cut. That bounce quotes the typed token
fenced in backticks and its example intent backslash-escaped, so the bounce
text itself is outside this grammar and never fires.

Every over-limit intent body is filed. At cut time `cutSpillStubs`
(wire/spill-cut.js) renders the first two intent stubs after each compact whose
file resolves as the original intent (bare head, the filed body, `[agent:end]`);
a stub whose file is missing or unreadable is not counted. The decision is
derived from the payload on every request and keeps no process state. Every remaining stub renders as the head and the runtime note. The measured facts live under
`## expansionOf` in docs/notes/wire-spill-cut.md.
A loop-minted seat (persistence `ephemeral: true`) gets `examples: 1`: its first long body after each compact stays in full, so a rework round has a real example of the verb it must write again.
