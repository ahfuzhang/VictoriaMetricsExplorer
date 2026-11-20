package resource

import (
	"context"
	json "encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

// selectorMatcher returns the test for the values of label that sel selects, sel being a selector
// shardedLabelValues sends: {label="v"} or {label=~"re"}.
func selectorMatcher(t *testing.T, label, sel string) func(string) bool {
	t.Helper()
	body, ok := strings.CutPrefix(sel, "{"+label)
	body, ok2 := strings.CutSuffix(body, "}")
	if !ok || !ok2 {
		t.Fatalf("unexpected selector %s", sel)
	}
	if quoted, isRegex := strings.CutPrefix(body, "=~"); isRegex {
		re, err := strconv.Unquote(quoted)
		if err != nil {
			t.Fatalf("selector %s: %v", sel, err)
		}
		return regexp.MustCompile("^(?:" + re + ")$").MatchString
	}
	v, err := strconv.Unquote(strings.TrimPrefix(body, "="))
	if err != nil {
		t.Fatalf("selector %s: %v", sel, err)
	}
	return func(s string) bool { return s == v }
}

// fakeLabelValues is a datasource with one label: a values request gets the values its match[]
// selects, sorted and cut to its limit, or a 500 when fail says so.
type fakeLabelValues struct {
	t     *testing.T
	label string
	fail  func(sel string) bool

	mu     sync.Mutex
	values []string
	asked  []string // the selector of every request
	limits []string // the limit of every request
}

func (f *fakeLabelValues) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasSuffix(r.URL.Path, "/api/v1/label/"+f.label+"/values") {
		f.t.Errorf("unexpected upstream request %s", r.URL.Path)
		http.NotFound(w, r)
		return
	}
	matches := r.URL.Query()["match[]"]
	if len(matches) != 1 {
		f.t.Errorf("want one match[], got %q", matches)
	}
	sel := strings.Join(matches, ",")
	f.mu.Lock()
	f.asked = append(f.asked, sel)
	f.limits = append(f.limits, r.URL.Query().Get("limit"))
	values := slices.Clone(f.values)
	f.mu.Unlock()
	if f.fail != nil && f.fail(sel) {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}

	match := selectorMatcher(f.t, f.label, sel)
	selected := []string{}
	for _, v := range values {
		if match(v) {
			selected = append(selected, v)
		}
	}
	slices.Sort(selected)
	if limit, _ := strconv.Atoi(r.URL.Query().Get("limit")); limit > 0 && len(selected) > limit {
		selected = selected[:limit]
	}
	data, _ := json.Marshal(selected)
	_, _ = w.Write([]byte(`{"status":"success","data":` + string(data) + `}`))
}

func (f *fakeLabelValues) set(values ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.values = values
}

func (f *fakeLabelValues) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.asked)
}

func newFakeLabelValues(t *testing.T, label string, values ...string) (*Handlers, *fakeLabelValues) {
	t.Helper()
	f := &fakeLabelValues{t: t, label: label, values: values}
	upstream := httptest.NewServer(f)
	t.Cleanup(upstream.Close)
	return handlersFor(t, upstream, vmclient.Config{UID: "vm", DefaultTimeRange: time.Hour}), f
}

// shardTestValues start with every kind of character a label value can start with.
var shardTestValues = []string{
	"a", "abc", "mid", "zeta", "Upper", "Z", "0day", "9", "_private", ":colon", "-dash", ".dot",
	"/slash", "ünicode", "日本", "[x", "]x", "^x", `\x`, `"q`, "a.b", "a-b", "a b",
}

func TestLabelValueShardsTakeEveryValueOnce(t *testing.T) {
	selected := func(s *labelValueShard, v string) bool {
		return selectorMatcher(t, "pod", s.selector("pod"))(v)
	}
	// once checks that every value of parent is in exactly one of shards.
	once := func(parent *labelValueShard, shards []labelValueShard) {
		t.Helper()
		for _, v := range shardTestValues {
			if parent != nil && !selected(parent, v) {
				continue
			}
			n := 0
			for i := range shards {
				if selected(&shards[i], v) {
					n++
				}
			}
			if n != 1 {
				t.Errorf("%q is in %d shards of %+v, want 1", v, n, parent)
			}
		}
	}

	roots := prefixShards("", false)
	if len(roots) < 5 {
		t.Fatalf("got %d first shards, want at least 5", len(roots))
	}
	once(nil, roots)
	for i := range roots {
		if children := roots[i].split(); children != nil {
			once(&roots[i], children)
		} else if roots[i].group.chars != "" {
			t.Errorf("shard %s cannot be split", roots[i].selector("pod"))
		}
	}
	// A prefix splits into itself and the prefix followed by each group.
	prefix := labelValueShard{prefix: "a"}
	once(&prefix, prefix.split())
}

func TestLabelValueShardSelectors(t *testing.T) {
	roots := prefixShards("", false)
	if got, want := roots[0].selector("pod"), `{pod=~"[abc].*"}`; got != want {
		t.Errorf("first shard = %s, want %s", got, want)
	}
	if got, want := roots[len(roots)-2].selector("__name__"), `{__name__=~"[_:\\-.].*"}`; got != want {
		t.Errorf("punctuation shard = %s, want %s", got, want)
	}
	tests := []struct {
		shard labelValueShard
		want  string
	}{
		{labelValueShard{prefix: "a.b"}, `{pod=~"a\\.b.*"}`},
		{labelValueShard{prefix: "a.b", exact: true}, `{pod="a.b"}`},
		{labelValueShard{prefix: "x", group: &labelValueGroups[1]}, `{pod=~"x[def].*"}`},
	}
	for _, tt := range tests {
		if got := tt.shard.selector("pod"); got != tt.want {
			t.Errorf("selector(%+v) = %s, want %s", tt.shard, got, tt.want)
		}
	}
}

func TestShardedLabelValuesSplitsShardsCutShort(t *testing.T) {
	values := []string{
		// More values than the limit of 3 start with [abc], with "a" and with "ab": each is split.
		"a", "a-1", "a0", "a1", "ab", "abc", "abd", "abe", "ac", "b1",
		"web-0", "Upper", "9lives", "_private", ":colon", "-dash", ".dot", "ünicode",
	}
	h, f := newFakeLabelValues(t, "pod", values...)
	h.router.limits.MaxMetricNamesHard = 3

	got, partial, err := h.shardedLabelValues(context.Background(), "pod", time.Unix(0, 0), time.Unix(86400, 0))
	if err != nil {
		t.Fatal(err)
	}
	if want := slices.Sorted(slices.Values(values)); !slices.Equal(got, want) || partial {
		t.Fatalf("got %q (partial %v), want %q", got, partial, want)
	}
	asked := f.requests()
	if len(asked) <= len(labelValueGroups) {
		t.Fatalf("got %d requests, want the first %d and the splits", len(asked), len(labelValueGroups))
	}
	for _, sel := range []string{`{pod=~"a.*"}`, `{pod="a"}`, `{pod=~"ab.*"}`, `{pod=~"_.*"}`} {
		if !slices.Contains(asked, sel) {
			t.Errorf("no request for %s in %q", sel, asked)
		}
	}
	for _, limit := range f.limits {
		if limit != "3" {
			t.Fatalf("request limit %s, want 3", limit)
		}
	}
}

func TestShardedLabelValuesIsPartialWhenTheCatchAllIsCutShort(t *testing.T) {
	h, _ := newFakeLabelValues(t, "pod", "web-0", "ünicode", "日本", "/slash")
	h.router.limits.MaxMetricNamesHard = 3

	got, partial, err := h.shardedLabelValues(context.Background(), "pod", time.Unix(0, 0), time.Unix(86400, 0))
	if err != nil {
		t.Fatal(err)
	}
	if !partial || len(got) != 4 {
		t.Fatalf("got %q (partial %v), want the 4 values, partial", got, partial)
	}
}

func TestShardedLabelValuesFailsWithAShard(t *testing.T) {
	h, f := newFakeLabelValues(t, "pod", "web-0", "9lives")
	f.fail = func(sel string) bool { return strings.Contains(sel, "0123456789") }

	if _, _, err := h.shardedLabelValues(context.Background(), "pod", time.Unix(0, 0), time.Unix(86400, 0)); err == nil {
		t.Fatal("want the failed shard's error")
	}
}
