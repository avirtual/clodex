// Model <-> extraArgs projection. The Model field in both session dialogs is a
// VIEW onto the `--model` token inside extraArgs (the single source of truth) —
// no separate persisted field. These pure helpers move the model in and out of
// an argv array (post-parseArgs); the same three forms the library preview
// parses: `--model X`, `-m X`, `--model=X`.

function isModelFlag(t) {
  return t === '--model' || t === '-m' || (typeof t === 'string' && t.startsWith('--model='));
}

// Pull the FIRST model token+value out of argv. Returns { model, rest } with
// rest in original order (model token removed). model is '' when none present.
function splitModelArg(argv) {
  const a = Array.isArray(argv) ? argv : [];
  let model = '';
  const rest = [];
  let taken = false;
  for (let i = 0; i < a.length; i++) {
    if (!taken && (a[i] === '--model' || a[i] === '-m') && a[i + 1] !== undefined) {
      if (isModelFlag(a[i + 1])) {
        taken = true;
        continue;
      }
      model = a[i + 1];
      i++; // consume the value too
      taken = true;
      continue;
    }
    if (!taken && typeof a[i] === 'string' && a[i].startsWith('--model=')) {
      model = a[i].slice('--model='.length);
      taken = true;
      continue;
    }
    rest.push(a[i]);
  }
  return { model, rest };
}

// Project a model value back onto argv. When model is non-empty the field is
// authoritative: strip ANY existing `--model`/`-m`/`--model=` and prepend
// `--model <model>`. When model is empty, return argv UNTOUCHED (F3 pass-through
// — never silently discard a hand-typed `--model` from the args box; the next
// populate splits it back into the field, so no durable dual-source).
function withModelArg(argv, model) {
  const a = Array.isArray(argv) ? argv : [];
  const m = (model || '').trim();
  if (!m) return a.slice();
  // Field is authoritative: strip EVERY existing model token (splitModelArg
  // takes one per pass) so a hand-typed `--model a --model b` can't leave a
  // stale token that a last-wins CLI would let override the field.
  let rest = a;
  let before;
  do { before = rest.length; rest = splitModelArg(rest).rest; } while (rest.length < before);
  return ['--model', m, ...rest];
}

module.exports = { splitModelArg, withModelArg };
