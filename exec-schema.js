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

module.exports = {
  DEFAULT_MAX_BYTES,
  FILENAME_RE,
  isFilenameToken,
  validateAgainstSchema,
  parseAndValidate,
};
