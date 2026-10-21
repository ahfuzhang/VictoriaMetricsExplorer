package resource

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
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
	matrix := func(series ...string) json.RawMessage {
		return json.RawMessage(`{"resultType":"matrix","result":[` + strings.Join(series, ",") + `]}`)
	}
	flat := `{"metric":{"i":"a"},"values":[[1,"4"],[2,"4"],[3,"4"]]}`
	growing := `{"metric":{"i":"b"},"values":[[1,"1"],[2,"2"],[3,"3"]]}`
	wobbly := `{"metric":{"i":"c"},"values":[[1,"1"],[2,"9"],[3,"2"]]}`
	nanOnly := `{"metric":{"i":"d"},"values":[[1,"NaN"],[2,"NaN"]]}`
	single := `{"metric":{"i":"e"},"values":[[1,"7"]]}`

	cases := []struct {
		name string
		data json.RawMessage
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

	if _, err := classifyMatrix(json.RawMessage(`{"result":`)); err == nil {
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
	// _count and _sum without any _bucket (a summary) are not a histogram either.
	if isHistogramMember("a_count", known("a_count", "a_sum")) {
		t.Error("a_count and a_sum without _bucket are not a histogram")
	}
	if isHistogramMember("_sum", known("_bucket", "_count", "_sum")) {
		t.Error("a metric named just a suffix has no base")
	}
}

func TestBuildMetricIndexEntriesCollapsesHistogramMembers(t *testing.T) {
	entries := buildMetricIndexEntries([]string{
		"rpc_duration_seconds_sum",
		"up",
		"rpc_duration_seconds_bucket",
		"summary_seconds_count",
		"rpc_duration_seconds_count",
		"summary_seconds_sum",
		"go_gc_pauses_seconds_bucket",
	})

	if len(entries) != 5 {
		t.Fatalf("expected two histograms plus three ordinary metrics, got %#v", entries)
	}
	for _, entry := range entries {
		if entry.Name == "go_gc_pauses_seconds_bucket" ||
			(entry.Name == "go_gc_pauses_seconds" && entry.QueryMetric != "go_gc_pauses_seconds_bucket") {
			t.Fatalf("a bucket-only histogram must collapse to its base name: %#v", entry)
		}
	}
	var histogram *metricIndexEntry
	for i := range entries {
		if entries[i].MetricType == metricTypeHistogram {
			histogram = &entries[i]
			break
		}
	}
	if histogram == nil {
		t.Fatal("expected a collapsed histogram entry")
	}
	if histogram.Name != "rpc_duration_seconds" || histogram.QueryMetric != "rpc_duration_seconds_bucket" {
		t.Fatalf("unexpected histogram entry: %#v", histogram)
	}
	for _, search := range []string{"rpc_duration_seconds", "_bucket", "_count", "_sum"} {
		if !metricIndexEntryMatches(*histogram, search) {
			t.Errorf("collapsed histogram should match search %q", search)
		}
	}

	filtered := filterMetricIndexEntries(entries, []string{"rpc_duration_seconds_sum"})
	if len(filtered) != 1 || filtered[0].QueryMetric != "rpc_duration_seconds_bucket" {
		t.Fatalf("a favorite histogram member must resolve to the collapsed bucket entry: %#v", filtered)
	}
}

// metricTypesHarness serves a fake datasource proxy: __name__ label values from names, and
// query_range matrices from series, keyed by metric name.
func metricTypesHarness(t *testing.T, names []string, series map[string]string) (*Handlers, *atomic.Int64) {
	t.Helper()
	var rangeQueries atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		// Every label's values are the given names (metric names, or pod names for pod-groups).
		case strings.Contains(r.URL.Path, "/api/v1/label/") && strings.HasSuffix(r.URL.Path, "/values"):
			data, _ := json.Marshal(names)
			_, _ = w.Write([]byte(`{"status":"success","data":` + string(data) + `}`))
		case strings.HasSuffix(r.URL.Path, "/api/v1/query_range"):
			rangeQueries.Add(1)
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
			if strings.HasPrefix(query, "max by (__name__) (max_over_time(") {
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
	lim := limits.Default()
	obs := observability.New("vm")
	t.Cleanup(obs.Close)
	client, err := vmclient.New(cfg, lim, obs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	l1 := cache.NewL1(cache.L1Config{MaxEntries: 1000, MaxBytes: 1 << 20, DefaultTTL: time.Minute})
	t.Cleanup(l1.Close)

	return NewRouter(client, l1, lim, obs, cfg).handlers, &rangeQueries
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

// postMetricTypes runs metric-types for metrics and returns the status and the types.
func postMetricTypes(t *testing.T, h *Handlers, metrics ...string) (int, *explorerpb.MetricTypesResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleMetricTypes(rec, postProto(t, "/explorer/v1/metric-types", &explorerpb.MetricTypesRequest{Metrics: metrics}))
	var resp explorerpb.MetricTypesResponse
	if rec.Code == http.StatusOK {
		decodeProto(t, rec.Body.Bytes(), &resp)
	}
	return rec.Code, &resp
}

func TestHandleMetricTypes(t *testing.T) {
	names := []string{
		"rpc_seconds_bucket", "rpc_seconds_count", "rpc_seconds_sum", // a histogram
		"lonely_bucket", // _bucket without _count/_sum is still a histogram
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
		"requests_total", "temperature_celsius", "build_info", "idle_gauge", "requests_total", ""}
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
		if got := allSamplesZero(json.RawMessage(data)); got != want {
			t.Errorf("allSamplesZero(%s) = %v, want %v", data, got, want)
		}
	}
}

func TestHandleMetricTypesMarksZeroCounters(t *testing.T) {
	h, rangeQueries := metricTypesHarness(t, nil, map[string]string{
		"idle_total":     `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
		"requests_total": `{"metric":{},"values":[[1,"1"],[2,"5"]]}`,
	})
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
}

func TestHandleMetricTypesMarksZeroHistograms(t *testing.T) {
	names := []string{
		"idle_seconds_bucket", "idle_seconds_count", "idle_seconds_sum",
		"busy_seconds_bucket", "busy_seconds_count", "busy_seconds_sum",
		"buckets_only_bucket",
	}
	h, _ := metricTypesHarness(t, names, map[string]string{
		"idle_seconds_count":  `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
		"busy_seconds_count":  `{"metric":{},"values":[[1,"3"],[2,"9"]]}`,
		"buckets_only_bucket": `{"metric":{},"values":[[1,"0"],[2,"0"]]}`,
	})
	code, resp := postMetricTypes(t, h, "idle_seconds_bucket", "busy_seconds_bucket", "buckets_only_bucket")
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	want := map[string]bool{"idle_seconds_bucket": true, "buckets_only_bucket": true}
	if !reflect.DeepEqual(resp.ZeroValues, want) {
		t.Fatalf("zeroValues = %v, want %v", resp.ZeroValues, want)
	}
}
