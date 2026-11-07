# api-contract.js

## accountsList

The five `accounts*` rows are bound on BOTH surfaces, like the `ctl*` rows: this
table is a binding table, not a permission list. The web build's bindings reach
no handler, because registration is gated on `enableAccounts` in
ipc-handlers.js, which web-host.js declines.
