'use strict';
// The placement round-trip must leave no cache holding BOX truth labeled as the
// host's.
//
// renderer/lib/checklists.js keeps seven module-global caches, seeded from six
// sites across four modules; the file's own header calls that a sanctioned seam.
// The hazard the seam creates is directional: choosing a Sandbox placement
// seeds them from the box's catalogs, and switching back to "This Mac" has to
// re-seed every one it touched. Miss one and the dialog shows the box's data
// under the host's label.
//
// It has been missed twice. The prompt-lib cache was found and fixed with an
// explicit reload in restoreHostCatalogs; skillLibCache had the identical
// exposure and no such reload, so after a Sandbox stint the New Session dialog
// listed the BOX's skills as the Mac's. Ticking one persisted a name the host
// may not have, and skills-util skips an unknown name SILENTLY at spawn — the
// operator's skill simply never loads and nothing reports it.
//
// So this is a source-level seam assertion rather than a behavioural one:
// renderer.js is DOM plumbing that no unit test constructs, and the invariant
// worth pinning is which seeders the return path covers. A third cache added to
// the box path fails here until the return path answers for it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

// The body of a top-level `function NAME(...)` / `async function NAME(...)`,
// taken to the first line that is exactly `}` — renderer.js indents every
// nested brace, so a column-0 close is the function's own.
function bodyOf(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\s*\\(`, 'm');
  const m = re.exec(SRC);
  assert.ok(m, `ENTER: ${name} not found in renderer.js — it was renamed or removed`);
  const rest = SRC.slice(m.index);
  const end = rest.search(/\n\}/);
  assert.ok(end > 0, `ENTER: could not find the end of ${name}`);
  return rest.slice(0, end);
}

const CACHE_SETTERS = [
  'setPromptLibCache',
  'setAgentLibCache',
  'setSkillLibCache',
  'setExecLibCache',
  'setIntentCatalogCache',
  'setClaudeToolsCache',
  'setDefaultToolDenyCache',
];

test('every cache the BOX path seeds is re-seeded on the way back to the host', () => {
  const boxPath = bodyOf('populateChecklistsFromCatalogs');

  // The return path is two functions: populateHostCatalogs plus whatever
  // restoreHostCatalogs adds around it for the caches it does not cover.
  const restore = bodyOf('restoreHostCatalogs');
  const hostPath = bodyOf('populateHostCatalogs') + '\n' + restore;

  // Resolved TRANSITIVELY, not one hop: the prompt cache is reached through
  // refreshSystemPromptDropdown -> loadPromptLib -> setPromptLibCache, so a
  // fixed-depth walk reports a covered cache as unrestored. Inlining the whole
  // file instead would make the assertion vacuous — every setter appears
  // somewhere in renderer.js — so the walk has to follow calls and stop.
  const helpers = ['refreshSystemPromptDropdown', 'loadPromptLib', 'refreshNewSessionInjectSkills',
    'refreshNewSessionExecCommands', 'refreshNewSessionIntents', 'refreshNewSessionTools',
    'refreshNewSessionSkills'];
  let hostReach = hostPath;
  const seen = new Set();
  for (let depth = 0; depth < 5; depth++) {
    let grew = false;
    for (const h of helpers) {
      if (seen.has(h) || !new RegExp(`\\b${h}\\s*\\(`).test(hostReach)) continue;
      seen.add(h);
      hostReach += '\n' + bodyOf(h);
      grew = true;
    }
    if (!grew) break;
  }

  const seededByBox = CACHE_SETTERS.filter((s) => new RegExp(`\\b${s}\\s*\\(`).test(boxPath));

  // ENTER: the box path must actually seed caches. If the extractor missed the
  // function body, seededByBox is empty and the subset check below passes over
  // nothing — the exact vacuous-green this suite has been bitten by before.
  assert.ok(
    seededByBox.length >= 3,
    `ENTER: found only ${seededByBox.length} cache seeders in the box path (${JSON.stringify(seededByBox)}) — the body extraction is wrong`,
  );

  const unrestored = seededByBox.filter((s) => !new RegExp(`\\b${s}\\s*\\(`).test(hostReach));
  assert.deepStrictEqual(
    unrestored, [],
    `these caches keep BOX data after switching back to This Mac: ${unrestored.join(', ')}. `
    + 'Seed them in populateHostCatalogs, or reload them explicitly in restoreHostCatalogs.',
  );
});

test('the skill library is reloaded on the return path, not merely rendered', () => {
  // The specific regression. refreshNewSessionSkills also exists and is NOT a
  // substitute: it renders the per-cwd availability list, a different cache
  // from the inject library, so a fix that called it would look right and
  // change nothing.
  const restore = bodyOf('restoreHostCatalogs');
  assert.match(
    restore, /refreshNewSessionInjectSkills\s*\(/,
    'restoreHostCatalogs must reload the skill library, or a box-only skill stays ticked and is dropped silently at spawn',
  );

  const injectRefresh = bodyOf('refreshNewSessionInjectSkills');
  assert.match(
    injectRefresh, /listSkillLib\s*\(/,
    'ENTER: refreshNewSessionInjectSkills must fetch the HOST library, or reloading it restores nothing',
  );
});
