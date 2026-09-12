'use strict';

function createTeamDelete({ loadManifest, deleteTeam, getManager, getSandboxManager }) {
  function deleteCheck(name) {
    let team;
    try {
      team = loadManifest(name);
    } catch (err) {
      return { ok: true, loaded: false, error: err.message };
    }
    const used = getManager()._teamInUse(team);
    const sandboxed = team.sandboxed === true;
    return {
      ok: true,
      loaded: true,
      seats: used.seats,
      tickets: used.tickets,
      saved: used.saved,
      root: team.root,
      sandboxed,
      ...(sandboxed ? { boxId: `team-${name}` } : {}),
    };
  }

  async function deleteGated(name) {
    const check = deleteCheck(name);
    if (check.loaded && (check.seats.length || check.tickets.length)) {
      return {
        ok: false,
        error: `team "${name}" is in use`,
        blockedBy: { seats: check.seats, tickets: check.tickets },
      };
    }
    let box;
    if (check.sandboxed) {
      const mgr = getSandboxManager ? getSandboxManager() : null;
      if (!mgr) {
        return {
          ok: false,
          error: `sandboxes are disabled on this host, so box ${check.boxId} cannot be removed; delete nothing`,
        };
      }
      let r;
      try {
        r = await mgr.remove(check.boxId);
      } catch (err) {
        return { ok: false, error: err.message };
      }
      if (r && r.ok === false && !/^no such sandbox: /.test(r.error || '')) {
        return { ok: false, error: r.error };
      }
      box = { id: check.boxId, removed: true, downError: r && r.downError };
    }
    try {
      deleteTeam(name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (check.root) getManager()._forgetTeam(name, check.root);
    return box ? { ok: true, box } : { ok: true };
  }

  return { deleteCheck, deleteGated };
}

module.exports = { createTeamDelete };
