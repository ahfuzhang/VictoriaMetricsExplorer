package resource

import (
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

func TestClassifySamples(t *testing.T) {
	cases := []struct {
		name   string
		values []float64
		want   string
	}{
		{"no samples", nil, metricTypeUnknown},
		{"one sample", []float64{3}, metricTypeUnknown},
		{"unchanged", []float64{5, 5, 5, 5}, metricTypeStatValue},
		{"unchanged zero", []float64{0, 0, 0}, metricTypeStatValue},
		{"increasing", []float64{1, 2, 3, 10}, metricTypeCounter},
		{"increasing with plateaus", []float64{1, 1, 2, 2, 3}, metricTypeCounter},
		{"fluctuating", []float64{1, 3, 2, 4}, metricTypeGauge},
		{"decreasing", []float64{9, 7, 5}, metricTypeGauge},
		{"counter reset", []float64{10, 20, 1, 5}, metricTypeGauge},
	}
	for _, tc := range cases {
		if got := classifySamples(tc.values); got != tc.want {
			t.Errorf("%s: classifySamples(%v) = %s, want %s", tc.name, tc.values, got, tc.want)
		}
	}
}

func TestMetricTypeFromName(t *testing.T) {
	if got, ok := metricTypeFromName("container_cpu_usage_seconds_total"); !ok || got != metricTypeCounter {
		t.Errorf("_total: got %q, %v; want counter", got, ok)
	}
	if got, ok := metricTypeFromName("process_resident_memory_bytes"); ok {
		t.Errorf("no suffix: got %q, want no type from the name", got)
	}
}

func TestClassifyMatrixTakesTheMostDynamicSeries(t *testing.T) {
	matrix := func(series ...string) jsontext.Value {
		return jsontext.Value(`{"resultType":"matrix","result":[` + strings.Join(series, ",") + `]}`)
	}
	flat := `{"metric":{"i":"a"},"values":[[1,"4"],[2,"4"],[3,"4"]]}`
	growing := `{"metric":{"i":"b"},"values":[[1,"1"],[2,"2"],[3,"3"]]}`
	wobbly := `{"metric":{"i":"c"},"values":[[1,"1"],[2,"9"],[3,"2"]]}`
	nanOnly := `{"metric":{"i":"d"},"values":[[1,"NaN"],[2,"NaN"]]}`
	single := `{"metric":{"i":"e"},"values":[[1,"7"]]}`

	cases := []struct {
		name string
		data jsontext.Value
		want string
	}{
		{"no series", matrix(), metricTypeUnknown},
		{"only flat", matrix(flat), metricTypeStatValue},
		{"flat and growing", matrix(flat, growing), metricTypeCounter},
		{"flat growing and wobbly", matrix(flat, growing, wobbly), metricTypeGauge},
		{"series without usable samples are ignored", matrix(nanOnly, single, flat), metricTypeStatValue},
		{"nothing usable", matrix(nanOnly, single), metricTypeUnknown},
	}
	for _, tc := range cases {
		got, err := classifyMatrix(tc.data)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}

	if _, err := classifyMatrix(jsontext.Value(`{"result":`)); err == nil {
		t.Error("a truncated response must be an error, not a classification")
	}
}

func TestIsHistogramMemberNeedsAllThreeMetrics(t *testing.T) {
	known := func(names ...string) map[string]struct{} {
		m := make(map[string]struct{}, len(names))
		for _, n := range names {
			m[n] = struct{}{}
		}
		return m
	}
	full := known("rpc_duration_seconds_bucket", "rpc_duration_seconds_count", "rpc_duration_seconds_sum", "up")

	for _, name := range []string{"rpc_duration_seconds_bucket", "rpc_duration_seconds_count", "rpc_duration_seconds_sum"} {
		if !isHistogramMember(name, full) {
			t.Errorf("%s should be part of the histogram", name)
		}
	}
	if isHistogramMember("up", full) {
		t.Error("up is not a histogram member")
	}

	// A bucket metric alone, or with only one sibling, is still a histogram.
	if !isHistogramMember("a_bucket", known("a_bucket")) {
		t.Error("a_bucket without _count and _sum is a histogram")
	}
	if !isHistogramMember("a_count", known("a_bucket", "a_count")) {
		t.Error("a_count next to a_bucket is part of the histogram")
	}
	// The histogram would be displayed as "a", which is already taken.
	if isHistogramMember("a_bucket", known("a", "a_bucket")) {
		t.Error("a_bucket next to a metric named a must stay apart")
	}
	// _count and _sum without any _bucket are grouped as a histogram too.
	if !isHistogramMember("a_count", known("a_count", "a_sum")) {
		t.Error("a_count next to a_sum is part of a histogram")
	}
	if isHistogramMember("a_count", known("a_count")) {
		t.Error("a_count alone is not a histogram")
	}
	// A summary with quantiles exports "a" itself, so its _count and _sum stay apart.
	if isHistogramMember("a_sum", known("a", "a_count", "a_sum")) {
		t.Error("a_sum next to a metric named a must stay apart")
	}
	if isHistogramMember("_sum", known("_bucket", "_count", "_sum")) {
		t.Error("a metric named just a suffix has no base")
	}
}

func TestBuildMetricIndexCollapsesHistogramMembers(t *testing.T) {
	entries := buildMetricIndex([]string{
		"rpc_duration_seconds_sum",
		"up",
		"rpc_duration_seconds_bucket",
		"summary_seconds_count",
		"rpc_duration_seconds_count",
		"summary_seconds_sum",
		"go_gc_pauses_seconds_bucket",
		"requests_total",
	})

	// Sorted by name; the name alone types histograms and _total counters.
	want := []struct {
		name, queryMetric, typ string
		flags                  uint64
	}{
		{"go_gc_pauses_seconds", "go_gc_pauses_seconds_bucket", metricTypeHistogram, 0},
		{"requests_total", "requests_total", metricTypeCounter, 0},
		{"rpc_duration_seconds", "rpc_duration_seconds_bucket", metricTypeHistogram, metricFlagHistogramCount},
		// A bucketless _count/_sum pair collapses to its base name and is queried through _count.
		{"summary_seconds", "summary_seconds_count", metricTypeHistogram, metricFlagHistogramCount},
		{"up", "up", metricTypeUnknown, 0},
	}
	if len(entries) != len(want) {
		t.Fatalf("expected %d rows, got %v", len(want), entries)
	}
	for i, w := range want {
		e := entries[i]
		if e.Name != w.name || e.QueryMetric != w.queryMetric || e.Type != w.typ || e.BitFlags != w.flags {
			t.Errorf("row %d = %v, want %+v", i, e, w)
		}
	}

	histogram := entries[2]
	for _, search := range []string{"rpc_duration_seconds", "_bucket", "_count", "_sum"} {
		matches := filterMetricIndex([]*explorerpb.MetricInfo{histogram}, func(alias string) bool {
			return strings.Contains(alias, search)
		})
		if len(matches) != 1 {
			t.Errorf("collapsed histogram should match search %q", search)
		}
	}

	filtered := filterMetricIndex(slices.Clone(entries), func(alias string) bool { return alias == "rpc_duration_seconds_sum" })
	if len(filtered) != 1 || filtered[0].QueryMetric != "rpc_duration_seconds_bucket" {
		t.Fatalf("a favorite histogram member must resolve to the collapsed bucket entry: %v", filtered)
	}
}

// upstreamCalls counts the requests a harness's fake datasource answered.
type upstreamCalls struct {
	labelValues  atomic.Int64
	rangeQueries atomic.Int64
	zeroChecks   atomic.Int64
}

// metricTypesHarness serves a fake datasource proxy: __name__ label values from names, and
// query_range matrices from series, keyed by metric name. It returns the count of range queries.
func metricTypesHarness(t *testing.T, names []string, series map[string]string, datasourceType ...string) (*Handlers, *atomic.Int64) {
	t.Helper()
	h, calls := newHarness(t, names, series, datasourceType...)
	return h, &calls.rangeQueries
}

// newHarness is metricTypesHarness returning every count.
func newHarness(t *testing.T, names []string, series map[string]string, datasourceType ...string) (*Handlers, *upstreamCalls) {
	t.Helper()
	calls := &upstreamCalls{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		// Every label's values are the given names (metric names, or pod names for pod-groups).
		case strings.Contains(r.URL.Path, "/api/v1/label/") && strings.HasSuffix(r.URL.Path, "/values"):
			calls.labelValues.Add(1)
			data, _ := json.Marshal(names)
			_, _ = w.Write([]byte(`{"status":"success","data":` + string(data) + `}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/query_range"):
			calls.rangeQueries.Add(1)
			query := r.URL.Query().Get("query")
			for name, values := range series {
				if query == `{__name__="`+name+`"}` {
					_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[` + values + `]}}`))
					return
				}
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/query"):
			query := r.URL.Query().Get("query")
			// The zero-counter check: report the maximum of every listed counter that has series.
			if strings.HasPrefix(query, "max by (__name__) (max_over_time(") || strings.HasPrefix(query, "label_replace(max(max_over_time(") {
				calls.zeroChecks.Add(1)
				if len(datasourceType) > 0 && datasourceType[0] == vmclient.PrometheusDatasourceType && strings.Contains(query, "keep_metric_names") {
					t.Error("Prometheus received a MetricsQL query")
					http.Error(w, "unsupported query", http.StatusBadRequest)
					return
				}
				var result []string
				for name, values := range series {
					if strings.Contains(query, regexp.QuoteMeta(name)) {
						maximum := "0"
						if !strings.Contains(values, `"0"]]`) {
							maximum = "1"
						}
						result = append(result, `{"metric":{"__name__":"`+name+`"},"value":[1,"`+maximum+`"]}`)
					}
				}
				_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[` + strings.Join(result, ",") + `]}}`))
				return
			}
			// Raw samples for the chart plan's sample interval probe, e.g. {__name__="up"}[1h].
			for name, values := range series {
				if query == `{__name__="`+name+`"}[1h]` {
					_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[` + values + `]}}`))
					return
				}
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)

	cfg := vmclient.Config{
		UID:              "vm",
		DefaultTimeRange: time.Hour,
		Credentials: func(context.Context) (string, string, error) {
			return upstream.URL, "token", nil
		},
	}
	if len(datasourceType) > 0 {
		cfg.DatasourceType = datasourceType[0]
	}
	lim := limits.Default()
	obs := observability.New("vm")
	t.Cleanup(obs.Close)
	client, err := vmclient.New(cfg, lim, obs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	c := cache.New(32 << 20)
	t.Cleanup(c.Close)

	return NewRouter(client, c.Scope(), lim, obs, cfg).handlers, calls
}

func TestHandleMetricIndexReturnsHistogramDisplayNameAndQueryMetric(t *testing.T) {
	h, _ := metricTypesHarness(t, []string{
		"rpc_duration_seconds_bucket",
		"rpc_duration_seconds_count",
		"rpc_duration_seconds_sum",
		"up",
	}, nil)

	req := postProto(t, "/explorer/v1/metric-index", &explorerpb.MetricIndexRequest{
		Search:    "rpc_duration_seconds_sum",
		GroupMode: explorerpb.GroupMode_GROUP_MODE_PREFIX,
		Page:      1,
		PageSize:  20,
		Sort:      "name",
	})
	rec := httptest.NewRecorder()
	h.handleMetricIndex(rec, req)
	expectOK(t, rec)

	var resp explorerpb.MetricIndexResponse
	decodeProto(t, rec.Body.Bytes(), &resp)
	if resp.TotalCount != 1 || len(resp.Metrics) != 1 {
		t.Fatalf("expected one collapsed histogram row, got %v", &resp)
	}
	metric := resp.Metrics[0]
	if metric.Group != "rpc" {
		t.Fatalf("prefix mode must fill the group, got %q", metric.Group)
	}
	if metric.Name != "rpc_duration_seconds" {
		t.Fatalf("display name must omit _bucket, got %q", metric.Name)
	}
	if metric.QueryMetric != "rpc_duration_seconds_bucket" || metric.Type != metricTypeHistogram {
		t.Fatalf("unexpected histogram query identity: %v", metric)
	}
}

// postMetricIndex runs metric-index for req and returns the response.
func postMetricIndex(t *testing.T, h *Handlers, req *explorerpb.MetricIndexRequest) *explorerpb.MetricIndexResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleMetricIndex(rec, postProto(t, "/explorer/v1/metric-index", req))
	expectOK(t, rec)
	var resp explorerpb.MetricIndexResponse
	decodeProto(t, rec.Body.Bytes(), &resp)
	return &resp
}

// postMetricTypes runs metric-types for metrics and returns the status and the types.
func postMetricTypes(t *testing.T, h *Handlers, metrics ...string) (int, *explorerpb.MetricTypesResponse) {
	t.Helper()
	return postMetricTypesRequest(t, h, &explorerpb.MetricTypesRequest{Metrics: metrics})
}

// postMetricTypesRequest runs metric-types for req and returns the status and the types.
func postMetricTypesRequest(t *testing.T, h *Handlers, req *explorerpb.MetricTypesRequest) (int, *explorerpb.MetricTypesResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleMetricTypes(rec, postProto(t, "/explorer/v1/metric-types", req))
	var resp explorerpb.MetricTypesResponse
	if rec.Code == http.StatusOK {
		decodeProto(t, rec.Body.Bytes(), &resp)
	}
	return rec.Code, &resp
}

// fixedRange is a range inside one UTC day, so every request of a test names the same lists.
var fixedRange = &explorerpb.TimeRange{StartMs: 1_700_000_000_000, EndMs: 1_700_003_600_000}

func TestMetricIndexServesEveryRequestOfAScopeFromOneFetch(t *testing.T) {
	h, calls := newHarness(t, []string{
		"apisix_etcd_reachable", "apisix_http_requests_total",
		"apisix_latency_seconds_bucket", "apisix_latency_seconds_count", "apisix_latency_seconds_sum",
		"go_goroutines", "up",
	}, nil)
	index := func(req *explorerpb.MetricIndexRequest) *explorerpb.MetricIndexResponse {
		req.GroupMode, req.Range = explorerpb.GroupMode_GROUP_MODE_PREFIX, fixedRange
		return postMetricIndex(t, h, req)
	}

	first := index(&explorerpb.MetricIndexRequest{Page: 1, PageSize: 2})
	if first.Meta.CacheHit || first.TotalCount != 5 || first.TotalPages != 3 || len(first.Metrics) != 2 {
		t.Fatalf("unexpected first page: %v", first)
	}
	// Other pages, searches, orders and prefix groups are cut from the cached list.
	second := index(&explorerpb.MetricIndexRequest{Page: 2, PageSize: 2})
	if !second.Meta.CacheHit || second.Metrics[0].Name != "apisix_latency_seconds" || second.Metrics[1].Name != "go_goroutines" {
		t.Fatalf("unexpected second page: %v", second)
	}
	if search := index(&explorerpb.MetricIndexRequest{Search: "LATENCY_SECONDS_SUM"}); search.TotalCount != 1 ||
		search.Metrics[0].QueryMetric != "apisix_latency_seconds_bucket" {
		t.Fatalf("a search for a histogram member must find the collapsed row: %v", search)
	}
	if desc := index(&explorerpb.MetricIndexRequest{Sort: "name_desc"}); desc.Metrics[0].Name != "up" {
		t.Fatalf("name_desc must start with the last name: %v", desc)
	}

	group := index(&explorerpb.MetricIndexRequest{Group: "apisix"})
	if !group.Meta.CacheHit || group.TotalCount != 3 || len(group.Groups) != 1 || group.Groups[0].Count != 3 {
		t.Fatalf("unexpected group: %v", group)
	}
	wantTypes := map[string]string{
		"apisix_etcd_reachable":      metricTypeUnknown,
		"apisix_http_requests_total": metricTypeCounter,
		"apisix_latency_seconds":     metricTypeHistogram,
	}
	for _, m := range group.Metrics {
		if m.Group != "apisix" || m.Type != wantTypes[m.Name] || m.BitFlags&metricFlagZeroChecked != 0 {
			t.Errorf("unexpected row %v", m)
		}
	}

	if n := calls.labelValues.Load(); n != 1 {
		t.Fatalf("expected one label values request for every request of the scope, got %d", n)
	}
}

func TestMetricIndexSearchIsACaseInsensitiveRegexp(t *testing.T) {
	h, calls := newHarness(t, []string{
		"apisix_etcd_reachable", "apisix_http_requests_total",
		"apisix_latency_seconds_bucket", "apisix_latency_seconds_count", "apisix_latency_seconds_sum",
		"apisix_retries_count", "go_goroutines", "up",
	}, nil)
	names := func(search string) []string {
		resp := postMetricIndex(t, h, &explorerpb.MetricIndexRequest{Search: search, Range: fixedRange})
		out := make([]string, 0, len(resp.Metrics))
		for _, m := range resp.Metrics {
			out = append(out, m.Name)
		}
		return out
	}

	for search, want := range map[string][]string{
		"":                       {"apisix_etcd_reachable", "apisix_http_requests_total", "apisix_latency_seconds", "apisix_retries_count", "go_goroutines", "up"},
		"goroutines":             {"go_goroutines"},
		"^APISIX_.*_total$":      {"apisix_http_requests_total"},
		"^(up|go_.+)$":           {"go_goroutines", "up"},
		"latency_seconds_count$": {"apisix_latency_seconds"},
		"LATENCY_SECONDS_SUM":    {"apisix_latency_seconds"},
		"seconds_":               {"apisix_latency_seconds"},
		`^apisix_\w+_reachable$`: {"apisix_etcd_reachable"},
		"^nothing$":              {},
		// A pattern that matches a member suffix on its own would list every histogram.
		"_count$":    {"apisix_retries_count"},
		"count":      {"apisix_retries_count"},
		"_bucket":    {},
		".*_sum$":    {},
		"bucket|^up": {"up"},
	} {
		if got := names(search); !slices.Equal(got, want) {
			t.Errorf("search %q: got %v, want %v", search, got, want)
		}
	}

	before := calls.labelValues.Load()
	rec := httptest.NewRecorder()
	h.handleMetricIndex(rec, postProto(t, "/explorer/v1/metric-index", &explorerpb.MetricIndexRequest{Search: "apisix_["}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid search: status %d, want 400", rec.Code)
	}
	if e := decodeError(t, rec); e.Code != "invalid_search" || e.Message != "missing closing ]: `[`" {
		t.Errorf("invalid search: got %s: %s", e.Code, e.Message)
	}
	if calls.labelValues.Load() != before {
		t.Error("an invalid search must not reach the datasource")
	}
}

func TestMetricTypesWritesBackIntoTheMetricIndexList(t *testing.T) {
	h, calls := newHarness(t, []string{
		"apisix_etcd_reachable", "apisix_http_requests_total", "apisix_idle",
		"apisix_latency_seconds_bucket", "apisix_latency_seconds_count", "apisix_latency_seconds_sum",
		"apisix_go_gc_seconds_bucket", // a histogram without _count
	}, map[string]string{
		"apisix_etcd_reachable":        `{"metric":{},"values":[[1,"1"],[2,"0"],[3,"1"]]}`,
		"apisix_http_requests_total":   `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
		"apisix_latency_seconds_count": `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
		"apisix_go_gc_seconds_bucket":  `{"metric":{},"values":[[1,"3"],[2,"5"]]}`,
		// apisix_idle has no samples in the last hour.
	})
	indexReq := &explorerpb.MetricIndexRequest{GroupMode: explorerpb.GroupMode_GROUP_MODE_PREFIX, Group: "apisix", Range: fixedRange}

	index := postMetricIndex(t, h, indexReq)
	metrics := make([]string, 0, len(index.Metrics))
	for _, m := range index.Metrics {
		if m.BitFlags&metricFlagZeroChecked != 0 {
			t.Fatalf("nothing was looked at yet: %v", m)
		}
		metrics = append(metrics, m.QueryMetric)
	}
	typesReq := &explorerpb.MetricTypesRequest{Metrics: metrics, Range: fixedRange, Group: "apisix"}
	if code, _ := postMetricTypesRequest(t, h, typesReq); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	// The cached list tells the histograms apart: no second label values request.
	if n := calls.labelValues.Load(); n != 1 {
		t.Fatalf("expected the list's single label values request, got %d", n)
	}
	queried := calls.rangeQueries.Load() + calls.zeroChecks.Load()

	type row struct {
		typ  string
		zero bool
	}
	want := map[string]row{
		"apisix_etcd_reachable":      {metricTypeGauge, false},
		"apisix_go_gc_seconds":       {metricTypeHistogram, false},
		"apisix_http_requests_total": {metricTypeCounter, true},
		"apisix_idle":                {metricTypeUnknown, false},
		"apisix_latency_seconds":     {metricTypeHistogram, true},
	}
	again := postMetricIndex(t, h, indexReq)
	if !again.Meta.CacheHit || len(again.Metrics) != len(want) {
		t.Fatalf("unexpected list: %v", again)
	}
	for _, m := range again.Metrics {
		w := want[m.Name]
		if m.BitFlags&metricFlagZeroChecked == 0 || m.Type != w.typ || (m.BitFlags&metricFlagZero != 0) != w.zero {
			t.Errorf("%s: got type %q flags %b, want %+v", m.Name, m.Type, m.BitFlags, w)
		}
	}

	// Asking again about metrics the list has looked at costs nothing upstream.
	if code, resp := postMetricTypesRequest(t, h, typesReq); code != http.StatusOK ||
		resp.Types["apisix_etcd_reachable"] != metricTypeGauge || !resp.ZeroValues["apisix_latency_seconds_bucket"] {
		t.Fatalf("status %d, %v", code, resp)
	}
	if n := calls.rangeQueries.Load() + calls.zeroChecks.Load(); n != queried {
		t.Fatalf("expected no further queries, got %d more", n-queried)
	}

	// Another scope's new list is completed from the types inferred for this one.
	pod := postMetricIndex(t, h, &explorerpb.MetricIndexRequest{PodGroup: "apisix", Range: fixedRange})
	for _, m := range pod.Metrics {
		if w := want[m.Name]; m.BitFlags&metricFlagZeroChecked == 0 || m.Type != w.typ {
			t.Errorf("pod scope %s: got type %q flags %b, want %+v", m.Name, m.Type, m.BitFlags, w)
		}
	}
}

func TestHandleMetricTypes(t *testing.T) {
	names := []string{
		"rpc_seconds_bucket", "rpc_seconds_count", "rpc_seconds_sum", // a histogram
		"lonely_bucket",                      // _bucket without _count/_sum is still a histogram
		"gc_seconds_count", "gc_seconds_sum", // _count and _sum without _bucket are a histogram too
		"requests_total", "temperature_celsius", "build_info", "idle_gauge",
	}
	h, rangeQueries := metricTypesHarness(t, names, map[string]string{
		// A counter reset: the _total suffix still makes it a counter, without querying samples.
		"requests_total":      `{"metric":{},"values":[[1,"10"],[2,"20"],[3,"1"]]}`,
		"temperature_celsius": `{"metric":{},"values":[[1,"20"],[2,"23"],[3,"21"]]}`,
		"build_info":          `{"metric":{},"values":[[1,"1"],[2,"1"],[3,"1"]]}`,
		// idle_gauge has no samples in the last hour.
	})

	body := []string{"rpc_seconds_bucket", "rpc_seconds_count", "rpc_seconds_sum", "lonely_bucket",
		"gc_seconds_count", "gc_seconds_sum", "requests_total", "temperature_celsius", "build_info", "idle_gauge", "requests_total", ""}
	code, resp := postMetricTypes(t, h, body...)
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	got := resp.Types
	want := map[string]string{
		"rpc_seconds_bucket":  metricTypeHistogram,
		"rpc_seconds_count":   metricTypeHistogram,
		"rpc_seconds_sum":     metricTypeHistogram,
		"lonely_bucket":       metricTypeHistogram,
		"gc_seconds_count":    metricTypeHistogram,
		"gc_seconds_sum":      metricTypeHistogram,
		"requests_total":      metricTypeCounter,
		"temperature_celsius": metricTypeGauge,
		"build_info":          metricTypeStatValue,
		"idle_gauge":          metricTypeUnknown,
	}
	if len(got) != len(want) {
		t.Fatalf("got %d types, want %d: %v", len(got), len(want), got)
	}
	for name, typ := range want {
		if got[name] != typ {
			t.Errorf("%s: got %q, want %q", name, got[name], typ)
		}
	}

	// Histogram members and _total counters never cost a range query: 3 metrics were queried.
	if n := rangeQueries.Load(); n != 3 {
		t.Fatalf("expected 3 range queries, got %d", n)
	}

	// A repeat is served from the per-metric cache.
	if code, _ := postMetricTypes(t, h, body...); code != http.StatusOK {
		t.Fatalf("repeat status %d", code)
	}
	if n := rangeQueries.Load(); n != 3 {
		t.Fatalf("repeat request must not query again, got %d total range queries", n)
	}
}

func TestHandleMetricTypesRejectsBadRequests(t *testing.T) {
	h, _ := metricTypesHarness(t, nil, nil)

	if code, _ := postMetricTypes(t, h); code != http.StatusBadRequest {
		t.Errorf("empty metrics: status %d, want 400", code)
	}
	badReq := httptest.NewRequest(http.MethodPost, "/explorer/v1/metric-types", strings.NewReader(`{"metrics":["up"]}`))
	badRec := httptest.NewRecorder()
	h.handleMetricTypes(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Errorf("JSON body: status %d, want 400", badRec.Code)
	} else if e := decodeError(t, badRec); e.Code != "parse_request" {
		t.Errorf("JSON body: error code %q, want parse_request", e.Code)
	}

	tooMany := make([]string, metricTypeMaxNames+1)
	for i := range tooMany {
		tooMany[i] = "metric_" + strconv.Itoa(i)
	}
	if code, _ := postMetricTypes(t, h, tooMany...); code != http.StatusBadRequest {
		t.Errorf("too many metrics: status %d, want 400", code)
	}

	req := httptest.NewRequest(http.MethodGet, "/explorer/v1/metric-types", nil)
	rec := httptest.NewRecorder()
	h.handleMetricTypes(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: status %d, want 405", rec.Code)
	}
}

func TestAllSamplesZero(t *testing.T) {
	cases := map[string]bool{
		`{"result":[{"values":[[1,"0"],[2,"0"]]},{"values":[[1,"0"]]}]}`: true,
		`{"result":[{"values":[[1,"0"],[2,"0"]]},{"values":[[1,"3"]]}]}`: false,
		`{"result":[]}`: false, // no samples at all is not a zero value
	}
	for data, want := range cases {
		if got := allSamplesZero(jsontext.Value(data)); got != want {
			t.Errorf("allSamplesZero(%s) = %v, want %v", data, got, want)
		}
	}
}

func TestHandleMetricTypesMarksZeroCounters(t *testing.T) {
	for _, datasourceType := range []string{vmclient.VictoriaMetricsDatasourceType, vmclient.PrometheusDatasourceType} {
		t.Run(datasourceType, func(t *testing.T) {
			h, rangeQueries := metricTypesHarness(t, nil, map[string]string{
				"idle_total":     `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
				"requests_total": `{"metric":{},"values":[[1,"1"],[2,"5"]]}`,
			}, datasourceType)
			code, resp := postMetricTypes(t, h, "idle_total", "requests_total", "missing_total")
			if code != http.StatusOK {
				t.Fatalf("status %d", code)
			}
			for _, name := range []string{"idle_total", "requests_total", "missing_total"} {
				if resp.Types[name] != metricTypeCounter {
					t.Errorf("%s: got %q, want counter", name, resp.Types[name])
				}
			}
			if !resp.ZeroValues["idle_total"] || resp.ZeroValues["requests_total"] || resp.ZeroValues["missing_total"] {
				t.Fatalf("only idle_total is always 0, got %v", resp.ZeroValues)
			}
			// Named counters are checked with one instant query, never a range query.
			if n := rangeQueries.Load(); n != 0 {
				t.Fatalf("expected no range queries, got %d", n)
			}
		})
	}
}

func TestHandleMetricTypesMarksZeroHistograms(t *testing.T) {
	for _, datasourceType := range []string{vmclient.VictoriaMetricsDatasourceType, vmclient.PrometheusDatasourceType} {
		t.Run(datasourceType, func(t *testing.T) {
			names := []string{
				"idle_seconds_bucket", "idle_seconds_count", "idle_seconds_sum",
				"busy_seconds_bucket", "busy_seconds_count", "busy_seconds_sum",
				"buckets_only_bucket",
			}
			h, _ := metricTypesHarness(t, names, map[string]string{
				"idle_seconds_count":  `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
				"busy_seconds_count":  `{"metric":{},"values":[[1,"3"],[2,"9"]]}`,
				"buckets_only_bucket": `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
			}, datasourceType)
			code, resp := postMetricTypes(t, h, "idle_seconds_bucket", "busy_seconds_bucket", "buckets_only_bucket")
			if code != http.StatusOK {
				t.Fatalf("status %d", code)
			}
			want := map[string]bool{"idle_seconds_bucket": true, "buckets_only_bucket": true}
			if !reflect.DeepEqual(resp.ZeroValues, want) {
				t.Fatalf("zeroValues = %v, want %v", resp.ZeroValues, want)
			}
		})
	}
}

func TestPrometheusZeroCounterBatches(t *testing.T) {
	names := make([]string, zeroCounterBatch+1)
	series := make(map[string]string, len(names))
	for i := range names {
		name := "counter_" + strconv.Itoa(1000+i) + "_total"
		names[i] = name
		series[name] = `{"metric":{},"values":[[1,"0"],[2,"0"]]}`
	}
	h, _ := metricTypesHarness(t, nil, series, vmclient.PrometheusDatasourceType)
	code, resp := postMetricTypes(t, h, names...)
	if code != http.StatusOK || len(resp.ZeroValues) != len(names) {
		t.Fatalf("expected all %d zero counters across batches, got status %d: %v", len(names), code, resp.ZeroValues)
	}
}
