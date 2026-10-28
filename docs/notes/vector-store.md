# vector-store

## adoptStagedSidecar

`compact` stages the new sidecar at `stagedSidecarPath` before renaming the blob, and load adopts it only when its `blobBytes` equals the blob's length. A crash before the blob rename leaves the old blob, which is longer, so the staged file is discarded. `compact` skips a store with no garbage because there the two lengths would be equal.

The primary sidecar is not rejected on a `blobBytes` mismatch: a blob longer than its sidecar is the normal state after unflushed appends, and a shorter one keeps its in-range rows.
