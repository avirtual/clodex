# team-manifest.js

## defaultLeadSeat
Every front door that mints the `<team>-lead` default owes this refusal, because
`createTeam` sees only the finished seat name: an overflowing default would
otherwise surface as a refusal of a `lead` field the caller never supplied. Two
callers today — `team:createBare` (ipc-handlers.js) and `_handleTeamCreate`
(team-tickets.js).
