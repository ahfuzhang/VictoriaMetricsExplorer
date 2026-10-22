package resource

import (
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const (
	// defaultRangeQueryPoints is the most points per series a range query asks for when the request
	// does not say, the same bound Grafana's Prometheus datasource applies.
	defaultRangeQueryPoints = 11000
	// rangeQueryMaxSeries bounds the series one response carries. Charts plot a single aggregate,
	// and a heatmap one series per bucket.
	rangeQueryMaxSeries = 1000
	// maxRangeQueryLength bounds the query text.
	maxRangeQueryLength = 16 << 10
)

// handleRangeQuery runs the chart's range query against the datasource, in place of Grafana's
// /api/ds/query, so the chart data travels in the same wire format as everything else.
func (h *Handlers) handleRangeQuery(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.RangeQueryRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}
	query := strings.TrimSpace(req.Query)
	if query == "" {
		writeError(w, http.StatusBadRequest, "missing_param", "query is required", requestID)
		return
	}
	if len(query) > maxRangeQueryLength {
		writeError(w, http.StatusBadRequest, "query_too_long", "query is too long", requestID)
		return
	}

	start, end := h.timeRange(req.Range)
	if !end.After(start) {
		writeError(w, http.StatusBadRequest, "invalid_range", "the range must end after it starts", requestID)
		return
	}
	stepSec := rangeQueryStep(req.Step, end.Sub(start), int(req.MaxDataPoints))
	step := formatStep(stepSec)
	// Align both ends to the step, as Grafana's Prometheus datasource does, so consecutive
	// refreshes sample the same instants.
	start = time.Unix(start.Unix()-start.Unix()%stepSec, 0)
	end = time.Unix(end.Unix()-end.Unix()%stepSec, 0)

	data, err := h.router.client.QueryRange(r.Context(), query, start, end, step)
	if err != nil {
		log.DefaultLogger.Warn("query-range: upstream query failed", "error", err, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "range query failed: "+err.Error(), requestID)
		return
	}
	series, truncated, err := parseRangeSeries(data, rangeQueryMaxSeries)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_error", "cannot read the range query result: "+err.Error(), requestID)
		return
	}
	if truncated {
		h.router.obs.RecordTruncation()
	}

	writeMessage(w, &explorerpb.RangeQueryResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId:      requestID,
			ElapsedMs:      uint64(time.Since(started).Milliseconds()),
			Truncated:      truncated,
			ReturnedCount:  uint32(len(series)),
			RequestedRange: req.Range,
			EffectiveRange: &explorerpb.TimeRange{StartMs: start.UnixMilli(), EndMs: end.UnixMilli()},
			RangePrecision: explorerpb.RangePrecision_RANGE_PRECISION_EXACT,
		},
		Series: series,
		Step:   step,
	}, requestID)
}

// niceSteps are the steps a raised step is rounded up to, in seconds.
var niceSteps = []int64{1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400}

// rangeQueryStep returns the step in whole seconds: the requested step (1m when empty or
// malformed), raised to the next nice step when the range would need more than maxPoints points
// per series.
func rangeQueryStep(step string, span time.Duration, maxPoints int) int64 {
	sec, ok := stepSeconds(step)
	if !ok {
		sec = 60
	}
	if maxPoints <= 0 {
		maxPoints = defaultRangeQueryPoints
	}
	minSec := int64(math.Ceil(span.Seconds() / float64(maxPoints)))
	if sec >= minSec {
		return sec
	}
	for _, nice := range niceSteps {
		if nice >= minSec {
			return nice
		}
	}
	return minSec
}

// stepSeconds parses a single-unit step such as 15s, 1m or 2h into whole seconds (at least 1).
func stepSeconds(step string) (int64, bool) {
	if !stepDurationPattern.MatchString(step) {
		return 0, false
	}
	units := map[string]float64{"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 7 * 86400, "y": 365 * 86400}
	unit := strings.TrimLeft(step, "0123456789")
	n, err := strconv.ParseInt(strings.TrimSuffix(step, unit), 10, 64)
	if err != nil {
		return 0, false
	}
	return max(int64(math.Ceil(float64(n)*units[unit])), 1), true
}

// parseRangeSeries converts a query_range "matrix" result into TimeSeries, keeping at most
// maxSeries series.
func parseRangeSeries(data jsontext.Value, maxSeries int) ([]*explorerpb.TimeSeries, bool, error) {
	var matrix struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string   `json:"metric"`
			Values [][2]jsontext.Value `json:"values"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return nil, false, err
	}
	if matrix.ResultType != "" && matrix.ResultType != "matrix" {
		const head = "unexpected result type "
		msg := append(make([]byte, 0, len(head)+quotedLen(matrix.ResultType)), head...)
		return nil, false, errors.New(bytesutil.ToUnsafeString(appendQuoted(msg, matrix.ResultType)))
	}

	truncated := len(matrix.Result) > maxSeries
	if truncated {
		matrix.Result = matrix.Result[:maxSeries]
	}
	series := make([]*explorerpb.TimeSeries, 0, len(matrix.Result))
	for _, result := range matrix.Result {
		ts := &explorerpb.TimeSeries{
			Labels:       result.Metric,
			TimestampsMs: make([]int64, 0, len(result.Values)),
			Values:       make([]float64, 0, len(result.Values)),
		}
		for _, sample := range result.Values {
			var sec float64
			if err := json.Unmarshal(sample[0], &sec); err != nil {
				return nil, false, err
			}
			// Sample values are strings: numbers, "NaN", "+Inf" or "-Inf".
			var text string
			if err := json.Unmarshal(sample[1], &text); err != nil {
				return nil, false, err
			}
			value, err := strconv.ParseFloat(text, 64)
			if err != nil {
				value = math.NaN()
			}
			ts.TimestampsMs = append(ts.TimestampsMs, int64(math.Round(sec*1000)))
			ts.Values = append(ts.Values, value)
		}
		series = append(series, ts)
	}
	return series, truncated, nil
}
