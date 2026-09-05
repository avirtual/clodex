# docs/notes/engine.md

## writeBundlePlugins

Writes INSIDE `skill-plugins/<session>/bundles/`, unlike the two flat
scaffolders which each own a root. Two consequences the code cannot show:

- `writeSkillPlugin` must run FIRST at every spawn. Its `rmSync` clears
  `skill-plugins/<session>`, which contains `bundles/`, so a bundle written
  before it is deleted after being written. Pinned by
  `test/plugin-bundle-spawn.test.js`.
- There is deliberately no `cleanupBundlePlugins`: `cleanupSkillPlugin` already
  rm -rf's the seat dir on every exit path, so bundles die with it. A second
  deleter would be a second unconfined join for no new coverage.

The CLI plugin name inside a bundle is the Clodex plugin id, which is what makes
the CLI namespace its contents `<plugin-id>:<skill>` / `<plugin-id>:<agent>`.
