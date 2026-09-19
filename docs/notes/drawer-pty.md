# drawer-pty notes

## armInstall

The install line is written after the far side has SPOKEN and then gone quiet
for `REMOTE_QUIET_MS`, capped at `ABANDON_MAX_MS`. Nothing downstream of the ^C
proves a far prompt, so this one write is blind — bounded by the same cap the
local path already accepts.

The leading space is sacrificial. The measured byte loss after an interrupt is
the LEADING byte, so a lost space leaves the line whole; a kept space is nothing
to a shell, and under `HISTCONTROL=ignorespace` it also stays out of far history.

Success is the far shell's tagged `D` exit status, not the install's own framing:
a two-byte loss eats the install's `C` mark while the rest of the line still runs.

## armNested

The release waits on a TAGGED prompt. An untagged `D;130 A` is the LOCAL shell's,
and an implementation that accepted it would type the command into a session the
untagged D just closed.

## forgetRemote

Install state is keyed to `outerSeq`, never a sticky flag. A second `ssh` to the
same host is a different far shell process, so it must install again.

## handshake

Shared by both layers because the nested exec IS the local algorithm one hop
away: the same three clocks, with `depth` choosing which prompt slot the release
listens on. A special "skip the abandon once after install" path would be a
second code path to get wrong for a saving of one prompt cycle.
