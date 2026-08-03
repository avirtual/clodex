// exec-schema.js — the payload validator for the `[agent:exec <cmd>] {json}`
// intent. Pure leaf (like clodex-paths / args-model): no electron, no I/O, no
// coordinator state — just a hand-rolled minimal JSON-schema check over an
// already-loaded registry entry + a raw body string. Kept deliberately tiny
// (type/required/maxLength/enum + the `filename` token guard + a raw-body size
// cap) so it stays auditable — a full ajv would be the only runtime dep in the
// tree and is overkill for the handful of fields a registered command declares.
//
// SECURITY SHAPE (why this file is load-bearing):
//   1. The size cap is checked on the RAW body BEFORE JSON.parse, so a huge
//      payload can't force a giant parse before we've had a chance to reject it.
//   2. The `filename` field type triggers the [A-Za-z0-9._-]{1,64} guard (no
//      `/`, no `..`, no leading dot) DECLARATIVELY — a registry entry marks a
//      field `"type":"filename"` and the traversal guard is enforced here, once,
//      for EVERY command, instead of being hand-coded in each wrapper. This is
//      what keeps a payload from choosing WHERE a command writes (it may only
//      choose the name-within-the-registry-fixed-dir).
// The payload NEVER contributes to argv — that rule lives in the dispatcher
// (session-manager `_handleExecIntent`); here we only vet the DATA.

// Absolute ceiling on the raw body if a registry entry omits its own `maxBytes`.
// A registered command should set a tight cap; this is the backstop.
const DEFAULT_MAX_BYTES = 64 * 1024;

// A `filename`-typed field must be a plain name within the command's fixed dir:
// letters/digits/dot/underscore/hyphen, 1-64 chars, AND not start with a dot
// (blocks `.`, `..`, and dotfiles). No `/` is possible under the char class, so
// no path segment — the payload can name a file but never a location.
const FILENAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isFilenameToken(v) {
  return typeof v === 'string' && FILENAME_RE.test(v) && !v.startsWith('.');
}

// Validate an already-parsed value against a schema node. Returns
// { ok: true } or { ok: false, error: '<path>: <reason>' }. Recurses for
// nested objects; supported leaf types: string, number, integer, boolean,
// filename. Unknown schema types are a schema-authoring error (fail closed).
function validateAgainstSchema(schema, value, at = 'payload') {
  if (!schema || typeof schema !== 'object') {
    return { ok: false, error: `${at}: no schema` };
  }
  const t = schema.type;

  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: `${at}: expected object` };
    }
    const props = schema.properties || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) return { ok: false, error: `${at}.${key}: required` };
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return { ok: false, error: `${at}.${key}: not allowed` };
      }
    }
    for (const key of Object.keys(props)) {
      if (!(key in value)) continue; // absent optional — required already checked
      const r = validateAgainstSchema(props[key], value[key], `${at}.${key}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }

  if (t === 'filename') {
    if (!isFilenameToken(value)) {
      return { ok: false, error: `${at}: not a safe filename token ([A-Za-z0-9._-]{1,64}, no leading dot)` };
    }
    return { ok: true };
  }

  if (t === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `${at}: expected string` };
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      return { ok: false, error: `${at}: exceeds maxLength ${schema.maxLength}` };
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      return { ok: false, error: `${at}: below minLength ${schema.minLength}` };
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      return { ok: false, error: `${at}: not one of ${schema.enum.join('|')}` };
    }
    return { ok: true };
  }

  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return { ok: false, error: `${at}: expected ${t}` };
    }
    if (t === 'integer' && !Number.isInteger(value)) {
      return { ok: false, error: `${at}: expected integer` };
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, error: `${at}: below minimum ${schema.minimum}` };
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, error: `${at}: above maximum ${schema.maximum}` };
    }
    return { ok: true };
  }

  if (t === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${at}: expected boolean` };
    return { ok: true };
  }

  return { ok: false, error: `${at}: unknown schema type "${t}"` };
}

// Full gate for one exec: size-cap the RAW body, JSON.parse it, then validate
// against the entry's schema. Returns { ok, value } on success or
// { ok: false, error } on any failure. `entry` is a loaded registry object;
// only `entry.maxBytes` and `entry.schema` are read here.
// Validate a whole registry DEF (the operator-authored `library/exec/<cmd>.json`
// object) at authoring time, so the registration UI can't save a file the exec
// dispatcher (_handleExecIntent) would later refuse. Returns { ok: true } or
// { ok: false, error }. Deliberately a STRUCTURAL check, not a full JSON-schema
// meta-validator: it asserts exactly the shape the dispatcher relies on (a
// non-empty string argv, a present object `schema`, sane optional caps) and
// leans on validateAgainstSchema's fail-closed "unknown schema type" to catch a
// malformed inner schema node loudly at run time. `name` (optional) is checked
// with the same filename-token rule the dispatcher applies to <cmd>, so a def
// can't be authored under a name the backend can't path-join safely.
function validateExecDef(entry, name) {
  if (name !== undefined && !isFilenameToken(name)) {
    return { ok: false, error: `name: not a safe command id ([A-Za-z0-9._-]{1,64}, no leading dot)` };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { ok: false, error: 'def: expected a JSON object' };
  }
  if (!Array.isArray(entry.argv) || entry.argv.length === 0) {
    return { ok: false, error: 'argv: required non-empty array' };
  }
  for (const a of entry.argv) {
    if (typeof a !== 'string' || a.length === 0) {
      return { ok: false, error: 'argv: every element must be a non-empty string' };
    }
  }
  if ('cwd' in entry && typeof entry.cwd !== 'string') {
    return { ok: false, error: 'cwd: must be a string' };
  }
  if ('timeoutMs' in entry && !(typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0)) {
    return { ok: false, error: 'timeoutMs: must be a positive number' };
  }
  if ('maxBytes' in entry && !(typeof entry.maxBytes === 'number' && entry.maxBytes > 0)) {
    return { ok: false, error: 'maxBytes: must be a positive number' };
  }
  // Optional stderr-return opt-in: on exit 0 + non-empty stderr the dispatcher
  // injects the stderr tail back to the invoking seat (failure-path discipline).
  // Strictly boolean so a truthy string can't silently flip a command chatty.
  if ('replyStderr' in entry && typeof entry.replyStderr !== 'boolean') {
    return { ok: false, error: 'replyStderr: must be a boolean' };
  }
  // Optional one-line prose rendered into the granted seat's EXEC prompt section
  // (t81): what the command is for, so an agent can pick one without firing it to
  // find out. Type-checked because it reaches a PROMPT — a number would render as
  // its digits, and a runaway string would be paid on every cache miss forever.
  // A def-level sibling of `schema`, never inside it, so it cannot collide with a
  // command that happens to declare its own `description` payload field.
  if ('description' in entry
      && !(typeof entry.description === 'string' && entry.description.length <= 200)) {
    return { ok: false, error: 'description: must be a string of at most 200 chars' };
  }
  // A command with no schema bounces every payload ("command has no schema") at
  // run time, so require one here. The top node must be an object schema because
  // the payload is always a JSON object handed to validateAgainstSchema.
  if (!entry.schema || typeof entry.schema !== 'object' || entry.schema.type !== 'object') {
    return { ok: false, error: 'schema: required object schema (type: "object")' };
  }
  return { ok: true };
}

function parseAndValidate(entry, raw) {
  const cap = (entry && typeof entry.maxBytes === 'number' && entry.maxBytes > 0)
    ? entry.maxBytes : DEFAULT_MAX_BYTES;
  const rawStr = typeof raw === 'string' ? raw : '';
  const bytes = Buffer.byteLength(rawStr, 'utf8');
  if (bytes > cap) {
    return { ok: false, error: `payload too large (${bytes} bytes > cap ${cap})` };
  }
  const trimmed = rawStr.trim();
  if (!trimmed) return { ok: false, error: 'payload: empty (expected JSON)' };
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `payload: invalid JSON (${e.message})` };
  }
  if (!entry || !entry.schema) {
    return { ok: false, error: 'payload: command has no schema' };
  }
  const r = validateAgainstSchema(entry.schema, value);
  if (!r.ok) return r;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Prompt rendering — the payload GRAMMAR an agent needs to call a command.
//
// Lives here, not in ipc-prompt.js, on purpose: the whole point is that the form
// is DERIVED from the schema rather than hand-written per command, so it must sit
// next to validateAgainstSchema — the two share a type vocabulary, and a new leaf
// type added above without a token here shows up as a visible omission in one
// file instead of silently rotting a prompt in another. ipc-prompt.js is a pure
// leaf and requiring this one keeps it that way (this file has zero requires).
//
// Cost discipline: this text lands in the system prompt of every seat with a
// grant, so it is paid on every cache miss forever. One line per command. Raw
// JSON Schema is never emitted; a nested object renders as `{...}` and optional
// properties as bare NAMES, which is the cheapest thing that still makes a field
// discoverable. argv is never rendered — it can carry absolute paths.

// One leaf type -> its placeholder token. Mirrors the leaf cases of
// validateAgainstSchema; `object` is handled structurally by the caller.
//
// STRING-VALUED tokens carry their own double quotes. The rendered form is meant
// to be copied and filled in, so an unquoted `"action":roster|retire|tickets`
// would teach an agent to emit invalid JSON and earn it a "payload: invalid
// JSON" bounce — which is precisely the class of failure this ticket exists to
// stop. Quoting here rather than at the join keeps the decision with the type.
function typeToken(node) {
  if (!node || typeof node !== 'object') return '<value>';
  if (Array.isArray(node.enum) && node.enum.length) return `"${node.enum.join('|')}"`;
  switch (node.type) {
    case 'string': return '"<string>"';
    case 'filename': return '"<filename>"';
    case 'number': return '<number>';
    case 'integer': return '<int>';
    case 'boolean': return '<bool>';
    case 'object': return '{...}';
    default: return '<value>';
  }
}

// Render the one-line payload form for a command's schema.
//   no required props  -> '{}'   (NOT "takes no payload" — see below)
//   required props     -> {"a":x,"b":y}  + ` optional: c, d` when there are any
//
// The `{}` case is load-bearing and is the whole reason this function does not
// have a "takes no payload" branch: parseAndValidate rejects an EMPTY BODY at
// the raw-string stage, before any schema is consulted, so a command with no
// required properties is still NOT callable bare — it bounces with
// "payload: empty (expected JSON)" and needs a literal {}. Rendering it as
// payload-free would put a fourth false statement into the prompt.
function payloadForm(schema) {
  if (!schema || typeof schema !== 'object') return '{}';
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => typeof k === 'string') : [];
  const optional = Object.keys(props).filter((k) => !required.includes(k));
  const body = required.map((k) => `"${k}":${typeToken(props[k])}`).join(',');
  const form = `{${body}}`;
  return optional.length ? `${form} optional: ${optional.join(', ')}` : form;
}

// One prompt line for one granted command. `def` may be:
//   - a string id            -> id + `{}` and a note that the def was unreadable
//   - { name, description?, schema? } -> id + derived payload form, and the
//     description on a continuation line when the def carries one.
// A def with no description renders WITHOUT a description line rather than with
// an invented one: descriptions are operator-authored, and guessing what an
// unknown command does is worse than saying nothing.
//
// The string branch still prints a payload form. Rendering the id ALONE made the
// degraded line indistinguishable from a healthy no-field command, and a seat
// reading a bare id calls it bare — which bounces with "payload: empty", looks
// like the grant is broken, and sends the seat to the raw shell command the
// grant exists to replace (observed: two bounced calls, then a hand-run
// `npm test` past the suite lock). `{}` is the right guess whatever the schema
// turns out to be: it is the minimum every command accepts, and the note says
// the field list is missing rather than implying there are none.
function commandLines(def) {
  if (typeof def === 'string') return `  [agent:exec ${def}] {}\n      (definition unreadable — payload fields unknown; {} is the minimum, add fields if it reports missing ones)`;
  if (!def || typeof def !== 'object' || !def.name) return '';
  const head = `  [agent:exec ${def.name}] ${payloadForm(def.schema)}`;
  const desc = typeof def.description === 'string' ? def.description.trim() : '';
  return desc ? `${head}\n      ${desc}` : head;
}

module.exports = {
  DEFAULT_MAX_BYTES,
  FILENAME_RE,
  isFilenameToken,
  validateAgainstSchema,
  validateExecDef,
  parseAndValidate,
  typeToken,
  payloadForm,
  commandLines,
};
