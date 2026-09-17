# log-mask.js

## maskSecrets

The key/value rule REQUIRES an `=` or a `:`. A bare space as separator was tried
and reverted: the five key words appear in ops-log prose more often than they
introduce a credential, and four security-diagnostic lines were being corrupted
into `token=[redacted]` — `web-host.js`'s "(token required)" vs
"(localhost-trust)" distinction, the `CLODEX_REMOTE_INSECURE` warning, and both
peer-wiring "token required — not opened" lines. At the WRITE boundary that loss
is irreversible; the truth never reaches disk. The space case that does carry a
credential — a command-line flag — is recovered by a separate rule requiring a
leading `-`/`--`, so `--token abc` still masks while `bearer abc` in prose does
not. Both rules allow a prefix on the key word (`GITHUB_TOKEN`, `access_token`)
because that is the shape an agent-written term command carries.

Rule order is load-bearing and the rules OVERLAP. The key/value rule runs first
and consumes to the next whitespace, so `?token=x&page=2` inside a URL loses the
rest of its query to that rule rather than to the query rule. Deliberate,
in the safe direction: making the key/value rule stop at `&` would leave a
credential intact in every log line that is not a URL, and those are the
majority.

The query rule enumerates `token`/`key`/`sig` and therefore cannot cover a
signed URL's vendor spellings (`X-Amz-Signature`, `Signature`, a bare `t`).
That is why engine.js's default `openExternal` seam drops the whole query
itself instead of relying on this.

The mask is applied at BOTH ends: each host's `writeLog` masks on the way in,
and remote.js's `readLogTail` masks again on the way out. The read-side pass is
not redundant — a clodex.log on disk predating this, or written by an older
generation of the app, still reaches the wire through that route.
