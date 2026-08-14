#!/usr/bin/env python3
"""t381: does a CLI repaint between the text write and the Enter discard the text?

Mirrors inject-queue.js _drain: \x15 -> 30ms -> text -> settleMsFor(text) -> \r.
The Enter goes out at EXACTLY settle_ms after the text, as production does; the
repaint arm fits its resize INSIDE that window rather than extending it, so a
redraw landing in the second half of the window is interleaved the way
production would see it, not straddled by a longer gap.

A repaint is forced with SIGWINCH (pty resize) -- the one repaint trigger we can
command. The reported one (a model-downgrade banner) is the same class of event:
the CLI redrawing its input line on its own initiative.

POSITIVE CONTROL: the bytes captured between the resize and the Enter are counted
and printed. Without that number the repaint arm cannot be distinguished from a
second copy of `control` -- if the CLI debounced the resize, nothing redrew and a
null result would read as a negative one. The arm only means something when its
resize->Enter window is materially larger than control's (control's is ~0: an
idle composer that has already echoed emits nothing further).

usage: repro.py <control|repaint> [text] [-- argv...]
"""
import os, pty, sys, time, select, fcntl, termios, struct, signal, re

CTRLU_SETTLE_MS = 30
SHORT_TEXT_DELAY = 50
LONG_TEXT_DELAY = 1000
LONG_TEXT_THRESHOLD = 200

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def drain(fd, buf, seconds):
    """Read for `seconds`, appending to buf. False if the child went away."""
    end = time.time() + seconds
    alive = True
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return False
            if not d:
                return False
            buf.append(d)
    return alive

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    s = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
    return s

def run(mode, argv, text, settle_ms):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        # Popped in both of THIS probe's arms: inheriting it from the parent CLI
        # turns transcript saving off, which changes what the child does on its own
        # initiative. The other probes here drop the whole CLAUDE_* set (exempting
        # CLAUDE_CONFIG_DIR); this one does not, and its two arms are identical to
        # each other, which is all its conclusion rests on.
        os.environ.pop('CLAUDE_CODE_ENTRYPOINT', None)
        os.environ.pop('CLAUDE_CODE_CHILD_SESSION', None)
        os.execvp(argv[0], argv)
    set_size(fd, 40, 100)
    buf = []
    if not drain(fd, buf, 12):
        return ('child-exited-early', b'', 0)

    mark = len(buf)
    os.write(fd, b'\x15')
    time.sleep(CTRLU_SETTLE_MS / 1000)
    os.write(fd, text.encode())

    # The settle window. Production sleeps settle_ms here and then writes '\r';
    # both arms below total exactly settle_ms, so the Enter timing is identical
    # and the resize is the ONLY difference between them.
    window = []
    if mode == 'repaint':
        time.sleep(settle_ms / 1000 / 2)
        set_size(fd, 40, 90)
        os.kill(pid, signal.SIGWINCH)
        # Everything the CLI emits between the resize and the Enter. This is the
        # positive control: a redraw shows up here as a burst of cursor/erase
        # sequences, a debounced (ignored) resize shows up as ~nothing.
        drain(fd, window, settle_ms / 1000 / 2)
    else:
        drain(fd, window, settle_ms / 1000)

    redraw_bytes = len(b''.join(window))
    buf.extend(window)
    os.write(fd, b'\r')
    drain(fd, buf, 8)

    tail = b''.join(buf[mark:])
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except Exception:
        pass
    os.close(fd)
    return (mode, tail, redraw_bytes)

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'control'
    text = sys.argv[2] if len(sys.argv) > 2 else 'say the single word PINEAPPLE and nothing else'
    settle = LONG_TEXT_DELAY if len(text) > LONG_TEXT_THRESHOLD else SHORT_TEXT_DELAY
    argv = sys.argv[3:] or ['claude']
    m, tail, redraw_bytes = run(mode, argv, text, settle)
    clean = strip_ansi(tail.decode('utf-8', 'replace'))
    # The derived verdict. 'PINEAPPLE' appears in the echo of the prompt itself, so
    # the answer is only counted where it occurs APART from the echoed text — and
    # the removal must survive the redraw: cursor moves land between glyphs (see
    # echo-probe.py), so a plain `.replace` can remove nothing and let the leftover
    # echo read as an answer. Collapse whitespace on both sides.
    answered = 'PINEAPPLE' in re.sub(r'\s+', '', clean).replace(re.sub(r'\s+', '', text), '')
    print('=== MODE %s ===' % m)
    if mode == 'repaint':
        # Control's window is the text echo alone (~131 bytes measured); a real
        # redraw re-renders the banner and runs an order of magnitude larger. The
        # gap between the two is wide enough that this needs no tuned threshold.
        print('resize->Enter window: %d bytes  (redraw fired: %s)'
              % (redraw_bytes, 'YES' if redraw_bytes > 600 else 'NO - debounced, arm is void'))
        print('text submitted and answered: %s' % answered)
        print('PASS (redraw fired AND text survived it): %s'
              % (redraw_bytes > 600 and answered))
    else:
        print('settle window: %d bytes (text echo; no resize in this arm)' % redraw_bytes)
        print('text submitted and answered: %s' % answered)
        print('PASS (control submits normally): %s' % answered)
    print('--- tail ---')
    print(clean[-1500:])
