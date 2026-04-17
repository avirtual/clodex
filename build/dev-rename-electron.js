// Rename the dev Electron.app so `npm start` shows "Clodex" in the menu bar
// instead of "Electron". macOS reads CFBundleName from Info.plist, not from
// app.setName(), so this is the only way to fix the dev-mode label.
// Packaged builds are unaffected — they get productName from package.json.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PLIST = path.join(
  __dirname, '..', 'node_modules', 'electron', 'dist',
  'Electron.app', 'Contents', 'Info.plist'
);

if (!fs.existsSync(PLIST)) process.exit(0);

const set = (key, value) => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, PLIST]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, PLIST]);
  }
};

set('CFBundleName', 'Clodex');
set('CFBundleDisplayName', 'Clodex');
console.log('[dev-rename-electron] Electron.app rebranded as Clodex for dev');
