# plugin-api notes

## seatHasPlugin

Absent list = TRUE (the living all-enabled default), which is the opposite
polarity to `pluginGranted`'s absent = refusal. The two are deliberately
different: flipping this one strips every pre-upgrade seat of the shipped
plugins with no migration back.

## pluginReaches

The grants-axis reach. Since t654 it is not the surfacing predicate and has one
production caller left, `renderer/renderer.js`'s `pluginReachesSession`, which
phase B re-keys onto `seatHasPlugin`. Nothing in the main process calls it.
