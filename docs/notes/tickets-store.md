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
