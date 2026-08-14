#!/usr/bin/env python3
"""Does a modal state leave bracketed-paste (mode 2004) ON?

Clodex latches _bootReadySeen on the first 2004h and tracks _pasteModeOn on
every 2004 transition. If a modal turns 2004 OFF, Clodex can already see it.
If it stays ON, the existing signals are structurally blind to the modal.

Prints every 2004 transition the CLI emits, with what was on screen around it.
"""
import os, pty, sys, time, select, fcntl, termios, struct, re

def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))

def strip_ansi(s):
    s = re.sub(r'\x1b\][^\x07\x1b]*(\x07|\x1b\\)', '', s)
    s = re.sub(r'\x1b[@-Z\\-_]', '', s)
    s = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', s)
    return s

argv = sys.argv[1:] or ['claude']
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execvp(argv[0], argv)
set_size(fd, 40, 100)

transitions = []
buf = []
end = time.time() + 20
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.1)
    if not r:
        continue
    try:
        d = os.read(fd, 65536)
    except OSError:
        break
    if not d:
        break
    buf.append(d)
    for m in re.finditer(rb'\x1b\[\?2004([hl])', d):
        transitions.append((round(time.time() - (end - 20), 2), m.group(1).decode()))

os.write(fd, b'\x15')
time.sleep(0.03)
os.write(fd, b'PROBE_TEXT_MARKER')
time.sleep(0.5)
mark = len(buf)
end2 = time.time() + 3
while time.time() < end2:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        buf.append(d)
        for m in re.finditer(rb'\x1b\[\?2004([hl])', d):
            transitions.append(('after-write', m.group(1).decode()))

screen = strip_ansi(b''.join(buf).decode('utf-8', 'replace'))
print('2004 transitions:', transitions)
print('final 2004 state:', transitions[-1][1] if transitions else 'NONE')
print('PROBE_TEXT_MARKER echoed on screen:', 'PROBE_TEXT_MARKER' in screen)
print('--- screen tail ---')
print(screen[-1500:])
try:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
except Exception:
    pass
