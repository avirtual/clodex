# wire/billing.js

## PRICES

`claude-opus-5-5` sits above `claude-opus-5` because `priceFor` resolves by longest prefix and `claude-opus-5` is a prefix of `claude-opus-5-5`; the row order is for reading, the match is by length. Its cache_read is 0.05x of `in` ($0.20), not the universal 0.1x — copied from the vendor's table (vendor/wirescope/proxylab/billing.py), not derived.

## PRICES_SPEED_FAST

The `claude-opus-5-5` fast row's cache columns (10.0/16.0 writes, 0.40 read on $8/$40) are DERIVED by wirescope — the pricing page prints only $8/$40 — and are kept byte-for-byte with the vendor's row. To be verified on the first real fast receipt.
