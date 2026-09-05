# docs/notes/plugin-loader.md

## readBundle

`unreadable` separates a read that FAILED from content that is absent — only
the first means a permission error, not a deletion. Set for the directory
listing AND each per-entry read, so one bad `SKILL.md` gives a SHORT list,
not a blanked record. `ENOENT` never sets it: that is a real absence.

## rescan

The bundle refresh is gated on neither-moved AND readable. A moved dir or
version keeps its require-cached OLD engine until restart, so refreshing
content would pair fresh skills with an engine no install shipped; refreshing
an unreadable listing would blank a good record.

## namespaceTemplateRefs

An already-namespaced ref is left alone deliberately: a plugin may name
ANOTHER plugin's prompt, so rewriting is conditional on the absent colon. It
also merges the plugin's own id into `plugins`, which makes picking a
template GRANT the plugin rather than require it.

## writeBundleFile

Two independent refusals: `editable` refuses a plugin outside the user root
even for a legal stem; `insideDir` re-checks the assembled path, so a stem
that slipped the name regex still cannot land outside the plugin's own
directory.

## mkFetchDir / fetchAndValidate / renameOrCopy / applyUpdate

Fetch temp dirs sit under `os.tmpdir()`: `discoverRoot` has no dot-entry
filter (verified by probe), so one under the plugins root would scan as
broken. `fetchAndValidate` renames the extracted dir to the manifest's own id
— GitHub's top dir is `owner-repo-<sha>`, not what `validateCandidate` wants.
`renameOrCopy` falls back to `cpSync` only on `EXDEV`. `applyUpdate` moves the
old copy aside before the rename-in; on a later failure the possibly-partial
target is removed before the old copy is renamed back, and "restored" is
claimed only if that rename succeeds — else the error names `.old-*` instead.
