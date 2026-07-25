'use strict';

/**
 * git-branches — renderer half. One activation per window (Law 1).
 *
 * All state lives in the activate() closure, never at module level: §3 is
 * explicit that a module-level variable in a renderer half is not something to
 * reason about across windows.
 *
 * The shape here is forced by two facts stated in the docs:
 *
 *  - `rowBadge.resolve` is synchronous and runs inside the sidebar's render
 *    loop (§6.4), so it can only ever return what is already in this window's
 *    cache. Anything it does not have, it asks the engine for and returns null
 *    for now, then asks for another render pass via `requestRelayout()`.
 *  - There is no renderer-side event subscription (§9, §14). The engine cannot
 *    tell this window that a branch changed, so liveness is a poll. The docs
 *    name polling as the sanctioned pattern for exactly this.
 *
 * The poll is deliberately not forced: the engine's TTL decides when a `git`
 * process is actually spawned, so two windows polling out of phase still cost
 * one git run per period rather than two.
 */

module.exports.activate = (rhost) => {
  // --- per-window state ----------------------------------------------------

  /** session name -> entry from the engine */
  const cache = new Map();
  /** session name -> last time the sidebar asked us to resolve it */
  const seen = new Map();
  /** names awaiting their first fetch */
  const pending = new Set();

  let settings = { refreshSeconds: 10, maxLength: 18 };
  let flushTimer = null;
  let pollTimer = null;
  let relayoutTimer = null;
  let torn = false;
  /** set once the host tells us the plugin is no longer routable (§8) */
  let unroutable = false;

  const FLUSH_DEBOUNCE_MS = 60;
  const RELAYOUT_DEBOUNCE_MS = 120;
  /** drop a session from the poll set if the sidebar has not asked about it
   *  in this long — it is no longer on screen in this window */
  const FORGET_AFTER_MS = 5 * 60 * 1000;

  const alive = () => !torn && !unroutable;

  // --- helpers -------------------------------------------------------------

  function truncate(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    // Keep the tail: branch names are commonly prefixed (`feature/`, `bugfix/`)
    // and the distinguishing part is at the end.
    return '…' + s.slice(-(max - 1));
  }

  /**
   * §6.4 specifies `{ text, tip?, cls? }` or null. `cls` is a single class
   * token — the docs do not say whether a space-separated list is accepted, so
   * we never send one. See NOTES.md ▸ Assumed #1.
   */
  function badgeFor(entry) {
    if (!entry) return null;
    const max = settings.maxLength;

    switch (entry.state) {
      case 'ok':
        return {
          text: truncate(entry.branch, max),
          tip: `Git branch: ${entry.branch}`,
          cls: 'gb-branch',
        };
      case 'unborn':
        return {
          text: truncate(entry.branch, max),
          tip: `Git branch: ${entry.branch} — no commits yet`,
          cls: 'gb-unborn',
        };
      case 'detached':
        return {
          text: entry.sha ? truncate(entry.sha, max) : 'detached',
          tip: entry.sha ? `Detached HEAD at ${entry.sha}` : 'Detached HEAD',
          cls: 'gb-detached',
        };
      // Everything else is "this row has no branch to show": not a repo, a
      // remote session, no working directory, git missing, or an error. A
      // sidebar row is the wrong place to report any of those — the
      // [agent:branch] intent gives the full reason on request.
      default:
        return null;
    }
  }

  function queueRelayout() {
    if (!alive() || relayoutTimer !== null) return;
    relayoutTimer = rhost.setTimeout(() => {
      relayoutTimer = null;
      if (!alive()) return;
      try {
        rhost.ui.sidebar.requestRelayout();
      } catch (e) {
        rhost.log.error('requestRelayout failed', e);
      }
    }, RELAYOUT_DEBOUNCE_MS);
  }

  /** True if anything the sidebar would render actually differs. */
  function applyResults(results) {
    let changed = false;
    for (const name of Object.keys(results || {})) {
      const next = results[name];
      if (next && next.state === 'gone') {
        // The engine asked fsScope and was told there is no such session.
        if (cache.delete(name)) changed = true;
        seen.delete(name);
        continue;
      }
      const prev = cache.get(name);
      cache.set(name, next);
      if (!sameBadge(prev, next)) changed = true;
    }
    return changed;
  }

  function sameBadge(a, b) {
    const x = badgeFor(a);
    const y = badgeFor(b);
    if (!x && !y) return true;
    if (!x || !y) return false;
    return x.text === y.text && x.tip === y.tip && x.cls === y.cls;
  }

  function applySettings(next) {
    if (!next || typeof next !== 'object') return;
    const prevRefresh = settings.refreshSeconds;
    const prevMax = settings.maxLength;
    settings = {
      refreshSeconds: Number(next.refreshSeconds) || prevRefresh,
      maxLength: Number(next.maxLength) || prevMax,
    };
    if (settings.refreshSeconds !== prevRefresh) startPolling();
    if (settings.maxLength !== prevMax) queueRelayout();
  }

  /**
   * §8: `{ ok:false, error:'no such plugin method' }` is the exact, documented
   * discriminator for "could not be routed at all" — plugin disabled, not
   * loaded, or plugins switched off. That is not a transient error, so we stop
   * asking rather than poll a dead channel forever.
   */
  function checkRoutable(res) {
    if (res && res.ok === false && res.error === 'no such plugin method') {
      unroutable = true;
      stopTimers();
      rhost.log.info('engine half is not routable; stopping badge updates');
      return false;
    }
    return true;
  }

  async function fetchNames(names, opts) {
    if (!alive() || !names.length) return;
    let res;
    try {
      res = await rhost.invoke('branch.getMany', names, opts || {});
    } catch (e) {
      rhost.log.error('branch.getMany failed', e);
      return;
    }
    if (!alive()) return; // torn down while in flight
    if (!checkRoutable(res)) return;
    if (!res || res.ok !== true) return;

    applySettings(res.settings);
    if (applyResults(res.results)) queueRelayout();
  }

  // --- first-sight fetches, debounced into one call ------------------------

  function request(name) {
    if (!alive() || pending.has(name)) return;
    pending.add(name);
    if (flushTimer !== null) return;
    flushTimer = rhost.setTimeout(() => {
      flushTimer = null;
      if (!alive()) return;
      const names = Array.from(pending);
      pending.clear();
      fetchNames(names);
    }, FLUSH_DEBOUNCE_MS);
  }

  // --- polling -------------------------------------------------------------

  function activeNames() {
    const cutoff = Date.now() - FORGET_AFTER_MS;
    const names = [];
    for (const [name, lastSeen] of seen) {
      if (lastSeen < cutoff) {
        seen.delete(name);
        cache.delete(name);
        continue;
      }
      names.push(name);
    }
    return names;
  }

  function poll() {
    if (!alive()) return;
    // A hidden window's sidebar is not being looked at; skip the work and pick
    // it up on the next tick. `document` is real in a renderer half (§5).
    if (typeof document !== 'undefined' && document.hidden) return;
    fetchNames(activeNames());
  }

  function startPolling() {
    if (pollTimer !== null) {
      rhost.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (!alive()) return;
    pollTimer = rhost.setInterval(poll, Math.max(3, settings.refreshSeconds) * 1000);
  }

  function stopTimers() {
    if (flushTimer !== null) {
      rhost.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (relayoutTimer !== null) {
      rhost.clearTimeout(relayoutTimer);
      relayoutTimer = null;
    }
    if (pollTimer !== null) {
      rhost.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // --- slot: the row badge -------------------------------------------------

  // Registration throws on a bad spec (§6) and a throwing activate() is a
  // strike toward quarantine (§10), so nothing above this line may throw.
  rhost.ui.sidebar.rowBadge({
    id: 'branch',
    resolve(sessionName, meta) {
      // Callbacks that throw during a render pass are caught by the host and
      // that contribution is skipped (§6) — but a badge that silently vanishes
      // is a bad failure mode, so we never let it happen.
      try {
        if (typeof sessionName !== 'string' || !sessionName) return null;
        // A remote session lives on a peer machine; fsScope would refuse it
        // with 'remote' (§4). Skipping it here saves the round trip.
        if (meta && meta.type === 'remote') return null;

        seen.set(sessionName, Date.now());

        const entry = cache.get(sessionName);
        if (entry === undefined) {
          request(sessionName);
          return null;
        }
        return badgeFor(entry);
      } catch (e) {
        try {
          rhost.log.error('rowBadge.resolve failed', e);
        } catch (_) {
          /* ignore */
        }
        return null;
      }
    },
  });

  // --- slot: preferences ---------------------------------------------------

  const FIELDS = [
    {
      key: 'refreshSeconds',
      label: 'Refresh interval (seconds)',
      min: 3,
      max: 600,
      def: 10,
      hint: 'How often each window re-checks branches. The engine will not run git more often than this.',
    },
    {
      key: 'maxLength',
      label: 'Maximum badge length (characters)',
      min: 4,
      max: 60,
      def: 18,
      hint: 'Longer branch names are truncated from the left.',
    },
  ];

  rhost.ui.settings.section({
    id: 'prefs',
    title: 'Git Branches',
    render(bodyEl, values) {
      const v = values || {};
      bodyEl.innerHTML = '';
      for (const f of FIELDS) {
        const row = document.createElement('div');
        row.className = 'gb-settings-row';

        const label = document.createElement('label');
        label.className = 'gb-settings-label';
        label.textContent = f.label; // text, never HTML

        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = '1';
        input.className = 'gb-settings-input';
        input.setAttribute('data-gb-key', f.key);
        input.value = String(Number(v[f.key]) || f.def);

        const hint = document.createElement('div');
        hint.className = 'gb-settings-hint';
        hint.textContent = f.hint;

        label.appendChild(input);
        row.appendChild(label);
        row.appendChild(hint);
        bodyEl.appendChild(row);
      }
    },
    collect(bodyEl) {
      // §6.6 does not say the host coerces anything, and an <input> value is
      // always a string, so we clamp and coerce here rather than persist "10".
      const patch = {};
      for (const f of FIELDS) {
        const el = bodyEl.querySelector(`[data-gb-key="${f.key}"]`);
        const n = el ? parseInt(el.value, 10) : NaN;
        patch[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def;
      }
      applySettings(patch);
      return patch;
    },
  });

  // --- go ------------------------------------------------------------------

  // Pull on activation (Law 2). This window may be opening into a world where
  // sessions have been running for hours, so nothing is assumed to be fresh.
  rhost
    .invoke('settings.get')
    .then((res) => {
      if (!alive()) return;
      if (!checkRoutable(res)) return;
      if (res && res.ok) applySettings(res.values);
    })
    .catch((e) => rhost.log.error('settings.get failed', e))
    .then(() => {
      if (alive()) startPolling();
    });

  // Start polling immediately at the default rate too, in case the settings
  // call is slow; startPolling() replaces the timer rather than adding one.
  startPolling();

  // Ask for one relayout on activation — the poll CANNOT bootstrap itself.
  // `activeNames()` reads `seen`, and `seen` is written only by resolve(), which
  // only core's render loop calls; a freshly activated closure therefore polls an
  // empty name list forever. The host does not close this for us: it un-paints
  // eagerly at dispose (plugin-host.js:649) but has no counterpart at activate,
  // and registering a rowBadge paints nothing (:243), unlike footerButton (:236).
  // Without this line a re-enable is invisible until something unrelated triggers
  // a sidebar relayout — core's 30s meta refresh, or the user typing. That is the
  // t17 defect Bogdan hit with two windows open.
  queueRelayout();

  // --- teardown ------------------------------------------------------------

  // Returned from activate(), so it runs first, while our DOM still exists
  // (§5). Disable-with-windows-open (Law 4) is the case this is for.
  return () => {
    torn = true;
    stopTimers();
    cache.clear();
    seen.clear();
    pending.clear();
    // The row badge, the settings section and our <style> element are removed
    // by the host regardless of what we do here (§5), so we do not call their
    // disposers: §6 does not state that a slot disposer is safe to call twice,
    // and there is nothing to gain by finding out.
  };
};
