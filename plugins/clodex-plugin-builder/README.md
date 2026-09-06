# clodex-plugin-builder

Build a Clodex plugin without reading the whole contract first. One skill that
scaffolds a plugin, wires the surfaces you asked for and verifies it against the
real loader, plus a subagent that answers API questions out of the contract on
your machine so the contract never lands in your context.

**Seat**: any seat where you want to write a plugin. It needs a shell and a
filesystem, nothing else.

**Writes**: nothing of its own. The skill writes the plugin folder you asked it
to create, wherever you point it.

## What you get

- `/clodex-plugin-builder:create-plugin <id> [what it should do]` — the build
  workflow, start to verified.
- `clodex-plugin-builder:api-scout` — reads `plugin-api.md` on this machine and
  returns the rules and signatures for a specific surface. Delegate to it
  directly for a one-off question ("what does `rowBadge` take?") without running
  the whole skill.

## Why this exists

The contract is thorough and long, and most of what makes a first plugin fail is
a handful of rules scattered through it: the folder must be named for the id,
`hostApi` is a string, `style.css` is injected unscoped into every window,
`events.emit` needs an explicit scope, a verb is off until the operator ticks it,
a content-only plugin needs no JavaScript at all. The skill front-loads exactly
those and delegates the rest, so a first plugin is an implementation task rather
than a reading task.

It also finds the **author tools** if you have a Clodex checkout —
`scaffold.js` writes a plugin that already passes, and `verify.js` runs one
against the host's own loader. Where those exist the skill uses them, because a
plugin that has not been through `verify.js` is a plugin nobody has run.

## Limits

- **It reads the contract from your machine**, so what it tells you is true for
  the Clodex you have. The scout states the version it read; believe that over
  anything remembered.
- **It does not install anything.** Registering a plugin and ticking it onto a
  seat are operator gestures, and the skill ends by telling you which ones.
- **No sandbox exists for plugins**, and this skill will say so rather than
  implying a plugin it wrote for you is contained. An engine half runs with the
  app's full privileges.

## Installing

**Clodex 5.33.0 and later already ship this plugin as a built-in**, off by
default — tick it on a seat and you are done. A copy installed from here wins
over the built-in only when its `version` is strictly greater, so check before
installing one: a copy at the same version is shadowed and your edits will not
appear.

Otherwise, **Plugins ▸ Manage Plugins… ▸ Install from GitHub…**:

```
https://github.com/avirtual/clodex-plugins/tree/master/clodex-plugin-builder
avirtual/clodex-plugins:clodex-plugin-builder                                # follows the branch
avirtual/clodex-plugins@clodex-plugin-builder-v0.2.2:clodex-plugin-builder   # frozen
```

`@` picks the ref and `:` picks the subfolder; the subpath is required, since
every plugin in that repo is a folder in it. Or clone the repo and use
**Register Plugin…** on the folder, which is the better loop while editing —
though note a registered symlink of an id blocks a GitHub install of the same id
(`"<id>" is a registered link, not a directory from a source — unregister it
first.`).

Then tick it on the seat that should hold it. Content is bound when a seat
starts, so a running seat picks it up at its next start.

## License

Apache-2.0.
