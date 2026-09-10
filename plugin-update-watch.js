'use strict';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_RUN = 8;
const DEFAULT_FIRST_RUN_DELAY_MS = 90 * 1000;

function createPluginUpdateWatch(deps) {
  const {
    getLoader,
    log,
    intervalMs = DEFAULT_INTERVAL_MS,
    maxPerRun = DEFAULT_MAX_PER_RUN,
    firstRunDelayMs = DEFAULT_FIRST_RUN_DELAY_MS,
    onChange,
  } = deps || {};

  let cached = [];
  let inflight = null;
  let timer = null;
  let firstTimer = null;
  let cursor = 0;
  let lastNote = null;

  function note(what) {
    const msg = String(what == null ? 'unknown error' : what);
    if (msg === lastNote) return;
    lastNote = msg;
    try { if (log && log.info) log.info('plugin', `update check: ${msg}`); } catch {}
  }

  function publish(next) {
    const key = (list) => list.map((e) => `${e.id}@${e.from}@${e.to}@${e.version}`).join(',');
    const changed = key(next) !== key(cached);
    cached = next;
    if (!changed) return;
    try { if (typeof onChange === 'function') onChange(cached.slice()); } catch {}
  }

  function drop(id) {
    const want = String(id == null ? '' : id);
    publish(cached.filter((e) => e.id !== want));
  }

  function slice(candidates) {
    if (candidates.length <= maxPerRun) { cursor = 0; return candidates.slice(); }
    const start = cursor % candidates.length;
    const out = [];
    for (let i = 0; i < maxPerRun; i++) out.push(candidates[(start + i) % candidates.length]);
    cursor = (start + maxPerRun) % candidates.length;
    return out;
  }

  async function runOnce() {
    const loader = getLoader && getLoader();
    if (!loader || typeof loader.libraryCatalog !== 'function'
      || typeof loader.resolveUpdate !== 'function') return cached.slice();

    let cat = null;
    try { cat = await loader.libraryCatalog(); } catch (e) { cat = { ok: false, error: (e && e.message) || e }; }
    if (!cat || !cat.ok) {
      note(`library catalog unavailable — ${(cat && cat.error) || 'no answer'}`);
      return cached.slice();
    }

    const candidates = (cat.plugins || [])
      .filter((p) => p && p.installed === 'fetched' && p.upToDate === false)
      .map((p) => p.id);
    const prior = new Map(cached.map((e) => [e.id, e]));
    const verdicts = new Map();
    let failed = false;

    for (const id of slice(candidates)) {
      let r = null;
      try { r = await loader.resolveUpdate(id); } catch (e) { r = { ok: false, error: (e && e.message) || e }; }
      if (!r || !r.ok) {
        failed = true;
        note(`could not resolve ${id} — ${(r && r.error) || 'no answer'}`);
        continue;
      }
      verdicts.set(id, r.changed ? {
        id,
        from: r.previousCommit == null ? null : r.previousCommit,
        to: r.commit == null ? null : r.commit,
        version: (r.manifest && r.manifest.version) || null,
      } : null);
    }
    if (!failed) lastNote = null;

    const next = [];
    for (const id of candidates) {
      if (verdicts.has(id)) {
        const v = verdicts.get(id);
        if (v) next.push(v);
      } else if (prior.has(id)) {
        next.push(prior.get(id));
      }
    }
    publish(next);
    return cached.slice();
  }

  function run() {
    if (inflight) return inflight;
    inflight = runOnce().finally(() => { inflight = null; });
    return inflight;
  }

  function start() {
    if (timer || firstTimer) return;
    firstTimer = setTimeout(() => {
      firstTimer = null;
      timer = setInterval(() => { run().catch(() => {}); }, intervalMs);
      if (timer.unref) timer.unref();
      run().catch(() => {});
    }, firstRunDelayMs);
    if (firstTimer.unref) firstTimer.unref();
  }

  function stop() {
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { run, start, stop, drop, list: () => cached.slice() };
}

module.exports = {
  createPluginUpdateWatch, DEFAULT_INTERVAL_MS, DEFAULT_MAX_PER_RUN, DEFAULT_FIRST_RUN_DELAY_MS,
};
