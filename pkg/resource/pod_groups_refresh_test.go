package resource

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

var (
	podGroupsTestStart = time.UnixMilli(1700000000000)
	podGroupsTestEnd   = time.UnixMilli(1700003600000)
)

func groupNames(e *explorerpb.PodGroupsCacheEntry) []string {
	names := make([]string, len(e.Groups))
	for i, g := range e.Groups {
		names[i] = g.Name
	}
	return names
}

func TestConcurrentPodGroupsRequestsShareOneFetch(t *testing.T) {
	f := &fakeLabelValues{t: t, label: "pod", values: []string{"web-7d4f8c9b7-k8pnx", "vmstorage-0"}}
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		f.ServeHTTP(w, r)
	}))
	t.Cleanup(upstream.Close)
	h := handlersFor(t, upstream, vmclient.Config{UID: "vm", DefaultTimeRange: time.Hour})

	const requests = 5
	results := make([]*explorerpb.PodGroupsCacheEntry, requests)
	var wg sync.WaitGroup
	for i := range requests {
		wg.Go(func() {
			var err error
			if results[i], err = h.loadPodGroups(context.Background(), podGroupsTestStart, podGroupsTestEnd); err != nil {
				t.Error(err)
			}
		})
	}
	time.Sleep(50 * time.Millisecond) // let every request reach the fetch
	close(release)
	wg.Wait()

	if got := len(f.requests()); got != len(labelValueGroups) {
		t.Fatalf("got %d upstream requests, want one fetch of %d shards", got, len(labelValueGroups))
	}
	for _, r := range results {
		if r == nil || len(r.Groups) != 2 {
			t.Fatalf("unexpected pod groups %v", r)
		}
	}
}

func TestPodGroupsRefreshKeepsRangesInUseFresh(t *testing.T) {
	h, f := newFakeLabelValues(t, "pod", "web-7d4f8c9b7-k8pnx")
	ctx := context.Background()

	first, err := h.loadPodGroups(ctx, podGroupsTestStart, podGroupsTestEnd)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupNames(first); len(got) != 1 || got[0] != "web" {
		t.Fatalf("first load = %q, want [web]", got)
	}
	fetch := len(f.requests())

	f.set("web-7d4f8c9b7-k8pnx", "api-6f9c7b5d8-x2x7z")
	h.podGroups.refresh()
	if got := len(f.requests()); got != 2*fetch {
		t.Fatalf("got %d upstream requests after the refresh, want %d", got, 2*fetch)
	}
	// The request after the refresh is answered from the cache, with the refreshed groups.
	second, err := h.loadPodGroups(ctx, podGroupsTestStart, podGroupsTestEnd)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupNames(second); len(got) != 2 || got[0] != "api" || len(f.requests()) != 2*fetch {
		t.Fatalf("second load = %q after %d requests, want [api web] from the cache", got, len(f.requests()))
	}

	// A range no request has asked for within podGroupsIdleAfter is no longer refreshed.
	h.podGroups.mu.Lock()
	for rng := range h.podGroups.used {
		h.podGroups.used[rng] = time.Now().Add(-podGroupsIdleAfter - time.Minute)
	}
	h.podGroups.mu.Unlock()
	h.podGroups.refresh()
	if got := len(f.requests()); got != 2*fetch || len(h.podGroups.used) != 0 {
		t.Fatalf("idle range refreshed: %d requests, %d ranges", got, len(h.podGroups.used))
	}
}

func TestPodGroupsRangesInUseAreBounded(t *testing.T) {
	h, _ := newFakeLabelValues(t, "pod")
	day := int64(24 * 60 * 60)
	dayRange := func(i int64) podGroupsRange { return podGroupsRange{start: i * day, end: (i + 1) * day} }
	for i := range int64(podGroupsMaxRanges) {
		h.podGroups.touch(context.Background(), dayRange(i))
	}
	h.podGroups.mu.Lock()
	h.podGroups.used[dayRange(5)] = time.Now().Add(-time.Hour)
	h.podGroups.mu.Unlock()

	h.podGroups.touch(context.Background(), dayRange(podGroupsMaxRanges))
	if got := len(h.podGroups.used); got != podGroupsMaxRanges {
		t.Fatalf("got %d ranges, want %d", got, podGroupsMaxRanges)
	}
	if _, ok := h.podGroups.used[dayRange(5)]; ok {
		t.Fatal("the least recently requested range should be forgotten")
	}
}

func TestClosedRouterFetchesNoPodGroups(t *testing.T) {
	h, f := newFakeLabelValues(t, "pod", "web-7d4f8c9b7-k8pnx")
	h.router.Close()
	if _, err := h.loadPodGroups(context.Background(), podGroupsTestStart, podGroupsTestEnd); err == nil {
		t.Fatal("want an error from a closed router")
	}
	if got := len(f.requests()); got != 0 {
		t.Fatalf("closed router sent %d upstream requests", got)
	}
}
