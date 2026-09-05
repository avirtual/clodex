# docs/notes/plugin-loader.md

## readBundle

`unreadable` separates a read that FAILED from content that is absent. Both
yield fewer entries, and only the second means "this plugin no longer carries
them" — without the flag a permission error or a half-copied directory is
indistinguishable from a deletion. Set for the directory listing AND for each
per-entry read, since one unreadable `SKILL.md` yields a SHORT list rather than
an empty one, which the rescan gate would otherwise write over a good record.
`ENOENT` never sets it: that is a real absence.

## rescan

The bundle refresh is gated on neither-moved AND readable. A moved dir or
version keeps its require-cached OLD engine until the restart the changed badge
asks for, so refreshing content there would pair fresh skills with an engine no
install ever shipped; and refreshing from an unreadable listing would blank a
good record. A genuine deletion lists fine, so it still empties the record.
