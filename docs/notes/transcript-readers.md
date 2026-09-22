# transcript-readers.js

## readerFor

Pure leaf: no `require`, no fs, no engine state — the same reason
`clodex-paths.js` is not in `test/free-identifier-leaks.test.js`'s scanned
lists, so this file is not listed there either. `readerFor` of an unknown id
returns the per-record sniffing reader (`id: null`), which is what a
`JsonlWatcher` constructed without a `reader` option uses; `claude` and `codex`
share one classify (the watcher's former inline sniff, moved verbatim) and
differ only by id.

## museClassify

Measured 2026-09-22 over 26 Muse Code sessions under
`~/.local/share/muse/sessions/2026/09/22/*/session.jsonl` (1.3.0-R3401.1).
Assistant text is carried ONLY by `payload_type:"runtime.session"` /
`payload.kind:"run"` / `event.kind:"assistant_message_committed"`
(`{message_id, response_id, text}`), one record per committed message with the
full text — no deltas (reasoning has `reasoning_summary_delta`; it is inert).
Turn end is `event.kind:"terminal"` with `event.terminal` in
`completed` (17), `cancelled` (2), `failed` (1) — the design measured only
`completed`; the two others were observed here, so `interrupted` is
`terminal !== 'completed'` on measured data, not fixture-only. Turn start is
`event.kind:"started"` (carries `prompt`, unused). The prompt is
`runtime.user_intent.accepted` `payload.refill_blocks[].text`, joined with
`\n`; `runtime.user_intent.materialized` repeats it and is inert. Between a
message and its `terminal` sit ~10 textless run events
(`goal_usage_attribution`, `context_block_diagnostic`, `model_completed`,
`task_stream_linked`, …), which is why every run event other than the three
named is `inert` — a Claude-style "textless flushes" rule would end every Muse
turn with `turnEnd:false`.

## museExpand

A `retained_frame` line (`{retained_frame, frame_schema_version, transaction_id,
children:[{child_index, record_json}]}`) wraps records as embedded JSON strings;
every measured frame was `session_permission_transaction` and its children were
inert. A `retained_marker:"omitted_live_only"` line stands in for an ephemeral
record the log dropped (`omitted_record.payload_kind:"task"`) and expands to
nothing.
