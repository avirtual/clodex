# renderer/lib/path-scan.js

## mayStartPath

A start right after a path character (or a path character right after `/`) is skipped: any match from there also exists one character to the left, which the scan already tried, so no hit is lost and long runs scan linearly instead of quadratically (~400 ms at 20,000 chars). The one start that must never be skipped is the resume point after a hit (`a.js:12abc.md` finds `abc.md`); 800k-string differential fuzz against the unguarded global scan: zero differences.
The guard is JS rather than a regex lookbehind because `build-web.js` targets `safari16`, and lookbehind needs Safari 16.4.
