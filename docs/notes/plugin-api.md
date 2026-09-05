# plugin-api notes

## seatHasPlugin

Absent list = SHIPPED-ONLY, which is neither `pluginGranted`'s absent = refusal
nor the all-enabled default this had before t661. The seat default splits on
ORIGIN: a plugin loaded from the repo's own plugins/ root reaches a seat with no
list, a custom one does not. A pre-upgrade seat therefore LOSES custom plugins
until they are ticked, which is the intended migration — one tick on the seats
that should have them.
