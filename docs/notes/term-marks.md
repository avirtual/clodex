# term-marks

## createMarkParser

WHO EMITS TAGGED MARKS. The file header lists the OSC 133 subset but names only
the local shell as an emitter, which is no longer the whole set: term-shim's
`REMOTE_INSTALL_LINE` types the same hooks into a FAR shell one hop away, and
every mark that shell emits carries `;nest=1`. So a `D;0` arriving here is the
local shell's close, and a `D;0;nest=1` is the far shell's — the tag is the only
thing separating them, because bytes alone cannot: the far shell's first precmd
emits `D;0 A` exactly as the local precmd does when `ssh` exits.

The parser therefore keeps two layers. An untagged mark means what it always
meant; a tagged one belongs to the inner layer and carries `depth: 1` plus the
`inside` command line on every record. `nest=2` and above are ignored and
stripped — there is no third layer, and accepting one would frame a command
against a shell nothing here can name.

THE NONCE AUTHENTICATES, THE TAG ONLY LAYERS. With `nonce` set, an untagged mark
counts only with `k=<nonce>`, and a `nest=1` mark only with `k=` equal to the
nonce passed to `setFarNonce` for the current install (cleared on every outer
C, so a mark before the install line is typed is dropped). A mark failing either
is stripped from the output and changes no state: not `capturing`, not the
inner layer, not the D/A pairing. Without it, a far host's own shell integration
prints `D;0 A` on its first prompt and closes the local `ssh` while it is still
connected. Tags are read off the end in any order. No `nonce` keeps the old
untagged-means-local reading; drawer-pty passes one to every seat shell's parser
when it has `mintNonce`, shimmed or not, so an unshimmed shell drops every mark.
