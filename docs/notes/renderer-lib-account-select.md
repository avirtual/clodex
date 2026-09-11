# renderer/lib/account-select.js

## loginSeat

The bump starts at `${base}-2`, never at `base`. Account labels routinely end in
a digit (`sub-2`) and `bumpDefaultName` increments a trailing number, so bumping
the bare base turns a taken `login-sub-2` into `login-sub-3` — a name that reads
as sub-3's login seat while running on sub-2's config dir.
