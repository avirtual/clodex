# scripts/embed-basket

## run

`--dry-run` opens the store with `readOnly: true`: it never compacts, appends or truncates the blob, and with `--compact` it prints what compaction would reclaim (`rows - live`) instead of compacting.

## keysById

Store keys are `keyOf(rec)` = `<basket id>:<content hash>`. Every run, before embedding, `run` removes each key under a basket id that is not the key of that id's current record; keys whose id is absent from the basket are kept, so a truncated basket cannot wipe the store.

## readBasket

The basket is append-only, so a later line with an existing id is that record's edit: the last line wins. A line without a non-empty string `id` is skipped, since its key would be `undefined:<hash>`.
