// manual/team-popover-stale-fields.js — the R4 stale state and the unsaved-edit
// carry-forward, in a real browser. Run:
//   ./node_modules/.bin/electron manual/team-popover-stale-fields.js
//
// Both behaviours here were shipped broken once and caught in review:
//   - a Clear button on the stale `template`, which cannot keep its promise
//     (buildSavePatch OMITS a blank template, so Save silently kept the value);
//   - any dispatch change rebuilding the fields from the STORED def, discarding
//     whatever the operator had typed or just cleared.
// Exits nonzero on any failed expectation.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.disableHardwareAcceleration();
const bail = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 60000);
const fail = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`);
  if (!ok) fail.push(name);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadFile(path.join(__dirname, 'harness.html'));
  const js = (s) => win.webContents.executeJavaScript(s);
  await js(`(() => { window.__saved = []; window.api.teamSetRole = async (t, role, patch) => {
    window.__saved.push({ role, patch }); return { ok: true, team: null }; }; return null; })()`);
  await js('window.__open()');
  const body = `document.querySelector('#team-roles-list .team-role-body:not(.hidden)')`;
  const expand = async (role) => {
    await js(`(() => { document.querySelector('.team-role-row[data-role="${role}"] button[data-act="disclose"]').click(); return null; })()`);
    await new Promise((r) => setTimeout(r, 150));
  };
  const setDispatch = async (v) => {
    await js(`(() => { const r = ${body}.querySelector('input[data-f="dispatch"][value="${v}"]');
      r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); return null; })()`);
    await new Promise((r) => setTimeout(r, 80));
  };
  const fieldState = () => js(`(() => [...${body}.querySelectorAll('.team-role-field')].map((f) => ({
      field: f.dataset.field || null, stale: f.classList.contains('stale'),
      value: (f.querySelector('input') || {}).value,
      hasClear: !!f.querySelector('.team-role-stale-clear'),
    })).filter((x) => x.field))()`);

  // --- MF1: the stock `hand` shape — standing with a template on disk. ---
  await expand('hand');
  check('hand: stale template is shown WITHOUT a Clear it cannot honour', await fieldState(),
    [{ field: 'template', stale: true, value: 'clodex-team-hand', hasClear: false }]);
  check('hand: the note explains why it cannot be cleared here',
    await js(`${body}.querySelector('[data-field="template"] .team-role-stale-note').title.includes("can't be cleared from the app")`), true);

  // --- MF1: `cwd` KEEPS its Clear, because a blank cwd does transmit. ---
  await expand('archivist');
  check('archivist: both stale, Clear on cwd only', await fieldState(), [
    { field: 'template', stale: true, value: 'fable-design', hasClear: false },
    { field: 'cwd', stale: true, value: 'api', hasClear: true },
  ]);
  await js(`(() => { ${body}.querySelector('[data-field="cwd"] .team-role-stale-clear').click(); return null; })()`);
  check('archivist: clearing cwd un-stales that field only', await fieldState(), [
    { field: 'template', stale: true, value: 'fable-design', hasClear: false },
    { field: 'cwd', stale: false, value: '', hasClear: false },
  ]);
  // The role is STILL standing here. An enabled box invites a fresh cwd that
  // Save would write to a role that never reads it — invisible on the next open.
  check('archivist: the cleared cwd is inert while the role is still standing',
    await js(`${body}.querySelector('[data-field="cwd"] input').disabled`), true);

  // --- MF2(b): a cleared field must NOT come back when dispatch changes. ---
  await setDispatch('spawn');
  check('MF2: the cleared cwd stays cleared across a dispatch change',
    await js(`${body}.querySelector('[data-field="cwd"] input').value`), '');
  // ...and becomes editable again, because a spawn role DOES consume a cwd. The
  // inertness above is a property of `standing`, not a one-way trip.
  check('MF2: and is editable again once the dispatch consumes it',
    await js(`${body}.querySelector('[data-field="cwd"] input').disabled`), false);

  // --- r2 nit 1: a Clear must reach the STATE computation, not just the DOM.
  //     Returning to standing re-derives stale-vs-hidden from what is stored,
  //     and a Clear is a promise that nothing is stored any more — so the field
  //     must be GONE, not back as an empty disabled box with an inert Clear. ---
  await setDispatch('standing');
  check('r2: a cleared cwd is HIDDEN on the way back to standing, not an empty stale box',
    await fieldState(), [{ field: 'template', stale: true, value: 'fable-design', hasClear: false }]);
  await setDispatch('spawn');

  // --- MF2(a): typing then switching between two ACTIVE dispatches. ---
  await js(`(() => { ${body}.querySelector('[data-field="cwd"] input').value = 'services/api'; return null; })()`);
  await setDispatch('worktree');
  check('MF2: a typed cwd survives edit -> edit',
    await js(`${body}.querySelector('[data-field="cwd"] input').value`), 'services/api');

  // The save patch is what actually reaches the backend.
  await js(`(() => { ${body}.querySelector('button[data-act="save"]').click(); return null; })()`);
  await new Promise((r) => setTimeout(r, 200));
  check('the patch carries the operator\'s values, not the stored ones',
    await js(`(() => { const p = window.__saved[window.__saved.length - 1].patch;
      return { cwd: p.cwd, template: p.template, dispatch: p.dispatch }; })()`),
    { cwd: 'services/api', template: 'fable-design', dispatch: 'worktree' });

  // --- A field going to `hidden` still DROPS its value. `designer` stores no
  //     cwd, so a cwd typed under worktree has never been on disk: switching to
  //     standing must hide it and write nothing, rather than promote the typed
  //     value to a stale-and-disabled field that Save would persist. ---
  await expand('designer');
  await js(`(() => { ${body}.querySelector('[data-field="cwd"] input').value = 'tmp/scratch'; return null; })()`);
  await setDispatch('standing');
  check('an unstored typed cwd is DROPPED, not promoted to stale', await fieldState(),
    [{ field: 'template', stale: true, value: 'fable-design', hasClear: false }]);
  await js(`(() => { ${body}.querySelector('button[data-act="save"]').click(); return null; })()`);
  await new Promise((r) => setTimeout(r, 200));
  check('and the patch writes no haunted cwd',
    await js(`window.__saved[window.__saved.length - 1].patch.cwd`), '');

  clearTimeout(bail);
  console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nall stale-field / carry-forward checks passed');
  win.destroy();
  app.exit(fail.length ? 1 : 0);
});
app.on('window-all-closed', () => {});
