// Ensure node-pty's shipped spawn-helper prebuild is executable.
//
// node-pty falls back to prebuilds/<platform>-<arch>/{pty.node,spawn-helper}
// when no local build/Release exists (i.e. no electron-rebuild was run). pty.node
// loads fine (N-API, ABI-independent), masking the problem — but spawn-helper is
// posix_spawn'd, and npm can extract the prebuild without its exec bit, so every
// pty.spawn dies with "posix_spawnp failed." This restores +x after each install.
//
// No-op on Windows (helpers are .node DLLs, not exec'd) and when the prebuild for
// the current platform/arch isn't present (a local build/Release is used instead).
const fs = require('fs');
const path = require('path');

if (process.platform === 'win32') process.exit(0);

const helper = path.join(
  __dirname, '..', 'node_modules', 'node-pty', 'prebuilds',
  `${process.platform}-${process.arch}`, 'spawn-helper',
);

if (!fs.existsSync(helper)) process.exit(0);

try {
  fs.chmodSync(helper, 0o755);
  console.log(`[fix-pty-helper] chmod +x ${helper}`);
} catch (e) {
  console.error(`[fix-pty-helper] failed to chmod ${helper}: ${e.message}`);
}
