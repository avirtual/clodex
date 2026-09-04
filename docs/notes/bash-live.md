# bash-live

Notes for `bash-live.js`. Facts the code cannot state; everything provable by a
test lives in `test/bash-live.test.js` instead.

## `tasksDirFromScratchpad` / `tasksDirFor`

The CLI's tasks dir is taken from the hook payload's `scratchpad_dir` (its
sibling), never derived from `os.tmpdir()`. On macOS the two disagree: `TMPDIR`
is `/var/folders/<hash>/T` while the CLI writes its task files under
`/private/tmp`. Deriving it shipped a watcher pointed at a directory that did not
exist -- snapshot always empty, no foreground output ever streamed, three cold
reviews and a green suite over a feature that did nothing. `bash-console.js`
reads the same field for the same reason; the two must not disagree.

`tasksDirFor` survives only as a fallback for a payload with no `scratchpad_dir`.
A fixture that supplies `tmpdir` through the DI seam cannot see the defect, since
the derived dir and the fixture's dir then agree by construction.
