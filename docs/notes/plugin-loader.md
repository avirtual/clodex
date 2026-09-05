# docs/notes/plugin-loader.md

## readBundle

`unreadable` separates a directory that failed to LIST from one that is absent.
Both yield no entries, and only the second means "this plugin carries none" —
without the flag a permission error or a half-copied directory is
indistinguishable from a deletion.

## rescan

The bundle refresh is gated on neither-moved AND readable. A moved dir or
version keeps its require-cached OLD engine until the restart the changed badge
asks for, so refreshing content there would pair fresh skills with an engine no
install ever shipped; and refreshing from an unreadable listing would blank a
good record. A genuine deletion lists fine, so it still empties the record.
