// session-restore.js — the restore-on-launch core, lifted verbatim from the
// `app:restore-sessions` IPC handler (Phase 2 of the engine extraction). Plain
// Node, zero electron: the handler used to close over main.js module globals, so
// it could never be unit-tested (a test can't require main.js under Electron's
// ABI). This leaf takes those collaborators as an injected deps object instead,
// so both the Electron adapter (a thin main.js closure passes the globals) and a
// future headless engine share ONE restore path, and the failure semantics are
// finally test-pinned.
//
// Body is move-only from ipc-handlers.js: same iteration, same manager.create
// arg order, same return-entry shapes, and — load-bearing — the SAME failure
// contract: a session that throws during restore is NOT removed from persistence;
// it comes back as a `{ failed: true }` entry so the renderer's retry/forget UI
// can offer it. Silently wiping it was the pre-v0.5.3 "upgrade kills my agents"
// bug (see CLAUDE.md gotcha).
//
// `readCtxFor` is injected (not inlined) because it moved to main.js alongside
// this extraction — it was a single-consumer local const in ipc-handlers, and the
// closure that now calls this leaf owns it. See its main.js header for the why.

'use strict';

async function restoreSessionsForWorkspace({
  workspaceId, persistence, manager, proxyPoller,
  maybeCompactBeforeResume, readCtxFor, log,
}) {
  const saved = persistence.listForWorkspace(workspaceId);
  const restored = [];
  for (const entry of saved) {
    // Archived sessions keep their record but are NOT re-spawned. Surface them
    // as archived rows so the sidebar's status filter (active/archived/all) has
    // something to show and the operator can resume them on demand.
    if (entry.archivedAt && !manager.sessions.has(entry.name)) {
      restored.push({
        name: entry.name,
        type: entry.type,
        cwd: entry.cwd,
        label: entry.label || null,
        backend: entry.backend || null,
        archived: true,
        archivedAt: entry.archivedAt,
        createdAt: entry.createdAt || null,
      });
      continue;
    }
    if (manager.sessions.has(entry.name)) {
      // Already running — report it and flush any buffered output so the
      // new terminal shows everything that happened while detached
      const session = manager.sessions.get(entry.name);
      const replay = session.pendingOutput || null;
      session.pendingOutput = '';
      restored.push({
        name: entry.name,
        type: entry.type,
        cwd: entry.cwd,
        label: entry.label || null,
        backend: session.backend || null,
        replay,
        // Seed the sidebar dot with the CURRENT state — activity events
        // while detached were dropped, so without this a busy or blocked
        // session reattaches showing idle grey until its next transition.
        activity: session.activityState || 'idle',
        attention: session.needsAttention || null,
        pendingCount: manager.pendingCountFor(entry.name),
        createdAt: entry.createdAt || null,
        ...readCtxFor(entry.name),
        proxy: proxyPoller.snapshot(entry.name),
      });
      continue;
    }
    try {
      // Resume-time bake (opt-in, fail-safe): slim the transcript before
      // --resume so the replayed prefix is small + permanently slimmer. Safe
      // regardless of cache warmth — the bake is byte-identical to the live
      // wire (bake ⊆ live-strip), so it can't bust a warm prefix. No-op unless
      // the compactOnResume setting + a live wirescope are both present.
      await maybeCompactBeforeResume(entry);
      await manager.create(
        entry.name,
        entry.type,
        entry.cwd,
        entry.extraArgs || [],
        entry.sessionId,
        workspaceId,
        entry.systemPrompt || null,
        false,
        entry.proxy ?? null,
        entry.agents || [],
        entry.denyBuiltins || [],
        entry.disabledTools || [],
        entry.disabledSkills || [],
        entry.injectSkills || [],
        entry.systemPromptFile || null,
        entry.appendPromptFiles || [],
        Array.isArray(entry.execCommands) ? entry.execCommands : [],
        Array.isArray(entry.intents) ? entry.intents : null,
      );
      restored.push({
        name: entry.name,
        type: entry.type,
        cwd: entry.cwd,
        label: entry.label || null,
        backend: (manager.sessions.get(entry.name) || {}).backend || null,
        createdAt: entry.createdAt || null,
        ...readCtxFor(entry.name),
        proxy: proxyPoller.snapshot(entry.name),
      });
    } catch (err) {
      // DO NOT remove from persistence — surface the failure to the UI
      // so the user can retry or delete. Silently wiping was the cause
      // of the "agents vanish after upgrade" bug.
      console.error(`Failed to restore session ${entry.name}:`, err.message);
      log.error('session', `restore failed ${entry.name}: ${err.message}`);
      restored.push({
        name: entry.name,
        type: entry.type,
        cwd: entry.cwd,
        label: entry.label || null,
        failed: true,
        error: err.message,
      });
    }
  }
  return restored;
}

module.exports = { restoreSessionsForWorkspace };
