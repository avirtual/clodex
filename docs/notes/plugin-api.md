# plugin-api notes

## seatHasPlugin

Absent list = TRUE (the living all-enabled default), which is the opposite
polarity to `pluginGranted`'s absent = refusal. The two are deliberately
different: flipping this one strips every pre-upgrade seat of the shipped
plugins with no migration back.
