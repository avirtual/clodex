# docs/notes/pending-store.md

## claimParkedByKey

Selects on a PAYLOAD field, so unlike `claimParkedById` each candidate must be
read before it can be claimed. That read is only a filter — the rename is still
the claim, and a concurrent whole-dir `drainPending` wins by making the rename
ENOENT, which ends the sweep with whatever it already took.
