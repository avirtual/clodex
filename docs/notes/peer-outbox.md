# peer-outbox.js

## claimedSenderFault

A system-sender name passes only on a record carrying `seat: true`, which
`_sendToFederatedTarget` sets only for a live local session holding that name.
A claiming hub on a build without this check still drops such a record as
`system sender name`, so both ends need the update.
