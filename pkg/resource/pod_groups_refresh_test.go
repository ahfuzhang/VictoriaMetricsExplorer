package resource

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

func TestOAuthPodGroupsStayInTheirRequestSession(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("OAuth pod groups used the service account")
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(upstream.Close)
	h := handlersFor(t, upstream, vmclient.Config{UID: "prom", ForwardOAuth: true})
	c := cache.New(32 << 20)
	t.Cleanup(c.Close)
	h.router.cache = c.UncachedScope()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	release := make(chan struct{})
	var calls [2]atomic.Int64
	var sessions [2]context.Context
	var ready [2]chan struct{}
	var wg sync.WaitGroup
	for i := range sessions {
		ready[i] = make(chan struct{})
		sessions[i] = vmclient.WithSessionProxy(ctx, func(ctx context.Context, path string) (*http.Response, error) {
			if calls[i].Add(1) == 1 {
				close(ready[i])
			}
			select {
			case <-release:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			body := fmt.Sprintf(`{"status":"success","data":["user%d-pod-0"]}`, i)
			return &http.Response{StatusCode: 200, ContentLength: int64(len(body)), Body: io.NopCloser(strings.NewReader(body))}, nil
		})
		wg.Go(func() {
			// Repeating the request must still fetch this user's values, without a shared cache.
			for range 2 {
				result, err := h.loadPodGroups(sessions[i], podGroupsTestStart, podGroupsTestEnd)
				if err != nil {
					t.Error(err)
					return
				}
				if names := groupNames(result); len(names) != 1 || names[0] != fmt.Sprintf("user%d-pod", i) {
					t.Errorf("session %d received another user's groups: %v", i, names)
				}
			}
		})
	}
	for _, started := range ready {
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal("concurrent users shared an in-flight request")
		}
	}
	close(release)
	wg.Wait()
	for i := range calls {
		if got := calls[i].Load(); got != int64(2*len(labelValueGroups)) {
			t.Errorf("session %d fetched %d shards", i, got)
		}
	}
	if h.podGroups.started || len(h.podGroups.used) != 0 || h.podGroups.baseCtx != nil {
		t.Fatal("OAuth session retained for background refresh")
	}
}

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
