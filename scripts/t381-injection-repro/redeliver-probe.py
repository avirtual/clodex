#!/usr/bin/env python3
"""Does a SECOND delivery land after the first was swallowed by a modal?

This is the whole feasibility question for shape (a). The operator recovered the
wedged reviewer by poking it with "there?" -- which suggests the swallowed
injection's own Enter had already consumed the modal, leaving a live composer for
the next write. If so, redelivery is a real fix, not just detection.
"""
import os, pty, time, select, fcntl, termios, struct, re, sys

def set_size(fd, r, c):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    s = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
    return s

def drain(fd, sec, sink):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                break
            if not d:
                break
            sink.append(d)
    return b''.join(sink)

def inject(fd, text, settle):
    """Exactly inject-queue.js _drain."""
    os.write(fd, b'\x15')
    time.sleep(0.030)
    os.write(fd, text.encode())
    time.sleep(settle)
    os.write(fd, b'\r')

d = '/tmp/t381-redeliver-%d' % os.getpid()
os.makedirs(d, exist_ok=True)
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['CLAUDE_CONFIG_DIR'] = d
    os.execvp('claude', ['claude'])
set_size(fd, 40, 100)
drain(fd, 12, [])

NUDGE = 'say the single word PINEAPPLE and nothing else'

# delivery 1 -- expected to be swallowed by the startup modal
sink1 = []
inject(fd, NUDGE, 0.050)
out1 = strip_ansi(drain(fd, 4, sink1).decode('utf-8', 'replace'))
print('delivery 1 -- text echoed:', NUDGE[:20] in out1)
print('delivery 1 -- answered PINEAPPLE:', 'PINEAPPLE' in out1.replace(NUDGE, ''))

# delivery 2 -- the redelivery
sink2 = []
inject(fd, NUDGE, 0.050)
out2 = strip_ansi(drain(fd, 12, sink2).decode('utf-8', 'replace'))
print('delivery 2 -- text echoed:', NUDGE[:20] in out2)
print('delivery 2 -- answered PINEAPPLE:', 'PINEAPPLE' in out2.replace(NUDGE, ''))
print('--- tail after redelivery ---')
print(out2[-700:])
try:
    os.kill(pid, 9); os.waitpid(pid, 0)
except Exception:
    pass
