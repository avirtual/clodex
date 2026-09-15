# test/lib/tmp-roots.js

## mkTmpDirIn

A scratch directory inside a parent that is ALREADY tracked, and deliberately
not registered itself. `sweep` removes that parent recursively, so a second
entry would glob `<nested>-*` inside a directory already gone by its turn.
Used by test/sandbox.test.js, whose per-case dirs live under one `TMP_USERDATA`
root that `mkTmpRoot` already registered.
