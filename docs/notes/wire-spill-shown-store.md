# wire/spill-shown-store notes

## SpillShownStore

Measured cost of the in-memory-only set (wirescope lead, 2026-09-24 19:10): one Clodex restart inside the TTL re-collapsed every expanded body past the newest two, about 113k cache-write tokens.
