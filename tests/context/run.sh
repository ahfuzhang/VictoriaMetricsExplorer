#!/bin/sh
# Isolated, reproducible local test. Does not modify existing Grafana containers or volumes.
set -eu
cd "$(dirname "$0")/../.."
OUT="$PWD/test-results/context-forwarding"
mkdir -p "$OUT/plugin" "$OUT/provisioning/plugins" "$OUT/provisioning/datasources"
if docker container inspect vmx-context-grafana >/dev/null 2>&1 || docker container inspect vmx-context-mock >/dev/null 2>&1; then
  echo 'Context test containers already exist; remove them before running this script again.' >&2
  exit 1
fi
npm run build -- --output-path "$OUT/plugin"
CGO_ENABLED=0 GOOS=linux GOARCH="$(docker version --format '{{.Server.Arch}}')" go build -o "$OUT/plugin/gpx_victoriametricsexplorer_linux_$(docker version --format '{{.Server.Arch}}')" .
cat > "$OUT/provisioning/plugins/app.yaml" <<'YAML'
apiVersion: 1
apps:
  - type: ahfuzhang-victoriametricsexplorer-app
    org_id: 1
    disabled: false
    jsonData:
      localCacheSize: 32MB
YAML
cat > "$OUT/provisioning/datasources/mock.yaml" <<'YAML'
apiVersion: 1
datasources:
  - name: Context Plain
    uid: context-plain
    type: prometheus
    access: proxy
    url: http://vmx-context-mock:9091/plain
  - name: Context Bearer
    uid: context-bearer
    type: prometheus
    access: proxy
    url: http://vmx-context-mock:9091/bearer
    jsonData:
      httpHeaderName1: Authorization
    secureJsonData:
      httpHeaderValue1: Bearer mock-upstream-only
  - name: Context OAuth
    uid: context-oauth
    type: prometheus
    access: proxy
    url: http://vmx-context-mock:9091/oauth
    jsonData:
      oauthPassThru: true
YAML
: > "$OUT/upstream-headers.jsonl"
chmod 700 "$OUT"
chmod 600 "$OUT/upstream-headers.jsonl"
docker network inspect vmx-context-test >/dev/null 2>&1 || docker network create vmx-context-test
# Only local synthetic traffic reaches this mock; raw identity headers remain in the evidence file.
docker run -d --name vmx-context-mock --network vmx-context-test -p 127.0.0.1:19092:9091 -v "$PWD/tests/context/mock_prometheus.py:/mock.py:ro" -v "$OUT:/evidence" python:3.13-alpine python /mock.py
docker run -d --name vmx-context-grafana --network vmx-context-test -p 127.0.0.1:13001:13001 \
 -e GF_SECURITY_ADMIN_PASSWORD=context-test-only \
 -e GF_SERVER_HTTP_PORT=13001 \
 -e GF_PLUGINS_PREINSTALL_DISABLED=true \
 -e GF_SERVER_ROOT_URL=http://127.0.0.1:13001 \
 -e GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ahfuzhang-victoriametricsexplorer-app \
 -e GF_FEATURE_TOGGLES_ENABLE=externalServiceAccounts,idForwarding,accessControlOnCallResource \
 -e GF_AUTH_MANAGED_SERVICE_ACCOUNTS_ENABLED=true \
 -e GF_DATAPROXY_SEND_USER_HEADER=true \
 -v "$OUT/plugin:/var/lib/grafana/plugins/ahfuzhang-victoriametricsexplorer-app:ro" \
 -v "$OUT/provisioning:/etc/grafana/provisioning:ro" grafana/grafana:13.2.2
python3 tests/context/probe.py
