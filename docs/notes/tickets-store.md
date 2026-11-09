# tickets-store.js

## mustFixItemLines

Returns `null` for "there are no items at all" (absent, or a placeholder) and an
array of the top-level item lines otherwise. A bare `[]` cannot carry that
distinction: an empty array reaches `countMustFix`'s floor-of-one, a placeholder
must not.

The top level is the minimum indentation PRESENT, not a fixed column, and so
relative: the direction worth protecting is undercounting, and against column 0
a verdict whose items are all indented matches no marker and falls to the floor.

## mustFixTitles

One title per must-fix, in the same order and the SAME NUMBER as `countMustFix`
reports — including its floor-of-one arm, which yields the first non-empty line.
A brief that says "3 must-fixes" and lists two is a brief the lead has to open
the verdict to reconcile, which is the whole cost the titles exist to remove.

The minimum indentation is reduced in a loop, never `Math.min(...widths)`: one
argument per line is a stack overflow on a long blob.

`countMustFix`'s floor-of-one is reached only once `mustFixItemLines` has
already ruled out "no items at all" by returning `null`.

## MUSTFIX_PLACEHOLDER_WORDS

Two placeholders seen in real ACCEPT verdicts (t1105): `(empty)` and `(none blocking)`.
The `none` arm takes at most three qualifier words, so a sentence that merely starts
with "none" (`none of the guards are checked`) still counts as a must-fix.

## read

The shared parse, cached per board path on `statSync`'s `mtimeMs` + `size` and
deep-frozen, so a caller that mutates it throws instead of corrupting the next
reader. `load` stays a fresh parse per call for every load-mutate-save path.
Measured on a 26 MB, 2,190-ticket board: a miss costs ~79 ms (parse + freeze,
freeze ~8 ms), a hit ~0.1 ms.

## boardCache

`save` drops the parse and keeps only the written file's stat as a known-valid
marker, so the next `save`'s `refuseReason` skips its own full parse while the
file is unchanged; the next `read` parses once.
