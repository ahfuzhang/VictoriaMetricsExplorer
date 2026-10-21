package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/limits"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/observability"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/resource"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/vmclient"
)

const (
	// defaultRevalidateEvery bounds how stale a target's view of its Grafana datasource can get. A
	// config change (URL, tenant path, auth...) shows up as a new fingerprint, which rebuilds the
	// target with an empty cache so entries from the old configuration are never served.
	defaultRevalidateEvery = 30 * time.Second

	// maxTargets caps live per-datasource caches/clients; the least recently used one is evicted.
	maxTargets = 32

	// perTargetCacheBytes is the L1 cache budget of one datasource.
	perTargetCacheBytes = 64 * 1024 * 1024
)

// target is everything the Explorer keeps for one (organization, datasource) pair.
type target struct {
	key         string
	fingerprint string
	handler     http.Handler
	client      *vmclient.Client
	cache       *cache.L1Cache
	obs         *observability.Observability

	checkedAt atomic.Int64 // unix nanos of the last successful Grafana lookup
	usedAt    atomic.Int64 // unix nanos of the last request
}

func (t *target) close() {
	t.client.Close()
	t.cache.Close()
	t.obs.Close()
}

// registry lazily builds one target per datasource the first time it is used.
type registry struct {
	settings *Settings
	api      *grafanaAPI
	creds    vmclient.CredentialsFunc
	lim      *limits.Limits

	revalidateEvery time.Duration

	mu      sync.Mutex
	targets map[string]*target
}

func newRegistry(settings *Settings, creds vmclient.CredentialsFunc) *registry {
	return &registry{
		settings: settings,
		api:      newGrafanaAPI(creds),
		creds:    creds,
		lim:      limits.Default(),

		revalidateEvery: defaultRevalidateEvery,
		targets:         map[string]*target{},
	}
}

func targetKey(orgID int64, uid string) string {
	return fmt.Sprintf("%d/%s", orgID, uid)
}

// get returns the target for a datasource, after checking that the datasource exists, is a
// VictoriaMetrics-type datasource, and passes the app's allowlist.
func (r *registry) get(ctx context.Context, orgID int64, uid string) (*target, error) {
	if !r.settings.allows(uid) {
		return nil, errDatasourceDenied
	}

	key := targetKey(orgID, uid)
	r.mu.Lock()
	t := r.targets[key]
	r.mu.Unlock()
	if t != nil && time.Since(time.Unix(0, t.checkedAt.Load())) < r.revalidateEvery {
		t.usedAt.Store(time.Now().UnixNano())
		return t, nil
	}

	// Look up outside the lock so a slow Grafana does not stall unrelated datasources.
	info, err := r.api.getDatasource(ctx, uid)
	if err != nil {
		if err == errDatasourceNotFound {
			r.drop(key)
		}
		return nil, err
	}
	if info.Type != vmDatasourceType {
		return nil, fmt.Errorf("%w: type %q is not %q", errDatasourceDenied, info.Type, vmDatasourceType)
	}

	fp := r.fingerprint(orgID, info)

	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UnixNano()
	if cur := r.targets[key]; cur != nil && cur.fingerprint == fp {
		cur.checkedAt.Store(now)
		cur.usedAt.Store(now)
		return cur, nil
	}

	nt, err := r.build(orgID, info, fp)
	if err != nil {
		return nil, err
	}
	nt.checkedAt.Store(now)
	nt.usedAt.Store(now)
	if old := r.targets[key]; old != nil {
		log.DefaultLogger.Info("datasource config changed; rebuilding explorer target", "uid", uid)
		go old.close()
	}
	r.targets[key] = nt
	r.evictLocked()
	return nt, nil
}

func (r *registry) drop(key string) {
	r.mu.Lock()
	t := r.targets[key]
	delete(r.targets, key)
	r.mu.Unlock()
	if t != nil {
		go t.close()
	}
}

// evictLocked removes the least recently used targets above maxTargets. Callers hold r.mu.
func (r *registry) evictLocked() {
	for len(r.targets) > maxTargets {
		var oldestKey string
		var oldest int64
		for k, t := range r.targets {
			if u := t.usedAt.Load(); oldestKey == "" || u < oldest {
				oldestKey, oldest = k, u
			}
		}
		go r.targets[oldestKey].close()
		delete(r.targets, oldestKey)
	}
}

// fingerprint hashes everything that changes what upstream answers mean, so cache keys never
// outlive a datasource reconfiguration: org, uid, type, URL (which carries a cluster tenant
// path), the saved-config version, jsonData, and this app's label mappings.
func (r *registry) fingerprint(orgID int64, info *datasourceInfo) string {
	h := sha256.New()
	fmt.Fprintf(h, "org=%d|uid=%s|type=%s|url=%s|ver=%d|%s|", orgID, info.UID, info.Type, info.URL, info.Version, r.settings.labelFingerprint())
	h.Write(info.JSONData)
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func (r *registry) build(orgID int64, info *datasourceInfo, fp string) (*target, error) {
	obs := observability.New(info.UID)
	client, err := vmclient.New(vmclient.Config{
		UID:               info.UID,
		OrgID:             orgID,
		ConfigFingerprint: fp,
		Credentials:       r.creds,
		PodLabel:          r.settings.PodLabel,
		NamespaceLabel:    r.settings.NamespaceLabel,
		NodeLabel:         r.settings.NodeLabel,
		ClusterLabel:      r.settings.ClusterLabel,
		DefaultTimeRange:  r.settings.DefaultTimeRange,
		CacheTTL:          r.settings.CacheTTL,
	}, r.lim, obs)
	if err != nil {
		obs.Close()
		return nil, err
	}
	l1 := cache.NewL1(cache.L1Config{
		MaxEntries: 10000,
		MaxBytes:   perTargetCacheBytes,
		DefaultTTL: r.settings.CacheTTL,
	})
	router := resource.NewRouter(client, l1, r.lim, obs, client.Config())
	return &target{
		key:         targetKey(orgID, info.UID),
		fingerprint: fp,
		handler:     router.HTTPHandler(),
		client:      client,
		cache:       l1,
		obs:         obs,
	}, nil
}

// closeAll releases every target (app instance disposal).
func (r *registry) closeAll() {
	r.mu.Lock()
	targets := r.targets
	r.targets = map[string]*target{}
	r.mu.Unlock()
	for _, t := range targets {
		t.close()
	}
}
