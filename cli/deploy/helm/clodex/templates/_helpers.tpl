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
