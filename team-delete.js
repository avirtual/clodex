'use strict';

function createTeamDelete({ loadManifest, deleteTeam, getManager }) {
  function deleteCheck(name) {
    let team;
    try {
      team = loadManifest(name);
    } catch (err) {
      return { ok: true, loaded: false, error: err.message };
    }
    const used = getManager()._teamInUse(team);
    return {
      ok: true,
      loaded: true,
      seats: used.seats,
      tickets: used.tickets,
      saved: used.saved,
      root: team.root,
    };
  }

  function deleteGated(name) {
    const check = deleteCheck(name);
    if (check.loaded && (check.seats.length || check.tickets.length)) {
      return {
        ok: false,
        error: `team "${name}" is in use`,
        blockedBy: { seats: check.seats, tickets: check.tickets },
      };
    }
    try {
      deleteTeam(name);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (check.root) getManager()._forgetTeam(name, check.root);
    return { ok: true };
  }

  return { deleteCheck, deleteGated };
}

module.exports = { createTeamDelete };
