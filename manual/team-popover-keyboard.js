// manual/team-popover-keyboard.js — B4's keyboard + ARIA behaviour, in a real
// browser. Run:  ./node_modules/.bin/electron manual/team-popover-keyboard.js
//
// Covers what no unit test in this repo can: arrow-key navigation within the
// dispatch radio group, the group being ONE tab stop (measured by pressing Tab,
// not by reading .tabIndex — that is 0 on every radio and says nothing about the
// group's tab semantics), and the reveal following a keyboard-only change with
// no save round-trip. Exits nonzero on any failed expectation.
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
  const key = async (keyCode) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'char', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    await new Promise((r) => setTimeout(r, 60));
  };
  await js('window.__open()');
  // `designer` dispatches worktree, so both fields are live and the segment
  // under test starts on the third option.
  await js(`(() => { document.querySelector('.team-role-row[data-role="designer"] button[data-act="disclose"]').click(); return null; })()`);
  await new Promise((r) => setTimeout(r, 150));
  const body = `document.querySelector('#team-roles-list .team-role-body:not(.hidden)')`;
  const checked = () => js(`(${body}.querySelector('input[data-f="dispatch"]:checked')||{}).value||null`);

  check('initial dispatch', await checked(), 'worktree');
  check('aria', await js(`(() => { const g = ${body}.querySelector('.team-role-segments');
    return { role: g.getAttribute('role'), label: g.getAttribute('aria-label') }; })()`),
    { role: 'radiogroup', label: 'dispatch' });
  check('one group name', await js(`new Set([...${body}.querySelectorAll('input[data-f="dispatch"]')].map((r) => r.name)).size`), 1);

  await js(`(() => { ${body}.querySelector('input[data-f="dispatch"]:checked').focus(); return null; })()`);
  await key('Left');  check('Left  selects previous', await checked(), 'spawn');
  await key('Left');  check('Left  again', await checked(), 'standing');
  await key('Right'); check('Right selects next', await checked(), 'spawn');
  await key('Down');  check('Down  wraps forward', await checked(), 'worktree');
  await key('Up');    check('Up    selects previous', await checked(), 'spawn');

  // ONE tab stop: Tab must leave the group entirely.
  await js(`(() => { ${body}.querySelector('input[data-f="dispatch"]:checked').focus(); return null; })()`);
  await key('Tab');
  check('Tab leaves the radio group', await js(`document.activeElement.dataset.f === 'dispatch'`), false);

  // B3 live: a keyboard-only change repaints the reveal with no save.
  check('reveal follows the keyboard', await js(`(() => { const b = ${body}; return {
    dispatch: (b.querySelector('input[data-f="dispatch"]:checked')||{}).value,
    cwd: !!b.querySelector('[data-field="cwd"]'), template: !!b.querySelector('[data-field="template"]'),
  }; })()`), { dispatch: 'spawn', cwd: true, template: true });

  // Two open editors must never share a radio group — same-named radios anywhere
  // in one document are ONE group, so the second would uncheck the first.
  await js(`(() => { document.querySelector('.team-role-row[data-role="archivist"] button[data-act="disclose"]').click(); return null; })()`);
  await new Promise((r) => setTimeout(r, 150));
  check('every rendered group is independent', await js(`(() => {
    const rows = [...document.querySelectorAll('#team-roles-list .team-role-row')]
      .map((row) => [...row.querySelectorAll('input[data-f="dispatch"]')])
      .filter((rs) => rs.length);
    return { groups: rows.length, distinctNames: new Set(rows.map((rs) => rs[0].name)).size,
             allExactlyOneChecked: rows.every((rs) => rs.filter((r) => r.checked).length === 1) };
  })()`), { groups: 3, distinctNames: 3, allExactlyOneChecked: true });

  clearTimeout(bail);
  console.log(fail.length ? `\n${fail.length} FAILED: ${fail.join(', ')}` : '\nall keyboard/ARIA checks passed');
  win.destroy();
  app.exit(fail.length ? 1 : 0);
});
app.on('window-all-closed', () => {});
