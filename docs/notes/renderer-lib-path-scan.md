# renderer/lib/path-scan.js

## PATH_RE

The lookbehind guard before the optional prefix skips a start that sits right after a path character (or a class character right after `/`): any match from there also exists one character to the left, which the scan already tried, so the guard drops no hit and turns long runs from quadratic (~400 ms at 20,000 chars) to linear.
The `:\d+` exception exists because a previous hit ending in `:line` leaves `lastIndex` inside a run (`a.js:12abc.md` finds `abc.md`); the `(?!\d)` before it keeps that lookbehind from rescanning a digit run at every position. Differential fuzz against the unguarded pattern (900k strings): zero differences.
