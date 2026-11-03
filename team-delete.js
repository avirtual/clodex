'use strict';

const path = require('path');

const { NAME_RE: TEAM_NAME_RE } = require('./team-manifest');

function createTeamDelete({ loadManifest, deleteTeam, getManager, getSandboxManager, teamsDir, fs = require('fs') }) {
  if (typeof teamsDir !== 'string' || !teamsDir) throw new Error('createTeamDelete: teamsDir is required');
  function pointerBoxId(name) {
    if (typeof name !== 'string' || !TEAM_NAME_RE.test(name)) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(teamsDir, name, 'sandbox.json'), 'utf8'));
      return rec && typeof rec.boxId === 'string' && rec.boxId ? rec.boxId : null;
    } catch {
      return null;
    }
  }

  function raisedBox(name) {
    const fromPointer = pointerBoxId(name);
    if (fromPointer === `team-${name}`) return fromPointer;
    const mgr = getSandboxManager ? getSandboxManager() : null;
    if (!mgr || typeof mgr.get !== 'function') return null;
    try {
      return mgr.get(`team-${name}`) ? `team-${name}` : null;
    } catch {
      return null;
    }
  }

  function deleteCheck(name) {
    let team;
    try {
      team = loadManifest(name);
    } catch (err) {
      const boxId = pointerBoxId(name);
      return { ok: true, loaded: false, error: err.message, ...(boxId ? { sandboxed: true, boxId } : {}) };
    }
    const used = getManager()._teamInUse(team);
    const raisedBoxId = team.sandboxed === true ? null : raisedBox(name);
    const sandboxed = team.sandboxed === true || !!raisedBoxId;
    return {
      ok: true,
      loaded: true,
      seats: used.seats,
      tickets: used.tickets,
      saved: used.saved,
      root: team.root,
      sandboxed,
      ...(sandboxed ? { boxId: raisedBoxId || `team-${name}` } : {}),
      ...(raisedBoxId ? { raised: true } : {}),
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
    getManager()._forgetTeam(name, check.root || null);
    return box ? { ok: true, box } : { ok: true };
  }

  return { deleteCheck, deleteGated };
}

module.exports = { createTeamDelete };
