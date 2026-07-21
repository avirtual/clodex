# Recipe: a Clodex node as a Kubernetes pod

Same node contract as everywhere: the published image self-configures; the
manifest only names it, feeds it secrets, and gives it storage. No ingress,
no service exposure — reachability is `kubectl port-forward` through
clodexctl's tunnel transport, so the customer's RBAC is the access control.

## 1. Secrets

```sh
kubectl create secret generic clodex-node \
  --from-literal=CLODEX_REMOTE_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="<claude setup-token output>"
```

(Bedrock variant: drop the OAuth key and use IRSA + `CLAUDE_CODE_USE_BEDROCK=1`
— see the Fargate recipe §4; identical mechanism via the service account.)

## 2. Manifest

`clodex-node.yaml` — a StatefulSet so `/data` (sessions, transcripts)
survives restarts:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: clodex-node
spec:
  serviceName: clodex-node
  replicas: 1
  selector: { matchLabels: { app: clodex-node } }
  template:
    metadata:
      labels: { app: clodex-node }
    spec:
      containers:
        - name: clodex
          image: ghcr.io/avirtual/clodex:VERSION
          ports: [{ containerPort: 7900, name: wire }]
          env:
            - { name: CLODEX_DATA_DIR, value: /data }
          envFrom:
            - secretRef: { name: clodex-node }
          volumeMounts:
            - { name: data, mountPath: /data }
          resources:
            requests: { cpu: "500m", memory: 2Gi }
            limits:   { memory: 4Gi }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 5Gi } }
```

No Service, no Ingress — deliberately. The wire binds 0.0.0.0 *inside the
pod netns* and is token-gated; nothing routes to it except port-forward.
Publishing it via an Ingress on the open internet is not a documented mode
(deployment-plan §exposure posture).

## 3. Reach it

```sh
kubectl apply -f clodex-node.yaml

clodexctl ctx add k8s --kubectl pod/clodex-node-0 --token <wire-token>
#   [--namespace CUSTOMER] [--kube-context ENGAGEMENT]

clodexctl --ctx k8s ctx test
clodexctl --ctx k8s spawn worker --type claude --cwd /home/clodex/work
clodexctl --ctx k8s run worker "…"
```

`--kubectl POD_OR_SVC` is a built-in template over the tunnel mechanism — it
expands to `kubectl [--context C] [-n NS] port-forward POD_OR_SVC {port}:7900`.
Namespace/context are `--namespace` / `--kube-context` flags (the latter avoids
colliding with clodexctl's own `--ctx`). The typed kind is **data** (safe to
`ctx import`/share); the raw `--tunnel kubectl port-forward …` form still works
if you need a custom argv. clodexctl relays kubectl's stderr on failure
(`ctx test --verbose`).

## 4. Teardown

`kubectl delete statefulset clodex-node && kubectl delete secret clodex-node`
(the PVC survives unless you delete it — that's the session history).
Per-engagement namespace + per-engagement secrets, deleted after; the node
is a trust boundary (deployment-plan §threat).
