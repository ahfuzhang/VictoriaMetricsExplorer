package resource

import (
	"reflect"
	"testing"
)

func TestLeRows(t *testing.T) {
	rows, total := leRows([]vectorSample{
		{labels: map[string]string{"le": "+Inf"}, value: 10},
		{labels: map[string]string{"le": "0.1"}, value: 4},
		{labels: map[string]string{"le": "0.5"}, value: 4}, // empty bucket
		{labels: map[string]string{"le": "1"}, value: 9},
	})
	want := []histogramTableRow{
		{From: "0", To: "0.1", Count: 4},
		{From: "0.5", To: "1", Count: 5},
		{From: "1", To: "+Inf", Count: 1},
	}
	if !reflect.DeepEqual(rows, want) || total != 10 {
		t.Fatalf("leRows = %+v, %v; want %+v, 10", rows, total, want)
	}
}

func TestVMRangeRows(t *testing.T) {
	rows, total := vmrangeRows([]vectorSample{
		{labels: map[string]string{"vmrange": "1.136e+00...1.292e+00"}, value: 3},
		{labels: map[string]string{"vmrange": "1.000e+00...1.136e+00"}, value: 1},
		{labels: map[string]string{"vmrange": "2.000e+00...2.272e+00"}, value: 0},
	})
	want := []histogramTableRow{
		{From: "1.000e+00", To: "1.136e+00", Count: 1},
		{From: "1.136e+00", To: "1.292e+00", Count: 3},
	}
	if !reflect.DeepEqual(rows, want) || total != 4 {
		t.Fatalf("vmrangeRows = %+v, %v; want %+v, 4", rows, total, want)
	}
}
