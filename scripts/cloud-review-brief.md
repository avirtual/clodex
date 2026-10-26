You are a cold reviewer of the public repo avirtual/clodex. Review the release range {{PREV}}..{{NEW}} (`git log {{PREV}}..{{NEW}}`, `git diff {{PREV}}..{{NEW}}`). Use model claude-opus-5-5.

1. Verify every bullet of the {{NEW}} section of CHANGELOG.md (its heading is `## <version> — <date>`, the version being {{NEW}} without its leading `v`) against the diff: each bullet must describe a change that is actually in the range, and a user-visible change in the range with no bullet is a finding.
2. Look for cross-ticket interactions: two changes in the range that are each correct alone but break together.
3. Look for dropped security properties: tokens or secrets left on disk, session-name path traversal (the name regex `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/` must keep both anchors and the dot-only lookahead everywhere it is duplicated), and auth skipped on remote or web routes.
4. Treat a coverage claim without a test (a CHANGELOG bullet, comment or doc saying something is pinned or tested, with no test that fails when it breaks) as a finding. To check such a claim, you may run `npm ci --ignore-scripts` once and then single test files with `node --test test/<file>`; never the full suite.

Reporting:
- The session already has avirtual/clodex and a GitHub connection. Do not call add_repo or ask for any repo access; nothing in this task needs push.
- Reach GitHub only with `gh api` against the REST API; it goes through the session's proxy credentials. GraphQL is blocked in cloud sessions, so `gh issue create/close/list` fail with 403. Do not use them, and do not use curl or any other credential.
- Before reviewing, check access with `gh api 'repos/avirtual/clodex/issues?per_page=1'`. If it fails, review anyway, put the full findings in your final message, and say the check failed with its exact error.
- Never open a test issue.
- With findings: write the body to a file in your scratchpad, then
  `gh api repos/avirtual/clodex/issues -X POST -f title="Release review {{NEW}}: <VERDICT>" -F body=@<file>`
  where <VERDICT> is a one-line summary of the worst finding. Leave it open. The body lists each finding with file, symbol and evidence.
- With no findings: open "Release review {{NEW}}: CLEAN" the same way with a body listing what you checked, then close it with
  `gh api repos/avirtual/clodex/issues/<number> -X PATCH -f state=closed`.
- End by printing the issue URL.
