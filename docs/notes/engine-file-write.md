# docs/notes/engine-file-write.md

## writeFilePeek

`O_NOFOLLOW` refuses a symlink only in the last path component, so an ancestor directory swapped for a symlink after the vet still opens. The `fstat` dev/ino compare against the vet's own `stat` is what catches that; `O_NOFOLLOW` keeps the open from going through a symlinked last component before that check runs. Pinned by `test/file-view-api.test.js`.
