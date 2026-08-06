// term-tab.js — the drawer's `term` tenant: a REAL PTY in the workbench, not a
// command runner. `vim`, `less` and interactive prompts must work, which is why
// this is an xterm bound to a shell rather than a block list like the ctl tab.
//
// It is NOT a session, and nothing here should make it look like one: no entry
// in the sidebar's `sessions` map, no name, no registry, no persistence. The
// main side (drawer-pty.js) holds the shell, keyed by workspace; this file
// holds one xterm and the three calls that drive it.
//
// HOST CONTRACT, and this tenant is the one it was written for
// (drawer-host.js rule 4): build DOM in mount, `terminal.open()` in onShow,
// `fit()` in onResize. Fitting in onShow would read a box mid-height-
// transition and compute plausible-but-wrong rows; the host's ResizeObserver
// fires through the transition and always schedules once more after the last
// callback, so the final onResize carries settled geometry.
//
// DOM-bound, so no unit tests per the R1 rule; drawer-pty.js is where the
// testable logic lives.

const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

function createTermTab({ host, xtermTheme }) {
  let terminal = null;
  let fitAddon = null;
  let hostEl = null;
  let opened = false;    // terminal.open() has run against a laid-out box
  let drawn = false;     // this pane has content for the current shell on screen
  let notify = () => {};

  function mount(pane, actions) {
    pane.innerHTML = '<div id="wterm-host"></div>';
    hostEl = pane.querySelector('#wterm-host');

    terminal = new Terminal({
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      theme: xtermTheme(),
      cursorBlink: true,
      allowProposedApi: true,
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Keystrokes go to the shell, never to a session. `onData` is post-decode
    // (it carries the escape sequences an interactive program expects), which
    // is what makes arrow keys and Ctrl-C work in `vim` and `less`.
    terminal.onData((d) => { window.api.wtermWrite(d); });

    // Output arrives for THIS window only — the main side resolves the target
    // window itself, so there is no name to filter on here.
    // The payload is the FIRST argument: preload's `on` binding strips the
    // IpcRendererEvent before invoking this (api-contract `kind: 'on'`). An
    // `(_e, data)` signature here shifts every byte into the ignored parameter
    // and renders an empty terminal that looks like a shell that never started.
    window.api.onWtermData((data) => {
      if (!terminal) return;
      terminal.write(data);
      // Unread only when the operator is not looking; the host suppresses the
      // badge for a visible tab itself.
      notify();
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'wterm-clear';
    clearBtn.title = 'Clear the terminal view';
    clearBtn.textContent = 'Clear';
    // The VIEW only — the shell's own scrollback on the main side is untouched,
    // and this sends nothing to the child (a `clear` keystroke would land in
    // whatever interactive program is running).
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); if (terminal) terminal.clear(); });
    actions.appendChild(clearBtn);
  }

  // Acquire: open against a real box, then ask for the shell — UNCONDITIONALLY,
  // on every show. There is deliberately no "already spawned" latch here: the
  // renderer is never told the shell died (the exit notice arrives as opaque
  // bytes on `wterm:data`), so a latch set on first show would gate out every
  // later attempt and Ctrl-D — the ordinary way anyone ends a shell — would
  // leave the tab permanently dead. The main side is lazy and idempotent, so
  // the repeat call costs a round trip and nothing else, and it also recovers
  // the window-reused-after-kill case.
  function onShow() {
    if (!terminal) return;
    if (!opened) {
      terminal.open(hostEl);
      opened = true;
    }
    const dims = fitAddon.proposeDimensions();
    window.api.wtermSpawn({ cols: dims && dims.cols, rows: dims && dims.rows })
      .then((res) => {
        if (!terminal) return;
        if (!res || !res.ok) {
          terminal.write(`\r\n\x1b[31m${(res && res.error) || 'failed to start a shell'}\x1b[0m\r\n`);
          return;
        }
        // Replay ONLY a shell this pane has never drawn. `wterm:data` is live
        // from mount, so everything a shell prints is already on screen — the
        // one case where the scrollback is news is a renderer that reloaded
        // out from under a still-running shell, which finds `fresh: false` and
        // an empty terminal. Without the once-guard, every re-show would paste
        // the whole history again under the output already there.
        if (!drawn && !res.fresh && res.scrollback) terminal.write(res.scrollback);
        drawn = true;
      })
      .catch(() => {});
    terminal.focus();
  }

  // The authoritative measurement (rule 4). Also the only place the child is
  // told its size — the host coalesces to one call per frame, so a 200ms
  // collapse animation is one SIGWINCH at the end, not a dozen.
  function onResize() {
    if (!terminal || !opened) return;
    fitAddon.fit();
    window.api.wtermResize(terminal.cols, terminal.rows);
  }

  notify = host.register({
    id: 'term',
    label: 'Terminal',
    // A UI nicety only: on the web surface the `wterm:*` handlers are ABSENT
    // from that host's map (engine's enableDrawerServices gate), so the tab
    // would be inert rather than a remote shell. The boundary is registration.
    available: () => !window.__CLODEX_WEB__,
    mount,
    onShow,
    onResize,
  });

  return { open: () => host.open('term') };
}

module.exports = { createTermTab };
