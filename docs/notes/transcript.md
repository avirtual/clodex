# transcript.js

## sliceSince

`after` is filtered before `.slice(-limit)`, so the page is the newest `limit`
rows that pass the window rather than a pre-cut tail re-filtered afterwards.
The two orderings are observationally identical whenever timestamps ascend with
`seq` — the survivors are then a suffix, and slicing either side of the filter
gives the same page. They differ only under clock skew, where a later-`seq` row
carries an earlier `ts`: filtering first keeps an older-seq survivor that
slicing first would have discarded unseen. The pin in `test/transcript.test.js`
uses a skewed fixture for exactly that reason; an ascending one passes against
both orderings.

## keepAfter

A row with no `ts`, or one whose `ts` does not parse, is KEPT. A merged bubble
carries no timestamp, and a time window that swallowed it would silently drop
turns the operator asked to see.
