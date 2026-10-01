# peer-visibility.js

## nextVisibleWithName

A session created on a peer after its whitelist was materialized is absent from
that array and never renders until eye-toggled; `peer:visibleAdd` appends it so
the create lands visible. An unmaterialized selection already shows everything.

## nextVisibleWithoutName

Hiding a row on an unmaterialized selection materializes the whitelist from the
caller's union of live and attached names; the main process cannot see the
renderer's attached tabs, so the caller supplies that union.
