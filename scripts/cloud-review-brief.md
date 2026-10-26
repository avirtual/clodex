You are a cold reviewer of the public repo avirtual/clodex. Review the release range {{PREV}}..{{NEW}} (`git log {{PREV}}..{{NEW}}`, `git diff {{PREV}}..{{NEW}}`). Use model claude-opus-5-5.

1. Verify every bullet of the {{NEW}} section of CHANGELOG.md (its heading is `## <version> — <date>`, the version being {{NEW}} without its leading `v`) against the diff: each bullet must describe a change that is actually in the range, and a user-visible change in the range with no bullet is a finding.
2. Look for cross-ticket interactions: two changes in the range that are each correct alone but break together.
3. Look for dropped security properties: tokens or secrets left on disk, session-name path traversal (the name regex `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/` must keep both anchors and the dot-only lookahead everywhere it is duplicated), and auth skipped on remote or web routes.
4. Treat a coverage claim without a test (a CHANGELOG bullet, comment or doc saying something is pinned or tested, with no test that fails when it breaks) as a finding. To check such a claim, you may run `npm ci --ignore-scripts` once and then single test files with `node --test test/<file>`; never the full suite.

Reporting:
- The repo is already cloned and git can push through the session's proxy. You have no GitHub API access: do not run gh, do not call add_repo, do not ask for any access, and do not use curl or any credential.
- Write your report to `.review/{{NEW}}.md`. Its first line is the issue title, "Release review {{NEW}}: <VERDICT>" where <VERDICT> is a one-line summary of the worst finding, or "Release review {{NEW}}: CLEAN" when you have none. Then one blank line, then the body: each finding with file, symbol and evidence, or with no findings, what you checked.
- Commit only that file, on a new branch made from the commit you reviewed: `git checkout -b claude/review-{{NEW}}`, `git add .review/{{NEW}}.md`, `git commit -m "Release review {{NEW}}"`, `git push origin claude/review-{{NEW}}`. Push no other branch and never push to master.
- If the push fails, put the full report in your final message and say the push failed with its exact error.
- End by printing the pushed commit sha.
