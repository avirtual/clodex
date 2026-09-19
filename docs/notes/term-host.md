# term-host

## shellHostOf

Recognises only argv shapes that cannot be anything but "open an interactive
shell". The asymmetry is deliberate: a false negative refuses the agent with the
program named and costs one message, while a false positive types the install
line into a program that is not a shell — in an editor that edits the operator's
buffer, which is not recoverable.

mosh is absent on purpose. It runs the terminal emulator on the far box and
ships screen diffs, so an OSC 133 mark printed there never reaches the parser.
Recognising it would fail every mosh exec with "no answer"; `MOSH_EXCLUDED_REASON`
carries the wording that says so instead.

OPTION PARSING STOPS AT THE HOST. Nothing after the host positional is an ssh
option — it is the remote command — so the walk takes the first positional and
hands the rest to `bareShell`. Parsing on would read the REMOTE command's flags
as ssh's: `ssh host bash -c 'tail -f x'` had `-c` eaten as ssh's `-c` (cipher),
swallowing the quoted command with it, leaving `[host, bash]` and recognising a
long-running non-interactive program as an interactive shell.

`-N`, `-W`, `-T`, `-n` and `-f` are refused inside the option walk
(`SSH_NO_SHELL_OPTS`): each leaves a connection with no interactive shell reading
keystrokes — no command, a forwarded socket, no tty (so PS0/precmd never run),
stdin from /dev/null, or backgrounded.

## HOST_TABLE

Exported so the refusal text and the docs can enumerate it, and so a test can pin
each row literally. A walk over the table cannot catch a deleted row — it just
makes the walk shorter — so test/term-host.test.js pins every row as a literal
line-in/value-out pair.

## sudoRecognised

A login flag alone is not enough: `sudo -i <cmd>` runs `<cmd>`, it does not open
a shell. The flag is remembered and only answers once the argv is known to carry
no command. A shell word or `su` delegates to `bareShell`/`suRecognised` rather
than re-deciding, so `sudo bash -c 'x'` and `sudo su -c whoami` refuse exactly as
the bare-shell and `su` rows already did. `doas` shares the function.

## nsenterShell

`nsenter`'s session is named by its `-t` pid, not by the shell path, because the
pid is what identifies the namespace being entered. With no `-t` the shell word
is the only thing left to name it.
