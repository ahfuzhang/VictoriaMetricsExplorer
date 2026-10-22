package resource

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// escapeCases covers every escaping rule: plain text, quotes and backslashes, the one-letter
// escapes, other control bytes, DEL, printable and non-printable Unicode, a 4-byte rune, invalid
// UTF-8 and every regex metacharacter.
var escapeCases = []string{
	"",
	"api-server",
	`say "hello"`,
	`C:\temp\`,
	"a\a\b\f\n\r\t\vz",
	"\x00\x01\x1f\x7f",
	"héllo 世界 \uFFFD",
	"\u00ad\u200b\u2028\ufeff",
	"emoji 😀 \U000e0001",
	"bad \xff\xfe utf8 \xe4\xb8",
	`.+*?()|[]{}^$\`,
	`1.0 a+b (x|y) [z] {1} ^$`,
}

func TestAppendQuotedMatchesStrconv(t *testing.T) {
	for _, s := range escapeCases {
		want := strconv.Quote(s)
		if got := string(appendQuoted(nil, s)); got != want {
			t.Errorf("appendQuoted(%q) = %s, want %s", s, got, want)
		}
		if got := quotedLen(s); got != len(want) {
			t.Errorf("quotedLen(%q) = %d, want %d", s, got, len(want))
		}
	}
}

func TestAppendEscapedRegexMatchesQuoteMeta(t *testing.T) {
	for _, s := range escapeCases {
		quoted := strconv.Quote(regexp.QuoteMeta(s))
		want := quoted[1 : len(quoted)-1]
		if got := string(appendEscaped(nil, s, true)); got != want {
			t.Errorf("appendEscaped(%q, regex) = %s, want %s", s, got, want)
		}
		if got := escapedLen(s, true); got != len(want) {
			t.Errorf("escapedLen(%q, regex) = %d, want %d", s, got, len(want))
		}
	}
}

func TestAppendValuesMatch(t *testing.T) {
	tests := []struct {
		values []string
		want   string
	}{
		{[]string{"api"}, `="api"`},
		{[]string{`a"b`}, `="a\"b"`},
		{[]string{"a.example", "b"}, `=~"^(?:a\\.example|b)$"`},
	}
	for _, tt := range tests {
		got := string(appendValuesMatch(nil, tt.values))
		if got != tt.want {
			t.Errorf("appendValuesMatch(%q) = %s, want %s", tt.values, got, tt.want)
		}
		if n := valuesMatchLen(tt.values); n != len(got) {
			t.Errorf("valuesMatchLen(%q) = %d, want %d", tt.values, n, len(got))
		}
	}
}

func TestMetricSelectorLenIsExact(t *testing.T) {
	filters := map[string][]string{
		"job":      {"api"},
		"instance": {"a.example:9100", `b"\`, "c\n"},
		"empty":    {},
	}
	matchers := []string{`pod=~"web-.*"`, "", `node="n1"`}
	labels := selectorLabels(filters)
	n := metricSelectorLen("http_requests_total", filters, labels, matchers)
	b := appendMetricSelector(make([]byte, 0, n), "http_requests_total", filters, labels, matchers)
	if len(b) != n || cap(b) != n {
		t.Fatalf("selector %s: len %d, cap %d, counted %d", b, len(b), cap(b), n)
	}
}

func TestAppendStep(t *testing.T) {
	for sec, want := range map[int64]string{1: "1s", 90: "90s", 120: "2m", 7200: "2h", 1<<63 - 1: "9223372036854775807s"} {
		b := appendStep(make([]byte, 0, maxStepLen), sec)
		if string(b) != want || cap(b) != maxStepLen {
			t.Errorf("appendStep(%d) = %s (cap %d), want %s", sec, b, cap(b), want)
		}
	}
}

func TestHistogramMemberNames(t *testing.T) {
	bucket, count, sum := histogramMemberNames("http_request_duration_seconds")
	if bucket != "http_request_duration_seconds_bucket" || count != "http_request_duration_seconds_count" ||
		sum != "http_request_duration_seconds_sum" {
		t.Fatalf("histogramMemberNames = %s, %s, %s", bucket, count, sum)
	}
}

func TestLabelsKey(t *testing.T) {
	a := labelsKey(map[string]string{"__name__": "up", "job": "api", "instance": "a"}, "__name__")
	b := labelsKey(map[string]string{"instance": "a", "job": "api"}, "")
	if a != b || a != "instance\x00a\x00job\x00api\x00" {
		t.Fatalf("labelsKey: %q and %q, want both %q", a, b, "instance\x00a\x00job\x00api\x00")
	}
	if strings.Contains(a, "up") {
		t.Fatalf("labelsKey kept the skipped label: %q", a)
	}
	if labelsKey(map[string]string{"a": "bc"}, "") == labelsKey(map[string]string{"ab": "c"}, "") {
		t.Fatal("labelsKey should keep names and values apart")
	}
}
