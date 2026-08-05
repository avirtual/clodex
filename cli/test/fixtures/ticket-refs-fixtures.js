// ticket-refs fixtures — the registry-cluster ticket text, verbatim.
//
// WHY THE TEXT IS COPIED IN HERE. The live tickets live in
// ~/.clodex/teams/clodex/tickets.json, outside this repo and outside any
// clone. A test that read them would pass on one machine and fail everywhere
// else, and would change meaning whenever a ticket is edited. These three are
// `state=done`; their text is frozen by definition.
//
// WHY THE CITED FILES ARE READ AT A PINNED COMMIT — do NOT repoint this at HEAD.
// PIN = the last commit before t75 was opened. The references were written
// against that tree, so it is the only tree where the CORRECT ones are correct.
// Verified: t75 cites agent-transport.js:86 for
// `existsSync(socket) && isAlive(pid)`, which lands on exactly that guard at
// the pin, and on comment prose in today's tree — 21 commits touched the two
// relevant files in between.
//
// Acceptance has two halves: flag every known defect AND leave the correct
// references alone. Reading the working tree destroys the second half
// specifically, because drift makes the correct reference indistinguishable
// from the defective ones — and a checker that flags everything passes the
// first half trivially while being worse than useless.

'use strict';

const PIN = 'f3c4f1f';

const TICKETS = {
  "t75": "tasks/registry-ghost-discovery — phantom peer: the pid-recycle ghost survives on the discovery side\n\nt57/t58/t59 fixed the DECISION side of the pid-recycle ghost: the pre-bind\nsocket probe (session-manager.js:1300-1313) plus proven-not-live overriding\nisStaleRegistration (:1380) means a recycled pid no longer WEDGES a name.\nVerified fixed.\n\nTHE DISCOVERY SIDE IS UNTOUCHED AND LIVE. The probe has one production call\nsite. agent-transport.js:86 (listPeers) and :103 (cleanup) still decide\nliveness with a bare `existsSync(socket) && isAlive(pid)` — and isAlive is\n`kill(pid,0)` at :34-37 against a record (:64) storing pid with nothing\nidentifying. So after an unclean shutdown + pid recycle:\n - [agent:who] ADVERTISES an agent that does not exist\n - bootstrap cleanup KEEPS its entry\n - every dm to it fails silently (send resolves false at :211)\n\nt57's journal records listPeers/isAlive being kept synchronous as a deliberate\nscope boundary — so this is a known edge, not an oversight. Filing it anyway\nbecause the two halves failed DIFFERENTLY: the wedge was loud and blocking, so\nit got fixed; the phantom peer is quiet. Quiet is what survives, which is this\nweek's recurring signature.\n\nThe async probe now exists in-tree. Decide whether discovery can use it, or\nwhether a cheaper identity field (start-time or random token, written at\nregister and required to match) is the better shape — the identity fix also\ncloses it for callers that cannot await.",
  "t76": "tasks/registry-cleanup-revalidate — cleanup() deletes live entries; the guard is already written one function away\n\nagent-transport.js:100-104: cleanup() reads a record, then unlinks it, with NO\nre-validation between. A re-registration landing in that gap has its LIVE entry\ndeleted by a routine maintenance pass. Recoverable rather than permanent (t57\ncorrectly stopped unlinking the socket, and :105-117 explains why re-adding\nthat would be worse), but a live agent still loses its registration.\n\nWHY THIS IS CHEAP: the fix is already written. session-manager.js:1350-1353 —\nadded by t58/t59 on the stale-recovery path — re-reads the record and discards\nthe verdict when the bytes changed. cleanup() has no equivalent.\n\nTHE ASYMMETRY IS THE ACTUAL DEFECT. Two read-then-act paths against the same\nstore, one guarded and one not, will read as INTENTIONAL to the next\nmaintainer. Either port the guard or comment why cleanup() does not need it.\nDo not leave it looking like a considered difference when it is an omission.",
  "t77": "tasks/cleanup-ordering-pins — pin the _cleanup ordering invariant that is protected by nothing\n\nNot a bug. A correctness property held by call-site discipline alone, which a\nplausible tidy would silently break.\n\nTWO PROPERTIES, BOTH LOAD-BEARING:\n (1) all three kill+create pairs await waitForSessionExit —\n     engine.js:1293, engine.js:1451, ipc-handlers.js:351\n (2) sessions.delete is the LAST statement in _cleanup\n     (session-manager.js:2368), AFTER the rmSync at :2366\n\n(2) is what makes (1) SUFFICIENT: waiting on the map slot is only a proxy for\n\"teardown finished\" because the map is dropped last. Move :2368 up three\nstatements — a tidy that groups the map mutations, which looks like an\nimprovement — and waitForSessionExit starts returning while the run dir is\nstill being deleted. NO TEST FAILS. engine.js:1253-1257 records that a fixed\n300ms sleep here once \"lost the session entirely\", so this is a bug already\npaid for once.\n\nTHE TECHNIQUE IS IN-TREE: test/plugin-host-engine.test.js:138-151 pins a call\nORDERING inside this very function's caller by reading source and comparing\nindexOf positions. Three lines pin sessions.delete as last. A grep pin catches\na fourth kill+create caller added without the wait.\n\nBoth pins must fail BY MESSAGE naming the consequence — \"teardown returns\nwhile the run dir is still being deleted\" — not by crash. A reader who trips\nthis pin must learn WHY the order matters from the failure alone, because the\nwhole point is that it is not obvious."
};

module.exports = { PIN, TICKETS };
