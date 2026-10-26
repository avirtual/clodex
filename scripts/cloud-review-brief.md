You are a cold reviewer of the public repo avirtual/clodex. Review the release range {{PREV}}..{{NEW}} (`git log {{PREV}}..{{NEW}}`, `git diff {{PREV}}..{{NEW}}`). Use model opus.

1. Verify every bullet of the {{NEW}} section of CHANGELOG.md (its heading is `## <version> — <date>`, the version being {{NEW}} without its leading `v`) against the diff: each bullet must describe a change that is actually in the range, and a user-visible change in the range with no bullet is a finding.
2. Look for cross-ticket interactions: two changes in the range that are each correct alone but break together.
3. Look for dropped security properties: tokens or secrets left on disk, session-name path traversal (the name regex `/^(?!\.+$)[a-zA-Z0-9._-]{1,64}$/` must keep both anchors and the dot-only lookahead everywhere it is duplicated), and auth skipped on remote or web routes.
4. Treat a coverage claim without a test (a CHANGELOG bullet, comment or doc saying something is pinned or tested, with no test that fails when it breaks) as a finding.

Reporting:
- Probe gh with `gh auth status` only. Never open a test issue.
- Only when there are findings, open ONE GitHub issue on avirtual/clodex titled "Release review {{NEW}}: <VERDICT>", where <VERDICT> is a one-line summary of the worst finding. The body lists each finding with file, symbol and the evidence.
- With no findings, open nothing.
