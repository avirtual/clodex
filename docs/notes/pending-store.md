# docs/notes/pending-store.md

## claimParkedByKey

Selects on a PAYLOAD field, so unlike `claimParkedById` each candidate must be
read before it can be claimed. That read is only a filter — the rename is still
the claim, and a concurrent whole-dir `drainPending` wins by making the rename
ENOENT, which ends the sweep with whatever it already took.

Returns `claimed` as a count separate from `ids` because a park file carries an
id only when its caller minted one, so a claim can be real and unnameable.

## rehomeOrphans

Lists `claimsDir` and, for one release, the pending root itself for a claim
left there by a pre-upgrade process. The root listing only takes the legacy
`<name>.draining.<kind>.<pid>` shape (`LEGACY_CLAIM_RE`): every shipped claim
tag carried a kind word, so a seat named `a.draining.99999` is not taken.

## drainPending

A directory rename keeps its mtime, so a pending dir last written more than
`CLAIM_STALE_MS` ago would read as a stale claim between the rename and
`touchClaim`; the source is touched before the rename to close that window.
`rehomeOrphans` does the same for the aged claim it takes, and the hook's
`rehome_orphans` and drain claim mirror both.
