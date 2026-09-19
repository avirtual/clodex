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
