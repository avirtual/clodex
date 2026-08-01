// An append-only vector store: a binary blob of fixed-width float32 rows plus a
// JSON sidecar mapping each row to the record that produced it.
//
// WHY NOT THE JSON CACHE IN hint-embed.js. That one holds the whole map in
// memory and rewrites it on every flush, which is right for 184 curated memory
// units and wrong for a corpus that grows daily. Measured over 13,926 records
// at 768 dims:
//
//              size     write all   APPEND ONE   load
//   json blob  212MB      594ms       1114ms      -
//   binary      43MB      223ms          0ms     4ms
//
// Appending one record to the JSON blob costs 1.1 SECONDS because the whole file
// is parsed, mutated and re-serialised. The basket grows ~97 records/day, so
// that is the operation that has to be cheap, not the initial build.
//
// INT8 QUANTIZATION WAS MEASURED AND REJECTED. It would cut 43MB to 11MB, and
// the self-similarity error is negligible (1.07e-4), but over 50 sample queries
// it reordered the top-5 on 4 of them. A store that changes the ANSWER to save
// disk is not a cheaper store, it is a different one. Revisit only with a
// re-ranking pass that restores exact order from the float32 rows.
//
// Rows are never rewritten in place and never deleted. A record whose text
// changed gets a NEW row and the sidecar repoints to it; the old row becomes
// garbage that `compact()` collects. That is what makes an append O(1) and a
// crash mid-write survivable — a torn tail is discarded on load, never merged.

const fs = require('fs');
const path = require('path');

// float32 over float64: the model emits float32-precision values anyway, so
// float64 would double the file to store noise. Fixed width is what makes row N
// addressable without an index.
const BYTES_PER_DIM = 4;

// The sidecar records the dimensionality the blob was written with. A model
// change (or a different model entirely) makes every existing row meaningless,
// and silently cosine-ing 768-dim rows against a 1024-dim query returns
// confident garbage rather than an error.
const SIDECAR_VERSION = 1;

function sidecarPath(file) { return `${file}.idx.json`; }

function readSidecar(file, readFile) {
  try {
    const o = JSON.parse(readFile(sidecarPath(file), 'utf-8'));
    if (!o || o.version !== SIDECAR_VERSION) return null;
    if (!Number.isInteger(o.dims) || o.dims <= 0) return null;
    if (!o.rows || typeof o.rows !== 'object') return null;
    return { dims: o.dims, model: o.model || '', rows: new Map(Object.entries(o.rows)) };
  } catch { return null; }
}

// `key -> row` rather than `row -> key`: lookup by key is the hot path (does
// this record already have a vector?) and row numbers are implicit in the blob.
function createVectorStore({
  file, dims, model = '',
  readFile = fs.readFileSync, writeFile = fs.writeFileSync,
  appendFile = fs.appendFileSync, statFile = fs.statSync,
} = {}) {
  let sidecar = null;
  let blob = null;      // Float32Array view over the whole file
  let rowCount = 0;
  let pendingRows = 0;  // rows appended since the sidecar was last flushed

  function loadBlob() {
    let raw;
    try { raw = readFile(file); } catch { return new Float32Array(0); }
    const whole = Math.floor(raw.length / (dims * BYTES_PER_DIM));
    // A TORN TAIL IS DISCARDED, NOT MERGED. A crash mid-append leaves a partial
    // row; reading it as a vector yields a plausible-looking direction built
    // from whatever bytes landed, which is worse than losing the record.
    const usable = whole * dims;
    // The Buffer may not be 4-byte aligned for a Float32Array view, so copy
    // rather than view when it is not — correctness over one memcpy at load.
    const bytes = usable * BYTES_PER_DIM;
    if (raw.byteOffset % 4 === 0) {
      return new Float32Array(raw.buffer, raw.byteOffset, usable);
    }
    const copy = Buffer.allocUnsafe(bytes);
    raw.copy(copy, 0, 0, bytes);
    return new Float32Array(copy.buffer, copy.byteOffset, usable);
  }

  function load() {
    if (sidecar) return;
    sidecar = readSidecar(file, readFile) || { dims, model, rows: new Map() };
    // A sidecar written for different dimensions or a different model cannot be
    // reconciled with the current one — every row is in the wrong space. Start
    // over rather than mix two vector spaces in one file.
    if (sidecar.dims !== dims || (model && sidecar.model && sidecar.model !== model)) {
      sidecar = { dims, model, rows: new Map() };
      try { writeFile(file, Buffer.alloc(0)); } catch { /* recreated on first append */ }
    }
    blob = loadBlob();
    rowCount = Math.floor(blob.length / dims);
    // The sidecar can outlive its blob (blob deleted, sidecar kept) or point
    // past a truncated one. Any row beyond what the blob actually holds is
    // dropped: a dangling row number reads as a vector of whatever follows.
    for (const [k, r] of [...sidecar.rows]) {
      if (!Number.isInteger(r) || r < 0 || r >= rowCount) sidecar.rows.delete(k);
    }
  }

  function flushSidecar() {
    if (!pendingRows) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Written to a temp path then renamed: rename is atomic, so a crash
      // leaves either the old sidecar or the new one, never a half-parsed file
      // that invalidates the whole blob.
      const tmp = `${sidecarPath(file)}.tmp`;
      writeFile(tmp, JSON.stringify({
        version: SIDECAR_VERSION, dims, model,
        rows: Object.fromEntries(sidecar.rows),
      }));
      fs.renameSync(tmp, sidecarPath(file));
      pendingRows = 0;
    } catch { /* an unflushed sidecar costs a re-embed, never a wrong answer */ }
  }

  return {
    dims,

    has(key) { load(); return sidecar.rows.has(key); },
    size() { load(); return sidecar.rows.size; },
    rows() { load(); return rowCount; },

    get(key) {
      load();
      const r = sidecar.rows.get(key);
      if (r == null) return null;
      return blob.subarray(r * dims, (r + 1) * dims);
    },

    // O(1) in the size of the store: one append of `dims * 4` bytes. The
    // sidecar entry is added in memory and flushed by the caller, so a batch of
    // appends costs one sidecar write rather than one per record.
    add(key, vec) {
      load();
      if (!vec || vec.length !== dims) {
        throw new Error(`vector for ${key} has ${vec ? vec.length : 0} dims, store expects ${dims}`);
      }
      const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        appendFile(file, Buffer.from(f32.buffer, f32.byteOffset, f32.length * BYTES_PER_DIM));
      } catch { return false; }
      // The in-memory view does not grow with the file, so re-read rather than
      // hand back a stale blob on the next get().
      const row = rowCount;
      sidecar.rows.set(key, row);
      rowCount++;
      blob = loadBlob();
      pendingRows++;
      return true;
    },

    flush() { load(); flushSidecar(); },

    // Score every live row against `q`, hottest loop in the module. Returns the
    // top `limit` as {key, sim}. Iterating the SIDECAR rather than the blob is
    // what skips garbage rows from superseded records.
    search(q, { limit = 5, allow = null } = {}) {
      load();
      if (!q || q.length !== dims || !rowCount) return [];
      // Precomputing the query norm hoists a sqrt out of the per-row loop; at
      // 13,926 rows that is 13,926 sqrt calls saved per query.
      let qn = 0;
      for (let i = 0; i < dims; i++) qn += q[i] * q[i];
      qn = Math.sqrt(qn);
      if (!(qn > 0)) return [];

      const out = [];
      for (const [key, row] of sidecar.rows) {
        if (allow && !allow(key)) continue;
        const base = row * dims;
        let dot = 0;
        let vn = 0;
        for (let i = 0; i < dims; i++) {
          const v = blob[base + i];
          dot += q[i] * v;
          vn += v * v;
        }
        const d = qn * Math.sqrt(vn);
        out.push({ key, sim: d > 0 ? dot / d : 0 });
      }
      out.sort((a, b) => (b.sim - a.sim) || String(a.key).localeCompare(String(b.key)));
      return out.slice(0, limit);
    },

    // Rewrite the blob with only the rows the sidecar still points at. Garbage
    // accumulates one row per superseded record, so this is a maintenance
    // operation, not part of any hot path — and it is why `add` can stay O(1).
    compact() {
      load();
      const live = [...sidecar.rows.entries()];
      if (!live.length) return { before: rowCount, after: 0, reclaimed: rowCount };
      const before = rowCount;
      const buf = Buffer.allocUnsafe(live.length * dims * BYTES_PER_DIM);
      const next = new Map();
      live.forEach(([key, row], i) => {
        const src = blob.subarray(row * dims, (row + 1) * dims);
        Buffer.from(src.buffer, src.byteOffset, dims * BYTES_PER_DIM).copy(buf, i * dims * BYTES_PER_DIM);
        next.set(key, i);
      });
      // Same temp-then-rename discipline as the sidecar: a crash here must not
      // leave a blob that is half old rows and half new.
      const tmp = `${file}.tmp`;
      writeFile(tmp, buf);
      fs.renameSync(tmp, file);
      sidecar.rows = next;
      pendingRows = live.length;
      flushSidecar();
      blob = loadBlob();
      rowCount = live.length;
      return { before, after: rowCount, reclaimed: before - rowCount };
    },

    // Bytes on disk, so a caller can decide when compaction is worth it without
    // reaching for fs itself.
    stats() {
      load();
      let bytes = 0;
      try { bytes = statFile(file).size; } catch {}
      return { rows: rowCount, live: sidecar.rows.size, garbage: rowCount - sidecar.rows.size, bytes };
    },
  };
}

module.exports = { createVectorStore, sidecarPath, SIDECAR_VERSION, BYTES_PER_DIM };
