# docs/notes/plugin-loader.md

## readBundle

`unreadable` separates a read that FAILED from content that is absent — only
the second means "no longer carries them", so a permission error does not
read as a deletion. Set for the directory listing AND each per-entry read, so
one bad `SKILL.md` gives a SHORT list, not one the rescan gate blanks a good
record with. `ENOENT` never sets it: that is a real absence.

## rescan

The bundle refresh is gated on neither-moved AND readable. A moved dir or
version keeps its require-cached OLD engine until the restart the changed
badge asks for, so refreshing content would pair fresh skills with an engine
no install shipped; refreshing an unreadable listing would blank a good
record. A genuine deletion lists fine, so it still empties the record.

## namespaceTemplateRefs

An already-namespaced ref is left alone deliberately: a plugin may name
ANOTHER plugin's prompt, so the rewrite is conditional on the absent colon.
It also merges the plugin's own id into `plugins`, which is what makes
picking a plugin template GRANT the plugin rather than require it.

## writeBundleFile

Two independent refusals, neither redundant. `editable` carries the ownership
ruling, so a plugin outside the user root is refused even for a legal stem;
`insideDir` re-checks the assembled path, so a stem that slipped the name
regex still could not land outside the plugin's own directory.

## mkFetchDir / fetchAndValidate / renameOrCopy / applyUpdate

Fetch temp dirs sit under `os.tmpdir()`: `discoverRoot` has no dot-entry
filter (verified by probe), so one under the plugins root would scan as
broken. `fetchAndValidate` renames the extracted dir to the manifest's own id
first — GitHub's tarball top dir is `owner-repo-<sha>`, not the id
`validateCandidate` wants. `renameOrCopy` falls back to `cpSync` only on
`EXDEV`; `applyUpdate` moves the old copy aside before the rename-in.
