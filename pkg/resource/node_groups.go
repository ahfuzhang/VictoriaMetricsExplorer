package resource

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

const nodeGroupsCacheTTL = 2 * time.Minute

// nodeMatcher returns the label matcher selecting the series of one node, e.g. node="ip-10-0-1-2",
// or "" without a node.
func (h *Handlers) nodeMatcher(node string) string {
	if node == "" {
		return ""
	}
	label := h.nodeLabel()
	b := make([]byte, 0, len(label)+len("=")+quotedLen(node))
	b = append(append(b, label...), '=')
	return bytesutil.ToUnsafeString(appendQuoted(b, node))
}

func (h *Handlers) nodeLabel() string {
	if label := h.router.config.NodeLabel; promLabelNamePattern.MatchString(label) {
		return label
	}
	return "node"
}

// loadNodeGroups fetches the node label's values for the day-aligned range.
func (h *Handlers) loadNodeGroups(ctx context.Context, startTime, endTime time.Time) (*explorerpb.NodeGroupsCacheEntry, error) {
	dayStart := startTime.Truncate(24 * time.Hour)
	dayEnd := endTime.Truncate(24 * time.Hour).Add(24 * time.Hour)
	label := h.nodeLabel()

	cfg := &h.router.config
	key := make([]byte, 0, cache.KeySize("node-groups-v2", cfg.UID, cfg.ConfigFingerprint, label)+2*cache.MaxIntKeySize)
	key = cache.AppendKey(key, "node-groups-v2", cfg.UID, cfg.ConfigFingerprint, label)
	key = cache.AppendKeyInt(key, dayStart.Unix())
	cacheKey := cache.HashKey(cache.AppendKeyInt(key, dayEnd.Unix()))
	var cached explorerpb.NodeGroupsCacheEntry
	if h.router.cache.Get(cacheKey, nodeGroupsCacheTTL, &cached) {
		h.router.obs.RecordCacheHit()
		return &cached, nil
	}
	h.router.obs.RecordCacheMiss()

	values, isPartial, err := h.router.client.LabelValues(ctx, label, nil, dayStart, dayEnd, h.router.limits.MaxMetricNamesHard)
	if err != nil {
		return nil, err
	}
	nodes := make([]string, 0, len(values))
	for _, node := range values {
		if node != "" {
			nodes = append(nodes, node)
		}
	}
	sort.Strings(nodes)
	result := &explorerpb.NodeGroupsCacheEntry{Label: label, Nodes: nodes, Partial: isPartial}
	h.router.cache.Set(cacheKey, result)
	return result, nil
}

func (h *Handlers) handleNodeGroups(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.NodeGroupsRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}
	startTime, endTime := h.timeRange(req.Range)

	result, err := h.loadNodeGroups(r.Context(), startTime, endTime)
	if err != nil {
		log.DefaultLogger.Error("node-groups: failed to fetch nodes", "error", err, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch node names: "+err.Error(), requestID)
		return
	}

	writeMessage(w, &explorerpb.NodeGroupsResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId: requestID,
			Partial:   result.Partial,
			ElapsedMs: uint64(time.Since(started).Milliseconds()),
		},
		Label: result.Label,
		Nodes: result.Nodes,
	}, requestID)
}
