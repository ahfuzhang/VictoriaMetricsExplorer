package resource

import (
	"context"
	json "encoding/json/v2"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

// labelsUpstream is a datasource for label detection: /api/v1/labels answers names, and a label's
// values request answers one value for the labels in values, none for the others. It records the
// limit of every label names request and the labels whose values were asked about.
type labelsUpstream struct {
	names   []string
	partial bool
	values  []string

	mu         sync.Mutex
	listLimits []string
	probed     []string
}

func (u *labelsUpstream) serve(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/api/v1/labels") {
			u.mu.Lock()
			u.listLimits = append(u.listLimits, r.URL.Query().Get("limit"))
			u.mu.Unlock()
			_ = json.MarshalWrite(w, map[string]any{"status": "success", "isPartial": u.partial, "data": u.names})
			return
		}
		label, ok := strings.CutSuffix(r.URL.Path, "/values")
		_, label, _ = strings.Cut(label, "/api/v1/label/")
		if !ok || label == "" {
			t.Errorf("unexpected upstream request %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if limit := r.URL.Query().Get("limit"); limit != "1" {
			t.Errorf("label %s was asked about with limit %q, want 1", label, limit)
		}
		u.mu.Lock()
		u.probed = append(u.probed, label)
		u.mu.Unlock()
		if slices.Contains(u.values, label) {
			_, _ = w.Write([]byte(`{"status":"success","data":["v"]}`))
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":[]}`))
	}
}

// requests returns the limits of the label names requests and the probed labels so far.
func (u *labelsUpstream) requests() ([]string, []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return slices.Clone(u.listLimits), slices.Clone(u.probed)
}

func labelMappingsHarness(t *testing.T, cfg vmclient.Config, u *labelsUpstream) *Handlers {
	t.Helper()
	upstream := httptest.NewServer(u.serve(t))
	t.Cleanup(upstream.Close)
	cfg.UID, cfg.DefaultTimeRange = "vm", time.Hour
	return handlersFor(t, upstream, cfg)
}

type wantMapping struct {
	role, label string
	detected    bool
}

func checkMappings(t *testing.T, mappings []*explorerpb.LabelMapping, want []wantMapping) {
	t.Helper()
	if len(mappings) != len(want) {
		t.Fatalf("got %d mappings, want %d: %v", len(mappings), len(want), mappings)
	}
	for i, w := range want {
		m := mappings[i]
		if m.Role != w.role || m.LabelName != w.label || m.Detected != w.detected || (m.Confidence == 1) != w.detected {
			t.Errorf("mapping %d = %v, want role %s label %s detected %v", i, m, w.role, w.label, w.detected)
		}
	}
}

var defaultLabelsConfig = vmclient.Config{PodLabel: "pod", NamespaceLabel: "namespace", NodeLabel: "node", ClusterLabel: "k8s_cluster"}

func TestDetectLabelMappingsReadsLabelNamesOnce(t *testing.T) {
	u := &labelsUpstream{names: []string{"__name__", "job", "k8s_cluster", "namespace", "pod_name"}}
	h := labelMappingsHarness(t, defaultLabelsConfig, u)

	mappings, err := h.detectLabelMappings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	checkMappings(t, mappings, []wantMapping{
		// The configured pod label is missing, so the first alternative the datasource has wins.
		{"pod", "pod_name", true},
		{"namespace", "namespace", true},
		// No node label exists: the configured one is reported, undetected.
		{"node", "node", false},
		{"cluster", "k8s_cluster", true},
	})

	limits, probed := u.requests()
	if want := []string{strconv.Itoa(labelNamesLimit)}; !slices.Equal(limits, want) {
		t.Errorf("label names requests had limits %v, want one with %v", limits, want)
	}
	if len(probed) != 0 {
		t.Errorf("a complete label names list needs no probe, asked about %v", probed)
	}
}

func TestDetectLabelMappingsIsCached(t *testing.T) {
	u := &labelsUpstream{names: []string{"namespace", "pod"}}
	h := labelMappingsHarness(t, defaultLabelsConfig, u)

	first, err := h.detectLabelMappings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := h.detectLabelMappings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if limits, _ := u.requests(); len(limits) != 1 {
		t.Fatalf("the second detection should come from the cache, made %d label names requests", len(limits))
	}
	if len(first) != len(second) {
		t.Fatalf("cached mappings %v differ from %v", second, first)
	}
	for i := range first {
		a, b := first[i], second[i]
		if a.Role != b.Role || a.LabelName != b.LabelName || a.Detected != b.Detected || a.Confidence != b.Confidence {
			t.Errorf("cached mapping %v differs from %v", b, a)
		}
	}
}

func TestDetectLabelMappingsDoesNotCachePartialAnswers(t *testing.T) {
	u := &labelsUpstream{names: []string{"pod"}, partial: true}
	h := labelMappingsHarness(t, defaultLabelsConfig, u)

	for range 2 {
		if _, err := h.detectLabelMappings(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if limits, _ := u.requests(); len(limits) != 2 {
		t.Fatalf("a partial answer must not be cached, made %d label names requests", len(limits))
	}
}

func TestDetectLabelMappingsSkipsInvalidLabelNames(t *testing.T) {
	cfg := vmclient.Config{PodLabel: "pod-name", NamespaceLabel: "namespace", NodeLabel: "node", ClusterLabel: "cluster"}
	// Even listed, an invalid name is never matched.
	u := &labelsUpstream{names: []string{"pod", "pod-name"}}
	h := labelMappingsHarness(t, cfg, u)

	mappings, err := h.detectLabelMappings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if m := mappings[0]; m.LabelName != "pod" || !m.Detected {
		t.Fatalf("pod mapping = %v, want the pod alternative detected", m)
	}
}

// A label names list that reaches the limit may have been cut: the names it lacks are asked about
// one by one, in each role's order, until one exists.
func TestDetectLabelMappingsProbesNamesMissingFromACutList(t *testing.T) {
	names := make([]string, 0, labelNamesLimit)
	names = append(names, "namespace")
	for i := len(names); i < labelNamesLimit; i++ {
		names = append(names, "label_"+strconv.Itoa(i))
	}
	cfg := vmclient.Config{PodLabel: "pod", NamespaceLabel: "namespace", NodeLabel: "node", ClusterLabel: "cluster"}
	u := &labelsUpstream{names: names, values: []string{"pod", "kubernetes_node"}}
	h := labelMappingsHarness(t, cfg, u)

	mappings, err := h.detectLabelMappings(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	checkMappings(t, mappings, []wantMapping{
		{"pod", "pod", true},
		{"namespace", "namespace", true},
		{"node", "kubernetes_node", true},
		{"cluster", "cluster", false},
	})

	_, probed := u.requests()
	slices.Sort(probed)
	// namespace is in the list; pod stops its role; node and cluster try every alternative.
	want := []string{"cluster", "cluster_name", "instance", "kubernetes_node", "node", "pod"}
	if !slices.Equal(probed, want) {
		t.Errorf("probed %v, want %v", probed, want)
	}
}

func TestDetectLabelMappingsFailsWhenTheDatasourceFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"Bad Gateway"}`, http.StatusBadGateway)
	}))
	t.Cleanup(upstream.Close)
	cfg := defaultLabelsConfig
	cfg.UID, cfg.DefaultTimeRange = "vm", time.Hour
	h := handlersFor(t, upstream, cfg)

	_, err := h.detectLabelMappings(context.Background())
	if err == nil || !strings.Contains(err.Error(), "/api/v1/labels") {
		t.Fatalf("expected the label names request's upstream error, got %v", err)
	}
}
