package resource

import (
	"context"
	"sync"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/requestcontext"
	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const (
	// podGroupsCacheTTL is how long fetched pod groups are served from the cache.
	podGroupsCacheTTL = time.Hour
	// podGroupsRefreshInterval is how often the pod groups of every range in use are fetched again
	// in the background, so that requests keep finding them in the cache.
	podGroupsRefreshInterval = time.Hour
	// podGroupsIdleAfter is how long a range no request asks for is still refreshed.
	podGroupsIdleAfter = 24 * time.Hour
	// podGroupsMaxRanges bounds the ranges refreshed; the least recently requested one goes first.
	podGroupsMaxRanges = 32
)

// podGroupsRange is a day-aligned range, in unix seconds.
type podGroupsRange struct{ start, end int64 }

// podGroupsRefresher runs the pod-groups fetches of one datasource. A range has at most one fetch
// running, which every request for it waits for, and the ranges requests use are fetched again
// every podGroupsRefreshInterval, so only the first request of a range waits for the datasource.
type podGroupsRefresher struct {
	h *Handlers
	// stopCtx ends with close; it stops the refresh loop and the fetches.
	stopCtx context.Context
	stop    context.CancelFunc

	mu sync.Mutex
	// baseCtx retains service configuration, but no user identity, request headers or trace.
	baseCtx  context.Context
	used     map[podGroupsRange]time.Time // when each range was last requested
	inflight map[podGroupsRange]*podGroupsCall
	started  bool
}

// podGroupsCall is one fetch of a range's pod groups; done is closed once result or err is set.
type podGroupsCall struct {
	done   chan struct{}
	result *explorerpb.PodGroupsCacheEntry
	err    error
}

func newPodGroupsRefresher(h *Handlers) *podGroupsRefresher {
	ctx, stop := context.WithCancel(context.Background())
	return &podGroupsRefresher{
		h:        h,
		stopCtx:  ctx,
		stop:     stop,
		used:     make(map[podGroupsRange]time.Time),
		inflight: make(map[podGroupsRange]*podGroupsCall),
	}
}

// close stops the refresh loop and cancels the fetches running.
func (p *podGroupsRefresher) close() {
	p.stop()
}

// touch records demand and retains service configuration for scheduled refreshes.
// The immediate fetch separately receives the originating request context.
func (p *podGroupsRefresher) touch(ctx context.Context, rng podGroupsRange) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.baseCtx = requestcontext.Background(ctx)
	if _, ok := p.used[rng]; !ok && len(p.used) >= podGroupsMaxRanges {
		p.forgetOldestLocked()
	}
	p.used[rng] = time.Now()
	if !p.started && p.stopCtx.Err() == nil {
		p.started = true
		go p.run()
	}
}

// forgetOldestLocked stops refreshing the least recently requested range. Callers hold p.mu.
func (p *podGroupsRefresher) forgetOldestLocked() {
	var oldest podGroupsRange
	var oldestAt time.Time
	for rng, at := range p.used {
		if oldestAt.IsZero() || at.Before(oldestAt) {
			oldest, oldestAt = rng, at
		}
	}
	delete(p.used, oldest)
}

// load returns the pod groups of rng from a fetch: the one running for rng, or a new one. If ctx
// ends first, the fetch goes on and still fills the cache.
func (p *podGroupsRefresher) load(ctx context.Context, rng podGroupsRange) (*explorerpb.PodGroupsCacheEntry, error) {
	c := p.fetch(rng, ctx)
	select {
	case <-c.done:
		return c.result, c.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// fetch returns the fetch running for rng, starting one if there is none. Callers have touched rng.
func (p *podGroupsRefresher) fetch(rng podGroupsRange, requestCtx context.Context) *podGroupsCall {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c := p.inflight[rng]; c != nil {
		return c
	}
	c := &podGroupsCall{done: make(chan struct{})}
	if err := p.stopCtx.Err(); err != nil {
		c.err = err
		close(c.done)
		return c
	}
	p.inflight[rng] = c
	base := p.baseCtx
	if requestCtx != nil {
		base = context.WithoutCancel(requestCtx)
	}
	ctx, cancel := context.WithCancel(base)
	go func() {
		stopped := context.AfterFunc(p.stopCtx, cancel)
		c.result, c.err = p.h.fetchPodGroups(ctx, rng)
		stopped()
		cancel()
		p.mu.Lock()
		delete(p.inflight, rng)
		p.mu.Unlock()
		close(c.done)
	}()
	return c
}

// run refreshes the pod groups every podGroupsRefreshInterval until close.
func (p *podGroupsRefresher) run() {
	ticker := time.NewTicker(podGroupsRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-p.stopCtx.Done():
			return
		case <-ticker.C:
			p.refresh()
		}
	}
}

// refresh fetches again the pod groups of the ranges requested within podGroupsIdleAfter, one
// range at a time.
func (p *podGroupsRefresher) refresh() {
	for _, rng := range p.activeRanges() {
		c := p.fetch(rng, nil)
		select {
		case <-p.stopCtx.Done():
			return
		case <-c.done:
		}
		if c.err != nil {
			log.DefaultLogger.Warn("pod-groups: background refresh failed", "error", c.err,
				"start", rng.start, "end", rng.end)
		}
	}
}

// activeRanges returns the ranges requested within podGroupsIdleAfter, and forgets the others.
func (p *podGroupsRefresher) activeRanges() []podGroupsRange {
	p.mu.Lock()
	defer p.mu.Unlock()
	cutoff := time.Now().Add(-podGroupsIdleAfter)
	ranges := make([]podGroupsRange, 0, len(p.used))
	for rng, at := range p.used {
		if at.Before(cutoff) {
			delete(p.used, rng)
			continue
		}
		ranges = append(ranges, rng)
	}
	return ranges
}
