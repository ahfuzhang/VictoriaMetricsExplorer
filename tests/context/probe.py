"""Exercise real Grafana -> app -> Grafana proxy -> mock, using an isolated test login.
Run against tests/context/run.sh; no production credentials are accepted or used.
"""
import hashlib
import base64
import http.cookiejar
import json
import pathlib
import time
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:13001'
OUT = pathlib.Path('test-results/context-forwarding')
PLUGIN = 'ahfuzhang-victoriametricsexplorer-app'
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def request(path, data=None, headers=None):
    req = urllib.request.Request(BASE + path, data=data, headers=headers or {})
    try:
        with opener.open(req) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()

for _ in range(60):
    try:
        if request('/api/health')[0] == 200:
            break
    except OSError:
        pass
    time.sleep(1)
else:
    raise SystemExit('Grafana did not start')
status, _, _ = request('/login', json.dumps({'user': 'admin', 'password': 'context-test-only'}).encode(),
                       {'Content-Type': 'application/json'})
assert status == 200, status
headers = {'Content-Type': 'application/x-protobuf', 'X-Payload-Encoding': 'zstd',
           'Accept': 'application/x-protobuf', 'Referer': BASE + '/a/' + PLUGIN, 'X-Grafana-Org-Id': '1',
           'X-Request-Id': 'vmx-context-probe', 'X-Correlation-Id': 'vmx-context-correlation',
           'X-Dashboard-Uid': 'context-dashboard', 'X-Panel-Id': '4',
           'X-Grafana-Device-Id': 'context-test-device', 'Accept-Language': 'zh-CN',
           'traceparent': '00-11111111111111111111111111111111-2222222222222222-01',
           'tracestate': 'vmx=contexttest', 'baggage': 'vmx.test=context-forwarding'}
# RangeQueryRequest{query:"up"}, encoded in a single-segment raw zstd frame.
protobuf = b'\x0a\x02up'
body = b'\x28\xb5\x2f\xfd\x20' + bytes([len(protobuf)]) + ((len(protobuf)<<3)|1).to_bytes(3, 'little') + protobuf
results = []
for uid in ['context-plain', 'context-bearer', 'context-oauth']:
    status, response_headers, data = request(f'/api/plugins/{PLUGIN}/resources/explorer/v1/ds/{uid}/query-range', body, headers)
    results.append({'datasource': uid, 'status': status, 'content_type': response_headers.get('Content-Type'), 'bytes': len(data)})
    (OUT / f'{uid}.response').write_bytes(data)
    assert status == (422 if uid == 'context-oauth' else 200), (uid, status, data[:100])
# CheckHealth is the second backend entry point and calls Grafana's datasource metadata API.
status, _, _ = request(f'/api/plugins/{PLUGIN}/health', headers=headers)
results.append({'endpoint': 'CheckHealth', 'status': status})
assert status == 200, status
(OUT / 'results.json').write_text(json.dumps(results, indent=2))
records = [json.loads(line) for line in (OUT / 'upstream-headers.jsonl').read_text().splitlines()]
assert len(records) == 4, [record['path'] for record in records]
for index, prefix in enumerate(['/plain', '/bearer']):
    assert records[2 * index]['path'] == f'{prefix}/api/v1/query?query=vector%281%29'
    assert records[2 * index + 1]['path'].startswith(f'{prefix}/api/v1/query_range?')
for record in records:
    h = {k.lower(): v for k, v in record['headers'].items()}
    for key, expected in [('x-request-id', 'vmx-context-probe'), ('x-dashboard-uid', 'context-dashboard'), ('x-panel-id', '4'), ('x-grafana-org-id', '1')]:
        assert h.get(key) == [expected], (key, h.get(key))
    assert 'cookie' not in h
    assert 'x-payload-encoding' not in h
    assert 'context-oauth' not in record['path']
    if record['path'].startswith('/bearer/'):
        assert h.get('authorization') == ['Bearer mock-upstream-only'], h.get('authorization')
    else:
        assert 'authorization' not in h, 'Grafana service account credential leaked upstream'
    signed = h.get('x-grafana-id', [''])[0]
    if signed:
        payload = signed.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        record['grafana_identity_claims'] = {key: claims.get(key) for key in ['iss', 'aud', 'sub', 'type', 'namespace', 'role']}
        assert claims.get('type') == 'service-account', claims
    # Keep full raw headers locally; redact signed identity tokens in the shareable report.
    for key in list(record['headers']):
        if key.lower() in ('x-grafana-id', 'x-id-token'):
            values = record['headers'][key]
            record['headers'][key] = [f'<redacted; sha256={hashlib.sha256(v.encode()).hexdigest()[:16]}; length={len(v)}>' for v in values]
(OUT / 'headers-redacted.json').write_text(json.dumps(records, indent=2))
print(json.dumps({'results': results, 'upstream': records}, indent=2))
