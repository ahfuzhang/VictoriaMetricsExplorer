package resource

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

const nodeGroupsCacheTTL = 2 * time.Minute

// nodeMatcher returns the label matcher selecting the series of one node, e.g. node="ip-10-0-1-2",
// or "" without a node.
func (h *Handlers) nodeMatcher(node string) string {
	if node == "" {
		return ""
	}
	return h.nodeLabel() + "=" + strconv.Quote(node)
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

	cacheKey := cache.CacheKey("node-groups-v2", h.router.config.UID, h.router.config.ConfigFingerprint,
		label, dayStart.Format(time.RFC3339), dayEnd.Format(time.RFC3339))
	if cached, ok := h.router.cache.Get(cacheKey); ok {
		var result explorerpb.NodeGroupsCacheEntry
		if err := wire.Decode(cached, &result); err == nil {
			h.router.obs.RecordCacheHit()
			return &result, nil
		}
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
	if data, err := wire.Encode(result); err == nil {
		h.router.cache.Set(cacheKey, data, nodeGroupsCacheTTL)
	}
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
