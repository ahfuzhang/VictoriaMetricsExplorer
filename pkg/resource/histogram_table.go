package resource

import (
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

// histogramTableRow is one bucket of the histogram table: how many observations fell in
// (From, To] over the chart's time range.
type histogramTableRow struct {
	From              string
	To                string
	Count             float64
	Percent           float64
	CumulativePercent float64
}

// histogramTableResult is the bucket table shown under a histogram heatmap. Count and Sum are the
// increase of <base>_count and <base>_sum over the same range, nil when those metrics are absent.
type histogramTableResult struct {
	Rows   []histogramTableRow
	Count  *float64
	Sum    *float64
	Window string
}

type vectorSample struct {
	labels map[string]string
	value  float64
}

// loadHistogramTable counts the observations per bucket between start and end. Percentages are
// relative to <base>_count, or to the bucket total for histograms that only export buckets.
func (h *Handlers) loadHistogramTable(
	ctx context.Context, bucketMetric string, filters map[string][]string, podGroup, node string,
	vmrange bool, start, end time.Time,
) (*histogramTableResult, error) {
	_, countMetric, sumMetric := histogramMemberNames(strings.TrimSuffix(bucketMetric, "_bucket"))
	seconds := int64(end.Sub(start).Seconds())
	if seconds < 1 {
		seconds = 1
	}
	window := formatStep(seconds)
	labels := selectorLabels(filters)
	matchers := []string{h.podGroupMatcher(podGroup), h.nodeMatcher(node)}
	increase := func(by, metric string) ([]vectorSample, error) {
		const head, mid, tail = "sum by (", ") (increase(", "]))"
		b := make([]byte, 0, len(head)+len(by)+len(mid)+metricSelectorLen(metric, filters, labels, matchers)+
			len("[")+len(window)+len(tail))
		b = append(append(append(b, head...), by...), mid...)
		b = appendMetricSelector(b, metric, filters, labels, matchers)
		b = append(append(append(b, '['), window...), tail...)
		data, err := h.router.client.Query(ctx, bytesutil.ToUnsafeString(b), end)
		if err != nil {
			return nil, err
		}
		return parseVector(data), nil
	}

	bucketLabel := "le"
	if vmrange {
		bucketLabel = "vmrange"
	}
	buckets, err := increase(bucketLabel, bucketMetric)
	if err != nil {
		return nil, err
	}
	table := &histogramTableResult{Window: window}
	// _count and _sum are optional: without them the table still has its buckets.
	if samples, err := increase("", countMetric); err == nil && len(samples) > 0 {
		table.Count = &samples[0].value
	}
	if samples, err := increase("", sumMetric); err == nil && len(samples) > 0 {
		table.Sum = &samples[0].value
	}

	var bucketTotal float64
	if vmrange {
		table.Rows, bucketTotal = vmrangeRows(buckets)
	} else {
		table.Rows, bucketTotal = leRows(buckets)
	}
	total := bucketTotal
	if table.Count != nil && *table.Count > 0 {
		total = *table.Count
	}
	cumulative := 0.0
	for i := range table.Rows {
		if total > 0 {
			table.Rows[i].Percent = table.Rows[i].Count / total * 100
		}
		cumulative += table.Rows[i].Percent
		table.Rows[i].CumulativePercent = cumulative
	}
	return table, nil
}

// leRows turns cumulative le buckets into per-bucket counts. Empty buckets are left out. The
// second result is the total observation count, i.e. the largest cumulative count.
func leRows(samples []vectorSample) ([]histogramTableRow, float64) {
	type bucket struct {
		le    string
		bound float64
		count float64
	}
	buckets := make([]bucket, 0, len(samples))
	for _, sample := range samples {
		le := sample.labels["le"]
		bound, err := strconv.ParseFloat(le, 64)
		if err != nil {
			continue
		}
		buckets = append(buckets, bucket{le: le, bound: bound, count: sample.value})
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].bound < buckets[j].bound })

	rows := make([]histogramTableRow, 0, len(buckets))
	from := "-Inf"
	if len(buckets) > 0 && buckets[0].bound > 0 {
		from = "0"
	}
	previous := 0.0
	for _, b := range buckets {
		// increase() of each bucket is computed separately, so a cumulative count can dip below
		// the one before it; that bucket then has no observations.
		if count := b.count - previous; count > 0 {
			rows = append(rows, histogramTableRow{From: from, To: b.le, Count: count})
		}
		previous = math.Max(previous, b.count)
		from = b.le
	}
	return rows, previous
}

// vmrangeRows lists the non-empty vmrange buckets, e.g. vmrange="1.000e+00...1.136e+00", by their
// lower bound. The second result is the total observation count.
func vmrangeRows(samples []vectorSample) ([]histogramTableRow, float64) {
	type bucket struct {
		row   histogramTableRow
		lower float64
	}
	buckets := make([]bucket, 0, len(samples))
	total := 0.0
	for _, sample := range samples {
		from, to, ok := strings.Cut(sample.labels["vmrange"], "...")
		if !ok || sample.value <= 0 {
			continue
		}
		lower, err := strconv.ParseFloat(from, 64)
		if err != nil {
			continue
		}
		buckets = append(buckets, bucket{row: histogramTableRow{From: from, To: to, Count: sample.value}, lower: lower})
		total += sample.value
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].lower < buckets[j].lower })

	rows := make([]histogramTableRow, len(buckets))
	for i, b := range buckets {
		rows[i] = b.row
	}
	return rows, total
}

// parseVector reads the finite samples of an instant-query vector result.
func parseVector(data jsontext.Value) []vectorSample {
	var vector struct {
		Result []struct {
			Metric map[string]string `json:"metric"`
			Value  []jsontext.Value  `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &vector); err != nil {
		return nil
	}
	samples := make([]vectorSample, 0, len(vector.Result))
	for _, result := range vector.Result {
		if len(result.Value) < 2 {
			continue
		}
		if value, ok := parsePrometheusValue(result.Value[1]); ok {
			samples = append(samples, vectorSample{labels: result.Metric, value: value})
		}
	}
	return samples
}

func (t *histogramTableResult) toProto() *explorerpb.HistogramTable {
	rows := make([]*explorerpb.HistogramTableRow, 0, len(t.Rows))
	for _, row := range t.Rows {
		rows = append(rows, &explorerpb.HistogramTableRow{
			From:              row.From,
			To:                row.To,
			Count:             row.Count,
			Percent:           row.Percent,
			CumulativePercent: row.CumulativePercent,
		})
	}
	return &explorerpb.HistogramTable{Rows: rows, Count: t.Count, Sum: t.Sum, Window: t.Window}
}
