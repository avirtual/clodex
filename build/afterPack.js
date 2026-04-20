// Ad-hoc sign the .app bundle so it runs on Apple Silicon without
// "killed" errors. No Apple Developer account required.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  // npm extraction strips the exec bit from node-pty's spawn-helper, so
  // posix_spawnp fails at runtime with "posix_spawnp failed". Restore it
  // before signing so the signature covers the correct mode.
  const arch = context.arch === 1 ? 'x64' : 'arm64';
  const spawnHelper = path.join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds',
    `darwin-${arch}`,
    'spawn-helper'
  );
  try {
    fs.chmodSync(spawnHelper, 0o755);
    console.log(`  • chmod +x ${spawnHelper}`);
  } catch (e) {
    console.error('  • chmod spawn-helper failed:', e.message);
    throw e;
  }

  console.log(`  • ad-hoc signing ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('  • ad-hoc signing complete');
  } catch (e) {
    console.error('  • ad-hoc signing failed:', e.message);
    throw e;
  }
};
