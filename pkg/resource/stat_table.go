package resource

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

// statTableMaxRows bounds the distinct values listed under a stat value.
const statTableMaxRows = 100

// statTableRow is one distinct value of a stat-value metric. Labels are the labels every series
// with this value shares and that are not shared by all series, i.e. what sets this value apart.
type statTableRow struct {
	Value string
	// NoData marks the row of series the series index lists for the range but that have no
	// sample in it; Value is empty then.
	NoData      bool
	Labels      map[string]string
	SeriesCount int
}

type statTableResult struct {
	Rows        []statTableRow
	SeriesTotal int
	// Truncated is set when there were more distinct values than rows.
	Truncated bool
}

// loadStatTable groups the series of selector by their last value between start and end. Every
// series seen in the range counts, not only those still reporting at end. The series index (what
// the label filters count) works per day, so it can also list series without a sample in the
// range; those are counted in a row of their own so both columns agree.
func (h *Handlers) loadStatTable(ctx context.Context, selector string, start, end time.Time) (*statTableResult, error) {
	data, err := h.router.client.Query(ctx, statTableQuery(selector, start, end), end)
	if err != nil {
		return nil, err
	}
	indexed, _, err := h.router.client.Series(ctx, []string{selector}, start, end, h.router.limits.MaxSeriesScan)
	if err != nil {
		// Without the index the table still shows every series that has a value.
		indexed = nil
	}
	return buildStatTable(data, indexed), nil
}

func statTableQuery(selector string, start, end time.Time) string {
	seconds := int64(end.Sub(start).Seconds())
	if seconds < 1 {
		seconds = 1
	}
	return "last_over_time(" + selector + "[" + formatStep(seconds) + "])"
}

// seriesKey identifies a series by its labels other than __name__, which query results drop.
func seriesKey(labels map[string]string) string {
	withoutName := make(map[string]string, len(labels))
	for name, value := range labels {
		if name != "__name__" {
			withoutName[name] = value
		}
	}
	key, _ := json.Marshal(withoutName) // map keys are sorted, so equal label sets give equal keys
	return string(key)
}

// buildStatTable groups the series of an instant-query vector by value. indexed lists every series
// the series index knows for the range; those missing from data form the no-data row.
func buildStatTable(data json.RawMessage, indexed []map[string]string) *statTableResult {
	var vector struct {
		Result []struct {
			Metric map[string]string
			Value  []json.RawMessage
		}
	}
	table := &statTableResult{Rows: []statTableRow{}}
	if err := json.Unmarshal(data, &vector); err != nil {
		return table
	}

	// Values are grouped by their exact text, as returned by the datasource.
	groups := make(map[string][]map[string]string)
	var all []map[string]string
	for _, result := range vector.Result {
		if len(result.Value) < 2 {
			continue
		}
		var value string
		if err := json.Unmarshal(result.Value[1], &value); err != nil {
			continue
		}
		labels := make(map[string]string, len(result.Metric))
		for name, labelValue := range result.Metric {
			if name != "__name__" {
				labels[name] = labelValue
			}
		}
		groups[value] = append(groups[value], labels)
		all = append(all, labels)
	}

	withValue := make(map[string]struct{}, len(all))
	for _, labels := range all {
		withValue[seriesKey(labels)] = struct{}{}
	}
	var noData []map[string]string
	for _, labels := range indexed {
		key := seriesKey(labels)
		if _, ok := withValue[key]; ok {
			continue
		}
		withValue[key] = struct{}{} // the index may list a series more than once
		var stripped map[string]string
		_ = json.Unmarshal([]byte(key), &stripped)
		noData = append(noData, stripped)
		all = append(all, stripped)
	}
	table.SeriesTotal = len(all)
	everywhere := commonLabels(all)

	distinctLabels := func(series []map[string]string) map[string]string {
		distinct := commonLabels(series)
		for name, labelValue := range everywhere {
			if distinct[name] == labelValue {
				delete(distinct, name)
			}
		}
		return distinct
	}
	for value, series := range groups {
		table.Rows = append(table.Rows, statTableRow{Value: value, Labels: distinctLabels(series), SeriesCount: len(series)})
	}
	sort.Slice(table.Rows, func(i, j int) bool {
		if table.Rows[i].SeriesCount != table.Rows[j].SeriesCount {
			return table.Rows[i].SeriesCount > table.Rows[j].SeriesCount
		}
		return table.Rows[i].Value < table.Rows[j].Value
	})
	if len(table.Rows) > statTableMaxRows {
		table.Rows = table.Rows[:statTableMaxRows]
		table.Truncated = true
	}
	// Series without a sample in the range come last, whatever their count.
	if len(noData) > 0 {
		table.Rows = append(table.Rows, statTableRow{NoData: true, Labels: distinctLabels(noData), SeriesCount: len(noData)})
	}
	return table
}

// commonLabels returns the label pairs that every series carries with the same value.
func commonLabels(series []map[string]string) map[string]string {
	common := make(map[string]string)
	if len(series) == 0 {
		return common
	}
	for name, value := range series[0] {
		common[name] = value
	}
	for _, labels := range series[1:] {
		for name, value := range common {
			if labels[name] != value {
				delete(common, name)
			}
		}
	}
	return common
}

func (t *statTableResult) toProto() *explorerpb.StatTable {
	rows := make([]*explorerpb.StatTableRow, 0, len(t.Rows))
	for _, row := range t.Rows {
		rows = append(rows, &explorerpb.StatTableRow{
			Value:       row.Value,
			NoData:      row.NoData,
			Labels:      row.Labels,
			SeriesCount: uint32(row.SeriesCount),
		})
	}
	return &explorerpb.StatTable{Rows: rows, SeriesTotal: uint32(t.SeriesTotal), Truncated: t.Truncated}
}
