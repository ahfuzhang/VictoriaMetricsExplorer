package observability

import (
	"testing"
	"time"
)

func TestObservability_Counters(t *testing.T) {
	obs := New("test-ds")
	defer obs.Close()

	obs.RecordUpstreamRequest(10*time.Millisecond, "success")
	obs.RecordUpstreamRequest(20*time.Millisecond, "success")
	obs.RecordUpstreamRequest(5*time.Millisecond, "error")

	obs.RecordCacheHit()
	obs.RecordCacheHit()
	obs.RecordCacheMiss()

	obs.RecordError("timeout")
	obs.RecordError("timeout")

	snap := obs.Snapshot()

	if snap.UpstreamRequests != 3 {
		t.Fatalf("expected 3 upstream requests, got %d", snap.UpstreamRequests)
	}
	if snap.UpstreamErrors != 1 {
		t.Fatalf("expected 1 upstream error, got %d", snap.UpstreamErrors)
	}
	if snap.CacheHits != 2 {
		t.Fatalf("expected 2 cache hits, got %d", snap.CacheHits)
	}
	if snap.CacheMisses != 1 {
		t.Fatalf("expected 1 cache miss, got %d", snap.CacheMisses)
	}
	if snap.ErrorCounts["timeout"] != 2 {
		t.Fatalf("expected 2 timeout errors, got %d", snap.ErrorCounts["timeout"])
	}
}

func TestObservability_Latency(t *testing.T) {
	obs := New("test-ds")
	defer obs.Close()

	obs.RecordUpstreamRequest(100*time.Millisecond, "success")
	obs.RecordUpstreamRequest(200*time.Millisecond, "success")
	obs.RecordUpstreamRequest(300*time.Millisecond, "success")

	snap := obs.Snapshot()

	if snap.AvgUpstreamLatencyMs < 199 || snap.AvgUpstreamLatencyMs > 201 {
		t.Fatalf("expected avg latency ~200ms, got %.2f", snap.AvgUpstreamLatencyMs)
	}
}
