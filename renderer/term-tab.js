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
const { termBackendFor } = require('../drawer-avail');

// getSeatShellCap: does the ACTIVE seat's peer box advertise the `shell` cap?
// Injected because the answer lives in renderer.js's peerStatuses map, and a
// second reader of that map here would drift the moment peer state moves.
function createTermTab({ host, xtermTheme, getActiveSession, getSeatType = null, getSeatShellCap = null }) {
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

  // 'local' | 'peer' | null for the ACTIVE seat. Recomputed at every call site
  // rather than cached per seat: a peer's grant can be withdrawn while the tab
  // is open, and a stale backend would keep typing at a door that closed.
  const shellCap = () => !!(getSeatShellCap && getSeatShellCap());
  const backendNow = () => termBackendFor({
    type: getSeatType ? getSeatType() : null,
    peerHasShell: shellCap(),
  });
  // Which backend the CURRENT pane contents came from — 'local', 'peer', or
  // null. The three senders below read this rather than backendNow() so a pane
  // showing one box's shell cannot type into another's.
  //
  // Reading the field is not by itself the safety property, and treating it as
  // one is how the keystroke path shipped broken: null is a THIRD answer, and
  // an `else` that means "local" turns a withdrawn grant into a send down the
  // local path — the exact case the field was supposed to prevent. Every sender
  // therefore tests for its own backend by name and does nothing otherwise.
  let backend = null;

  // Everything at or below the snapshot's seq is already inside the scrollback
  // that was just written, so only what came AFTER it is flushed. Without the
  // comparison the overlap is either printed twice or dropped, and which one
  // depends on IPC timing rather than on anything the operator did. The peer
  // wire carries no seq and passes null, which flushes everything held — its
  // snapshot and its live feed come from one buffer on the serving side, so an
  // overlap there would be bytes that side already knows it sent.
  function flushPending(upto) {
    const held = pending || [];
    pending = null;
    for (const h of held) {
      if (typeof h.seq === 'number' && typeof upto === 'number' && h.seq <= upto) continue;
      terminal.write(h.data);
    }
  }

  // The composite key of the PEER stream this pane currently holds open, or
  // null. Not derivable from `seat` + `backend`: those describe what the pane is
  // showing NOW, and every release runs at a moment when one of them is about
  // to change or has already changed. Recording what was actually opened is
  // also what keeps the release exact — a close for a seat we never opened is
  // not free, because the serving side's close route drops EVERY watcher of
  // that seat, including another consumer's.
  let held = null;

  // Which open the pane is waiting on. `asked === seat` distinguishes SEATS but
  // not OPENS, and onShow re-opens the same seat on every show: show, hide,
  // show(alice) leaves two opens in flight for one seat. If the second succeeds
  // and the first comes back refused, the seat test passes and the refusal
  // clears the hold the LIVE stream is recorded under — the next onHide releases
  // nothing, and the far box keeps a stream, a shell and a mark for a pane
  // nobody is looking at. The epoch is what makes a stale reply inert.
  let openGen = 0;

  // Has ANY open for the currently held seat come back ok? The epoch decides
  // which reply is current; this decides whether a current refusal is even
  // evidence that nothing is open. It is not, when an earlier open for the same
  // seat succeeded: peer-client refuses on a transient offline/no-cap
  // disagreement BEFORE reaching its `wanted` early return, so the refusal is
  // local and the main side still has `wanted` true — it re-opens on the next
  // hello, and a `held` cleared here means nothing will ever close that.
  let openedOk = false;

  // Tell the serving box we have stopped watching. Local shells never get here:
  // they have no stream, and the main side keeps them running on purpose.
  //
  // Best-effort — a close that fails costs the far side a stale stream until
  // its socket dies, which is not worth a line of red in the operator's pane.
  function releasePeer() {
    openedOk = false;
    if (!held) return;
    const which = held;
    held = null;
    try { window.api.peerWtermClose(which).catch(() => {}); } catch {}
  }

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
    //
    // Both branches name their backend and there is no `else`. A pane with no
    // backend stays MOUNTED, OPENED AND FOCUSED — onShow prints its refusal and
    // returns without unmounting anything — so this callback keeps firing after
    // a peer goes offline or its grant is withdrawn. An `else` would carry the
    // composite `name@peerId` key to wtermWrite, where `seatOf` rejects the `@`
    // and a rejected seat is null: the keystroke, including the Enter, executes
    // in the SEATLESS workspace shell. Silently — `write` never spawns, so it
    // lands only where that shell already exists, and the data handler's `from`
    // filter drops the echo.
    //
    // Discriminating positively rather than guarding `!backend` at the head:
    // this shape refuses a future third value too, where a null check would
    // wave it through into whichever branch it fell to.
    terminal.onData((d) => {
      if (backend === 'peer') window.api.peerWtermInput(seat, d);
      else if (backend === 'local') window.api.wtermWrite(seat, d);
    });

    // Output arrives for THIS window only — the main side resolves the target
    // window itself, so there is no name to filter on here.
    // The payload is the FIRST argument: preload's `on` binding strips the
    // IpcRendererEvent before invoking this (api-contract `kind: 'on'`). An
    // `(_e, data)` signature here shifts every byte into the ignored parameter
    // and renders an empty terminal that looks like a shell that never started.
    window.api.onWtermData((data, from, seq) => {
      if (!terminal) return;
      // A local shell's bytes must not land in a pane showing a PEER's, and the
      // seat key alone cannot tell them apart: a peer seat is `name@peerId` and
      // a local one is a bare name, but the main side sends `from: null` for
      // the seatless workspace shell, which matches the `undefined`-is-mine
      // rule below. So the pane's own backend is the discriminator.
      if (backend === 'peer') return;
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

    // The peer half. Four channels rather than the local one's one, because a
    // shell on ANOTHER box can end for reasons a local one cannot: the wire can
    // drop, and the grant can be revoked. Both are told to the operator here —
    // an unexplained dead pane is the failure mode this feature was designed
    // against.
    //
    // `from` is the BARE seat (the wire never carries the `@`), so it is
    // compared against the seat half of this pane's composite key.
    const mine = (from) => backend === 'peer' && seat && String(seat).split('@')[0] === from;
    window.api.onPeerWtermReplay((_id, from, snap) => {
      if (!terminal || !mine(from)) return;
      // Same held-bytes protocol as the local path: onShow parks live output in
      // `pending` while the open is in flight, so the replay writes first and
      // the held bytes follow. There is no seq on this wire, so the flush is
      // unconditional — the serving side sends the snapshot and the live feed
      // from the same buffer, so an overlap would be bytes it already sent.
      terminal.write(snap && snap.data ? snap.data : '');
      flushPending(null);
      drawn = true;
    });
    window.api.onPeerWtermData((_id, from, data) => {
      if (!terminal || !mine(from)) return;
      if (pending) { pending.push({ data, seq: null }); return; }
      terminal.write(data);
      notify();
    });
    window.api.onPeerWtermExit((_id, from, code) => {
      if (!terminal || !mine(from)) return;
      // A shell the far operator ENDED (their window or their seat closed)
      // arrives here as the string 'closed' rather than a wait status — it did
      // not exit, it was taken away, and "exited (closed)" invites the reader to
      // go looking for an exit code that never existed.
      terminal.write(typeof code === 'number'
        ? `\r\n\x1b[33mthe remote shell exited (${code})\x1b[0m\r\n`
        : `\r\n\x1b[33mthe remote terminal was closed on that box\x1b[0m\r\n`);
    });
    window.api.onPeerWtermClosed((_id, from, why) => {
      if (!terminal || !mine(from)) return;
      // The reason is composed main-side from peer-shell's vocabulary. Printed
      // rather than swallowed: a revoked grant and a dropped tunnel look
      // identical on screen otherwise, and one of them is someone's decision.
      terminal.write(`\r\n\x1b[31m${why || 'the remote terminal closed'}\x1b[0m\r\n`);
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
    // The BACKEND is re-read on the same door, before anything is sent: a seat
    // switch is the only thing that can change it, and every send below reads
    // the field rather than recomputing, so the pane cannot be showing one
    // box's shell while typing into another's.
    if (want !== seat) {
      // Release the seat being LEFT, before the fields are re-keyed. A seat
      // switch reaches here through onSeatChanged, which fires neither onShow's
      // pair member nor onHide (rule 2 is the visibility axis, not the seat
      // one), so this is the only edge that can free the old stream. Without
      // it the serving box keeps a watcher recorded for a seat nobody is
      // looking at and its heartbeat re-asserts that indefinitely.
      releasePeer();
      seat = want;
      drawn = false;
      terminal.reset();
    }
    backend = backendNow();
    const dims = fitAddon.proposeDimensions();
    const asked = seat;
    pending = [];
    // NULL is a third answer, not a synonym for local. A peer seat whose box
    // went offline or whose grant was withdrawn lands here while the tab is
    // still visible — `availableFor` only re-runs on syncSeatAvailability — and
    // falling through to the local branch would send this seat's COMPOSITE key
    // (`name@peerId`) to wtermSpawn. `seatOf` rejects the `@`, a rejected seat
    // becomes null, and null is the key of the seatless workspace shell: every
    // stranded peer row would be handed the one workspace-wide terminal and
    // share it with each other. That is the defect drawer-avail.js says is
    // root-cause-fixed, and this is the line that keeps it fixed.
    //
    // Said out loud rather than left as an empty pane: the two causes are
    // someone's decision and a broken wire, and an operator staring at a blank
    // terminal cannot tell which.
    if (!backend) {
      releasePeer();
      pending = null;
      terminal.write('\r\n\x1b[33mno terminal for this session — the peer is offline, or terminal sharing was turned off on that box\x1b[0m\r\n');
      return;
    }
    if (backend === 'peer') {
      // No scrollback in the reply and no seq on this wire: the serving side
      // sends the snapshot as a `replay` FRAME on the stream, so the paint
      // happens in the listener above and this call only opens the door.
      // Marked held BEFORE the reply, not after: onShow re-opens on every show
      // and the main side is idempotent about it, so a second open for the same
      // seat is ordinary — but a release that arrives while the first open is
      // still in flight must still close it. Recording the intent is what makes
      // that release land.
      held = seat;
      const gen = ++openGen;
      window.api.peerWtermOpen(seat)
        .then((res) => {
          if (!terminal || asked !== seat) { pending = null; return; }
          if (!res || !res.ok) {
            terminal.write(`\r\n\x1b[31m${(res && res.error) || 'failed to open the remote terminal'}\x1b[0m\r\n`);
            pending = null;
            // A refused open holds nothing, and the close route drops every
            // watcher of the seat — so releasing on a door that never opened
            // would detach a DIFFERENT consumer. The epoch, not `asked === seat`,
            // is what decides which reply may speak: only the LATEST open,
            // because a superseded reply — whether the seat changed or not — is
            // talking about a door somebody has already reopened.
            //
            // `openedOk` decides whether it has anything to say. A refusal is
            // evidence of nothing open only if nothing opened: an earlier
            // success for this seat means the main side is holding it `wanted`
            // and will re-open on the next hello, so clearing here would strand
            // a stream nothing local can ever close.
            if (gen === openGen && !openedOk) held = null;
          } else {
            openedOk = true;
          }
        })
        .catch(() => { pending = null; if (asked === seat && gen === openGen && !openedOk) held = null; });
      terminal.focus();
      return;
    }
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
        flushPending(res.seq);
      })
      .catch(() => { pending = null; });
    terminal.focus();
  }

  // The release half of rule 2's pair, and the reason a peer's box can tell
  // when nobody is watching any more. Drawer collapse, a switch to another tab
  // and a tenant losing the seat all arrive here.
  //
  // The LOCAL shell is deliberately left running: it is the operator's own, it
  // survives a collapse today, and killing it on a tab switch would lose
  // whatever is running in it. A peer stream is the opposite case — leaving it
  // open holds a watcher record on someone else's box, and that box shows a
  // mark for it.
  function onHide() {
    releasePeer();
  }

  // The authoritative measurement (rule 4). Also the only place the child is
  // told its size — the host coalesces to one call per frame, so a 200ms
  // collapse animation is one SIGWINCH at the end, not a dozen.
  function onResize() {
    if (!terminal || !opened) return;
    fitAddon.fit();
    // The same positive discrimination as the keystroke path, for the same
    // reason: an `else` means "local" and a null backend is not local. The fit
    // above still runs unconditionally — the xterm is the operator's own view.
    if (backend === 'peer') window.api.peerWtermResize(seat, terminal.cols, terminal.rows);
    else if (backend === 'local') window.api.wtermResize(seat, terminal.cols, terminal.rows);
  }

  notify = host.register({
    id: 'term',
    label: 'Terminal',
    // NO `available()` SURFACE AXIS (t227), and its absence is the load-bearing
    // part of that change rather than a tidy-up. The web host registers the
    // local `wterm:*` family now — it already serves `session:create`, and a
    // `type: 'bash'` session is the same shell on the same box. An
    // environment test here would keep the tab hidden on web no matter what the
    // host registers, which is exactly how it read before: un-gating the
    // handlers alone changed nothing an operator could see.
    // Pinned by test/drawer-services-seam.test.js, because this file is
    // DOM-bound and has no behavioural test that would notice its return.
    // The seat axis, re-evaluated on every session switch (drawer-host's
    // `availableFor`). A bash seat already IS a shell, so it never gets a tab;
    // a peer seat gets one only while that box advertises the `shell` cap.
    //
    // The host passes the seat TYPE, but the peer case needs a second fact, so
    // this reads `getSeatType`/`getSeatShellCap` directly and ignores the
    // argument. Deliberately NOT routed through termAvailableFor: that one is
    // the AGENT-facing predicate (session-manager's `[agent:term exec]`), and
    // teaching it about peer backends would make remote agent exec a one-line
    // addition. Two predicates, two questions — see drawer-avail.js.
    availableFor: () => backendNow() !== null,
    mount,
    onShow,
    onHide,
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
