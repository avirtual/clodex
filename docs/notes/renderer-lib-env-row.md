# docs/notes/renderer-lib-env-row.md

## buildEnvRow

Takes its `document` as a parameter so the row's classes and titles are
assertable without a browser (`test/prefs-env-row.test.js`); renderer.js has no
harness of its own. It sets no inline style deliberately — an inline style
cannot be overridden by the `.prefs-env-row` rules in styles.css, which is where
the name/value flex sizing lives.
