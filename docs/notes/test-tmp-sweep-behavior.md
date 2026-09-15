# test/tmp-sweep-behavior.js

## plant

Ages the directory LAST, after `fill` has written into it. Writing anything
inside a directory resets its mtime to now, so a root aged before its contents
are created reads as fresh and `tmp-sweep.sh`'s age gate skips it. Round 1 of
this test failed exactly that way: the chmod-000 case created `inner/` after
aging and the sweep never saw the root.
