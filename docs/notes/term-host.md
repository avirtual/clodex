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

`ssh -N` and `-W` are refused inside the option walk rather than by positional
count: both leave a connection with nothing reading keystrokes, and `-N` takes no
argument so the host still parses as a lone positional.

## HOST_TABLE

Exported so the refusal text and the docs can enumerate it, and so a test can pin
each row literally. A walk over the table cannot catch a deleted row — it just
makes the walk shorter — so test/term-host.test.js pins every row as a literal
line-in/value-out pair.

## nsenterShell

`nsenter`'s session is named by its `-t` pid, not by the shell path, because the
pid is what identifies the namespace being entered. With no `-t` the shell word
is the only thing left to name it.
