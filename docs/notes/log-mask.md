# log-mask.js

## maskSecrets

The key/value rule REQUIRES an `=` or a `:`. A bare space as separator was tried
and reverted: the key words appear in ops-log prose more often than they
introduce a credential, and four security-diagnostic lines were being corrupted
into `token=[redacted]` — `web-host.js`'s "(token required)" vs
"(localhost-trust)" distinction, the `CLODEX_REMOTE_INSECURE` warning, and both
peer-wiring "token required — not opened" lines. At the WRITE boundary that loss
is irreversible; the truth never reaches disk. The space case that does carry a
credential — a command-line flag — is recovered by a separate rule requiring a
leading `-`/`--`, so `--token abc` still masks while `bearer abc` in prose does
not. Both rules allow a prefix on the key word (`GITHUB_TOKEN`, `access_token`)
because that is the shape an agent-written term command carries.

Key words: `token`, `secret`, `password`, `authorization`, `bearer`,
`api[-_]?key`, `access[-_]?key`, `private[-_]?key`, `credential(s)`, `passwd`,
`auth`. A suffix is allowed (`SECRET_ACCESS_KEY`, `API_KEY_ID`) only when it
opens with `-` or `_`: a bare `[\w-]*` suffix masks `author: bob` and
`tokenizer=x`. The prefix is NOT anchored to a word start, so `refreshToken=`
still masks; `--keyboard foo` and `monkey=1` survive because no key word is
`key` alone.

## maskNamed

The name is matched once as a whole `[\w.-]+` run and judged afterwards by
`isSecretName`. Putting the key-word alternation and its suffix inside the run
regex made a long `=`-less identifier (`'_auth'.repeat(4000)`) take minutes.
The name regex stops at the separator; the value regex runs only for a secret
name. A rejected name resumes right after its separator, so a `name=` inside its
value is still seen and every byte of a dense `k=v&k=v` run is scanned once.
Scanning the value before judging the name re-read the rest of the line per
rejected pair: 1.7 s for `'a=b'.repeat(33333)`.

Rule order is load-bearing and the rules OVERLAP. The key/value rule runs first
and consumes to the next whitespace, so `?token=x&page=2` inside a URL loses the
rest of its query to that rule rather than to the query rule. Deliberate,
in the safe direction: making the key/value rule stop at `&` would leave a
credential intact in every log line that is not a URL, and those are the
majority.

The query rule enumerates `token`/`key`/`sig`/`api[-_]?key`; the key/value rule
already masks the other key words inside a query. Neither can cover a signed URL's vendor
spellings (`X-Amz-Signature`, `Signature`, a bare `t`). That is why
engine.js's default `openExternal` seam drops the whole query itself instead
of relying on this.

The mask is applied at BOTH ends: each host's `writeLog` masks on the way in,
and remote.js's `readLogTail` masks again on the way out. The read-side pass is
not redundant — a clodex.log on disk predating this, or written by an older
generation of the app, still reaches the wire through that route.
