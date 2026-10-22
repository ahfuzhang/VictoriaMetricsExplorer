package resource

import (
	"context"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

func TestPodPrefix(t *testing.T) {
	tests := []struct {
		pod  string
		want string
	}{
		// Deployment: <name>-<replicaset hash>-<random>
		{"mahjong-ways-7d4f8c9b7-k8pnx", "mahjong-ways"},
		{"mahjong-ways2-5c6b8d9f4-xq2zr", "mahjong-ways2"},
		{"api-gateway-6f9c7b5d8-x2x7z", "api-gateway"},
		// DaemonSet / Job: <name>-<random>
		{"node-exporter-qwxzt", "node-exporter"},
		// StatefulSet: <name>-<ordinal>
		{"vmstorage-0", "vmstorage"},
		{"worker10-2", "worker10"},
		// CronJob: <name>-<schedule time>-<random>
		{"backup-28473920-bc7xz", "backup"},
		// Hex-like hashes from other generators
		{"svc-a1b2c3d4-x7zpq", "svc"},
		// Names chosen by people stay whole
		{"myapp-v2", "myapp-v2"},
		{"s3proxy", "s3proxy"},
		{"my-s3proxy", "my-s3proxy"},
		{"simple", "simple"},
		{"mydb--", "mydb"},
		{"12345", "12345"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := podPrefix(tt.pod); got != tt.want {
			t.Errorf("podPrefix(%q) = %q, want %q", tt.pod, got, tt.want)
		}
	}
}

func TestBuildPodGroupsKeepsSimilarNamesApart(t *testing.T) {
	groups := buildPodGroups([]string{
		"mahjong-ways2-5c6b8d9f4-xq2zr",
		"mahjong-ways-7d4f8c9b7-k8pnx",
		"mahjong-ways-7d4f8c9b7-b2h9w",
		"mahjong-ways2-5c6b8d9f4-zz7kq",
		"vmstorage-1",
		"vmstorage-0",
	})
	want := []podGroupEntry{
		{Name: "mahjong-ways", Count: 2, Pods: []string{"mahjong-ways-7d4f8c9b7-b2h9w", "mahjong-ways-7d4f8c9b7-k8pnx"}},
		{Name: "mahjong-ways2", Count: 2, Pods: []string{"mahjong-ways2-5c6b8d9f4-xq2zr", "mahjong-ways2-5c6b8d9f4-zz7kq"}},
		{Name: "vmstorage", Count: 2, Pods: []string{"vmstorage-0", "vmstorage-1"}},
	}
	if !reflect.DeepEqual(groups, want) {
		t.Fatalf("buildPodGroups = %+v, want %+v", groups, want)
	}
}

func TestPodPrefixMatcher(t *testing.T) {
	if got, want := podPrefixMatcher("pod", "mahjong-ways"), `pod=~"mahjong-ways-.*"`; got != want {
		t.Errorf("podPrefixMatcher = %s, want %s", got, want)
	}
	if got, want := podPrefixMatcher("pod", "web.app"), `pod=~"web\\.app-.*"`; got != want {
		t.Errorf("podPrefixMatcher (escaped) = %s, want %s", got, want)
	}
}

func TestLabelSelector(t *testing.T) {
	tests := []struct {
		matchers []string
		want     string
	}{
		{nil, ""},
		{[]string{"", ""}, ""},
		{[]string{`pod=~"a-.*"`, ""}, `{pod=~"a-.*"}`},
		{[]string{"", `node="n1"`}, `{node="n1"}`},
		{[]string{`pod=~"a-.*"`, `node="n1"`}, `{pod=~"a-.*",node="n1"}`},
	}
	for _, tt := range tests {
		if got := labelSelector(tt.matchers...); got != tt.want {
			t.Errorf("labelSelector(%q) = %s, want %s", tt.matchers, got, tt.want)
		}
	}
}

func TestBuildMetricSelectorMatchers(t *testing.T) {
	tests := []struct {
		matchers []string
		want     string
	}{
		{nil, `{__name__="up",job="api"}`},
		{[]string{`pod=~"a-.*"`, ""}, `{__name__="up",job="api",pod=~"a-.*"}`},
		{[]string{`pod=~"a-.*"`, `node="n1"`}, `{__name__="up",job="api",pod=~"a-.*",node="n1"}`},
	}
	for _, tt := range tests {
		if got := buildMetricSelector("up", map[string][]string{"job": {"api"}}, tt.matchers...); got != tt.want {
			t.Errorf("buildMetricSelector(up, job=api, %q) = %s, want %s", tt.matchers, got, tt.want)
		}
	}
}

func TestHandlePodGroupsReturnsProtobuf(t *testing.T) {
	h, _ := metricTypesHarness(t, []string{
		"mahjong-ways-7d4f8c9b7-k8pnx",
		"mahjong-ways-7d4f8c9b7-b2h9w",
		"vmstorage-0",
	}, nil)

	req := postProto(t, "/explorer/v1/pod-groups", &explorerpb.PodGroupsRequest{
		Range: &explorerpb.TimeRange{StartMs: 1700000000000, EndMs: 1700003600000},
	})
	rec := httptest.NewRecorder()
	h.handlePodGroups(rec, req)
	expectOK(t, rec)

	var resp explorerpb.PodGroupsResponse
	decodeProto(t, rec.Body.Bytes(), &resp)
	if resp.Label != "pod" || resp.PodCount != 3 || len(resp.Groups) != 2 {
		t.Fatalf("unexpected response: %v", &resp)
	}
	if g := resp.Groups[0]; g.Name != "mahjong-ways" || g.Count != 2 ||
		!reflect.DeepEqual(g.Pods, []string{"mahjong-ways-7d4f8c9b7-b2h9w", "mahjong-ways-7d4f8c9b7-k8pnx"}) {
		t.Fatalf("unexpected first group: %v", g)
	}
	if resp.Meta.GetRequestId() == "" {
		t.Fatal("meta must carry the request id")
	}
}

func TestPodAndNodeGroupsAreServedFromCache(t *testing.T) {
	h, _ := metricTypesHarness(t, []string{"vmstorage-0", "vmstorage-1", "web-7d4f8c9b7-k8pnx"}, nil)
	ctx := context.Background()
	start, end := time.UnixMilli(1700000000000), time.UnixMilli(1700003600000)

	hits := func() uint64 { return h.router.obs.Snapshot().CacheHits }

	pods, err := h.loadPodGroups(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	before := hits()
	cachedPods, err := h.loadPodGroups(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	if hits() != before+1 || !proto.Equal(pods, cachedPods) {
		t.Fatalf("pod groups: expected an identical cache hit, got %v (was %v)", cachedPods, pods)
	}
	if len(cachedPods.Groups) != 2 || cachedPods.Groups[0].Name != "vmstorage" || cachedPods.Groups[0].Count != 2 {
		t.Fatalf("unexpected cached pod groups: %v", cachedPods)
	}

	nodes, err := h.loadNodeGroups(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	before = hits()
	cachedNodes, err := h.loadNodeGroups(ctx, start, end)
	if err != nil {
		t.Fatal(err)
	}
	if hits() != before+1 || !proto.Equal(nodes, cachedNodes) || len(cachedNodes.Nodes) != 3 {
		t.Fatalf("node groups: expected an identical cache hit, got %v (was %v)", cachedNodes, nodes)
	}
}
