// path-confine.js — one caller-supplied name, one path segment, positively
// confined to a directory Clodex owns. Pure leaf (like clodex-paths /
// exec-schema): no electron, no I/O, no requires beyond `path`. NOT in the
// leak-scanner SCANNED lists, same reason clodex-paths isn't.
//
// WHY POSITIVE. Every store here filtered names with a charset regex
// (`/^[a-zA-Z0-9._-]{1,64}$/`) and treated that as containment. It isn't: `.`
// and `..` are spelled entirely in that charset, so `path.join(ROOT, '..')`
// is the parent, `'../..'` its parent, and the filter passes both. A blacklist
// has the same disease one layer up — it has to anticipate every spelling.
// Resolving and comparing does not: a name is safe iff the path it produces is
// a DIRECT CHILD of the root, whatever it looks like.
//
// The charset regexes stay where they are. They give a better error message
// and reject control characters; they are no longer load-bearing for
// containment, and their comments say so.

const path = require('path');

// The resolved `<root>/<name>` if `name` is a single segment inside `root`,
// else null. Case and symlinks are deliberately NOT resolved (no realpath): a
// synchronous stat per call on every list is not worth it, and the roots are
// 0700 dirs Clodex creates itself.
function confine(root, name) {
  if (typeof root !== 'string' || !root) return null;
  if (typeof name !== 'string' || !name) return null;
  const dir = path.resolve(root, name);
  if (path.dirname(dir) !== path.resolve(root)) return null;
  // `path.resolve(root, '.')` IS the root, and its dirname is the root's
  // parent, so the check above already rejects it. Kept explicit because a
  // future reader reaching for `dir !== root` would be writing a blacklist.
  return dir;
}

// Same test, for a caller that wants the name to be fatal rather than absent.
// `label` names the thing in the message ("agent name", "template name") so a
// refusal reads like the store's own errors.
function confineOrThrow(root, name, label = 'name') {
  const dir = confine(root, name);
  if (dir === null) throw new Error(`invalid ${label}: ${name}`);
  return dir;
}

module.exports = { confine, confineOrThrow };
