// Ad-hoc sign the .app bundle so it runs on Apple Silicon without
// "killed" errors. No Apple Developer account required.
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  console.log(`  • ad-hoc signing ${appPath}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log('  • ad-hoc signing complete');
  } catch (e) {
    console.error('  • ad-hoc signing failed:', e.message);
    throw e;
  }
};
