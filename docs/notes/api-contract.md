# api-contract.js

## accountsList

The `accounts*` rows are bound on BOTH surfaces, like the `ctl*` rows: this
table is a binding table, not a permission list. Both hosts register the
handlers; `accounts:setApiKey` alone refuses a caller whose
`secureTransportOfSender` is not exactly `true`.
