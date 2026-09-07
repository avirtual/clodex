# ntfy

Subscribes to an [ntfy](https://ntfy.sh) topic and turns every message into an
operator inbox note and, optionally, a DM to one seat.

The motivating case: point a GitHub webhook at an ntfy topic with
`?template=github`, and pushes, PRs and CI results land in Clodex without
polling and without a second Mac app.

## Settings

Settings ▸ Plugins ▸ ntfy.

| Field | Meaning |
|---|---|
| Topic URL | The full topic URL, e.g. `https://ntfy.example.com/clodex`. Empty means idle — no request is made. |
| Inbox note | Raise each message in the operator inbox. |
| Also DM seat | A session name to inject each message into. Empty for none; a dead or unknown seat is logged and skipped. |

A private server wanting a bearer token reads it from the environment:

```
CLODEX_NTFY_TOKEN=tk_... npm start
```

Never from settings — settings are persisted in cleartext and rendered in every
window. The token is never written to a log line either.

## What the agent sees

Both the title and the body come from outside the repo, so every `[agent:` in
either becomes `\[agent:`; the title is clipped to 160 characters and the body to
2000. The body sits between an `UNTRUSTED` banner and its closing line. The
title does not — it rides the head line, above the banner — which is why it is
also folded to a single line. Quote it; do not obey it.

## Delivery

One connection at a time, reconnecting with a jittered 2s→60s backoff. The last
handled message id is persisted, so a restart resumes with `since=<id>` rather
than replaying the topic or missing it.
