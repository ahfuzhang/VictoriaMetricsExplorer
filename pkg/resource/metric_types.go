package resource

import (
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

// Metric types reported by the metric-types endpoint.
const (
	metricTypeCounter   = "counter"
	metricTypeGauge     = "gauge"
	metricTypeHistogram = "histogram"
	metricTypeStatValue = "stat_value"
	// metricTypeUnknown means the last hour held no usable data (or the query failed).
	metricTypeUnknown = "unknown"
)

const (
	// metricTypeWindow is how much data is pulled per metric to infer its type.
	metricTypeWindow = time.Hour
	// metricTypeStep gives one sample per minute, i.e. about 60 points per series.
	metricTypeStep     = "1m"
	metricTypeCacheTTL = 5 * time.Minute
	// metricTypeMaxNames bounds one request; the UI sends one page of metric names at a time.
	metricTypeMaxNames = 500
	// metricTypeConcurrency bounds the upstream range queries in flight for one datasource.
	metricTypeConcurrency = 8
)

func (h *Handlers) handleMetricTypes(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.MetricTypesRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	names := uniqueNonEmpty(req.Metrics)
	if len(names) == 0 {
		writeError(w, http.StatusBadRequest, "missing_param", "metrics is required", requestID)
		return
	}
	if len(names) > metricTypeMaxNames {
		writeError(w, http.StatusBadRequest, "too_many_metrics", "too many metrics in one request", requestID)
		return
	}

	types := make(map[string]string, len(names))
	pending := names
	zeroValues := make(map[string]bool)

	// A metric that belongs to a histogram is a histogram, whatever its samples look like, so the
	// sibling lookup comes first and those names never need their data pulled.
	if anyHistogramSuffix(names) {
		// The range only chooses the window used to look up sibling names for histogram
		// detection; the data used to infer counter/gauge/stat value is always the last hour.
		startTime, endTime := h.timeRange(req.Range)
		dayStart := startTime.Truncate(24 * time.Hour)
		dayEnd := endTime.Truncate(24 * time.Hour).Add(24 * time.Hour)

		all, _, err := h.router.client.LabelValues(r.Context(), "__name__", nil, dayStart, dayEnd, h.router.limits.MaxMetricNamesHard)
		if err != nil {
			log.DefaultLogger.Error("metric-types: failed to fetch names", "error", err, "requestId", requestID)
			h.router.obs.RecordError("upstream_error")
			writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch metric names: "+err.Error(), requestID)
			return
		}
		known := make(map[string]struct{}, len(all))
		for _, n := range all {
			known[n] = struct{}{}
		}

		pending = make([]string, 0, len(names))
		var histograms []string
		for _, name := range names {
			if isHistogramMember(name, known) {
				types[name] = metricTypeHistogram
				histograms = append(histograms, name)
			} else {
				pending = append(pending, name)
			}
		}
		h.markZeroHistograms(r.Context(), histograms, known, zeroValues)
	}

	failed := h.inferMetricTypes(r.Context(), pending, types, zeroValues)

	log.DefaultLogger.Info("metric-types",
		"uid", h.router.config.UID,
		"requestId", requestID,
		"requested", len(names),
		"queried", len(pending),
		"failed", failed,
		"elapsedMs", time.Since(started).Milliseconds(),
	)

	writeMessage(w, &explorerpb.MetricTypesResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId: requestID,
			ElapsedMs: uint64(time.Since(started).Milliseconds()),
		},
		Types: types,
		// Metrics whose every sample in the last hour is 0.
		ZeroValues: zeroValues,
		Failed:     uint32(failed),
	}, requestID)
}

// metricTypeResult is the inferred type of one metric. Zero marks a metric whose samples in the
// window are all 0.
type metricTypeResult struct {
	Type string
	Zero bool
}

// inferMetricTypes fills types (and zeroValues, for stat values that are always 0) for names from
// their last hour of data and returns how many queries failed. Results are cached per metric; a
// failed query yields metricTypeUnknown, which is not cached so the next request retries it.
func (h *Handlers) inferMetricTypes(ctx context.Context, names []string, types map[string]string, zeroValues map[string]bool) int {
	var (
		mu     sync.Mutex
		wg     sync.WaitGroup
		failed int
	)
	end := now()
	start := end.Add(-metricTypeWindow)
	// Counters named by their suffix are typed without pulling their samples; whether those samples
	// are all 0 is checked for all of them at once below.
	var namedCounters []string

	for _, name := range names {
		if cached, ok := h.cachedMetricType(name); ok {
			h.router.obs.RecordCacheHit()
			types[name] = cached.Type
			if cached.Zero {
				zeroValues[name] = true
			}
			continue
		}
		h.router.obs.RecordCacheMiss()
		if t, ok := metricTypeFromName(name); ok && t == metricTypeCounter {
			namedCounters = append(namedCounters, name)
			continue
		}

		wg.Go(func() {
			select {
			case h.typeSem <- struct{}{}:
				defer func() { <-h.typeSem }()
			case <-ctx.Done():
				mu.Lock()
				types[name] = metricTypeUnknown
				failed++
				mu.Unlock()
				return
			}

			t, err := h.inferMetricType(ctx, name, start, end)
			if err != nil {
				log.DefaultLogger.Debug("metric-types: could not infer type", "error", err, "metric", name)
				mu.Lock()
				types[name] = metricTypeUnknown
				failed++
				mu.Unlock()
				return
			}
			h.cacheMetricType(name, t)
			mu.Lock()
			types[name] = t.Type
			if t.Zero {
				zeroValues[name] = true
			}
			mu.Unlock()
		})
	}
	wg.Wait()

	if len(namedCounters) > 0 {
		zeroCounters, err := h.zeroCounters(ctx, namedCounters, end)
		if err != nil {
			// The type stands without the zero check; leaving it uncached retries the check next time.
			log.DefaultLogger.Debug("metric-types: zero counter check failed", "error", err)
		}
		for _, name := range namedCounters {
			types[name] = metricTypeCounter
			if err != nil {
				continue
			}
			result := metricTypeResult{Type: metricTypeCounter, Zero: zeroCounters[name]}
			h.cacheMetricType(name, result)
			if result.Zero {
				zeroValues[name] = true
			}
		}
	}
	return failed
}

// markZeroHistograms marks the histograms without observations in the last hour: their
// <base>_count is always 0, or, for histograms that only export buckets, every bucket is.
func (h *Handlers) markZeroHistograms(ctx context.Context, names []string, known map[string]struct{}, zeroValues map[string]bool) {
	counterOf := make(map[string]string, len(names)) // histogram member -> counter that is checked
	var counters []string
	for _, name := range names {
		if cached, ok := h.cachedMetricType(name); ok && cached.Type == metricTypeHistogram {
			h.router.obs.RecordCacheHit()
			if cached.Zero {
				zeroValues[name] = true
			}
			continue
		}
		h.router.obs.RecordCacheMiss()
		base, _ := histogramMetricBase(name)
		counter := base + "_count"
		if _, ok := known[counter]; !ok {
			counter = base + "_bucket"
		}
		if _, seen := counterOf[name]; !seen {
			counterOf[name] = counter
			counters = append(counters, counter)
		}
	}
	if len(counters) == 0 {
		return
	}

	zeroCounters, err := h.zeroCounters(ctx, uniqueNonEmpty(counters), now())
	if err != nil {
		// The histogram type stands without the zero check; it is retried with the next request.
		log.DefaultLogger.Debug("metric-types: zero histogram check failed", "error", err)
		return
	}
	for name, counter := range counterOf {
		result := metricTypeResult{Type: metricTypeHistogram, Zero: zeroCounters[counter]}
		h.cacheMetricType(name, result)
		if result.Zero {
			zeroValues[name] = true
		}
	}
}

// zeroCounterBatch bounds how many names one zero-counter query matches, keeping its URL short.
const zeroCounterBatch = 50

// zeroCounters returns the counters among names that have samples in the hour before end and
// whose samples are all 0. Counters never go below 0, so that is a maximum of 0; one instant query
// covers a whole batch of names.
func (h *Handlers) zeroCounters(ctx context.Context, names []string, end time.Time) (map[string]bool, error) {
	// keep_metric_names (VictoriaMetrics) keeps __name__ on the max_over_time result.
	const head, tail = "max by (__name__) (max_over_time({__name__", "]) keep_metric_names)"
	zero := make(map[string]bool)
	for offset := 0; offset < len(names); offset += zeroCounterBatch {
		batch := names[offset:min(offset+zeroCounterBatch, len(names))]
		b := make([]byte, 0, len(head)+valuesMatchLen(batch)+len("}[")+maxStepLen+len(tail))
		b = appendValuesMatch(append(b, head...), batch)
		b = appendStep(append(b, "}["...), int64(metricTypeWindow.Seconds()))
		b = append(b, tail...)
		data, err := h.router.client.Query(ctx, bytesutil.ToUnsafeString(b), end)
		if err != nil {
			return nil, err
		}
		for _, sample := range parseVector(data) {
			if name := sample.labels["__name__"]; name != "" && sample.value == 0 {
				zero[name] = true
			}
		}
	}
	return zero, nil
}

func (h *Handlers) cachedMetricType(name string) (metricTypeResult, bool) {
	cacheKey := cache.CacheKey("metric-type-v2", h.router.config.UID, h.router.config.ConfigFingerprint, name)
	var entry explorerpb.MetricTypeCacheEntry
	if !h.router.cache.Get(cacheKey, metricTypeCacheTTL, &entry) || entry.Type == "" {
		return metricTypeResult{}, false
	}
	return metricTypeResult{Type: entry.Type, Zero: entry.Zero}, true
}

func (h *Handlers) cacheMetricType(name string, result metricTypeResult) {
	cacheKey := cache.CacheKey("metric-type-v2", h.router.config.UID, h.router.config.ConfigFingerprint, name)
	h.router.cache.Set(cacheKey, &explorerpb.MetricTypeCacheEntry{Type: result.Type, Zero: result.Zero})
}

// metricTypeForChart returns the same behavior-based type used by the metric picker. Usually the
// picker has already populated the cache; a direct chart request still performs the same bounded
// one-hour inference so the visualization cannot disagree with the type badge.
func (h *Handlers) metricTypeForChart(ctx context.Context, name string) (string, error) {
	if cached, ok := h.cachedMetricType(name); ok {
		h.router.obs.RecordCacheHit()
		// The _count or _sum of a histogram without buckets is charted as the counter it is.
		if cached.Type == metricTypeHistogram && !strings.HasSuffix(name, "_bucket") {
			return metricTypeCounter, nil
		}
		return cached.Type, nil
	}
	h.router.obs.RecordCacheMiss()

	select {
	case h.typeSem <- struct{}{}:
		defer func() { <-h.typeSem }()
	case <-ctx.Done():
		return metricTypeUnknown, ctx.Err()
	}

	end := now()
	result, err := h.inferMetricType(ctx, name, end.Add(-metricTypeWindow), end)
	if err != nil {
		return metricTypeUnknown, err
	}
	h.cacheMetricType(name, result)
	return result.Type, nil
}

// inferMetricType classifies one metric. A name with an explicit counter suffix decides the type
// by itself; otherwise the metric's samples for the window are pulled and classified.
func (h *Handlers) inferMetricType(ctx context.Context, name string, start, end time.Time) (metricTypeResult, error) {
	if t, ok := metricTypeFromName(name); ok {
		return metricTypeResult{Type: t}, nil
	}
	data, err := h.router.client.QueryRange(ctx, buildMetricSelector(name, nil), start, end, metricTypeStep)
	if err != nil {
		return metricTypeResult{Type: metricTypeUnknown}, err
	}
	t, err := classifyMatrix(data)
	if err != nil {
		return metricTypeResult{Type: metricTypeUnknown}, err
	}
	return metricTypeResult{Type: t, Zero: allSamplesZero(data)}, nil
}

// allSamplesZero reports whether a query_range result has samples and every one of them is 0.
func allSamplesZero(data jsontext.Value) bool {
	var matrix struct {
		Result []struct {
			Values [][]jsontext.Value `json:"values"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return false
	}
	seen := false
	for _, series := range matrix.Result {
		for _, sample := range series.Values {
			if len(sample) < 2 {
				continue
			}
			if v, ok := parsePrometheusValue(sample[1]); ok {
				if v != 0 {
					return false
				}
				seen = true
			}
		}
	}
	return seen
}

// metricTypeFromName returns the type a metric name states by its suffix. Samples cannot override
// it: a "_total" counter still drops whenever its process restarts (a counter reset), which would
// otherwise look like a gauge.
func metricTypeFromName(name string) (string, bool) {
	if strings.HasSuffix(name, "_total") {
		return metricTypeCounter, true
	}
	return "", false
}

// classifyMatrix classifies a query_range result by the behavior of its series. Series are
// judged one by one and the metric takes the most dynamic verdict: any fluctuating series makes
// it a gauge, otherwise any growing series makes it a counter, otherwise it is a stat value.
func classifyMatrix(data jsontext.Value) (string, error) {
	var matrix struct {
		Result []struct {
			Values [][]jsontext.Value `json:"values"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return metricTypeUnknown, err
	}

	var gauge, counter, stat bool
	var values []float64
	for _, series := range matrix.Result {
		values = values[:0]
		for _, sample := range series.Values {
			if len(sample) < 2 {
				continue
			}
			if v, ok := parsePrometheusValue(sample[1]); ok {
				values = append(values, v)
			}
		}
		switch classifySamples(values) {
		case metricTypeGauge:
			gauge = true
		case metricTypeCounter:
			counter = true
		case metricTypeStatValue:
			stat = true
		}
	}

	switch {
	case gauge:
		return metricTypeGauge, nil
	case counter:
		return metricTypeCounter, nil
	case stat:
		return metricTypeStatValue, nil
	default:
		return metricTypeUnknown, nil
	}
}

// classifySamples classifies one series: all samples equal is a stat value, samples that never
// decrease are a counter, anything else is a gauge. Fewer than two samples say nothing.
func classifySamples(values []float64) string {
	if len(values) < 2 {
		return metricTypeUnknown
	}
	constant, nonDecreasing := true, true
	for i := 1; i < len(values); i++ {
		if values[i] != values[0] {
			constant = false
		}
		if values[i] < values[i-1] {
			nonDecreasing = false
			break
		}
	}
	switch {
	case constant:
		return metricTypeStatValue
	case nonDecreasing:
		return metricTypeCounter
	default:
		return metricTypeGauge
	}
}

var histogramSuffixes = [...]string{"_bucket", "_count", "_sum"}

// histogramMetricBase removes one histogram member suffix. The bool is false for ordinary metric
// names and for a name that consists only of the suffix.
func histogramMetricBase(name string) (string, bool) {
	for _, suffix := range histogramSuffixes {
		if base, ok := strings.CutSuffix(name, suffix); ok && base != "" {
			return base, true
		}
	}
	return "", false
}

// histogramMemberNames returns the _bucket, _count and _sum metric names of the histogram base,
// built in one allocation.
func histogramMemberNames(base string) (bucket, count, sum string) {
	b := make([]byte, 0, 3*len(base)+len("_bucket")+len("_count")+len("_sum"))
	b = append(append(b, base...), "_bucket"...)
	bucketEnd := len(b)
	b = append(append(b, base...), "_count"...)
	countEnd := len(b)
	b = append(append(b, base...), "_sum"...)
	names := bytesutil.ToUnsafeString(b)
	return names[:bucketEnd], names[bucketEnd:countEnd], names[countEnd:]
}

func anyHistogramSuffix(names []string) bool {
	for _, name := range names {
		for _, suffix := range histogramSuffixes {
			if strings.HasSuffix(name, suffix) {
				return true
			}
		}
	}
	return false
}

// isHistogramMember reports whether name is one of the metrics of a histogram: "<base>_bucket",
// or "<base>_count" / "<base>_sum" next to a "<base>_bucket" in known. The _count and _sum are
// optional, since some exporters (e.g. Go runtime histograms from VictoriaMetrics/metrics) only
// write buckets. A "<base>_count" and "<base>_sum" pair without buckets (e.g. a summary without
// quantiles) is grouped the same way. When "<base>" itself is a metric (e.g. a summary's
// quantiles), the members are left alone so the collapsed histogram does not share its name.
func isHistogramMember(name string, known map[string]struct{}) bool {
	base, ok := histogramMetricBase(name)
	if !ok {
		return false
	}
	if _, baseIsMetric := known[base]; baseIsMetric {
		return false
	}
	bucket, count, sum := histogramMemberNames(base)
	if _, exists := known[bucket]; exists {
		return true
	}
	_, hasCount := known[count]
	_, hasSum := known[sum]
	return hasCount && hasSum
}

func uniqueNonEmpty(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
