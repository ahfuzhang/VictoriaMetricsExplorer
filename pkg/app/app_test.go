package app

import (
	"context"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/metricconfig"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

const testToken = "test-sa-token"

// fakeGrafana serves the parts of the Grafana HTTP API the app uses and counts proxy calls.
type fakeGrafana struct {
	*httptest.Server

	mu           sync.Mutex
	datasources  map[string]*datasourceInfo
	proxyCalls   atomic.Int64
	accessProbes atomic.Int64
	apiCalls     atomic.Int64
	badTokens    atomic.Int64
	// proxyStatus, when non-zero, makes every datasource-proxy call fail with that HTTP status
	// (what Grafana answers when the datasource's URL is unreachable).
	proxyStatus atomic.Int64
	// probeGate, when set, holds every access probe until it is released or its caller gives up.
	probeGate atomic.Pointer[probeGate]
}

type probeGate struct {
	started chan struct{} // receives one value per probe that reached the gate
	release chan struct{} // closing it lets the held probes answer
}

func newFakeGrafana(t *testing.T) *fakeGrafana {
	t.Helper()
	g := &fakeGrafana{datasources: map[string]*datasourceInfo{
		"vm1":  {UID: "vm1", OrgID: 1, Name: "VM One", Type: vmDatasourceType, URL: "http://secret-vm.internal:8428", Version: 1},
		"vm2":  {UID: "vm2", OrgID: 1, Name: "VM Two", Type: vmDatasourceType, URL: "http://other.internal:8481/select/0/prometheus", Version: 1},
		"loki": {UID: "loki", OrgID: 1, Name: "Logs", Type: "loki", URL: "http://logs.internal:3100", Version: 1},
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
		for _, uid := range []string{"vm2", "loki", "prom", "vm1"} { // deliberately unsorted
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
		if r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/api/v1/query") && r.URL.Query().Get("query") == "vector(1)" {
			g.accessProbes.Add(1)
			if gate := g.probeGate.Load(); gate != nil {
				gate.started <- struct{}{}
				select {
				case <-gate.release:
				case <-r.Context().Done():
					return
				}
			}
		}
		if status := int(g.proxyStatus.Load()); status != 0 {
			http.Error(w, `{"message":"Bad Gateway"}`, status)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/api/v1/labels"):
			_, _ = w.Write([]byte(`{"status":"success","data":["__name__","job","namespace","pod"]}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/label/__name__/values"):
			_, _ = w.Write([]byte(`{"status":"success","data":["go_goroutines","process_cpu_seconds_total","up","vm_app_version"]}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/label/pod/values"), strings.HasSuffix(r.URL.Path, "/api/v1/label/namespace/values"):
			_, _ = w.Write([]byte(`{"status":"success","data":["default"]}`))
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
	a := newApp(s, func(context.Context) (string, string, error) { return g.URL, testToken, nil }, false)
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
	return callContext(t, context.Background(), a, pCtx, method, path, body)
}

func callContext(t *testing.T, ctx context.Context, a *App, pCtx backend.PluginContext, method, path string, body proto.Message) result {
	t.Helper()
	var payload []byte
	var headers map[string][]string
	if body != nil {
		var err error
		if payload, err = wire.Encode(body); err != nil {
			t.Fatal(err)
		}
		headers = map[string][]string{"Content-Type": {wire.ContentType}, wire.EncodingHeader: {wire.EncodingZstd}}
	}
	var res result
	err := a.CallResource(ctx, &backend.CallResourceRequest{
		PluginContext: pCtx,
		Method:        method,
		Path:          path,
		URL:           path,
		Headers:       headers,
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
	if len(items) != 3 {
		t.Fatalf("expected Prometheus and both VictoriaMetrics datasources, got %v", items)
	}
	if first := items[0].Uid; first != "prom" {
		t.Fatalf("expected datasources sorted by name (Prom first), got %v", first)
	}
	body := prototext.Format(&explorerpb.DatasourcesResponse{Datasources: items})
	for _, leaked := range []string{"internal", "8428", "9090", "loki"} {
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
	for _, tc := range []struct {
		uid, product string
		metricsQL    bool
	}{
		{"vm1", "VictoriaMetrics", true},
		{"prom", "Prometheus", false},
	} {
		t.Run(tc.product, func(t *testing.T) {
			g := newFakeGrafana(t)
			a := newTestApp(t, g, nil)
			res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/"+tc.uid+"/capabilities", nil)
			if res.status != http.StatusOK {
				t.Fatalf("capabilities: %d %s", res.status, res)
			}
			var caps explorerpb.CapabilitiesResponse
			res.decode(t, &caps)
			if caps.UpstreamProduct != tc.product || caps.SupportsMetricsql != tc.metricsQL {
				t.Fatalf("unexpected capabilities: %v", &caps)
			}
			if g.proxyCalls.Load() == 0 {
				t.Fatal("expected the request to reach the Grafana datasource proxy")
			}
			if g.badTokens.Load() != 0 {
				t.Fatalf("%d request(s) reached Grafana without the service-account token", g.badTokens.Load())
			}
		})
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
	firstResp, secondResp := first.metricIndex(t), second.metricIndex(t)
	if firstResp.Meta.GetCacheHit() || !secondResp.Meta.GetCacheHit() {
		t.Fatal("only the second response should come from the cache")
	}
	// Only the meta (request id, timing, cache hit) tells them apart.
	firstResp.Meta, secondResp.Meta = nil, nil
	if !proto.Equal(secondResp, firstResp) {
		t.Fatal("the cached list should give the original response")
	}

	// Same request against a different datasource must not be served from vm1's cache.
	call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/prom/metric-index", req)
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

func TestMetricIndexChecksDatasourceAccessBeforeReadingCache(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	path := "explorer/v1/ds/vm1/metric-index"
	req := &explorerpb.MetricIndexRequest{
		Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000},
	}
	firstUser := viewer(1)
	secondUser := viewer(1)
	secondUser.User.Login = "another-viewer"

	if res := call(t, a, firstUser, http.MethodPost, path, req); res.status != http.StatusOK {
		t.Fatalf("first visit: %d %s", res.status, res)
	}
	g.proxyStatus.Store(http.StatusForbidden)
	if res := call(t, a, secondUser, http.MethodPost, path, req); res.status != http.StatusForbidden ||
		res.errorBody(t).Code != "datasource_denied" {
		t.Fatalf("another user received a cached response without a successful probe: %d %s", res.status, res)
	}
	if res := call(t, a, firstUser, http.MethodPost, path, req); res.status != http.StatusOK ||
		!res.metricIndex(t).Meta.GetCacheHit() {
		t.Fatalf("recent visit should read the cache: %d %s", res.status, res)
	}

	visitOf(t, a, firstUser).lastAccess.Store(time.Now().Add(-datasourceIdleTimeout).UnixNano())
	if res := call(t, a, firstUser, http.MethodPost, path, req); res.status != http.StatusForbidden {
		t.Fatalf("expired visit received a cached response: %d %s", res.status, res)
	}

	// A refusal is remembered: the user is refused again without a probe until it expires.
	g.proxyStatus.Store(0)
	if res := call(t, a, secondUser, http.MethodPost, path, req); res.status != http.StatusForbidden ||
		res.errorBody(t).Code != "datasource_denied" {
		t.Fatalf("a remembered refusal should be answered without a probe: %d %s", res.status, res)
	}
	if got := g.accessProbes.Load(); got != 3 {
		t.Fatalf("got %d access probes, want 3", got)
	}
	expireFailure(t, visitOf(t, a, secondUser))
	if res := call(t, a, secondUser, http.MethodPost, path, req); res.status != http.StatusOK ||
		!res.metricIndex(t).Meta.GetCacheHit() {
		t.Fatalf("successful retry should be able to read the cache: %d %s", res.status, res)
	}
	if got := g.accessProbes.Load(); got != 4 {
		t.Fatalf("got %d access probes, want 4", got)
	}
}

// expireFailure makes the remembered failure of v expire now.
func expireFailure(t *testing.T, v *datasourceVisit) {
	t.Helper()
	f := v.failure.Load()
	if f == nil {
		t.Fatal("no failure is remembered")
	}
	v.failure.Store(&datasourceFailure{until: time.Now().UnixNano(), err: f.err})
}

// visitOf is the access record of user on vm1.
func visitOf(t *testing.T, a *App, user backend.PluginContext) *datasourceVisit {
	t.Helper()
	key := datasourceVisitKey{targetID: a.reg.targets[targetKey(1, "vm1")].id, username: user.User.Login}
	v, ok := datasourceVisits.Load(key)
	if !ok {
		t.Fatalf("no access record for %s", user.User.Login)
	}
	return v.(*datasourceVisit)
}

func TestConcurrentFirstVisitsShareDatasourceAccessProbe(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	user := viewer(1)

	var requests sync.WaitGroup
	for range 8 {
		requests.Go(func() {
			if res := call(t, a, user, http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil); res.status != http.StatusOK {
				t.Errorf("capabilities: %d %s", res.status, res)
			}
		})
	}
	requests.Wait()
	if got := g.accessProbes.Load(); got != 1 {
		t.Fatalf("concurrent first visits made %d access probes, want 1", got)
	}
}

// A request waiting for another one's probe must not inherit that request's cancellation.
func TestCancelledProbeDoesNotFailWaitingRequests(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	gate := &probeGate{started: make(chan struct{}, 2), release: make(chan struct{})}
	g.probeGate.Store(gate)
	path := "explorer/v1/ds/vm1/capabilities"

	ctx, cancel := context.WithCancel(t.Context())
	first := make(chan result, 1)
	go func() { first <- callContext(t, ctx, a, viewer(1), http.MethodGet, path, nil) }()
	<-gate.started

	second := make(chan result, 1)
	go func() { second <- call(t, a, viewer(1), http.MethodGet, path, nil) }()
	// Give the second request time to queue behind the running probe. Arriving later still
	// has to succeed; it only skips the waiting path.
	time.Sleep(50 * time.Millisecond)
	cancel()
	if res := <-first; res.status == http.StatusOK {
		t.Fatalf("the cancelled request should fail: %d %s", res.status, res)
	}

	select {
	case <-gate.started:
	case res := <-second:
		t.Fatalf("the waiting request should probe on its own: %d %s", res.status, res)
	}
	close(gate.release)
	if res := <-second; res.status != http.StatusOK {
		t.Fatalf("the waiting request should probe on its own: %d %s", res.status, res)
	}
	if got := g.accessProbes.Load(); got != 2 {
		t.Fatalf("got %d access probes, want 2", got)
	}
}

func TestDatasourceTypeChangeRefreshesCapabilities(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	a.reg.revalidateEvery = 0
	path := "explorer/v1/ds/vm1/capabilities"
	call(t, a, viewer(1), http.MethodGet, path, nil)
	before := g.proxyCalls.Load()

	g.mu.Lock()
	g.datasources["vm1"].Type = vmclient.PrometheusDatasourceType
	g.mu.Unlock()
	var caps explorerpb.CapabilitiesResponse
	res := call(t, a, viewer(1), http.MethodGet, path, nil)
	res.decode(t, &caps)
	if res.status != http.StatusOK || caps.UpstreamProduct != "Prometheus" || caps.SupportsMetricsql || g.proxyCalls.Load() == before {
		t.Fatalf("changing type must rebuild the target and capabilities: %d %v", res.status, &caps)
	}

	g.mu.Lock()
	g.datasources["vm1"].Type = "loki"
	g.mu.Unlock()
	if res := call(t, a, viewer(1), http.MethodGet, path, nil); res.status != http.StatusForbidden {
		t.Fatalf("unsupported type must invalidate the existing target: %d %s", res.status, res)
	}
}

func TestPrometheusAllowlist(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, &Settings{DatasourceUIDs: []string{"prom"}, DefaultTimeRange: time.Hour, CacheTTL: time.Minute})
	items := call(t, a, viewer(1), http.MethodGet, "explorer/v1/datasources", nil).datasources(t)
	if len(items) != 1 || items[0].Uid != "prom" || items[0].Type != vmclient.PrometheusDatasourceType {
		t.Fatalf("expected only the allowed Prometheus datasource, got %v", items)
	}
	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/prom/capabilities", nil); res.status != http.StatusOK {
		t.Fatalf("allowed Prometheus datasource: %d %s", res.status, res)
	}
	blocked := newTestApp(t, g, &Settings{DatasourceUIDs: []string{"vm1"}})
	before := g.apiCalls.Load()
	if res := call(t, blocked, viewer(1), http.MethodGet, "explorer/v1/ds/prom/capabilities", nil); res.status != http.StatusForbidden {
		t.Fatalf("Prometheus outside allowlist: %d %s", res.status, res)
	}
	if g.apiCalls.Load() != before {
		t.Fatal("denied requests must not reach Grafana")
	}
}

func TestRejectsUnsupportedAndUnknownDatasources(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)

	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/loki/capabilities", nil); res.status != http.StatusForbidden {
		t.Fatalf("loki datasource: expected 403, got %d: %s", res.status, res)
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
		func(context.Context) (string, string, error) { return "", "", vmclient.ErrNoServiceAccount }, false)
	defer a.Dispose()

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/datasources", nil)
	if res.status != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d: %s", res.status, res)
	}
	msg := res.errorBody(t).Message
	for _, want := range []string{"Configuration page", "externalServiceAccounts"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message should tell the admin what to set (%q), got %q", want, msg)
		}
	}
}

// A token set in the app's secureJsonData replaces the managed service account; without one, the app
// asks Grafana for the managed token.
func TestNewAppPrefersTheConfiguredToken(t *testing.T) {
	g := newFakeGrafana(t)
	ctx := config.WithGrafanaConfig(context.Background(), config.NewGrafanaCfg(map[string]string{config.AppURL: g.URL}))
	health := func(secure map[string]string) *backend.CheckHealthResult {
		t.Helper()
		inst, err := NewApp(ctx, backend.AppInstanceSettings{DecryptedSecureJSONData: secure})
		if err != nil {
			t.Fatal(err)
		}
		a := inst.(*App)
		defer a.Dispose()
		got, err := a.CheckHealth(ctx, &backend.CheckHealthRequest{})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}

	if got := health(map[string]string{serviceAccountTokenKey: " " + testToken + "\n"}); got.Status != backend.HealthStatusOk {
		t.Fatalf("the configured token should reach Grafana, got %+v", got)
	}
	if g.badTokens.Load() != 0 {
		t.Fatalf("%d request(s) reached Grafana without the configured token", g.badTokens.Load())
	}
	for _, secure := range []map[string]string{nil, {serviceAccountTokenKey: "  "}} {
		if got := health(secure); got.Status != backend.HealthStatusError || !strings.Contains(got.Message, "externalServiceAccounts") {
			t.Fatalf("without a token (%v) the managed service account is required, got %+v", secure, got)
		}
	}
}

// The configured token belongs to the organization whose settings hold it, so it serves that
// organization instead of being limited to org 1.
func TestConfiguredTokenServesOtherOrganizations(t *testing.T) {
	g := newFakeGrafana(t)
	a := newApp(&Settings{DefaultTimeRange: time.Hour, CacheTTL: time.Minute},
		func(context.Context) (string, string, error) { return g.URL, testToken, nil }, true)
	defer a.Dispose()

	for _, path := range []string{"explorer/v1/datasources", "explorer/v1/ds/vm1/capabilities"} {
		if res := call(t, a, viewer(2), http.MethodGet, path, nil); res.status != http.StatusOK {
			t.Fatalf("%s from org 2: expected 200, got %d: %s", path, res.status, res)
		}
	}
}

func TestRejectedServiceAccountIsReported(t *testing.T) {
	g := newFakeGrafana(t)
	a := newApp(&Settings{DefaultTimeRange: time.Hour, CacheTTL: time.Minute},
		func(context.Context) (string, string, error) { return g.URL, "stale-token", nil }, false)
	defer a.Dispose()

	res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
	if res.status != http.StatusBadGateway || !strings.Contains(res.errorBody(t).Message, "service account") {
		t.Fatalf("expected a 502 naming the service account, got %d: %s", res.status, res)
	}
}

func TestContextReachesMetadataProxyAndHealthRequests(t *testing.T) {
	g := newFakeGrafana(t)
	var seen atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Add(1)
		for key, want := range map[string]string{"Authorization": "Bearer " + testToken, "X-Grafana-Org-Id": "1", "X-Grafana-User": "v", "X-Grafana-Id": "signed-test-id", "X-Request-Id": "request-test"} {
			if got := r.Header.Get(key); got != want {
				t.Errorf("%s: %s = %q, want %q", r.URL.Path, key, got, want)
			}
		}
		if r.Header.Get("Cookie") != "" || r.Header.Get("X-Payload-Encoding") != "" {
			t.Error("browser or body headers leaked")
		}
		g.serve(w, r)
	}))
	t.Cleanup(server.Close)
	settings, _ := ParseSettings(backend.AppInstanceSettings{})
	a := newApp(settings, func(context.Context) (string, string, error) { return server.URL, testToken, nil }, false)
	t.Cleanup(a.Dispose)
	pc := viewer(1)
	pc.PluginID = "explorer"
	headers := map[string][]string{"X-Grafana-Id": {"signed-test-id"}, "X-Request-Id": {"request-test"}, "Cookie": {"secret"}, "X-Payload-Encoding": {"zstd"}}
	err := a.CallResource(t.Context(), &backend.CallResourceRequest{PluginContext: pc, Method: "GET", Path: "explorer/v1/ds/prom/capabilities", URL: "explorer/v1/ds/prom/capabilities", Headers: headers}, backend.CallResourceResponseSenderFunc(func(resp *backend.CallResourceResponse) error {
		if resp.Status != 200 {
			t.Errorf("resource status: %d", resp.Status)
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	health, err := a.CheckHealth(t.Context(), &backend.CheckHealthRequest{PluginContext: pc, Headers: map[string]string{"X-Grafana-Id": "signed-test-id", "X-Request-Id": "request-test"}})
	if err != nil || health.Status != backend.HealthStatusOk {
		t.Fatalf("health: %v, %v", health, err)
	}
	if seen.Load() < 3 {
		t.Fatalf("expected metadata, proxy and health HTTP calls, got %d", seen.Load())
	}
}

// A large datasource response stays on the server, never becoming a browser callback upload.
func TestChartQueryProcessesLargeResponseOnBackend(t *testing.T) {
	g := newFakeGrafana(t)
	var queries atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/datasources/proxy/uid/prom/api/v1/query_range" {
			g.serve(w, r)
			return
		}
		queries.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+testToken || r.Method != http.MethodGet || r.ContentLength > 0 {
			t.Error("expected authenticated server-side GET without an upstream JSON upload")
		}
		// Valid JSON larger than a typical reverse proxy request-body limit.
		_, _ = fmt.Fprint(w, strings.Repeat(" ", 2<<20), `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"__name__":"up"},"values":[[1700000040,"1"]]}]}}`)
	}))
	t.Cleanup(server.Close)
	settings, _ := ParseSettings(backend.AppInstanceSettings{})
	a := newApp(settings, func(context.Context) (string, string, error) { return server.URL, testToken, nil }, false)
	t.Cleanup(a.Dispose)
	res := call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/prom/query-range", &explorerpb.RangeQueryRequest{
		Query: "up", Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000}, Step: "1m",
	})
	if res.status != http.StatusOK {
		t.Fatalf("chart query: %d %s", res.status, res)
	}
	var response explorerpb.RangeQueryResponse
	res.decode(t, &response)
	if queries.Load() != 1 || len(response.Series) != 1 || len(response.Series[0].Values) != 1 || response.Series[0].Values[0] != 1 {
		t.Fatalf("unexpected chart result: %v", &response)
	}
	if len(res.body) > 4096 {
		t.Fatalf("raw upstream response was forwarded: %d bytes", len(res.body))
	}
}

func TestOAuthDatasourceFailsExplicitlyWithoutBrowserRelay(t *testing.T) {
	g := newFakeGrafana(t)
	g.datasources["prom"].JSONData = []byte(`{"oauthPassThru":true}`)
	a := newTestApp(t, g, &Settings{})
	for _, endpoint := range []string{"capabilities", "pod-groups", "query-range"} {
		method := http.MethodGet
		var body proto.Message
		if endpoint == "query-range" {
			method = http.MethodPost
			body = &explorerpb.RangeQueryRequest{Query: "up"}
		}
		res := call(t, a, viewer(1), method, "explorer/v1/ds/prom/"+endpoint, body)
		if res.status != http.StatusUnprocessableEntity {
			t.Fatalf("%s: %d %s", endpoint, res.status, res)
		}
		err := res.errorBody(t)
		if err.Code != "oauth_forwarding_unsupported" || !strings.Contains(err.Message, "OAuth access token") {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if g.proxyCalls.Load() != 0 {
		t.Fatal("OAuth queries must not silently use the service account identity")
	}
	// Stale frontend bundles cannot upload upstream responses to the removed callback.
	res := call(t, a, viewer(1), http.MethodPost, "explorer/v1/oauth/removed", nil)
	if res.status != http.StatusNotFound {
		t.Fatalf("removed callback returned %d", res.status)
	}
}

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
	for _, want := range []string{"datasource access probe failed", "HTTP 502", "/api/v1/query", "Bad Gateway"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("message %q should mention %q", msg, want)
		}
	}
	if body.RequestId == "" {
		t.Fatal("the error should carry a request ID to find it in the Grafana log")
	}

	// The unreachable datasource is not probed again for a while, even once it is back.
	g.proxyStatus.Store(0)
	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil); res.status != http.StatusBadGateway ||
		res.errorBody(t).Code != "upstream_error" {
		t.Fatalf("a remembered unreachable datasource should be answered without a probe: %d %s", res.status, res)
	}
	if got := g.accessProbes.Load(); got != 1 {
		t.Fatalf("got %d access probes, want 1", got)
	}

	expireFailure(t, visitOf(t, a, viewer(1)))
	if res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil); res.status != http.StatusOK {
		t.Fatalf("a failed capabilities call must not be cached, got %d: %s", res.status, res)
	}
	if got := g.accessProbes.Load(); got != 2 {
		t.Fatalf("got %d access probes, want 2", got)
	}
}

func TestDatasourceProbeFailureKinds(t *testing.T) {
	live := t.Context()
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	refused := &url.Error{Op: "Get", URL: "http://grafana/api/datasources/proxy/uid/vm1/api/v1/query", Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}}
	for _, tc := range []struct {
		name        string
		ctx         context.Context
		err         error
		denied      bool
		unreachable bool
	}{
		{"401", live, &vmclient.UpstreamError{StatusCode: http.StatusUnauthorized}, true, false},
		{"403", live, &vmclient.UpstreamError{StatusCode: http.StatusForbidden}, true, false},
		{"502", live, &vmclient.UpstreamError{StatusCode: http.StatusBadGateway}, false, true},
		{"503", live, &vmclient.UpstreamError{StatusCode: http.StatusServiceUnavailable}, false, true},
		{"504", live, &vmclient.UpstreamError{StatusCode: http.StatusGatewayTimeout}, false, true},
		{"500", live, &vmclient.UpstreamError{StatusCode: http.StatusInternalServerError}, false, false},
		{"404", live, &vmclient.UpstreamError{StatusCode: http.StatusNotFound}, false, false},
		{"connection refused", live, refused, false, true},
		{"request cancelled", cancelled, &url.Error{Op: "Get", URL: refused.URL, Err: context.Canceled}, false, false},
		{"malformed answer", live, errors.New("decode response: unexpected end of JSON input"), false, false},
	} {
		if got := isDatasourceDenied(tc.err); got != tc.denied {
			t.Errorf("%s: denied = %v, want %v", tc.name, got, tc.denied)
		}
		if got := isDatasourceUnreachable(tc.ctx, tc.err); got != tc.unreachable {
			t.Errorf("%s: unreachable = %v, want %v", tc.name, got, tc.unreachable)
		}
	}
}

func TestCheckHealth(t *testing.T) {
	g := newFakeGrafana(t)
	a := newTestApp(t, g, nil)
	got, err := a.CheckHealth(context.Background(), &backend.CheckHealthRequest{})
	if err != nil || got.Status != backend.HealthStatusOk || !strings.Contains(got.Message, "3 Prometheus/VictoriaMetrics") {
		t.Fatalf("unexpected healthy result: %+v err=%v", got, err)
	}

	bad := newApp(&Settings{}, func(context.Context) (string, string, error) { return "", "", vmclient.ErrNoServiceAccount }, false)
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
		`{"datasourceUids":[" vm1 ","","vm2"],"podLabel":"pod_name","defaultTimeRange":"6h","cacheTTL":"5m",` +
			`"metricIndexCacheTTL":"1h","upstreamTimeout":"45s"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if len(s.DatasourceUIDs) != 2 || s.DatasourceUIDs[0] != "vm1" || s.PodLabel != "pod_name" ||
		s.DefaultTimeRange != 6*time.Hour || s.CacheTTL != 5*time.Minute || s.NodeLabel != "node" ||
		s.MetricIndexCacheTTL != time.Hour || s.UpstreamTimeout != 45*time.Second {
		t.Fatalf("unexpected settings: %+v", s)
	}
	if s, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{}`)}); err != nil ||
		s.UpstreamTimeout != 120*time.Second || s.MetricIndexCacheTTL != 30*time.Minute {
		t.Fatalf("expected the 120s upstreamTimeout and 30m metricIndexCacheTTL defaults, got %v (err=%v)", s, err)
	}
	for _, bad := range []string{`{"cacheTTL":"soon"}`, `{"defaultTimeRange":"-1h"}`, `{"datasourceUids":"vm1"}`,
		`{"upstreamTimeout":"0s"}`, `{"metricIndexCacheTTL":"-30m"}`} {
		if _, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(bad)}); err == nil {
			t.Fatalf("expected %s to be rejected", bad)
		}
	}
}

// showImportantMetrics defaults to on. Off, the app drops the chart catalog: capabilities tell the UI
// to hide the Important Metrics entry and configured-charts reports the charts as disabled.
func TestShowImportantMetrics(t *testing.T) {
	g := newFakeGrafana(t)
	catalog := &metricconfig.Catalog{Enabled: true}
	for _, tc := range []struct {
		jsonData string
		want     bool
	}{
		{``, true},
		{`{}`, true},
		{`{"showImportantMetrics":true}`, true},
		{`{"showImportantMetrics":false}`, false},
	} {
		inst, err := newConfiguredApp(context.Background(), backend.AppInstanceSettings{JSONData: []byte(tc.jsonData)}, catalog)
		if err != nil {
			t.Fatalf("%s: %v", tc.jsonData, err)
		}
		s := inst.(*App).settings
		inst.(*App).Dispose()
		if s.ShowImportantMetrics != tc.want || (s.MetricCatalog == catalog) != tc.want {
			t.Fatalf("%s: expected showImportantMetrics=%v with the catalog bound accordingly, got %+v", tc.jsonData, tc.want, s)
		}

		a := newTestApp(t, g, s)
		res := call(t, a, viewer(1), http.MethodGet, "explorer/v1/ds/vm1/capabilities", nil)
		var caps explorerpb.CapabilitiesResponse
		res.decode(t, &caps)
		if res.status != http.StatusOK || caps.ImportantMetrics != tc.want {
			t.Fatalf("%s: expected capabilities important_metrics=%v, got %d %v", tc.jsonData, tc.want, res.status, &caps)
		}
		if !tc.want {
			res = call(t, a, viewer(1), http.MethodPost, "explorer/v1/ds/vm1/configured-charts", &explorerpb.ConfiguredChartsRequest{})
			var charts explorerpb.ConfiguredChartsResponse
			res.decode(t, &charts)
			if res.status != http.StatusOK || charts.Enabled {
				t.Fatalf("%s: expected configured charts to be disabled, got %d %v", tc.jsonData, res.status, &charts)
			}
		}
	}
	if _, err := ParseSettings(backend.AppInstanceSettings{JSONData: []byte(`{"showImportantMetrics":"false"}`)}); err == nil {
		t.Fatal("expected a non-boolean showImportantMetrics to be rejected")
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

func TestConfiguredChartsUseDatasourceAndOrganizationScope(t *testing.T) {
	g := newFakeGrafana(t)
	s, _ := ParseSettings(backend.AppInstanceSettings{})
	s.PodLabel = "k8s_pod"
	s.DatasourceUIDs = []string{"vm1", "prom"}
	s.MetricCatalog = &metricconfig.Catalog{Enabled: true, Files: []metricconfig.File{{Category: metricconfig.Category{ID: "example", Title: "Example"}, Charts: []metricconfig.Chart{
		{ID: "cpu", Title: "CPU", Description: "CPU", Language: "metricsql", RateWindow: "1m", Match: metricconfig.Match{MetricNames: []string{"process_cpu_seconds_total"}}, Queries: []metricconfig.Query{{RefID: "A", Expr: "sum(rate({{selector:process_cpu_seconds_total}}[{{rateWindow}}]))"}}, Visualization: metricconfig.Visualization{Type: "timeseries", FieldConfig: map[string]any{"defaults": map[string]any{"unit": "percentunit"}, "overrides": []any{}}}},
		{ID: "missing", Title: "Missing", Language: "metricsql", Match: metricconfig.Match{MetricNames: []string{"nonexistent"}}},
	}}}}
	a := newTestApp(t, g, s)
	req := &explorerpb.ConfiguredChartsRequest{PodGroup: "api.+", Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000}}
	for _, tc := range []struct {
		uid        string
		org        int64
		status     int
		categories int
	}{{"vm1", 1, 200, 1}, {"prom", 1, 200, 0}, {"vm2", 1, 403, 0}, {"vm1", 2, 403, 0}} {
		res := call(t, a, viewer(tc.org), http.MethodPost, "explorer/v1/ds/"+tc.uid+"/configured-charts", req)
		if res.status != tc.status {
			t.Fatalf("%s/org%d: %d %s", tc.uid, tc.org, res.status, res)
		}
		if tc.status != 200 {
			continue
		}
		var response explorerpb.ConfiguredChartsResponse
		res.decode(t, &response)
		if len(response.Categories) != tc.categories {
			t.Fatalf("%s: %v", tc.uid, &response)
		}
		if tc.categories > 0 {
			charts := response.Categories[0].Charts
			if len(charts) != 1 || !strings.Contains(charts[0].Queries[0].Expr, `k8s_pod=~`) || charts[0].Visualization.AsMap()["type"] != "timeseries" {
				t.Fatalf("unexpected planned charts: %v", charts)
			}
		}
	}
}
