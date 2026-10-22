package app

import (
	"context"
	json "encoding/json/v2"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

const testToken = "test-sa-token"

// fakeGrafana serves the parts of the Grafana HTTP API the app uses and counts proxy calls.
type fakeGrafana struct {
	*httptest.Server

	mu          sync.Mutex
	datasources map[string]*datasourceInfo
	proxyCalls  atomic.Int64
	apiCalls    atomic.Int64
	badTokens   atomic.Int64
	// proxyStatus, when non-zero, makes every datasource-proxy call fail with that HTTP status
	// (what Grafana answers when the datasource's URL is unreachable).
	proxyStatus atomic.Int64
}

func newFakeGrafana(t *testing.T) *fakeGrafana {
	t.Helper()
	g := &fakeGrafana{datasources: map[string]*datasourceInfo{
		"vm1":  {UID: "vm1", OrgID: 1, Name: "VM One", Type: vmDatasourceType, URL: "http://secret-vm.internal:8428", Version: 1},
		"vm2":  {UID: "vm2", OrgID: 1, Name: "VM Two", Type: vmDatasourceType, URL: "http://other.internal:8481/select/0/prometheus", Version: 1},
		"prom": {UID: "prom", OrgID: 1, Name: "Prom", Type: "prometheus", URL: "http://prom.internal:9090", Version: 1},
	}}
	g.Server = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.Close)
	return g
}

func (g *fakeGrafana) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		g.badTokens.Add(1)
		http.Error(w, `{"message":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()

	switch {
	case r.URL.Path == "/api/datasources":
		g.apiCalls.Add(1)
		list := make([]*datasourceInfo, 0, len(g.datasources))
		for _, uid := range []string{"prom", "vm2", "vm1"} { // deliberately unsorted
			list = append(list, g.datasources[uid])
		}
		_ = json.MarshalWrite(w, list)
	case strings.HasPrefix(r.URL.Path, "/api/datasources/uid/"):
		g.apiCalls.Add(1)
		ds, ok := g.datasources[strings.TrimPrefix(r.URL.Path, "/api/datasources/uid/")]
		if !ok {
			http.Error(w, `{"message":"Data source not found"}`, http.StatusNotFound)
			return
		}
		_ = json.MarshalWrite(w, ds)
	case strings.HasPrefix(r.URL.Path, "/api/datasources/proxy/uid/"):
		g.proxyCalls.Add(1)
		if status := int(g.proxyStatus.Load()); status != 0 {
			http.Error(w, `{"message":"Bad Gateway"}`, status)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/v1/label/__name__/values"):
			_, _ = w.Write([]byte(`{"status":"success","data":["go_goroutines","process_cpu_seconds_total","up","vm_app_version"]}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/labels"):
			_, _ = w.Write([]byte(`{"status":"success","data":["__name__","job","instance","pod","namespace"]}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/status/buildinfo"):
			_, _ = w.Write([]byte(`{"status":"success","data":{"version":"v1.130.0"}}`))
		default:
			_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
		}
	default:
		http.NotFound(w, r)
	}
}

func (g *fakeGrafana) setVersion(uid string, v int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.datasources[uid].Version = v
}

func newTestApp(t *testing.T, g *fakeGrafana, s *Settings) *App {
	t.Helper()
	if s == nil {
		s, _ = ParseSettings(backend.AppInstanceSettings{})
	}
	a := newApp(s, func(context.Context) (string, string, error) { return g.URL, testToken, nil })
	t.Cleanup(a.Dispose)
	return a
}

type result struct {
	status int
	body   []byte
}

// decode decodes the wire-format body into msg.
func (r result) decode(t *testing.T, msg proto.Message) {
	t.Helper()
	if err := wire.Decode(r.body, msg); err != nil {
		t.Fatalf("response is not a %T (%d): %v", msg, r.status, err)
	}
}

// errorBody decodes an error response.
func (r result) errorBody(t *testing.T) *explorerpb.Error {
	t.Helper()
	var e explorerpb.Error
	r.decode(t, &e)
	return &e
}

// String shows an error body in failure messages.
func (r result) String() string {
	var e explorerpb.Error
	if r.status >= 400 && wire.Decode(r.body, &e) == nil {
		return e.Code + ": " + e.Message
	}
	return fmt.Sprintf("<%d bytes>", len(r.body))
}

func (r result) metricIndex(t *testing.T) *explorerpb.MetricIndexResponse {
	t.Helper()
	var resp explorerpb.MetricIndexResponse
	r.decode(t, &resp)
	return &resp
}

func (r result) datasources(t *testing.T) []*explorerpb.DatasourceInfo {
	t.Helper()
	var resp explorerpb.DatasourcesResponse
	r.decode(t, &resp)
	return resp.Datasources
}

func viewer(orgID int64) backend.PluginContext {
	return backend.PluginContext{OrgID: orgID, User: &backend.User{Login: "v", Role: "Viewer"}}
}

func admin() backend.PluginContext {
	return backend.PluginContext{OrgID: 1, User: &backend.User{Login: "a", Role: "Admin"}}
}

func call(t *testing.T, a *App, pCtx backend.PluginContext, method, path string, body proto.Message) result {
	t.Helper()
	var payload []byte
	if body != nil {
		var err error
		if payload, err = wire.Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	var res result
	err := a.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: pCtx,
		Method:        method,
		Path:          path,
		URL:           path,
		Body:          payload,
	}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		res.status = resp.Status
		res.body = append(res.body, resp.Body...)
		return nil
	}))
	if err != nil {
		t.Fatalf("CallResource: %v", err)
	}
	return res
}

func TestListDatasourcesFiltersByTypeAndNeverLeaksURLs(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/datasources", nil)
	if res.status != http.StatusOK {
		t.Fatalf("status %d: %s", res.status, res)
	}
	items := res.datasources(t)
	if len(items) != 2 {
		t.Fatalf("expected the 2 VictoriaMetrics datasources, got %v", items)
	}
	if first := items[0].Uid; first != "vm1" {
		t.Fatalf("expected datasources sorted by name (vm1 first), got %v", first)
	}
	body := prototext.Format(&explorerpb.DatasourcesResponse{Datasources: items})
	for _, leaked := range []string{"internal", "8428", "prom"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("response leaks %q: %s", leaked, body)
		}
	}
}

func TestAllowlistRestrictsDatasources(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, &Settings{DatasourceUIDs: []string{"vm2"}, DefaultTimeRange: time.Hour, CacheTTL: time.Minute})

	list := call(t, a, viewer(1), http.MethodGet, "explorer/v1/datasources", nil).datasources(t)
	if len(list) != 1 || list[0].Uid != "vm2" {
		t.Fatalf("expected only vm2, got %v", list)
	}

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
	if res.status != http.StatusForbidden {
		t.Fatalf("expected 403 for a datasource outside the allowlist, got %d: %s", res.status, res)
	}
	if g.apiCalls.Load() != 1 { // only the list call above; the denied request must not reach Grafana
		t.Fatalf("denied request should not hit Grafana, api calls = %d", g.apiCalls.Load())
	}
}

func TestScopedCallsGoThroughGrafanaProxy(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
	if res.status != http.StatusOK {
		t.Fatalf("capabilities: %d %s", res.status, res)
	}
	var caps explorerpb.CapabilitiesResponse
	res.decode(t, &caps)
	if caps.UpstreamVersion != "v1.130.0" {
		t.Fatalf("expected the version fetched through the proxy, got %v", caps.UpstreamVersion)
	}
	if g.proxyCalls.Load() == 0 {
		t.Fatal("expected the request to reach the Grafana datasource proxy")
	}
	if g.badTokens.Load() != 0 {
		t.Fatalf("%d request(s) reached Grafana without the service-account token", g.badTokens.Load())
	}
}

func TestMetricIndexIsCachedPerDatasource(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	req := &explorerpb.MetricIndexRequest{
		Range:    &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000},
		PageSize: 10,
	}
	first := call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/metric-index", req)
	if first.status != http.StatusOK {
		t.Fatalf("metric-index: %d %s", first.status, first)
	}
	if n := first.metricIndex(t).TotalCount; n != 4 {
		t.Fatalf("expected 4 metrics, got %v", n)
	}
	afterFirst := g.proxyCalls.Load()

	second := call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/metric-index", req)
	if g.proxyCalls.Load() != afterFirst {
		t.Fatalf("second identical request should be served from cache")
	}
	if !proto.Equal(second.metricIndex(t), first.metricIndex(t)) {
		t.Fatal("the cached response should decode to the original one")
	}

	// Same request against a different datasource must not be served from vm1's cache.
	call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm2/metric-index", req)
	if g.proxyCalls.Load() == afterFirst {
		t.Fatalf("a different datasource must not share a cache")
	}
}

func TestDatasourceReconfigurationInvalidatesCache(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	a.reg.revalidateEvery = 0 // look the datasource up on every request

	req := &explorerpb.MetricIndexRequest{Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000}}
	call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/metric-index", req)
	before := g.proxyCalls.Load()

	call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/metric-index", req)
	if g.proxyCalls.Load() != before {
		t.Fatal("unchanged datasource should keep serving from cache")
	}

	g.setVersion("vm1", 2) // e.g. the admin switched the URL / tenant path
	call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/metric-index", req)
	if g.proxyCalls.Load() == before {
		t.Fatal("a reconfigured datasource must start with an empty cache")
	}
}

func TestRejectsNonVictoriaMetricsAndUnknownDatasources(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/prom/capabilities", nil); res.status != http.StatusForbidden {
		t.Fatalf("prometheus datasource: expected 403, got %d: %s", res.status, res)
	}
	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/nope/capabilities", nil); res.status != http.StatusNotFound {
		t.Fatalf("unknown datasource: expected 404, got %d: %s", res.status, res)
	}
	if g.proxyCalls.Load() != 0 {
		t.Fatal("rejected datasources must never be queried")
	}
}

func TestOtherOrganizationsAreRefused(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	for _, path := range []string{"explorer/v1/datasources", "explorer/v1/ds/vm1/capabilities"} {
		res := call(t, a, viewer(2), http.MethodGet, path, nil)
		if res.status != http.StatusForbidden {
			t.Fatalf("%s from org 2: expected 403, got %d: %s", path, res.status, res)
		}
	}
	if g.apiCalls.Load()+g.proxyCalls.Load() != 0 {
		t.Fatal("org 2 requests must not be answered from org 1's service account")
	}
}

func TestCacheEndpointsRequireAdmin(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	for _, path := range []string{"explorer/v1/ds/vm1/cache", "explorer/v1/ds/vm1/cache/purge"} {
		if res := call(t, a, viewer(1), http.MethodPost, path, nil); res.status != http.StatusForbidden {
			t.Fatalf("%s as Viewer: expected 403, got %d", path, res.status)
		}
	}
	if res := call(t, a, admin(), http.MethodPost, "explorer/v1/ds/vm1/cache/purge", nil); res.status != http.StatusOK {
		t.Fatalf("purge as Admin: expected 200, got %d: %s", res.status, res)
	}
}

func TestCachePurgeDropsOnlyThatDatasource(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	req := &explorerpb.MetricIndexRequest{Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000}}
	// upstreamCalls makes a metric-index request and counts the datasource calls it took.
	upstreamCalls := func(uid string) int64 {
		t.Helper()
		before := g.proxyCalls.Load()
		if res := call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/"+uid+"/metric-index", req); res.status != http.StatusOK {
			t.Fatalf("metric-index on %s: %d %s", uid, res.status, res)
		}
		return g.proxyCalls.Load() - before
	}
	upstreamCalls("vm1")
	upstreamCalls("vm2")

	if res := call(t, a, admin(), http.MethodPost, "explorer/v1/ds/vm1/cache/purge", &explorerpb.CachePurgeRequest{}); res.status != http.StatusOK {
		t.Fatalf("purge: %d %s", res.status, res)
	}
	if upstreamCalls("vm1") == 0 {
		t.Fatal("vm1's cache was purged, so its request should reach the datasource")
	}
	if n := upstreamCalls("vm2"); n != 0 {
		t.Fatalf("purging vm1 should leave vm2's cache alone, yet vm2 made %d datasource calls", n)
	}
}

func TestAppCacheHasTheConfiguredSize(t *testing.T) {
	g := newFakeGrafana(t)
	if got := newTestApp(t, g, nil).reg.cache.Stats().MaxBytes; got != 1<<30 {
		t.Fatalf("default capacity %d, want 1GB", got)
	}

	s, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{"localCacheSize":"64MB"}`)})
	if err != nil {
		t.Fatal(err)
	}
	a := newTestApp(t, g, s)
	call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)

	var stats explorerpb.CacheStatsResponse
	call(t, a, admin(), http.MethodGet, "explorer/v1/ds/vm1/cache", nil).decode(t, &stats)
	if stats.MaxBytes != 64<<20 || stats.Entries == 0 || stats.TotalBytes == 0 {
		t.Fatalf("expected a 64MB cache holding the capabilities response, got %v", prototext.Format(&stats))
	}
}

func TestMissingServiceAccountGivesActionableError(t *testing.T) {
	a := newApp(&Settings{DefaultTimeRange: time.Hour, CacheTTL: time.Minute},
		func(context.Context) (string, string, error) { return "", "", vmclient.ErrNoServiceAccount })
	defer a.Dispose()

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/datasources", nil)
	if res.status != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", res.status, res)
	}
	if msg := res.errorBody(t).Message; !strings.Contains(msg, "externalServiceAccounts") {
		t.Fatalf("message should tell the admin what to enable, got %q", msg)
	}
}

func TestRejectedServiceAccountIsReported(t *testing.T) {
	g := newFakeGrafana(t)
	a := newApp(&Settings{DefaultTimeRange: time.Hour, CacheTTL: time.Minute},
		func(context.Context) (string, string, error) { return g.URL, "stale-token", nil })
	defer a.Dispose()

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
	if res.status != http.StatusBadGateway || !strings.Contains(res.errorBody(t).Message, "service account") {
		t.Fatalf("expected a 502 naming the service account, got %d: %s", res.status, res)
	}
}

// An unreachable datasource must be reported by /capabilities (the first call the UI makes), with
// the cause and where it failed, and must not be cached once it recovers.
func TestCapabilitiesReportsUnreachableDatasource(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	g.proxyStatus.Store(http.StatusBadGateway)

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
	if res.status != http.StatusBadGateway {
		t.Fatalf("expected 502 for an unreachable datasource, got %d: %s", res.status, res)
	}
	body := res.errorBody(t)
	if body.Code != "upstream_error" {
		t.Fatalf("expected code upstream_error, got %v", body.Code)
	}
	msg := body.Message
	for _, want := range []string{"cannot read labels", "HTTP 502", "/api/v1/labels", "Bad Gateway"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q should mention %q", msg, want)
		}
	}
	if body.RequestId == "" {
		t.Fatal("the error should carry a request ID to find it in the Grafana log")
	}

	g.proxyStatus.Store(0)
	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil); res.status != http.StatusOK {
		t.Fatalf("a failed capabilities call must not be cached, got %d: %s", res.status, res)
	}
}

func TestCheckHealth(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	got, err := a.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if err != nil || got.Status != backend.HealthStatusOk || !strings.Contains(got.Message, "2 VictoriaMetrics") {
		t.Fatalf("unexpected healthy result: %+v err=%v", got, err)
	}

	bad := newApp(&Settings{}, func(context.Context) (string, string, error) { return "", "", vmclient.ErrNoServiceAccount })
	defer bad.Dispose()
	got, _ = bad.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if got.Status != backend.HealthStatusError || !strings.Contains(got.Message, "managed_service_accounts_enabled") {
		t.Fatalf("unexpected unhealthy result: %+v", got)
	}
}

func TestTargetsAreEvictedBeyondTheCap(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	for i := 0; i < maxTargets+5; i++ {
		uid := fmt.Sprintf("many-%d", i)
		g.mu.Lock()
		g.datasources[uid] = &datasourceInfo{UID: uid, OrgID: 1, Name: uid, Type: vmDatasourceType, Version: 1}
		g.mu.Unlock()
		if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/"+uid+"/capabilities", nil); res.status != http.StatusOK {
			t.Fatalf("%s: %d %s", uid, res.status, res)
		}
	}
	a.reg.mu.Lock()
	n := len(a.reg.targets)
	a.reg.mu.Unlock()
	if n > maxTargets {
		t.Fatalf("expected at most %d live targets, got %d", maxTargets, n)
	}
}

func TestParseSettings(t *testing.T) {
	s, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(
		`{"datasourceUids":[" vm1 ","","vm2"],"podLabel":"pod_name","defaultTimeRange":"6h","cacheTTL":"5m","upstreamTimeout":"45s"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.DatasourceUIDs) != 2 || s.DatasourceUIDs[0] != "vm1" || s.PodLabel != "pod_name" ||
		s.DefaultTimeRange != 6*time.Hour || s.CacheTTL != 5*time.Minute || s.NodeLabel != "node" ||
		s.UpstreamTimeout != 45*time.Second {
		t.Fatalf("unexpected settings: %+v", s)
	}
	if s, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{}`)}); err != nil || s.UpstreamTimeout != 120*time.Second {
		t.Fatalf("expected the 120s upstreamTimeout default, got %v (err=%v)", s, err)
	}
	for _, bad := range []string{`{"cacheTTL":"soon"}`, `{"defaultTimeRange":"-1h"}`, `{"datasourceUids":"vm1"}`, `{"upstreamTimeout":"0s"}`} {
		if _, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(bad)}); err == nil {
			t.Fatalf("expected %s to be rejected", bad)
		}
	}
}

func TestParseSettingsLocalCacheSize(t *testing.T) {
	parse := func(value string) (*Settings, error) {
		return ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{"localCacheSize":` + value + `}`)})
	}

	if s, err := ParseSettings(backend.AppInstanceSettings{}); err != nil || s.LocalCacheSize != 1<<30 {
		t.Fatalf("expected the 1GB default, got %v (err=%v)", s, err)
	}
	for _, tc := range []struct {
		value string
		want  int
	}{
		{`"1GB"`, 1 << 30},
		{`"512MB"`, 512 << 20},
		{`"512mib"`, 512 << 20},
		{`"64M"`, 64 << 20},
		{`" 2 gb "`, 2 << 30},
		{`"1.5GB"`, 3 << 29},
		{`"1TB"`, 1 << 40},
		{`"1048576"`, 1 << 20},
		{`1073741824`, 1 << 30}, // a YAML number is bytes
		{`null`, 1 << 30},       // unset
	} {
		if s, err := parse(tc.value); err != nil || s.LocalCacheSize != tc.want {
			t.Errorf("localCacheSize %s: got %v (err=%v), want %d", tc.value, s, err, tc.want)
		}
	}
	for _, bad := range []string{
		`""`, `"GB"`, `"big"`, `"0"`, `"0.5"`, `"-1GB"`, `"2TB"`, `"1PB"`, `"1.5.5GB"`, `"1 G B"`, `true`, `[1]`, `{}`,
	} {
		if _, err := parse(bad); err == nil {
			t.Errorf("expected localCacheSize %s to be rejected", bad)
		}
	}
}

// The provisioning file is how Grafana hands the app its jsonData; its cache size must parse.
func TestProvisionedLocalCacheSizeIsValid(t *testing.T) {
	data, err := os.ReadFile("../../provisioning/plugins/app.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^\s+localCacheSize:\s*(\S+)\s*$`).FindSubmatch(data)
	if m == nil {
		t.Fatal("provisioning/plugins/app.yaml should set jsonData.localCacheSize")
	}
	value, err := json.Marshal(strings.Trim(string(m[1]), `"'`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{"localCacheSize":` + string(value) + `}`)}); err != nil {
		t.Fatalf("provisioned localCacheSize %s: %v", m[1], err)
	}
}
