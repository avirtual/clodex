'use strict';
// build-web.js — produces the browser frontend bundle in web-dist/ (web-frontend
// Phase 3b). Run via `npm run build:web`. web-host.js serves this directory.
//
// Output is a SINGLE self-contained web-dist/index.html with the JS and CSS
// inlined. That is deliberate: the host token-gates every HTTP route, and a
// browser does NOT carry the page's ?token= query onto separate <script>/<link>
// requests — so a one-request page (the token rides its own URL) is the only
// shape that works uniformly for BOTH localhost-trust and tokened mode without
// touching the committed web-host.js. The WebSocket and /exports/ URLs carry the
// token in-query (the shim builds them). For localhost-trust there is no token
// and it works either way.
//
// The body markup is taken from renderer/index.html (the Electron page) so the
// two frontends never drift: we swap its two stylesheet <link>s for the inlined
// CSS and its <script src="renderer.js"> for the inlined bundle. Node builtins
// that the renderer graph touches are aliased to browser shims — os (homedir from
// the welcome frame), crypto (Web Crypto), child_process (throws; never reached).

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'renderer', 'web');
const OUT = path.join(ROOT, 'web-dist');

// ── Plugin renderer halves (plugin-plan.md [internal design doc, not in this repo] §4 W8, GAP G7) ─────────────
// The Electron renderer activates a plugin's renderer half with
// `window.require(absolutePath)`. A browser has no require and esbuild resolves
// every import at BUILD time, so the modules must be baked in and keyed by id.
// This rewrites the marked block in renderer/web/plugin-registry.js from
// `plugins/*/manifest.json` before the bundle is built.
//
// The plugin's CSS needs nothing here: it already crosses as TEXT over the
// `_host` `renderer.info` call and becomes a per-plugin <style>, identically in
// both frontends.
//
// The file is REWRITTEN IN PLACE and committed empty. Kept as a real file rather
// than a virtual esbuild module so `require('./plugin-registry')` in boot.js is
// an ordinary resolvable require — the same reason web-dist itself is tracked.
const REGISTRY = path.join(WEB, 'plugin-registry.js');
const GEN_START = '  // <<< BUILD-GENERATED PLUGIN MODULES — build/build-web.js rewrites this block';
const GEN_END = '  // >>> END BUILD-GENERATED PLUGIN MODULES';

function discoverPluginRenderers() {
  const dir = path.join(ROOT, 'plugins');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries.filter((d) => d.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, ent.name, 'manifest.json'), 'utf8')); } catch { continue; }
    const rel = manifest && manifest.entry && manifest.entry.renderer;
    // Engine-only plugins have no renderer half and belong nowhere in a bundle.
    // Mirrors plugin-loader's refusal rather than re-deriving it: an id that
    // does not match its directory is not a plugin, here either.
    if (!rel || typeof rel !== 'string' || manifest.id !== ent.name) continue;
    if (!fs.existsSync(path.join(dir, ent.name, rel))) continue;
    out.push({ id: manifest.id, spec: `../../plugins/${ent.name}/${rel.replace(/^\.\//, '')}` });
  }
  return out;
}

function writePluginRegistry(plugins) {
  const src = fs.readFileSync(REGISTRY, 'utf8');
  const a = src.indexOf(GEN_START);
  const b = src.indexOf(GEN_END);
  if (a < 0 || b < 0) throw new Error('build-web: the generated block markers moved in renderer/web/plugin-registry.js');
  const body = plugins.map((p) => `  ${JSON.stringify(p.id)}: require(${JSON.stringify(p.spec)}),`).join('\n');
  const next = `${src.slice(0, a + GEN_START.length)}\n${body ? `${body}\n` : ''}${src.slice(b)}`;
  // Rewritten only when the plugin set changed, and the discovery sort keeps
  // those bytes deterministic: the release script's staleness guard (a dirty
  // tree = a stale bundle) would fire on every build if this varied run to run.
  if (next !== src) fs.writeFileSync(REGISTRY, next);
  return plugins.map((p) => p.id);
}

// The assembly, with NO side effect on the tree: it reads sources and RETURNS
// the bytes. That split is what lets test/web-dist-fresh.test.js check the
// committed bundle against a fresh build without writing anything — a test that
// rebuilt into web-dist/ would repair the staleness it exists to report, and one
// that reimplemented the assembly could not detect drift from this file at all.
// Everything that writes (the registry rewrite, the output file) stays in main().
// `logLevel` is the only knob: esbuild's 'info' chatter belongs in a build run
// and not in a test's output. It does not touch the produced bytes, which is
// what makes the test's build comparable to the committed one.
async function buildBundle({ logLevel = 'silent' } = {}) {
  const alias = {
    os: path.join(WEB, 'os-shim.js'),
    crypto: path.join(WEB, 'crypto-shim.js'),
    child_process: path.join(WEB, 'child_process-shim.js'),
  };

  // Both flags stay, for different reasons — esbuild names every inlined module
  // RELATIVE TO THE BUILD'S WORKING DIRECTORY, after resolving symlinks.
  //
  // `preserveSymlinks`: the ticket loop plants `node_modules` in each worktree as
  // a symlink to the root checkout, so without it esbuild escapes through the
  // link and writes `../wb-wrap-ui/node_modules/...` — reachable from the
  // ordinary `npm run build:web`, and the form that actually shipped twice.
  //
  // `absWorkingDir`: pins the marker root to ROOT rather than the invocation cwd.
  // Only a DIRECT `node build/build-web.js` from a subdirectory ever reached the
  // defect — `npm run build:web` re-roots cwd to the package directory, so the
  // documented invocation was never exposed. It stays because it is what makes
  // the bundle byte-identical however it is invoked, which is the property the
  // test checks; it is not load-bearing against the shipped bug.
  //
  // Pinned by test/web-dist-portable.test.js.
  const js = await esbuild.build({
    entryPoints: [path.join(WEB, 'boot.js')],
    absWorkingDir: ROOT,
    preserveSymlinks: true,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'firefox110', 'safari16'],
    alias,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel,
  });

  const css = await esbuild.build({
    entryPoints: [path.join(WEB, 'app.css')],
    absWorkingDir: ROOT,
    preserveSymlinks: true,
    bundle: true,
    write: false,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
    logLevel,
  });

  const jsText = js.outputFiles[0].text;
  const cssText = css.outputFiles[0].text;

  // Take the Electron page's markup and rewrite head/script for the browser build.
  // Each replacement must match exactly once, or the Electron page's markup moved
  // and the browser build would silently drift — so assert on the match, not on a
  // whole-document substring scan (the inlined bundle legitimately contains the
  // strings "renderer.js"/"styles.css" in esbuild's module-path comments).
  const html0 = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const subs = [
    [/[ \t]*<link rel="stylesheet" href="\.\.\/node_modules\/@xterm\/xterm\/css\/xterm\.css">\n?/, '', 'xterm css link'],
    [/[ \t]*<link rel="stylesheet" href="styles\.css">\n?/, `  <style>\n${cssText}\n  </style>\n`, 'styles.css link'],
    [/[ \t]*<script src="renderer\.js"><\/script>/, `  <script>\n${inlineSafe(jsText)}\n  </script>`, 'renderer.js script'],
  ];
  let html = html0;
  for (const [re, repl, label] of subs) {
    if (!re.test(html)) throw new Error(`build-web: could not find the ${label} in renderer/index.html — markup drifted`);
    html = html.replace(re, () => repl);
  }

  return { html, jsText, cssText };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const bundled = writePluginRegistry(discoverPluginRenderers());
  console.log(`plugin renderer halves bundled: ${bundled.length ? bundled.join(', ') : '(none)'}`);

  const { html, jsText, cssText } = await buildBundle({ logLevel: 'info' });

  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log(`web-dist/index.html written (${(html.length / 1024).toFixed(0)} KB: ${(jsText.length / 1024).toFixed(0)} KB js + ${(cssText.length / 1024).toFixed(0)} KB css)`);
}

// Guard against a stray `</script>` inside string literals closing the inline tag.
function inlineSafe(s) { return s.replace(/<\/script>/gi, '<\\/script>'); }

module.exports = { buildBundle, OUT };

// Only when run as a script: `require`ing this module must not launch a build.
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
