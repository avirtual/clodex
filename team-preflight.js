// team-preflight.js — "does this team's manifest name anything that resolves to
// nothing?", as DATA rather than as N scattered warns.
//
// One rule, from the team-portability design: a name that resolves to nothing is
// reported — once, to the party who can act on it — and the operation proceeds.
// This module is the resolver half; every surface (roles popover, Create Team…,
// the spawn/dispatch replies) is a caller that relays the same findings on its
// own channel. Building it warn-first is how the popover and the create flow end
// up re-deriving the same checks a week later, in prose that disagrees.
//
// Pure leaf: no fs, no path, no electron, no requires at all. Every disk touch
// arrives as an injected probe, which is what makes the whole findings table
// assertable from a fixture with no library on disk and no team checked out.
//
// FINDINGS ARE PROBLEMS ONLY. The level enum is warn|note with no 'ok' member,
// so a resolved name has nothing to carry; absence of a finding for a role+kind
// IS resolution, and the surfaces render the ✓ from the manifest row. `verify`
// is stage 3's kind — the enum has room for it and this file emits none.
//
// `resolvedFrom` names where the thing that DID resolve came from, and is null
// when nothing resolved. Today that is only ever 'library'; stage 4 adds
// team-local prompt directories, and this field is what turns a team-local file
// silently shadowing a library one into a displayed fact instead of a surprise.
//
// NOT A HOT PATH. It stats files and parses template/exec JSON per role — fine
// for a popover open or a team create, wrong for resolveTeam, which runs on
// every roster render.
//
// THE RULE THIS MODULE MUST HOLD AGAINST THE RUNNER: preflight checks
// everything the runner expands, and accepts nothing the runner would refuse.
// Three sightings so far: the exec scan read `argv` but not the def's `cwd`,
// which the runner expands identically; an empty `argv` read as "resolved,
// nothing to check"; a garbled def file read as no def at all. A tick over a
// command that bounces every time is the exact failure this module exists to
// kill, so when the runner grows a new expansion or a new refusal, it grows
// here in the same change.
//
// WHERE THE DISAGREEMENT KEEPS COMING FROM: the last two both arrived through
// execLibrary.list(), which NORMALIZES what the runner treats as fatal — a
// non-array `argv` becomes [], an unparseable file becomes absence. A
// normalizing lister is a LOSSY probe, so a falsy or empty result from one
// carries two different states at once and cannot be trusted as it stands.
// When a check here reads through such a loader, establish what the
// normalization erased (the raw bytes, the pre-default value) before choosing a
// message — the operator recovery differs per state even where the level does
// not. Stage 3's `verify` reads through the same class of loader.

'use strict';

// Severity is by CONSEQUENCE, not uniform, and the split is load-bearing rather
// than cosmetic:
//   warn — the seat's behaviour breaks. An unresolved role prompt boots it
//          unbriefed; an unresolved template drops its whole shape.
//   note — the team owes a file nobody has written yet. The portable hand
//          template deliberately names an append stem the operator is expected
//          to supply, so this must read as "here is the named thing to write",
//          not as an error. Promote it and every fresh team looks broken.
const LEVELS = ['warn', 'note'];
const KINDS = ['prompt', 'append', 'template', 'exec', 'verify'];

// Only `${TEAM_ROOT}` is expandable from a manifest alone. The exec runner also
// substitutes ${CLODEX_BIN} and ${CLODEX_HOME} (session-manager, _handleExecIntent),
// which are host paths this pure module has no business knowing — so an argv
// element carrying one of those is SKIPPED rather than guessed at. Reporting a
// path we could not build as "missing" would be a false accusation about a file
// that is on disk, which is worse than the silence this module exists to end.
const TEAM_ROOT_TOKEN = '${TEAM_ROOT}';

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// A role's prompt/template/exec/append names, checked against what is installed.
// Order within a role is prompt → template → exec → append: severity-descending
// and stable, so a surface can render findings in arrival order without sorting.
function teamPreflight(team, probes) {
  const findings = [];
  if (!team || typeof team !== 'object') return findings;
  const roles = (team.roles && typeof team.roles === 'object' && !Array.isArray(team.roles))
    ? team.roles : null;
  if (!roles) return findings;

  const p = probes || {};
  const resolvePrompt = typeof p.resolvePrompt === 'function' ? p.resolvePrompt : () => null;
  const listTemplates = typeof p.listTemplates === 'function' ? p.listTemplates : () => [];
  const readExecDef = typeof p.readExecDef === 'function' ? p.readExecDef : () => null;
  const exists = typeof p.exists === 'function' ? p.exists : () => false;

  // Listed ONCE for the whole run, not per role: a team whose roles all name the
  // same template would otherwise re-read the template directory per role, and
  // this is called from a popover open where that is the visible cost.
  let templates;
  try { templates = listTemplates(); } catch { templates = []; }
  const byName = new Map();
  for (const t of Array.isArray(templates) ? templates : []) {
    if (t && isNonEmptyString(t.name)) byName.set(t.name, t);
  }

  const root = isNonEmptyString(team.root) ? team.root : null;

  for (const [role, def] of Object.entries(roles)) {
    if (!def || typeof def !== 'object') continue;

    if (isNonEmptyString(def.prompt)) {
      let hit = null;
      try { hit = resolvePrompt('system', def.prompt); } catch { hit = null; }
      if (!hit) {
        findings.push({
          level: 'warn', kind: 'prompt', role, ref: def.prompt, resolvedFrom: null,
          message: `role "${role}": prompt "${def.prompt}" is not installed under library/prompts/system — a seat spawned for this role boots unbriefed`,
        });
      }
    }

    if (!isNonEmptyString(def.template)) continue;
    const tpl = byName.get(def.template) || null;
    if (!tpl) {
      // The template's own contents are what the exec/append checks read, so a
      // missing template is the end of this role's line, not a warning we then
      // check around. Continuing would emit "grants no exec commands" about a
      // file that does not exist.
      findings.push({
        level: 'warn', kind: 'template', role, ref: def.template, resolvedFrom: null,
        message: `role "${role}": template "${def.template}" is not in the template library — a seat spawned for this role gets none of its shape`,
      });
      continue;
    }

    for (const raw of Array.isArray(tpl.execCommands) ? tpl.execCommands : []) {
      if (!isNonEmptyString(raw)) continue;
      let entry = null;
      try { entry = readExecDef(raw); } catch { entry = null; }
      if (!entry || typeof entry !== 'object') {
        // Reported rather than skipped: an ungrantable command is the same class
        // of break as a missing script, and "we could not read the def so we
        // checked nothing" is exactly the silent swallow this design kills.
        findings.push({
          level: 'warn', kind: 'exec', role, ref: raw, resolvedFrom: null,
          message: `role "${role}": template "${def.template}" grants exec command "${raw}", which has no def installed under library/exec`,
        });
        continue;
      }
      if (entry.unreadable) {
        // A def that EXISTS but yields nothing usable. The probe has to hand this
        // over as its own condition, because the lister it reads through drops
        // such a file exactly like an absent one — and telling the operator to
        // install a file already sitting on disk sends them at the wrong repair
        // while every call keeps failing. `resolvedFrom` stays null: nothing
        // resolved. Ends this def's line — there are no parsed argv/cwd below.
        //
        // "read as a def object" rather than "parsed": execLibrary.list() drops
        // BOTH unparseable bytes and valid JSON that is not an object ("x", 42,
        // null). Naming the JSON would be a wrong instruction for the second —
        // its JSON is fine, its shape is not — and the repair is the same.
        findings.push({
          level: 'warn', kind: 'exec', role, ref: raw, resolvedFrom: null,
          message: `role "${role}": exec command "${raw}" has a def file under library/exec that could not be read as a def object — the runner cannot read it, so every call fails; repair the file`,
        });
        continue;
      }
      const argv = Array.isArray(entry.argv) ? entry.argv : [];
      if (!argv.length) {
        // execLibrary.list() normalizes a missing or non-array argv to [], so
        // without this a malformed def reads as "resolved, nothing to check"
        // while the runner refuses it outright ("malformed registry entry
        // (needs a non-empty argv)") on every single call. Ends this def's
        // line: the runner never reaches the cwd expansion below, so checking
        // its paths would report a consequence of a def that cannot run at all.
        findings.push({
          level: 'warn', kind: 'exec', role, ref: raw, resolvedFrom: 'library',
          message: `role "${role}": exec command "${raw}" has a def under library/exec but no argv to run — the runner refuses it as malformed, so every call bounces`,
        });
        continue;
      }

      // The runner expands the def's `cwd` with the SAME substitution it applies
      // to argv, so a cwd carrying ${TEAM_ROOT} is as much a path this team must
      // own — our own shipped clodex-run-tests.json is exactly that shape, and
      // scanning argv alone gave it a tick over a directory that may not exist.
      const scan = argv.map((value) => ({ value, verb: 'needs' }));
      if (isNonEmptyString(entry.cwd)) scan.push({ value: entry.cwd, verb: 'runs in' });

      for (const { value, verb } of scan) {
        if (typeof value !== 'string' || !value.includes(TEAM_ROOT_TOKEN)) continue;
        if (!root) continue; // no root to substitute — see the header on false accusations
        const abs = value.split(TEAM_ROOT_TOKEN).join(root);
        if (abs.includes('${')) continue; // another token we cannot resolve here
        let ok = false;
        try { ok = !!exists(abs); } catch { ok = false; }
        if (ok) continue;
        findings.push({
          // 'library': the def itself resolved, and this is the portable path
          // INSIDE it that does not. That distinction is the whole point of the
          // ${TEAM_ROOT} token — a def that hardcodes an absolute project path
          // runs the wrong project's script for every other team, silently.
          level: 'warn', kind: 'exec', role, ref: raw, resolvedFrom: 'library',
          message: `role "${role}": exec command "${raw}" ${verb} ${abs}, which does not exist under this team's root`,
        });
      }
    }

    for (const stem of Array.isArray(tpl.appendPromptFiles) ? tpl.appendPromptFiles : []) {
      if (!isNonEmptyString(stem)) continue;
      let hit = null;
      try { hit = resolvePrompt('append', stem); } catch { hit = null; }
      if (hit) continue;
      findings.push({
        level: 'note', kind: 'append', role, ref: stem, resolvedFrom: null,
        message: `role "${role}": template "${def.template}" composes append prompt "${stem}", which is not installed under library/prompts/append — write it, or drop it from the template`,
      });
    }
  }

  return findings;
}

module.exports = { teamPreflight, LEVELS, KINDS };
