# docs/notes/plugin-source.md

## createPluginSource

Deps-injected leaf like plugin-loader.js (fs/path/https/execFile all arrive
through the deps object), not a pure leaf like clodex-paths.js — every network
and `tar` call is a seam a test swaps out. `parseSourceSpec` is exported
standalone since it needs neither.

## parseSourceSpec

Accepts `owner/repo`, `owner/repo@ref`, `owner/repo:sub/path`,
`owner/repo@ref:sub/path`, and `https://github.com/owner/repo(/tree/ref/sub/path)?`,
with a trailing `.git` stripped in both forms. `ref` null means the repo's
default branch. Refused by name: ssh remotes, non-github.com hosts, an
absolute or traversing subpath, an empty owner.

## fetchTarball

GET on `api.github.com/repos/<o>/<r>/tarball/<ref-or-empty>`, following
redirects (codeload.github.com issues one). Byte-counting runs on the
response's own `data` event, before the pipe to the destination file
completes, so a cap breach can `res.destroy()` mid-stream instead of buffering
the whole tarball into memory first to find out it was too big.

## extractPlugin

GitHub's tarball's single top-level directory is always named
`owner-repo-<sha7>`, never the plugin's manifest id — the abbreviated commit
sha is read out of that name. `plugin-loader.js`'s `fetchAndValidate` renames
the extracted directory to the manifest's own id before validating, since
`validateCandidate` requires the directory name to equal the manifest id.

## fetchCommitSha

Never rejects: a caller that cannot reach the `commits/<ref>` API keeps the
abbreviated sha from the tarball name instead, which the sidecar's
`commitFull: false` records honestly rather than failing the whole fetch over
one extra optional call.
