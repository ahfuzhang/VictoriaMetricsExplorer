package app

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

const (
	// After a successful probe, a user's requests pass until the user has been idle this long.
	datasourceIdleTimeout = 30 * time.Minute
	// A probe that was refused, or could not reach the datasource, is answered from memory this
	// long before the datasource is probed again.
	datasourceFailureTTL = 5 * time.Minute
)

// A target ID identifies one app instance's datasource in one organization. Rebuilding a
// target after a configuration change gives it a new ID.
type datasourceVisitKey struct {
	targetID uint64
	username string
}

// datasourceVisit is one user's access to one datasource.
type datasourceVisit struct {
	// probing holds one token: a request puts it in before probing and takes it out afterwards,
	// so the user's other requests wait here instead of probing too.
	probing chan struct{}
	// Only the request holding the token writes these, except that a passing request moves
	// lastAccess forward.
	lastAccess atomic.Int64                      // UnixNano of the last allowed request; 0 if none
	failure    atomic.Pointer[datasourceFailure] // the last remembered failure
}

// datasourceFailure is a probe failure that is answered from memory until it expires.
type datasourceFailure struct {
	until int64 // UnixNano
	err   error
}

var datasourceVisits sync.Map // datasourceVisitKey -> *datasourceVisit
var lastDatasourceVisitCleanup atomic.Int64

// checkDatasourceAccess probes the datasource with a vector(1) query on a user's first request
// and after the user has been idle, through the same Grafana proxy and service account as other
// queries. Concurrent requests of the user wait for that probe.
func (t *target) checkDatasourceAccess(ctx context.Context, username string) error {
	if username == "" {
		// Anonymous requests cannot share an access record under an empty username.
		_, err := t.client.Query(ctx, "vector(1)", time.Time{})
		return err
	}

	now := time.Now().UnixNano()
	cleanDatasourceVisits(now)
	key := datasourceVisitKey{targetID: t.id, username: username}
	value, ok := datasourceVisits.Load(key)
	if !ok {
		value, _ = datasourceVisits.LoadOrStore(key, &datasourceVisit{probing: make(chan struct{}, 1)})
	}
	visit := value.(*datasourceVisit)
	if err, known := visit.result(now); known {
		return err
	}

	select {
	case visit.probing <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-visit.probing }()
	// The request this one waited for may have settled it.
	if err, known := visit.result(time.Now().UnixNano()); known {
		return err
	}

	_, err := t.client.Query(ctx, "vector(1)", time.Time{})
	switch {
	case err == nil:
		visit.failure.Store(nil)
		visit.lastAccess.Store(time.Now().UnixNano())
	case isDatasourceDenied(err) || isDatasourceUnreachable(ctx, err):
		visit.lastAccess.Store(0)
		visit.failure.Store(&datasourceFailure{until: time.Now().Add(datasourceFailureTTL).UnixNano(), err: err})
	}
	// Other failures (this request cancelled, a malformed answer) are not remembered: the next
	// request, or the next one waiting on the token, probes again.
	return err
}

// result answers from the last probe: allowed while the user keeps visiting within the idle
// timeout (an allowed request counts as a visit), failed while a remembered failure lasts.
// known is false when the request has to probe.
func (v *datasourceVisit) result(now int64) (err error, known bool) {
	if f := v.failure.Load(); f != nil && now < f.until {
		return f.err, true
	}
	if last := v.lastAccess.Load(); last != 0 && now-last < int64(datasourceIdleTimeout) {
		// If another request changed it meanwhile, its value stands.
		v.lastAccess.CompareAndSwap(last, now)
		return nil, true
	}
	return nil, false
}

// expired reports whether the record no longer decides anything and no probe is running.
func (v *datasourceVisit) expired(now int64) bool {
	f := v.failure.Load()
	return len(v.probing) == 0 && now-v.lastAccess.Load() >= int64(datasourceIdleTimeout) && (f == nil || now >= f.until)
}

// isDatasourceDenied reports whether the datasource refused the request (HTTP 401 or 403).
func isDatasourceDenied(err error) bool {
	var upstream *vmclient.UpstreamError
	return errors.As(err, &upstream) &&
		(upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden)
}

// isDatasourceUnreachable reports whether a request failed because the datasource could not be
// reached: Grafana's proxy got no answer from the datasource's URL (HTTP 502, 503 or 504), or the
// request failed in transport (refused, reset, timed out). The end of the request's own context
// says nothing about the datasource.
func isDatasourceUnreachable(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	var upstream *vmclient.UpstreamError
	if errors.As(err, &upstream) {
		switch upstream.StatusCode {
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return true
		}
		return false
	}
	var transport net.Error
	return errors.As(err, &transport)
}

// cleanDatasourceVisits drops, at most once per idle timeout, the records that no longer decide
// anything.
func cleanDatasourceVisits(now int64) {
	previous := lastDatasourceVisitCleanup.Load()
	if now-previous < int64(datasourceIdleTimeout) || !lastDatasourceVisitCleanup.CompareAndSwap(previous, now) {
		return
	}
	datasourceVisits.Range(func(key, value any) bool {
		if value.(*datasourceVisit).expired(now) {
			datasourceVisits.CompareAndDelete(key, value)
		}
		return true
	})
}
