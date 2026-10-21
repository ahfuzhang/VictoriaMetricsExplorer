package resource

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestBuildStatTable(t *testing.T) {
	data := json.RawMessage(`{"result":[
		{"metric":{"__name__":"cfg","job":"api","zone":"a","pod":"api-1"},"value":[1,"3"]},
		{"metric":{"__name__":"cfg","job":"api","zone":"b","pod":"api-2"},"value":[1,"3"]},
		{"metric":{"__name__":"cfg","job":"api","zone":"a","pod":"api-3"},"value":[1,"3"]},
		{"metric":{"__name__":"cfg","job":"web","zone":"a","pod":"web-1"},"value":[1,"5"]},
		{"metric":{"__name__":"cfg","job":"web","zone":"b","pod":"web-2"},"value":[1,"5"]},
		{"metric":{"__name__":"cfg","job":"db","zone":"a","pod":"db-1"},"value":[1,"0"]}
	]}`)
	got := buildStatTable(data, nil)
	want := &statTableResult{
		Rows: []statTableRow{
			{Value: "3", Labels: map[string]string{"job": "api"}, SeriesCount: 3},
			{Value: "5", Labels: map[string]string{"job": "web"}, SeriesCount: 2},
			{Value: "0", Labels: map[string]string{"job": "db", "zone": "a", "pod": "db-1"}, SeriesCount: 1},
		},
		SeriesTotal: 6,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildStatTable =\n%+v\nwant\n%+v", got, want)
	}
}

func TestBuildStatTableDropsLabelsSharedByEverySeries(t *testing.T) {
	data := json.RawMessage(`{"result":[
		{"metric":{"cluster":"prod","job":"api"},"value":[1,"1"]},
		{"metric":{"cluster":"prod","job":"web"},"value":[1,"2"]}
	]}`)
	got := buildStatTable(data, nil)
	for _, row := range got.Rows {
		if _, ok := row.Labels["cluster"]; ok {
			t.Fatalf("cluster is shared by every series and explains no value: %+v", row)
		}
	}
}

func TestStatTableQueryCoversTheWholeRange(t *testing.T) {
	end := time.Unix(10_000, 0)
	if got, want := statTableQuery(`{__name__="up"}`, end.Add(-6*time.Hour), end), `last_over_time({__name__="up"}[6h])`; got != want {
		t.Fatalf("statTableQuery = %s, want %s", got, want)
	}
}

func TestBuildStatTableCountsIndexedSeriesWithoutSamples(t *testing.T) {
	data := json.RawMessage(`{"result":[
		{"metric":{"pod":"a"},"value":[1,"-1"]},
		{"metric":{"pod":"b"},"value":[1,"-1"]}
	]}`)
	indexed := []map[string]string{
		{"__name__": "health", "pod": "a"},
		{"__name__": "health", "pod": "b"},
		{"__name__": "health", "pod": "c"},
		{"__name__": "health", "pod": "c"}, // listed twice
	}
	got := buildStatTable(data, indexed)
	want := &statTableResult{
		Rows: []statTableRow{
			{Value: "-1", Labels: map[string]string{}, SeriesCount: 2},
			{NoData: true, Labels: map[string]string{"pod": "c"}, SeriesCount: 1},
		},
		SeriesTotal: 3,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildStatTable =\n%+v\nwant\n%+v", got, want)
	}
}
