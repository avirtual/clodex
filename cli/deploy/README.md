# cli/deploy/ — the Clodex infra catalog

The infrastructure assets `clodexctl deploy` ships and applies: one file (or
chart) per target platform, each a **reviewable, self-contained deployment
definition** a client security team can read before anything touches their
account or cluster. Everything here is packaged with the `clodexctl` npm
release (`cli/package.json` `files` includes `deploy/`), so `npm i -g` installs
these assets alongside the CLI and the deploy verbs resolve them relative to
their own module (`path.join(__dirname, '..', 'deploy', …)`) — the in-repo run
and the global install find the same bytes.

None of this is generated or templated by application code: the CLI spawns the
operator's own `aws` / `helm` / `kubectl` / `ssh` against these files, never an
SDK, never a shell. What you review here is exactly what runs.

## Assets

| Asset | Deploys | Consumed by | Review posture |
|---|---|---|---|
| `clodex-fargate.yaml` | An AWS Fargate node — an ECS cluster, task IAM roles, the wire-token secret (stack-minted), a log group, the task definition, and an optional self-healing ECS Service — plus a minimal operator IAM policy. | `clodexctl deploy fargate <stack>` (`aws cloudformation deploy`) | A single CloudFormation template. The security posture and the exact outbound egress the task needs are documented in the comment blocks at the top of the file; every resource is `Delete`/`UpdateReplace` so a teardown leaves no footprint. The wire token is defense-in-depth — **IAM is the real access boundary** (see `OperatorPolicy`, which deliberately excludes `ecs:ExecuteCommand`). |
| `helm/clodex/` | A Kubernetes node — a StatefulSet with a persistent volume, a Service, a ServiceAccount, a NetworkPolicy, and the chart-managed Secret — reachable only via `kubectl port-forward`. | `clodexctl deploy helm <name>` (`helm upgrade --install`) | A standard Helm chart. No Ingress, no LoadBalancer: the reviewable surface is the chart, the access path is the operator's own kubectl credentials. Defaults in `values.yaml`; the wirescope proxy is opt-out via `wirescope.enabled`. |
| `clodex-deploy.sh` | A headless Clodex on any ssh-reachable Linux box — a dedicated `clodex` user running a `systemd --user` service on loopback. Idempotent: a re-run **is** the update path. | `clodexctl deploy <user@host>` and `clodexctl deploy ssm <name>` (over ssh / AWS SSM RunCommand) | A single, auditable bash installer. Every step checks before it acts; progress is machine-readable `::step`/`::ok`/`::fail` markers on stdout. This is a **byte-for-byte copy** of `peering/clodex-deploy.sh` (the source of truth in the repo); a drift test pins the two equal. |

## What lives elsewhere (and why)

- **Container image build — `docker/web/Dockerfile`** (+ `docker/web/compose.yaml`).
  This is the *build tooling* for the published image
  (`ghcr.io/avirtual/clodex:<version>`), not a deploy asset: it produces the
  image the Fargate template, the Helm chart, and `deploy docker` all *run*. It
  stays with the other Docker build files under `docker/`.
- **The `deploy docker` flavor** ships no file here — it's one `docker run` of
  that published image, assembled as argv by the CLI.
- **The recipe walkthrough — `docs/recipes/aws-fargate.md`** is the prose
  companion to `clodex-fargate.yaml`: the one-command path at the top, then the
  same stack spelled out by hand as a review-posture alternative.
