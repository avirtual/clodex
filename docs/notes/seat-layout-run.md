## ensureRunDir

`run` is the reversed kind (`ensureRunDir`): `run/<seat>` is the REAL dir and
`sessions/<seat>/run` the link, because `sandbox.js` mounts `~/.clodex/run` as a
tmpfs — the box's `~/.clodex` is a virtiofs bind that cannot host a unix socket,
and a link from `run/` into the home put `agent.sock` on the bind (`EINVAL
chmod`, then `listen ENOTSUP`, seat dead). A real `run/<seat>` is adopted, not
refused; a `run/<seat>` that is a LINK (laid out by 9563c95f..b5239253) is
unlinked and the home dir it pointed at removed before the real dir is made —
`run/` is transient, so nothing is carried. A real `sessions/<seat>/run` gives
way to the link; a link already naming `run/<seat>` is left as is.
