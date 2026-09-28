# session-manager.js (pty output buffer)

## escapeSafeTail
Resyncs only across sequences `TERM_ESCAPE_RE` matches; a cut inside a colon-parameter SGR (`\x1b[4:3m`), a DCS, or an OSC body over 4096 characters still starts mid-sequence.
So does a cut between the `\x1b` and the `\\` of an OSC's closing `\x1b\\`: the lone `\\` is left at the head.
