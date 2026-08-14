#!/usr/bin/env python3
"""t381 reproduction: does a CLI repaint between the text write and the Enter
write discard the injected text?

Mirrors inject-queue.js _drain exactly: \x15 -> 30ms -> text -> settle -> \r.
A repaint is forced with SIGWINCH (pty resize), which is the one repaint trigger
we can command; the reported one (model-downgrade banner) is the same class of
event -- the CLI redrawing its input line on its own initiative.
"""
import os, pty, sys, time, select, fcntl, termios, struct, signal, re

CTRLU_SETTLE_MS = 30
SHORT_TEXT_DELAY = 50
LONG_TEXT_DELAY = 1000
LONG_TEXT_THRESHOLD = 200

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def drain(fd, buf, seconds):
    """Read for `seconds`, appending to buf."""
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return False
            if not d:
                return False
            buf.append(d)
    return True

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    s = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
    return s

def run(mode, argv, text, settle_ms):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ.pop('CLAUDE_CODE_ENTRYPOINT', None)
        os.execvp(argv[0], argv)
    set_size(fd, 40, 100)
    buf = []
    # let the CLI boot and enter raw mode
    if not drain(fd, buf, 12):
        return ('child-exited-early', b''.join(buf))

    mark = len(buf)
    os.write(fd, b'\x15')
    time.sleep(CTRLU_SETTLE_MS / 1000)
    os.write(fd, text.encode())

    if mode == 'repaint':
        # force the CLI to redraw its input line mid-settle
        time.sleep(settle_ms / 1000 / 2)
        set_size(fd, 40, 90)
        os.kill(pid, signal.SIGWINCH)
        time.sleep(settle_ms / 1000 / 2)
    else:
        time.sleep(settle_ms / 1000)

    drain(fd, buf, 0.05)
    os.write(fd, b'\r')
    drain(fd, buf, 6)

    out = b''.join(buf)
    tail = b''.join(buf[mark:])
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except Exception:
        pass
    os.close(fd)
    return (mode, tail)

if __name__ == '__main__':
    mode = sys.argv[1]
    text = sys.argv[2] if len(sys.argv) > 2 else 'say the single word PINEAPPLE and nothing else'
    settle = LONG_TEXT_DELAY if len(text) > LONG_TEXT_THRESHOLD else SHORT_TEXT_DELAY
    argv = sys.argv[3:] or ['claude']
    m, tail = run(mode, argv, text, settle)
    clean = strip_ansi(tail.decode('utf-8', 'replace'))
    sys.stdout.write('=== MODE %s ===\n' % m)
    sys.stdout.write(clean[-4000:])
    sys.stdout.write('\n=== END ===\n')
