# scripts/embed-basket

## run

`--dry-run` opens the store with `readOnly: true`: it never compacts, appends or truncates the blob, and with `--compact` it prints what compaction would reclaim (`rows - live`) instead of compacting.

## keysById

Store keys are `keyOf(rec)` = `<basket id>:<content hash>`; basket records carry a stable uuid `id`, so after a successful `add` every other key under the same id is retired with `store.remove`.
