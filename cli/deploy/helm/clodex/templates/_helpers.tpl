{{- define "clodex.name" -}}
{{ .Release.Name }}
{{- end }}

{{- define "clodex.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}
{{- end }}

{{- /* Which Secret the pod reads tokens from: the chart-managed one when
a wireToken value was passed (--set-file), else the operator's
existingSecret. Fails the render loudly if neither is provided — a pod
stuck ContainerCreating on a missing Secret is a worse error message. */ -}}
{{- define "clodex.secretName" -}}
{{- if .Values.secrets.wireToken -}}
{{ .Release.Name }}-secrets
{{- else if .Values.secrets.existingSecret -}}
{{ .Values.secrets.existingSecret }}
{{- else -}}
{{ fail "set secrets.wireToken (--set-file) or secrets.existingSecret" }}
{{- end -}}
{{- end }}

{{- define "clodex.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ .Values.serviceAccount.name | default (printf "%s-node" .Release.Name) }}
{{- else -}}
{{ .Values.serviceAccount.name | default "default" }}
{{- end -}}
{{- end }}

{{- define "clodex.labels" -}}
app.kubernetes.io/name: clodex
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "clodex.selectorLabels" -}}
app.kubernetes.io/name: clodex
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
