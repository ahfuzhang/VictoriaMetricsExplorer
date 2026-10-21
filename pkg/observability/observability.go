package observability

import (
	"sync"
	"sync/atomic"
	"time"
)

// Observability holds structured logging state, metrics counters, and diagnostic info.
type Observability struct {
	datasourceUID string

	// Metrics counters (low cardinality)
	upstreamRequests   atomic.Int64
	upstreamErrors     atomic.Int64
	cacheHits          atomic.Int64
	cacheMisses        atomic.Int64
	cacheEvictions     atomic.Int64
	singleflightMerged atomic.Int64
	requestsCancelled  atomic.Int64
	requestsTimedOut   atomic.Int64
	requestsTruncated  atomic.Int64

	// Upstream latency tracking (simplified)
	upstreamLatencySum atomic.Int64 // nanoseconds
	upstreamLatencyCnt atomic.Int64

	// Error code counts
	errorCounts sync.Map // map[string]*atomic.Int64

	// Current in-flight requests
	inFlight atomic.Int64

	// Close
	closed atomic.Bool
}

// New creates a new Observability instance.
func New(datasourceUID string) *Observability {
	return &Observability{
		datasourceUID: datasourceUID,
	}
}

// Close stops any background tasks.
func (o *Observability) Close() {
	o.closed.Store(true)
}

// RecordUpstreamRequest records an upstream request's outcome.
func (o *Observability) RecordUpstreamRequest(elapsed time.Duration, status string) {
	o.upstreamRequests.Add(1)
	o.upstreamLatencySum.Add(int64(elapsed))
	o.upstreamLatencyCnt.Add(1)
	if status == "error" {
		o.upstreamErrors.Add(1)
	}
}

// RecordCacheHit records a cache hit.
func (o *Observability) RecordCacheHit() {
	o.cacheHits.Add(1)
}

// RecordCacheMiss records a cache miss.
func (o *Observability) RecordCacheMiss() {
	o.cacheMisses.Add(1)
}

// RecordCacheEviction records a cache eviction.
func (o *Observability) RecordCacheEviction() {
	o.cacheEvictions.Add(1)
}

// RecordSingleflightMerge records a singleflight merge.
func (o *Observability) RecordSingleflightMerge() {
	o.singleflightMerged.Add(1)
}

// RecordCancellation records a cancelled request.
func (o *Observability) RecordCancellation() {
	o.requestsCancelled.Add(1)
}

// RecordTimeout records a timed-out request.
func (o *Observability) RecordTimeout() {
	o.requestsTimedOut.Add(1)
}

// RecordTruncation records a truncated result.
func (o *Observability) RecordTruncation() {
	o.requestsTruncated.Add(1)
}

// RecordError records an error by code.
func (o *Observability) RecordError(code string) {
	v, _ := o.errorCounts.LoadOrStore(code, &atomic.Int64{})
	v.(*atomic.Int64).Add(1)
}

// IncInFlight increments the in-flight request counter.
func (o *Observability) IncInFlight() {
	o.inFlight.Add(1)
}

// DecInFlight decrements the in-flight request counter.
func (o *Observability) DecInFlight() {
	o.inFlight.Add(-1)
}

// Snapshot returns a point-in-time snapshot of metrics for diagnostics.
func (o *Observability) Snapshot() Snapshot {
	errors := make(map[string]uint64)
	o.errorCounts.Range(func(key, value any) bool {
		errors[key.(string)] = uint64(value.(*atomic.Int64).Load())
		return true
	})

	var avgLatencyMs float64
	cnt := o.upstreamLatencyCnt.Load()
	if cnt > 0 {
		avgLatencyMs = float64(o.upstreamLatencySum.Load()) / float64(cnt) / float64(time.Millisecond)
	}

	return Snapshot{
		UpstreamRequests:   uint64(o.upstreamRequests.Load()),
		UpstreamErrors:     uint64(o.upstreamErrors.Load()),
		CacheHits:          uint64(o.cacheHits.Load()),
		CacheMisses:        uint64(o.cacheMisses.Load()),
		CacheEvictions:     uint64(o.cacheEvictions.Load()),
		SingleflightMerged: uint64(o.singleflightMerged.Load()),
		RequestsCancelled:  uint64(o.requestsCancelled.Load()),
		RequestsTimedOut:   uint64(o.requestsTimedOut.Load()),
		RequestsTruncated:  uint64(o.requestsTruncated.Load()),
		AvgUpstreamLatencyMs: avgLatencyMs,
		InFlight:           o.inFlight.Load(),
		ErrorCounts:        errors,
	}
}

// Snapshot is a point-in-time metrics snapshot.
type Snapshot struct {
	UpstreamRequests     uint64
	UpstreamErrors       uint64
	CacheHits            uint64
	CacheMisses          uint64
	CacheEvictions       uint64
	SingleflightMerged   uint64
	RequestsCancelled    uint64
	RequestsTimedOut     uint64
	RequestsTruncated    uint64
	AvgUpstreamLatencyMs float64
	InFlight             int64
	ErrorCounts          map[string]uint64
}
