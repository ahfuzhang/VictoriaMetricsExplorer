package resource

import (
	"encoding/json/jsontext"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

func TestRangeQueryStep(t *testing.T) {
	cases := []struct {
		step      string
		span      time.Duration
		maxPoints int
		want      int64
	}{
		{"1m", time.Hour, 0, 60},
		{"15s", time.Hour, 0, 15},
		{"2h", 24 * time.Hour, 0, 7200},
		{"500ms", time.Minute, 0, 1},
		{"", time.Hour, 0, 60},
		{"auto", time.Hour, 0, 60},
		{"1m]) or vector(1", time.Hour, 0, 60},
		// 30 days in 15s steps would be 172800 points: raised to fit 11000 (236s), rounded to 5m.
		{"15s", 30 * 24 * time.Hour, 0, 300},
		// 7 days at 1000 points, as the chart asks: 605s, rounded to 15m.
		{"1m", 7 * 24 * time.Hour, 1000, 900},
		{"1m", time.Hour, 1000, 60},
	}
	for _, tc := range cases {
		if got := rangeQueryStep(tc.step, tc.span, tc.maxPoints); got != tc.want {
			t.Errorf("rangeQueryStep(%q, %v, %d) = %d, want %d", tc.step, tc.span, tc.maxPoints, got, tc.want)
		}
	}
}

func TestParseRangeSeries(t *testing.T) {
	data := jsontext.Value(`{"resultType":"matrix","result":[
		{"metric":{"le":"0.1"},"values":[[1700000000,"1.5"],[1700000060.5,"NaN"],[1700000120,"+Inf"]]},
		{"metric":{"le":"+Inf"},"values":[[1700000000,"2"]]}
	]}`)
	series, truncated, err := parseRangeSeries(data, 10)
	if err != nil || truncated || len(series) != 2 {
		t.Fatalf("got %d series, truncated=%v, err=%v", len(series), truncated, err)
	}
	first := series[0]
	if first.Labels["le"] != "0.1" || len(first.TimestampsMs) != 3 {
		t.Fatalf("unexpected first series: %v", first)
	}
	if first.TimestampsMs[1] != 1700000060500 || first.Values[0] != 1.5 || !math.IsNaN(first.Values[1]) ||
		!math.IsInf(first.Values[2], 1) {
		t.Fatalf("unexpected samples: %v %v", first.TimestampsMs, first.Values)
	}

	if series, truncated, _ := parseRangeSeries(data, 1); !truncated || len(series) != 1 {
		t.Fatalf("expected truncation to 1 series, got %d (truncated=%v)", len(series), truncated)
	}
	if _, _, err := parseRangeSeries(jsontext.Value(`{"resultType":"vector","result":[]}`), 10); err == nil {
		t.Fatal("a vector result must be rejected")
	}
}

func TestHandleRangeQuery(t *testing.T) {
	h, rangeQueries := metricTypesHarness(t, nil, map[string]string{
		"up": `{"metric":{"__name__":"up","job":"api"},"values":[[1700000040,"1"],[1700000100,"0"]]}`,
	})

	req := postProto(t, "/explorer/v1/query-range", &explorerpb.RangeQueryRequest{
		Query: `{__name__="up"}`,
		Range: &explorerpb.TimeRange{StartMs: 1700000010000, EndMs: 1700003610000},
		Step:  "1m",
	})
	rec := httptest.NewRecorder()
	h.handleRangeQuery(rec, req)
	expectOK(t, rec)

	var resp explorerpb.RangeQueryResponse
	decodeProto(t, rec.Body.Bytes(), &resp)
	if rangeQueries.Load() != 1 || resp.Step != "1m" || len(resp.Series) != 1 {
		t.Fatalf("unexpected response: %v", &resp)
	}
	if s := resp.Series[0]; s.Labels["job"] != "api" || len(s.Values) != 2 || s.TimestampsMs[1] != 1700000100000 {
		t.Fatalf("unexpected series: %v", s)
	}
	// Both ends are aligned to the step.
	if r := resp.Meta.EffectiveRange; r.StartMs != 1699999980000 || r.EndMs != 1700003580000 {
		t.Fatalf("unexpected effective range: %v", r)
	}
}

func TestHandleRangeQueryRejectsBadRequests(t *testing.T) {
	h, _ := metricTypesHarness(t, nil, nil)
	for name, req := range map[string]*explorerpb.RangeQueryRequest{
		"no query":       {Range: &explorerpb.TimeRange{StartMs: 2000, EndMs: 1000}},
		"inverted range": {Query: "up", Range: &explorerpb.TimeRange{StartMs: 2000, EndMs: 1000}},
	} {
		rec := httptest.NewRecorder()
		h.handleRangeQuery(rec, postProto(t, "/explorer/v1/query-range", req))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, rec.Code)
		}
	}
}
