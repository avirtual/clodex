// ctl-tab.js — the drawer's `ctl` tenant: a clodexctl REPL against one warm
// context, held in the MAIN process (ctl-service.js). The renderer sends a
// command string and receives a rendered block; it never sees a token, a
// contexts file, or a transport, and it must not grow a client of its own.
//
// BLOCKS ARE DATA. `blocks` is the model — a capped array of
// { command, output, exitCode, ctx, ts } — and the DOM is a view rebuilt from
// it. Flattening this to an appended text blob is the one shape to avoid: a
// block is the selection and provenance unit the agent-facing peek contract is
// designed against, and a blob cannot say which bytes came from which command.
//
// The v1 verb allowlist is NOT here. It is enforced in ctl-service.js, because
// a renderer-side list is an affordance the client chooses to honour — this
// pane offers no way to type a deferred verb, and that is a convenience, not a
// boundary.
//
// DOM-bound, so no unit tests per the R1 rule; the service it drives is where
// the testable logic lives.

const { esc } = require('./lib/format');

// The scrollback cap, in blocks rather than lines: the unit the operator
// reasons about is a command, so dropping half of one to satisfy a line budget
// would leave output with no command above it.
const MAX_BLOCKS = 200;
// Command history for ↑/↓, independent of the block cap (a pruned block's
// command is still worth recalling).
const MAX_HISTORY = 100;

function createCtlTab({ host }) {
  const blocks = [];            // the model; DOM below is a view of exactly this
  const history = [];           // typed commands, newest last
  let histIdx = -1;             // -1 = editing a fresh line, else index into history
  let draft = '';               // the in-progress line parked when ↑ starts browsing

  let bodyEl = null;
  let inputEl = null;
  let promptEl = null;
  let emptyEl = null;
  let ctxName = null;
  let running = false;
  let notify = () => {};

  function renderPrompt() {
    if (!promptEl) return;
    promptEl.textContent = ctxName ? `${ctxName} ❯` : '(no context) ❯';
    promptEl.classList.toggle('none', !ctxName);
  }

  // One block → one node. Appended rather than re-rendering the whole list: the
  // pane holds up to MAX_BLOCKS and a full rebuild per command would drop the
  // operator's text selection mid-read.
  function blockNode(b) {
    const el = document.createElement('div');
    el.className = 'ctl-block' + (b.exitCode ? ' failed' : '');
    const time = new Date(b.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const head = `<div class="ctl-block-head">`
      + `<span class="ctl-block-ctx">${esc(b.ctx || '(no context)')}</span>`
      + `<span class="ctl-block-cmd">${esc(b.command)}</span>`
      + `<span class="ctl-block-time">${time}</span>`
      + (b.exitCode ? `<span class="ctl-block-exit">exit ${b.exitCode}</span>` : '')
      + `</div>`;
    // Trailing newline trimmed for display only — the model keeps the bytes the
    // verb actually wrote.
    const out = String(b.output || '').replace(/\n+$/, '');
    el.innerHTML = head + (out ? `<pre class="ctl-block-out">${esc(out)}</pre>` : '');
    return el;
  }

  function pushBlock(b) {
    blocks.push(b);
    if (emptyEl && emptyEl.parentNode === bodyEl) emptyEl.remove();
    bodyEl.appendChild(blockNode(b));
    while (blocks.length > MAX_BLOCKS) {
      blocks.shift();
      if (bodyEl.firstElementChild) bodyEl.firstElementChild.remove();
    }
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  async function submit() {
    const line = inputEl.value;
    if (!line.trim() || running) return;
    inputEl.value = '';
    histIdx = -1;
    draft = '';
    if (history[history.length - 1] !== line) history.push(line);
    while (history.length > MAX_HISTORY) history.shift();

    running = true;
    inputEl.disabled = true;
    // The allowlist admits verbs that WAIT — `run` waits up to 300s for an
    // agent's turn to end, `exec` up to 30 for a quiet gate. A disabled input
    // and an empty pane is indistinguishable from a wedged tab over that span,
    // so the prompt line counts. There is no cancel: the service serializes
    // commands on one chain and the CLI's event streams take no abort signal,
    // so the verb's own --timeout is the only ceiling. Say so at 10s rather
    // than let the operator discover it by waiting.
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - startedAt) / 1000);
      promptEl.textContent = s >= 10
        ? `running ${s}s — no cancel; --timeout is the ceiling ❯`
        : `running ${s}s ❯`;
    }, 1000);
    try {
      const block = await window.api.ctlRun(line);
      pushBlock(block);
      // `ctx use` is the stateful payoff — the prompt follows it without a
      // round trip, since the service reports the resolved name per block.
      if (block && block.ctx !== undefined) { ctxName = block.ctx; renderPrompt(); }
      // Badge only a FAILING command: a REPL the operator drove themselves is
      // not news when it worked, and a badge on every success would make the
      // count meaningless for the one case worth surfacing.
      if (block && block.exitCode) notify('attention');
    } catch (e) {
      // An IPC-level failure (no handler on this surface, main threw) still
      // becomes a block — the pane's whole vocabulary is blocks, and a silent
      // no-op after Enter reads as a hang.
      pushBlock({ command: line, output: `clodexctl: ${e && e.message ? e.message : String(e)}\n`, exitCode: 1, ctx: ctxName, ts: Date.now() });
      notify('attention');
    } finally {
      clearInterval(tick);
      running = false;
      inputEl.disabled = false;
      // Unconditional: the catch above may have left the prompt showing an
      // elapsed count for a command that already failed.
      renderPrompt();
      inputEl.focus();
    }
  }

  function browseHistory(dir) {
    if (!history.length) return;
    if (histIdx === -1) {
      if (dir > 0) return;               // ↓ on a fresh line: nothing newer
      draft = inputEl.value;
      histIdx = history.length - 1;
    } else {
      histIdx += dir;
      if (histIdx >= history.length) { histIdx = -1; inputEl.value = draft; return; }
      if (histIdx < 0) histIdx = 0;
    }
    inputEl.value = history[histIdx];
    // Caret to the end, after the value lands.
    requestAnimationFrame(() => { inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length; });
  }

  function clear() {
    blocks.length = 0;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(emptyEl);
  }

  // Host rule 5, scoped to the block list rather than the pane: the input row is
  // inside the pane too, and its text is what the operator is still typing.
  const selectionInPane = () => host.domSelection(bodyEl);

  // The cheat sheet. Anchored to its button and rendered from ctl:help, which
  // DERIVES the list from the service's allowlist — deliberately not a literal
  // here: a hand-kept copy would go on advertising a verb the service had
  // dropped, and this pane's whole job is to say what actually runs.
  //
  // Inside the drawer rather than document.body: the drawer is the tallest
  // thing on screen in tall mode, and a body-level popover would need its own
  // z-index race against it.
  function renderHelp(el, data) {
    if (!data || !data.verbs || !data.verbs.length) {
      el.innerHTML = '<div class="ctl-help-note">Help is unavailable on this surface.</div>';
      return;
    }
    const rows = data.verbs.map((v) => {
      // A family the service spells as a subcommand list shows the subs that
      // RUN, not the registry's usage line — so a narrowed family advertises
      // only what survived rather than the whole `<get|set>`.
      const usage = v.subs ? `${v.verb} ${v.subs.join('|')} …` : (v.usage || v.verb);
      return `<div class="ctl-help-row">`
        + `<code class="ctl-help-usage">${esc(usage)}</code>`
        + `<span class="ctl-help-sum">${esc(v.summary || '')}</span>`
        + `</div>`;
    }).join('');
    // The refusal list comes from the service (`deferred`), not a literal here,
    // for the same reason the verb rows do — it is the other half of the same
    // table and would drift the same way.
    el.innerHTML = `<div class="ctl-help-sec">These verbs run here</div>${rows}`
      + `<div class="ctl-help-note">${esc(data.deferred || '')}<br>`
      + `A block resolves once, so anything that streams or asks a question belongs in the Terminal tab.<br>`
      + `Type <code>help</code> for the full CLI index, or <code>&lt;verb&gt; --help</code> for one verb `
      + `(including the ones that will not run here).</div>`;
  }

  function wireHelpButton(pane, actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'ctl-help-btn';
    btn.title = 'What can I type here?';
    btn.textContent = '?';
    const pop = document.createElement('div');
    pop.id = 'ctl-help-pop';
    pop.className = 'hidden';
    pane.appendChild(pop);

    let loaded = false;
    const close = () => pop.classList.add('hidden');

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!pop.classList.contains('hidden')) { close(); return; }
      pop.classList.remove('hidden');
      if (!loaded) {
        pop.innerHTML = '<div class="ctl-help-note">Loading…</div>';
        try {
          const data = await window.api.ctlHelp();
          renderHelp(pop, data);
          // Cached: the allowlist cannot change while the app runs, so a second
          // open is not worth a round trip.
          loaded = true;
        } catch (err) {
          renderHelp(pop, null);
        }
      }
    });

    // Dismissal, scoped to the pane: a document-level listener would fire for
    // clicks in other windows' panes and for the drawer's own header buttons.
    pane.addEventListener('mousedown', (ev) => {
      if (pop.classList.contains('hidden')) return;
      if (pop.contains(ev.target) || ev.target === btn) return;
      close();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !pop.classList.contains('hidden')) { close(); inputEl.focus(); }
    });

    actions.appendChild(btn);
  }

  function mount(pane, actions) {
    pane.innerHTML = `
      <div id="ctl-body">
        <div id="ctl-empty">clodexctl against your current context. Press <code>?</code> for what runs here, or type <code>help</code> for the full index.</div>
      </div>
      <div id="ctl-input-row">
        <span id="ctl-prompt">(no context) ❯</span>
        <input id="ctl-input" type="text" spellcheck="false" autocomplete="off" placeholder="sessions" />
      </div>`;
    bodyEl = pane.querySelector('#ctl-body');
    emptyEl = pane.querySelector('#ctl-empty');
    inputEl = pane.querySelector('#ctl-input');
    promptEl = pane.querySelector('#ctl-prompt');
    renderPrompt();

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); browseHistory(-1); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); browseHistory(1); return; }
    });
    // The row is a click target for the input, not just decoration — a click on
    // the prompt glyph should land the caret rather than do nothing.
    pane.querySelector('#ctl-input-row').addEventListener('click', () => inputEl.focus());

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'ctl-clear';
    clearBtn.title = 'Clear blocks';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clear(); });
    // No Copy button here: the drawer header owns one for every tenant, fed by
    // the `selection` hook below (host rule 5). A per-tenant copy would be a
    // second implementation of the same gesture.
    wireHelpButton(pane, actions);
    actions.appendChild(clearBtn);
  }

  // Host contract (drawer-host rule 4): DOM in mount, acquire in onShow. The
  // context name is read here rather than in mount because mount runs at boot
  // for a pane nobody has opened — an IPC round trip per launch for a tab that
  // may never be shown.
  function onShow() {
    window.api.ctlContext().then((name) => { ctxName = name; renderPrompt(); }).catch(() => {});
    inputEl.focus();
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  notify = host.register({
    id: 'ctl',
    label: 'clodexctl',
    // A UI nicety only: on the web surface the `ctl:*` handlers are ABSENT from
    // the host's map (engine's enableDrawerServices gate), so the tab would be
    // inert rather than dangerous. The boundary is registration, not this.
    available: () => !window.__CLODEX_WEB__,
    mount,
    onShow,
    selection: selectionInPane,
  });

  return { open: () => host.open('ctl') };
}

module.exports = { createCtlTab, MAX_BLOCKS };
