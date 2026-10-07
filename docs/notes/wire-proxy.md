# wire/proxy notes

## spillEligible

Read once per request from `spillEnabled()`, which returns three flags: `tickets` (task add/respec/reject/done), `messages` (dm, shout, sub) and `prose` (text after the last intent). The tee is armed when any flag is on; the verbs it spills are the seat's granted verbs filtered through `SPILL_CATEGORY_OF`, and `prose` is the only flag that also needs an injected turn (`turnInjected`).
