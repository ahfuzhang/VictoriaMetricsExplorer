package resource

import (
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

func TestBuildMetricSelector(t *testing.T) {
	filters := map[string][]string{
		"job":        {"api"},
		"instance":   {"a.example", "b"},
		"empty":      {},
		"bad-label!": {"ignored"},
		"__name__":   {"cannot-override-metric"},
	}

	got := buildMetricSelector(`request_duration_seconds_bucket`, filters)
	want := `{__name__="request_duration_seconds_bucket",instance=~"^(?:a\\.example|b)$",job="api"}`
	if got != want {
		t.Fatalf("unexpected selector\nwant: %s\n got: %s", want, got)
	}
}

func TestBuildMetricSelectorEscapesValues(t *testing.T) {
	got := buildMetricSelector(`metric:name`, map[string][]string{
		"path": {`say "hello"`, `C:\\temp`},
	})
	want := `{__name__="metric:name",path=~"^(?:say \"hello\"|C:\\\\\\\\temp)$"}`
	if got != want {
		t.Fatalf("unexpected selector\nwant: %s\n got: %s", want, got)
	}
}

func TestBuildChartQueryReturnsOneCounterSeries(t *testing.T) {
	selector := `{__name__="coredns_kubernetes_rest_client_requests_total",job="coredns"}`

	perSecond, aggregation, visualization := buildChartQuery("counter", selector, "5m", counterFuncRate)
	if perSecond != `sum by () (rate({__name__="coredns_kubernetes_rest_client_requests_total",job="coredns"}[5m]))` {
		t.Fatalf("unexpected per-second query: %s", perSecond)
	}
	if aggregation != "sum_rate" || visualization != "timeseries" {
		t.Fatalf("unexpected plan: aggregation=%s visualization=%s", aggregation, visualization)
	}

	perMinute, aggregation, _ := buildChartQuery("counter", selector, "5m", counterFuncIncrease)
	if perMinute != `sum by () (increase({__name__="coredns_kubernetes_rest_client_requests_total",job="coredns"}[5m]))` {
		t.Fatalf("unexpected low-frequency counter query: %s", perMinute)
	}
	if aggregation != "sum_increase" {
		t.Fatalf("unexpected low-frequency counter aggregation: %s", aggregation)
	}
}

func TestBuildChartQueryUsesRequestedWindow(t *testing.T) {
	selector := `{__name__="dotnet_process_cpu_time_seconds_total"}`

	perMinute, _, _ := buildChartQuery("counter", selector, "1m", counterFuncIncrease)
	if want := `sum by () (increase({__name__="dotnet_process_cpu_time_seconds_total"}[1m]))`; perMinute != want {
		t.Fatalf("unexpected increase query\nwant: %s\n got: %s", want, perMinute)
	}

	perSecond, _, _ := buildChartQuery("counter", selector, "15m", counterFuncRate)
	if want := `sum by () (rate({__name__="dotnet_process_cpu_time_seconds_total"}[15m]))`; perSecond != want {
		t.Fatalf("unexpected rate query\nwant: %s\n got: %s", want, perSecond)
	}

	heatmap, _, viz := buildChartQuery("histogram", selector, "30s", "")
	if want := `sum by (le) (rate({__name__="dotnet_process_cpu_time_seconds_total"}[30s]))`; heatmap != want || viz != "heatmap" {
		t.Fatalf("unexpected histogram query: %s (%s)", heatmap, viz)
	}
	perMinuteHeatmap, aggregation, _ := buildChartQuery("histogram", selector, "1m", counterFuncIncrease)
	if want := `sum by (le) (increase({__name__="dotnet_process_cpu_time_seconds_total"}[1m]))`; perMinuteHeatmap != want ||
		aggregation != "sum_by_le_increase" {
		t.Fatalf("unexpected per-minute histogram query: %s (%s)", perMinuteHeatmap, aggregation)
	}
}

func TestVMRangeHeatmapQuery(t *testing.T) {
	got := vmrangeHeatmapQuery(`{__name__="vm_rows_read_per_query_bucket"}`, "1m", "")
	want := `sum by (le) (label_replace(rate({__name__="vm_rows_read_per_query_bucket"}[1m]), ` +
		`"le", "$1", "vmrange", "([^\\n]+)\\.\\.\\.([^\\n]+)"))`
	if got != want {
		t.Fatalf("unexpected vmrange heatmap query\nwant: %s\n got: %s", want, got)
	}
}

func TestRateWindowForStep(t *testing.T) {
	cases := map[string]string{
		"15s":                         "15s",
		"1m":                          "1m",
		"5m":                          "5m",
		"1h":                          "1h",
		"":                            "5m",
		"auto":                        "5m",
		"30":                          "5m",
		"0m":                          "5m",
		"1m]) or vector(1) or (up[1m": "5m",
	}
	for step, want := range cases {
		if got := rateWindowForStep(step); got != want {
			t.Errorf("rateWindowForStep(%q) = %q, want %q", step, got, want)
		}
	}
}

func TestHandleChartPlanQueryFollowsRequestedStep(t *testing.T) {
	const metric = "dotnet_process_cpu_time_seconds_total"
	h, _ := metricTypesHarness(t, []string{metric}, map[string]string{
		metric: `{"metric":{"instance":"a"},"values":[[1,"1"],[2,"2"],[3,"3"]]}`,
	})

	plan := func(step string) (query, gotStep, rateWindow string) {
		t.Helper()
		resp := postChartPlan(t, h, &explorerpb.ChartPlanRequest{Metric: metric, Step: step})
		return resp.Plan.Query, resp.Plan.Step, resp.Plan.RateWindow
	}

	selector := `{__name__="` + metric + `"}`
	for _, tc := range []struct{ step, window string }{
		// Samples one second apart: the automatic step is the one-minute minimum.
		{"auto", "1m"},
		{"1m", "1m"},
		{"15m", "15m"},
	} {
		query, gotStep, rateWindow := plan(tc.step)
		if want := `sum by () (rate(` + selector + `[` + tc.window + `]))`; query != want {
			t.Errorf("step %q: unexpected query\nwant: %s\n got: %s", tc.step, want, query)
		}
		if rateWindow != tc.window {
			t.Errorf("step %q: rateWindow = %q, want %q", tc.step, rateWindow, tc.window)
		}
		if wantStep := tc.window; gotStep != wantStep {
			t.Errorf("step %q: plan step = %q, want %q", tc.step, gotStep, wantStep)
		}
	}
}

func TestHandleChartPlanAutoStepFollowsSampleInterval(t *testing.T) {
	cases := []struct{ name, values, step string }{
		// Samples two minutes apart, with one missed scrape.
		{"slow_total", `[0,"1"],[120,"2"],[360,"3"],[480,"4"]`, "2m"},
		{"odd_total", `[0,"1"],[90,"2"],[180,"3"]`, "90s"},
		{"fast_total", `[0,"1"],[15,"2"],[30,"3"]`, "1m"},
		{"missing_total", ``, "1m"},
	}
	series := map[string]string{}
	for _, tc := range cases {
		if tc.values != "" {
			series[tc.name] = `{"metric":{"instance":"a"},"values":[` + tc.values + `]}`
		}
	}
	h, _ := metricTypesHarness(t, nil, series)

	for _, tc := range cases {
		resp := postChartPlan(t, h, &explorerpb.ChartPlanRequest{Metric: tc.name, Step: "auto"})
		if resp.Plan.Step != tc.step {
			t.Errorf("%s: step = %q, want %q", tc.name, resp.Plan.Step, tc.step)
		}
		if want := `sum by () (rate({__name__="` + tc.name + `"}[` + tc.step + `]))`; resp.Plan.Query != want {
			t.Errorf("%s: unexpected query\nwant: %s\n got: %s", tc.name, want, resp.Plan.Query)
		}
	}
}

// postChartPlan runs chart-plan for req and decodes its response.
func postChartPlan(t *testing.T, h *Handlers, req *explorerpb.ChartPlanRequest) *explorerpb.ChartPlanResponse {
	t.Helper()
	rec := httptest.NewRecorder()
	h.handleChartPlan(rec, postProto(t, "/explorer/v1/chart-plan", req))
	expectOK(t, rec)
	var resp explorerpb.ChartPlanResponse
	decodeProto(t, rec.Body.Bytes(), &resp)
	return &resp
}

func TestFormatStepKeepsExactDuration(t *testing.T) {
	cases := map[int64]string{15: "15s", 60: "1m", 90: "90s", 120: "2m", 3600: "1h", 5400: "90m", 7200: "2h"}
	for sec, want := range cases {
		if got := formatStep(sec); got != want {
			t.Errorf("formatStep(%d) = %q, want %q", sec, got, want)
		}
	}
}

func TestHandleChartPlanUsesRequestedRateMode(t *testing.T) {
	const metric = "dotnet_process_cpu_time_seconds_total"
	h, _ := metricTypesHarness(t, []string{metric}, map[string]string{
		metric: `{"metric":{"instance":"a"},"values":[[1,"1"],[2,"2"],[3,"3"]]}`,
	})

	selector := `{__name__="` + metric + `"}`
	// A _seconds_total counter keeps its unit in front of the rate.
	for _, tc := range []struct{ mode, query, aggregation, unit string }{
		{"rate", `sum by () (rate(` + selector + `[1m]))`, "sum_rate", "s/s"},
		{"increase", `sum by () (increase(` + selector + `[1m]))`, "sum_increase", "s/min"},
		{"irate", `sum by () (irate(` + selector + `[1m]))`, "sum_irate", "s/s"},
		{"bogus", `sum by () (rate(` + selector + `[1m]))`, "sum_rate", "s/s"},
	} {
		resp := postChartPlan(t, h, &explorerpb.ChartPlanRequest{Metric: metric, Step: "1m", RateMode: tc.mode})
		if resp.Plan.Query != tc.query || resp.Plan.Aggregation != tc.aggregation || resp.Plan.Unit != tc.unit {
			t.Errorf("mode %q: got query=%s aggregation=%s unit=%s", tc.mode, resp.Plan.Query, resp.Plan.Aggregation, resp.Plan.Unit)
		}
	}
}

func TestHandleChartPlanUsesStatVisualizationForConstantMetric(t *testing.T) {
	h, rangeQueries := metricTypesHarness(t, []string{"worker_slots"}, map[string]string{
		"worker_slots": `{"metric":{"instance":"a"},"values":[[1,"7"],[2,"7"],[3,"7"]]}`,
	})

	resp := postChartPlan(t, h, &explorerpb.ChartPlanRequest{Metric: "worker_slots", Step: "auto"})
	if resp.Plan.MetricType != metricTypeStatValue || resp.Plan.MetricTypeSource != "behavior" {
		t.Fatalf("expected behavior-based stat value, got %#v", resp.Plan)
	}
	if resp.Plan.MetricTypeConfidence != 0.9 {
		t.Fatalf("expected behavior confidence 0.9, got %v", resp.Plan.MetricTypeConfidence)
	}
	if resp.Plan.Visualization != "stat" || resp.Plan.Aggregation != "sum" {
		t.Fatalf("expected stat visualization, got %#v", resp.Plan)
	}
	if resp.Plan.Query != `sum by () ({__name__="worker_slots"})` {
		t.Fatalf("unexpected stat query: %s", resp.Plan.Query)
	}
	if got := rangeQueries.Load(); got != 1 {
		t.Fatalf("stat planning should issue one type-inference query, got %d", got)
	}
}

func TestShouldUsePerMinuteUsesMajorityOfFiniteSamples(t *testing.T) {
	mostlySmall := json.RawMessage(`{
		"resultType":"matrix",
		"result":[{"values":[[1,"0.2"],[2,"0.4"],[3,"0.9"],[4,"2.0"],[5,"NaN"]]}]
	}`)
	if !shouldUsePerMinute(mostlySmall) {
		t.Fatal("expected per-minute display when more than half of finite samples are below one")
	}

	exactlyHalf := json.RawMessage(`{
		"resultType":"matrix",
		"result":[{"values":[[1,"0.2"],[2,"0.4"],[3,"1.0"],[4,"2.0"]]}]
	}`)
	if shouldUsePerMinute(exactlyHalf) {
		t.Fatal("exactly half of the samples below one must remain per-second")
	}
}

func TestSumRangeValuesAddsEveryFiniteSample(t *testing.T) {
	data := json.RawMessage(`{
		"resultType":"matrix",
		"result":[
			{"values":[[1,"1.5"],[2,"-0.5"],[3,"NaN"]]},
			{"values":[[1,2],[2,"3.25"]]},
			{"value":[4,"0.75"]}
		]
	}`)

	sum, count := sumRangeValues(data)
	if sum != 7 || count != 5 {
		t.Fatalf("expected sum=7 from five finite samples, got sum=%v count=%d", sum, count)
	}
}

func TestSumRangeValuesRejectsInvalidData(t *testing.T) {
	if sum, count := sumRangeValues(json.RawMessage(`not-json`)); sum != 0 || count != 0 {
		t.Fatalf("invalid data must not produce a sum, got sum=%v count=%d", sum, count)
	}
	if sum, count := sumRangeValues(json.RawMessage(`{
		"result":[{"values":[[1,"1.7976931348623157e308"],[2,"1.7976931348623157e308"]]}]
	}`)); sum != 0 || count != 0 {
		t.Fatalf("an overflowing sum must be discarded, got sum=%v count=%d", sum, count)
	}
}

func TestInferDisplayUnit(t *testing.T) {
	if got := inferDisplayUnit("requests_total", "counter", "", true); got != "/min" {
		t.Fatalf("expected /min, got %q", got)
	}
	for metric, want := range map[string]string{
		"network_receive_bytes_total": "bytes/s",
		"disk_written_bytes":          "bytes/s",
		"cpu_usage_seconds_total":     "s/s",
		"requests_seconds_count":      "/s",
	} {
		if got := inferDisplayUnit(metric, "counter", "", false); got != want {
			t.Fatalf("%s: expected %q, got %q", metric, want, got)
		}
	}
	if got := inferDisplayUnit("cpu_usage_seconds_total", "counter", "", true); got != "s/min" {
		t.Fatalf("expected s/min, got %q", got)
	}
	if got := inferDisplayUnit("temperature_celsius", "gauge", "", false); got != "°C" {
		t.Fatalf("expected °C, got %q", got)
	}
	if got := inferDisplayUnit("request_duration_seconds_bucket", "histogram", "", false); got != "s" {
		t.Fatalf("expected seconds, got %q", got)
	}
}

func TestCalculateFacetsUsesRealSeriesAndFilterSemantics(t *testing.T) {
	series := []map[string]string{
		{"__name__": "requests_total", "cluster": "prod", "job": "api", "instance": "api-1", "zone": "a"},
		{"__name__": "requests_total", "cluster": "prod", "job": "api", "instance": "api-2", "zone": "b"},
		{"__name__": "requests_total", "cluster": "prod", "job": "worker", "instance": "worker-1"},
	}

	facets, returned, truncated := calculateFacets(series, map[string][]string{"job": {"api"}}, nil, "", 100)
	if truncated {
		t.Fatal("did not expect facet values to be truncated")
	}
	if returned != 2 {
		t.Fatalf("expected two matching series, got %d", returned)
	}

	byLabel := make(map[string]facetResult, len(facets))
	for _, facet := range facets {
		byLabel[facet.Label] = facet
	}
	if _, exists := byLabel["__name__"]; exists {
		t.Fatal("__name__ must not be exposed as a label facet for a single selected metric")
	}
	cluster := byLabel["cluster"]
	if !cluster.IsConstant || cluster.ConstantValue != "prod" {
		t.Fatalf("expected cluster=prod to be a common label, got %#v", cluster)
	}

	jobCounts := facetCounts(byLabel["job"])
	if jobCounts["api"].AvailableCount != 2 || jobCounts["worker"].AvailableCount != 1 {
		t.Fatalf("same-label choices must exclude the job filter, got %#v", jobCounts)
	}
	instanceCounts := facetCounts(byLabel["instance"])
	if instanceCounts["api-1"].AvailableCount != 1 || instanceCounts["worker-1"].AvailableCount != 0 {
		t.Fatalf("other-label filters must use AND semantics, got %#v", instanceCounts)
	}
}

func TestCalculateFacetsOrdersConstantsThenByMaximumValueCountAndCardinality(t *testing.T) {
	series := []map[string]string{
		{"__name__": "requests_total", "environment": "prod", "sparse_workload": "nginx-intel", "value_order": "hot", "two_values": "a", "three_values": "x"},
		{"__name__": "requests_total", "environment": "prod", "sparse_workload": "nginx-intel", "value_order": "hot", "two_values": "a", "three_values": "x"},
		{"__name__": "requests_total", "environment": "prod", "sparse_workload": "nginx-intel", "value_order": "hot", "two_values": "a", "three_values": "x"},
		{"__name__": "requests_total", "environment": "prod", "sparse_workload": "nginx-intel", "value_order": "hot", "two_values": "b", "three_values": "y"},
		{"__name__": "requests_total", "environment": "prod", "sparse_workload": "nginx-intel", "value_order": "warm", "two_values": "b", "three_values": "y"},
		{"__name__": "requests_total", "environment": "prod", "value_order": "cold", "two_values": "b", "three_values": "z"},
	}

	facets, _, _ := calculateFacets(series, nil, nil, "", 100)
	wantLabels := []string{"environment", "sparse_workload", "value_order", "two_values", "three_values"}
	if len(facets) != len(wantLabels) {
		t.Fatalf("expected %d facets, got %d: %#v", len(wantLabels), len(facets), facets)
	}
	for index, want := range wantLabels {
		if facets[index].Label != want {
			t.Fatalf("facet %d: expected %q, got %q", index, want, facets[index].Label)
		}
	}
	if !facets[0].IsConstant || facets[0].ConstantValue != "prod" {
		t.Fatalf("expected environment=prod to be the leading constant facet, got %#v", facets[0])
	}

	orderedValues := facets[2].Values
	wantValues := []string{"hot", "cold", "warm"}
	for index, want := range wantValues {
		if orderedValues[index].Value != want {
			t.Fatalf("value %d: expected %q, got %q", index, want, orderedValues[index].Value)
		}
	}
}

func TestCalculateFacetsUsesORWithinOneLabel(t *testing.T) {
	series := []map[string]string{
		{"__name__": "requests_total", "job": "api"},
		{"__name__": "requests_total", "job": "worker"},
		{"__name__": "requests_total", "job": "db"},
	}

	_, returned, _ := calculateFacets(
		series,
		map[string][]string{"job": {"api", "worker"}},
		nil,
		"",
		100,
	)
	if returned != 2 {
		t.Fatalf("expected OR within one label to return two series, got %d", returned)
	}
}

func TestCalculateFacetsKeepsSelectedValuesWhenTruncated(t *testing.T) {
	series := []map[string]string{
		{"__name__": "requests_total", "job": "api"},
		{"__name__": "requests_total", "job": "api"},
		{"__name__": "requests_total", "job": "api"},
		{"__name__": "requests_total", "job": "worker"},
		{"__name__": "requests_total", "job": "worker"},
		{"__name__": "requests_total", "job": "batch"},
		{"__name__": "requests_total", "job": "rare"},
	}

	facets, _, truncated := calculateFacets(series, map[string][]string{"job": {"rare"}}, nil, "", 2)
	if !truncated {
		t.Fatal("expected the job values to be truncated")
	}
	jobValues := facetCounts(facets[0])
	if _, exists := jobValues["rare"]; !exists {
		t.Fatalf("selected value must remain visible when a facet is truncated: %#v", jobValues)
	}
	if got := []string{facets[0].Values[0].Value, facets[0].Values[1].Value, facets[0].Values[2].Value}; got[0] != "api" || got[1] != "worker" || got[2] != "rare" {
		t.Fatalf("selected values must keep count order after the normal limit: %#v", got)
	}
}

func facetCounts(facet facetResult) map[string]facetValueResult {
	values := make(map[string]facetValueResult, len(facet.Values))
	for _, value := range facet.Values {
		values[value.Value] = value
	}
	return values
}

func TestWithoutBucketLabels(t *testing.T) {
	series := withoutBucketLabels([]map[string]string{
		{"__name__": "x_bucket", "job": "a", "le": "0.1"},
		{"__name__": "x_bucket", "job": "a", "le": "+Inf"},
		{"__name__": "x_bucket", "job": "b", "vmrange": "1.000e+00...1.136e+00"},
	})
	want := []map[string]string{
		{"__name__": "x_bucket", "job": "a"},
		{"__name__": "x_bucket", "job": "b"},
	}
	if !reflect.DeepEqual(series, want) {
		t.Fatalf("withoutBucketLabels = %v, want %v", series, want)
	}
}
