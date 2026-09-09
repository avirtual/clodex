'use strict';
// team-delete.js — the in-use check and the gated delete behind Delete Team….
//
// A leaf on the ENGINE rather than a pair built in main.js, because both callers
// must run the same body: the Teams menu reaches it through getTeams() (the main
// process has no IPC to itself) and the renderer reaches it through
// `team:delete`, which web-host serves from the same registration. Built in
// main.js it would be absent from the web host's deps and that channel would
// throw there while working on the desktop.

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
