# docs/notes/engine-file-write.md

## writeFilePeek

`vetFileWrite` vets the descriptor `writeFilePeek` opens, and the write goes through that same descriptor, so the type, size, mtime and content checks describe the bytes the write replaces. The open descriptor keeps its inode alive, so its number cannot be recycled while held; the post-vet name check (`realpathSync` equal to the vetted path, then `statSync` matching the descriptor's `dev`, `ino` and `birthtimeNs`) is what refuses an ancestor swapped for a symlink and a file recreated at the vetted name. `O_NOFOLLOW` refuses a leaf symlink swapped in before the open. Pinned by `test/file-view-api.test.js`.
