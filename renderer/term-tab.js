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

function createTermTab({ host, xtermTheme, getActiveSession }) {
  // The seat this pane is currently showing a shell for. One xterm is reused
  // across seats — a terminal per seat would multiply the DOM and the fit
  // measurements for panes nobody is looking at — so this is what says whose
  // bytes belong on screen.
  let seat = null;
  // Live bytes arriving between a spawn request and its reply. Null when no
  // spawn is in flight, which is the ordinary state.
  let pending = null;
  let terminal = null;
  let fitAddon = null;
  let hostEl = null;
  let opened = false;    // terminal.open() has run against a laid-out box
  let drawn = false;     // this pane has content for the current shell on screen
  // The stub carries `selectionChanged` too: mount() can only run from inside
  // register() (before the real notify is assigned) and today's registration
  // order makes that unreachable for this tenant — but a bare `() => {}` turns
  // that ordering fact, stated in another file, into a TypeError here.
  let notify = Object.assign(() => {}, { selectionChanged: () => {} });

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
    terminal.onData((d) => { window.api.wtermWrite(seat, d); });

    // Output arrives for THIS window only — the main side resolves the target
    // window itself, so there is no name to filter on here.
    // The payload is the FIRST argument: preload's `on` binding strips the
    // IpcRendererEvent before invoking this (api-contract `kind: 'on'`). An
    // `(_e, data)` signature here shifts every byte into the ignored parameter
    // and renders an empty terminal that looks like a shell that never started.
    window.api.onWtermData((data, from, seq) => {
      if (!terminal) return;
      // Every seat's shell in this window sends here, so bytes for one the pane
      // is not showing must be DROPPED, not written: the main side keeps a
      // scrollback per shell and replays it on switch, so nothing is lost — but
      // writing them would interleave two shells into one unrecoverable buffer.
      // `undefined` is the pre-seat shape and is treated as "mine" so a stale
      // main process cannot blank the tab.
      if (from !== undefined && (from || null) !== seat) return;
      // A spawn is in flight for this seat, so the scrollback snapshot that is
      // about to arrive may or may not already contain these bytes. Writing them
      // now risks printing them twice; dropping them risks losing the ones that
      // came after the snapshot. So hold them and flush AFTER the replay.
      if (pending) { pending.push({ data, seq }); return; }
      terminal.write(data);
      // Unread only when the operator is not looking; the host suppresses the
      // badge for a visible tab itself.
      notify();
    });

    // xterm owns its selection model and fires no document `selectionchange`,
    // so the shared copy button would never learn about one. This is the push
    // half of drawer-host rule 5.
    // Uncaught on purpose: the stub above makes the ordering hazard impossible,
    // so anything thrown here is a real fault in the host's sync and swallowing
    // it would leave the button silently wrong.
    terminal.onSelectionChange(() => notify.selectionChanged());

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
    const want = (getActiveSession && getActiveSession()) || null;
    // A seat change means a DIFFERENT shell, so the pane is cleared and redrawn
    // from that shell's scrollback rather than continuing under the previous
    // seat's output. `drawn` resets with it: the replay guard is per-shell, and
    // carrying it across a switch would leave the new pane empty.
    if (want !== seat) {
      seat = want;
      drawn = false;
      terminal.reset();
    }
    const dims = fitAddon.proposeDimensions();
    const asked = seat;
    pending = [];
    // Everything at or below the snapshot's seq is already inside the scrollback
    // that was just written, so only what came AFTER it is flushed. Without the
    // comparison the overlap is either printed twice or dropped, and which one
    // depends on IPC timing rather than on anything the operator did.
    const flush = (upto) => {
      const held = pending || [];
      pending = null;
      for (const h of held) {
        if (typeof h.seq === 'number' && typeof upto === 'number' && h.seq <= upto) continue;
        terminal.write(h.data);
      }
    };
    window.api.wtermSpawn({ seat, cols: dims && dims.cols, rows: dims && dims.rows })
      .then((res) => {
        if (!terminal) return;
        // A switch that resolved after a LATER switch must not paint: its
        // scrollback belongs to a seat the operator has already left. The held
        // bytes go with it — they are that seat's, and the switch already
        // cleared the pane.
        if (asked !== seat) { pending = null; return; }
        if (!res || !res.ok) {
          terminal.write(`\r\n\x1b[31m${(res && res.error) || 'failed to start a shell'}\x1b[0m\r\n`);
          pending = null;
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
        flush(res.seq);
      })
      .catch(() => { pending = null; });
    terminal.focus();
  }

  // The authoritative measurement (rule 4). Also the only place the child is
  // told its size — the host coalesces to one call per frame, so a 200ms
  // collapse animation is one SIGWINCH at the end, not a dozen.
  function onResize() {
    if (!terminal || !opened) return;
    fitAddon.fit();
    window.api.wtermResize(seat, terminal.cols, terminal.rows);
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
    // Rule 5: the terminal's selected text lives in xterm's model, not the DOM.
    selection: () => (terminal ? terminal.getSelection() : ''),
    // The shell is per-seat, so a switch is a different shell. onShow does the
    // whole job (clear, re-key, replay) and is idempotent about a seat that did
    // not actually change, so this is a plain re-entry rather than a second
    // acquisition path that could drift from it.
    // The host only calls this on the VISIBLE tenant, so there is no visibility
    // check here — adding one would duplicate a rule that lives in the host.
    onSeatChanged: () => onShow(),
  });

  return { open: () => host.open('term') };
}

module.exports = { createTermTab };
