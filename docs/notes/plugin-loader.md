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

## namespaceTemplateRefs

An already-namespaced ref is left alone deliberately: a plugin may name ANOTHER
plugin's prompt, so the rewrite is conditional on the absent colon rather than
unconditional. It also merges the plugin's own id into `plugins`, which is what
makes picking a plugin template GRANT the plugin rather than require it.

## writeBundleFile

Two independent refusals, and neither is redundant. `editable` carries the
ownership ruling, so a plugin outside the user root is refused even for a legal
stem; `insideDir` re-checks the assembled path, so a stem that somehow slipped
the name regex still could not land outside the plugin's own directory.
