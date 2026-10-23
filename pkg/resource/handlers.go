package resource

import (
	"context"
	"encoding/json/jsontext"
	json "encoding/json/v2"
	"math"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend/log"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/bytesutil"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/cache"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
	"github.com/ahfuzhang/victoriametricsexplorer/pkg/wire"
)

const (
	capabilitiesCacheTTL = 5 * time.Minute
	// metricIndexCacheTTL is short because metric names can change.
	metricIndexCacheTTL = 2 * time.Minute
)

// Handlers contains all the Resource API endpoint handlers.
type Handlers struct {
	router *Router
	// typeSem bounds the range queries metric-types has in flight against the datasource.
	typeSem chan struct{}
}

// NewHandlers creates a new Handlers instance.
func NewHandlers(r *Router) *Handlers {
	return &Handlers{router: r, typeSem: make(chan struct{}, metricTypeConcurrency)}
}

// ============================================================================
// Capabilities
// ============================================================================

func (h *Handlers) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "only GET is supported", requestID)
		return
	}

	// Check cache first
	cacheKey := cache.CacheKey("capabilities", h.router.config.UID, h.router.config.ConfigFingerprint)
	if cached, ok := h.router.cache.GetZstd(cacheKey, capabilitiesCacheTTL); ok {
		h.router.obs.RecordCacheHit()
		wire.Write(w, http.StatusOK, cached)
		return
	}
	h.router.obs.RecordCacheMiss()

	// Build capabilities response. Failing here (rather than returning an empty-looking success)
	// is what tells the user the datasource itself is unusable; failures are never cached.
	resp, err := h.buildCapabilitiesResponse(r.Context(), requestID)
	if err != nil {
		log.DefaultLogger.Warn("capabilities: datasource is not usable",
			"uid", h.router.config.UID, "requestId", requestID, "error", err)
		writeError(w, http.StatusBadGateway, "upstream_error", "cannot read labels from the datasource: "+err.Error(), requestID)
		return
	}

	data, err := wire.Encode(resp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal_error", "failed to encode response: "+err.Error(), requestID)
		return
	}

	h.router.cache.Set(cacheKey, resp)

	elapsed := time.Since(started)
	log.DefaultLogger.Info("capabilities",
		"uid", h.router.config.UID,
		"requestId", requestID,
		"elapsedMs", elapsed.Milliseconds(),
	)

	wire.Write(w, http.StatusOK, data)
}

func (h *Handlers) buildCapabilitiesResponse(ctx context.Context, requestID string) (*explorerpb.CapabilitiesResponse, error) {
	// Detect label mappings. This is also the connectivity check: every Explorer feature needs the
	// labels API, so if it fails the datasource is unusable. (A missing buildinfo is not fatal.)
	labelMappings, err := h.detectLabelMappings(ctx)
	if err != nil {
		return nil, err
	}

	// Try to get upstream version
	version := h.router.client.GetUpstreamVersionPublic(ctx)

	lim := h.router.limits
	return &explorerpb.CapabilitiesResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId:      requestID,
			RangePrecision: explorerpb.RangePrecision_RANGE_PRECISION_EXACT,
		},
		UpstreamVersion:       version,
		UpstreamProduct:       "VictoriaMetrics",
		SupportsMetricsql:     true,
		LabelMappings:         labelMappings,
		MaxMetricNames:        uint32(lim.MaxMetricNames),
		MaxSeriesScan:         uint32(lim.MaxSeriesScan),
		MaxFacetValues:        uint32(lim.MaxFacetValues),
		MaxChartSeries:        uint32(lim.MaxChartSeries),
		MaxConcurrentRequests: uint32(lim.MaxConcurrentRequests),
		KnowledgeBaseVersion:  "0.1.0",
	}, nil
}

func (h *Handlers) detectLabelMappings(ctx context.Context) ([]*explorerpb.LabelMapping, error) {
	settings := h.router.config

	// Try to detect if these labels exist in the data source
	detected, _, err := h.router.client.Labels(ctx, time.Time{}, time.Time{}, 1000)
	if err != nil {
		return nil, err
	}

	labelSet := make(map[string]bool)
	for _, l := range detected {
		labelSet[l] = true
	}

	mappings := []*explorerpb.LabelMapping{}
	for _, role := range []string{"pod", "namespace", "node", "cluster"} {
		var labelName string
		var candidates []string
		switch role {
		case "pod":
			labelName = settings.PodLabel
			candidates = []string{"pod", "pod_name", "kubernetes_pod_name"}
		case "namespace":
			labelName = settings.NamespaceLabel
			candidates = []string{"namespace", "kubernetes_namespace"}
		case "node":
			labelName = settings.NodeLabel
			candidates = []string{"node", "instance", "kubernetes_node"}
		case "cluster":
			labelName = settings.ClusterLabel
			candidates = []string{"cluster", "cluster_name"}
		}

		isDetected := labelSet[labelName]
		if !isDetected {
			for _, c := range candidates {
				if labelSet[c] {
					labelName = c
					isDetected = true
					break
				}
			}
		}

		var confidence float32
		if isDetected {
			confidence = 1.0
		}

		mappings = append(mappings, &explorerpb.LabelMapping{
			Role:       role,
			LabelName:  labelName,
			Confidence: confidence,
			Detected:   isDetected,
		})
	}
	return mappings, nil
}

// ============================================================================
// Metric Index
// ============================================================================

// metricIndexEntry is one row in the metric picker. Name is exactly what the UI displays;
// QueryMetric is the real metric used by facets and charts. A classic Prometheus histogram is
// represented by its bucket metric (its _count without buckets) for queries, but Name omits the
// suffix. Aliases keep searches and favorite lookups for any of the original three member names
// working.
type metricIndexEntry struct {
	Name        string
	QueryMetric string
	MetricType  string
	Aliases     []string
}

func buildMetricIndexEntries(names []string) []metricIndexEntry {
	known := make(map[string]struct{}, len(names))
	for _, name := range names {
		known[name] = struct{}{}
	}

	entries := make([]metricIndexEntry, 0, len(names))
	seenHistograms := make(map[string]struct{})
	for _, name := range names {
		base, hasHistogramSuffix := histogramMetricBase(name)
		if hasHistogramSuffix && isHistogramMember(name, known) {
			if _, seen := seenHistograms[base]; seen {
				continue
			}
			seenHistograms[base] = struct{}{}
			bucket, count, sum := histogramMemberNames(base)
			// A histogram without buckets is queried through its _count.
			queryMetric := bucket
			if _, hasBucket := known[bucket]; !hasBucket {
				queryMetric = count
			}
			entries = append(entries, metricIndexEntry{
				Name:        base,
				QueryMetric: queryMetric,
				MetricType:  metricTypeHistogram,
				Aliases:     []string{base, bucket, count, sum},
			})
			continue
		}

		entries = append(entries, metricIndexEntry{
			Name:        name,
			QueryMetric: name,
			Aliases:     []string{name},
		})
	}
	return entries
}

func filterMetricIndexEntries(entries []metricIndexEntry, metricNames []string) []metricIndexEntry {
	wanted := make(map[string]struct{}, len(metricNames))
	for _, name := range metricNames {
		wanted[name] = struct{}{}
	}
	filtered := entries[:0]
	for _, entry := range entries {
		for _, alias := range entry.Aliases {
			if _, ok := wanted[alias]; ok {
				filtered = append(filtered, entry)
				break
			}
		}
	}
	return filtered
}

func metricIndexEntryMatches(entry metricIndexEntry, searchLower string) bool {
	for _, alias := range entry.Aliases {
		if strings.Contains(strings.ToLower(alias), searchLower) {
			return true
		}
	}
	return false
}

func (h *Handlers) handleMetricIndex(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.MetricIndexRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	// Defaults
	prefixMode := req.GroupMode == explorerpb.GroupMode_GROUP_MODE_PREFIX
	if req.Page == 0 {
		req.Page = 1
	}
	if req.PageSize == 0 {
		req.PageSize = 200
	}
	if req.PageSize > 1000 {
		req.PageSize = 1000
	}
	if req.Sort == "" {
		req.Sort = "name"
	}

	startTime, endTime := h.timeRange(req.Range)

	// Check cache
	cacheKey := h.metricIndexCacheKey(&req, prefixMode, startTime, endTime)
	if cached, ok := h.router.cache.GetZstd(cacheKey, metricIndexCacheTTL); ok {
		h.router.obs.RecordCacheHit()
		wire.Write(w, http.StatusOK, cached)
		return
	}
	h.router.obs.RecordCacheMiss()

	// Fetch metric names from upstream
	// Use day-granularity time range for label values API
	dayStart := startTime.Truncate(24 * time.Hour)
	dayEnd := endTime.Truncate(24 * time.Hour).Add(24 * time.Hour)

	var matches []string
	if selector := labelSelector(h.podGroupMatcher(req.PodGroup), h.nodeMatcher(req.Node)); selector != "" {
		matches = []string{selector}
	}

	names, isPartial, err := h.router.client.LabelValues(r.Context(), "__name__", matches, dayStart, dayEnd, h.router.limits.MaxMetricNamesHard)
	if err != nil {
		log.DefaultLogger.Error("metric-index: failed to fetch names", "error", err, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch metric names: "+err.Error(), requestID)
		return
	}
	entries := buildMetricIndexEntries(names)
	if len(req.Metrics) > 0 {
		entries = filterMetricIndexEntries(entries, req.Metrics)
	}

	// Apply search filter
	if req.Search != "" {
		searchLower := strings.ToLower(req.Search)
		filtered := entries[:0]
		for _, entry := range entries {
			if metricIndexEntryMatches(entry, searchLower) {
				filtered = append(filtered, entry)
			}
		}
		entries = filtered
	}

	// Sort
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Name == entries[j].Name {
			return entries[i].QueryMetric < entries[j].QueryMetric
		}
		return entries[i].Name < entries[j].Name
	})
	if req.Sort == "name_desc" {
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
	}

	// Build groups if prefix mode
	var groups []*explorerpb.MetricGroup
	if prefixMode {
		groupMap := make(map[string]uint32)
		for _, entry := range entries {
			group := getPrefixGroup(entry.Name)
			groupMap[group]++
		}
		groups = make([]*explorerpb.MetricGroup, 0, len(groupMap))
		for name, count := range groupMap {
			groups = append(groups, &explorerpb.MetricGroup{Name: name, Count: count})
		}
		sort.Slice(groups, func(i, j int) bool {
			return groups[i].Name < groups[j].Name
		})
	}

	// Filter by group if specified
	if req.Group != "" && prefixMode {
		filtered := entries[:0]
		for _, entry := range entries {
			if getPrefixGroup(entry.Name) == req.Group {
				filtered = append(filtered, entry)
			}
		}
		entries = filtered
	}

	totalCount := len(entries)
	truncated := false
	if totalCount > h.router.limits.MaxMetricNames {
		truncated = true
	}

	// Paginate
	page, pageSize := int(req.Page), int(req.PageSize)
	totalPages := (totalCount + pageSize - 1) / pageSize
	if totalPages == 0 {
		totalPages = 1
	}
	startIdx := (page - 1) * pageSize
	endIdx := startIdx + pageSize
	if startIdx >= totalCount {
		entries = []metricIndexEntry{}
	} else {
		if endIdx > totalCount {
			endIdx = totalCount
		}
		entries = entries[startIdx:endIdx]
	}

	// Build response
	metrics := make([]*explorerpb.MetricInfo, 0, len(entries))
	for _, entry := range entries {
		m := &explorerpb.MetricInfo{
			Name:        entry.Name,
			QueryMetric: entry.QueryMetric,
			Type:        entry.MetricType,
		}
		if prefixMode {
			m.Group = getPrefixGroup(entry.Name)
		}
		metrics = append(metrics, m)
	}

	resp := &explorerpb.MetricIndexResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId:      requestID,
			RangePrecision: explorerpb.RangePrecision_RANGE_PRECISION_DAY,
			Truncated:      truncated,
			Partial:        isPartial,
			ElapsedMs:      uint64(time.Since(started).Milliseconds()),
			TotalCount:     uint32(totalCount),
			ReturnedCount:  uint32(len(metrics)),
			RequestedRange: &explorerpb.TimeRange{StartMs: req.Range.GetStartMs(), EndMs: req.Range.GetEndMs()},
			EffectiveRange: &explorerpb.TimeRange{StartMs: dayStart.UnixMilli(), EndMs: dayEnd.UnixMilli()},
		},
		Metrics:    metrics,
		Groups:     groups,
		TotalCount: uint32(totalCount),
		Page:       req.Page,
		PageSize:   req.PageSize,
		TotalPages: uint32(totalPages),
	}

	if truncated {
		resp.Meta.Warnings = []string{
			"Result truncated to soft limit. Narrow your search to see all metrics.",
		}
		h.router.obs.RecordTruncation()
	}

	data, err := wire.Encode(resp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal_error", "failed to encode response: "+err.Error(), requestID)
		return
	}

	h.router.cache.Set(cacheKey, resp)

	log.DefaultLogger.Info("metric-index",
		"uid", h.router.config.UID,
		"requestId", requestID,
		"total", totalCount,
		"returned", len(metrics),
		"page", req.Page,
		"elapsedMs", time.Since(started).Milliseconds(),
		"truncated", truncated,
		"partial", isPartial,
	)

	wire.Write(w, http.StatusOK, data)
}

// metricIndexCacheKey is the cache key of a metric-index request. It sorts req.Metrics, whose
// order does not matter.
func (h *Handlers) metricIndexCacheKey(req *explorerpb.MetricIndexRequest, prefixMode bool, start, end time.Time) string {
	cfg := &h.router.config
	sort.Strings(req.Metrics)
	b := make([]byte, 0, cache.KeySize("metric-index-v4", cfg.UID, cfg.ConfigFingerprint, req.Search, req.Group,
		req.PodGroup, req.Node, req.Sort)+cache.MaxBoolKeySize+2*cache.MaxUintKeySize+2*cache.MaxIntKeySize+
		cache.KeySize(req.Metrics...))
	b = cache.AppendKey(b, "metric-index-v4", cfg.UID, cfg.ConfigFingerprint, req.Search, req.Group, req.PodGroup,
		req.Node, req.Sort)
	b = cache.AppendKeyBool(b, prefixMode)
	b = cache.AppendKeyUint(b, uint64(req.Page))
	b = cache.AppendKeyUint(b, uint64(req.PageSize))
	b = cache.AppendKeyInt(b, start.Unix())
	b = cache.AppendKeyInt(b, end.Unix())
	// The list of metrics goes last, so it needs no count to keep it apart from the fields after it.
	b = cache.AppendKey(b, req.Metrics...)
	return cache.HashKey(b)
}

// getPrefixGroup extracts the prefix group from a metric name.
// The prefix is the part before the first underscore.
func getPrefixGroup(name string) string {
	idx := strings.IndexByte(name, '_')
	if idx == -1 {
		return "other"
	}
	return name[:idx]
}

// ============================================================================
// Entities (stub for now — implemented in M4)
// ============================================================================

func (h *Handlers) handleEntities(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	writeError(w, http.StatusNotImplemented, "not_implemented", "entities endpoint will be available in M4", requestID)
}

// ============================================================================
// Facets
// ============================================================================

type facetValueResult struct {
	Value          string
	Count          int
	AvailableCount int
}

type facetResult struct {
	Label           string
	Values          []facetValueResult
	TotalValues     int
	Truncated       bool
	IsConstant      bool
	ConstantValue   string
	SeriesWithLabel int
	SeriesTotal     int

	maxAvailable int
}

func (f facetResult) toProto() *explorerpb.Facet {
	values := make([]*explorerpb.FacetValue, 0, len(f.Values))
	for _, v := range f.Values {
		values = append(values, &explorerpb.FacetValue{
			Value:          v.Value,
			Count:          uint32(v.Count),
			AvailableCount: uint32(v.AvailableCount),
		})
	}
	return &explorerpb.Facet{
		Label:           f.Label,
		Values:          values,
		TotalValues:     uint32(f.TotalValues),
		Truncated:       f.Truncated,
		IsConstant:      f.IsConstant,
		ConstantValue:   f.ConstantValue,
		SeriesWithLabel: uint32(f.SeriesWithLabel),
		SeriesTotal:     uint32(f.SeriesTotal),
	}
}

// labelFilters turns the request's label filters into label -> accepted values. Filters naming
// the same label are merged. The values are sorted (in place: they are the request's own), so
// equal filters give equal cache keys.
func labelFilters(filters []*explorerpb.LabelFilter) map[string][]string {
	if len(filters) == 0 {
		return nil
	}
	out := make(map[string][]string, len(filters))
	for _, f := range filters {
		if values, ok := out[f.GetName()]; ok {
			// The full slice expression makes append copy, so the request's values stay untouched.
			out[f.GetName()] = append(values[:len(values):len(values)], f.GetValues()...)
		} else {
			out[f.GetName()] = f.GetValues()
		}
	}
	for _, values := range out {
		sort.Strings(values)
	}
	return out
}

func (h *Handlers) handleFacets(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.FacetsRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	if req.Metric == "" {
		writeError(w, http.StatusBadRequest, "missing_param", "metric is required", requestID)
		return
	}

	maxValues := int(req.MaxValuesPerFacet)
	if maxValues <= 0 {
		maxValues = h.router.limits.MaxFacetValues
	}
	if maxValues > h.router.limits.MaxFacetValuesHard {
		maxValues = h.router.limits.MaxFacetValuesHard
	}

	startTime, endTime := h.timeRange(req.Range)
	filters := labelFilters(req.Filters)

	// Check cache
	cacheKey := h.facetsCacheKey(&req, filters, maxValues, startTime, endTime)
	if cached, ok := h.router.cache.GetZstd(cacheKey, h.router.config.CacheTTL); ok {
		h.router.obs.RecordCacheHit()
		wire.Write(w, http.StatusOK, cached)
		return
	}
	h.router.obs.RecordCacheMiss()

	podMatcher, nodeMatcher := h.podGroupMatcher(req.PodGroup), h.nodeMatcher(req.Node)
	fetchSeries := func(metric string) ([]map[string]string, bool, error) {
		selector := buildMetricSelector(metric, nil, podMatcher, nodeMatcher)
		return h.router.client.Series(r.Context(), []string{selector}, startTime, endTime, h.router.limits.MaxSeriesScan)
	}

	// A histogram's labels are read from its _sum series: the _bucket series carry the same labels
	// plus the bucket boundaries (le, vmrange), which are not useful filters. Without _sum series,
	// the bucket series are used with the bucket labels removed.
	var series []map[string]string
	var isPartial bool
	var err error
	if base, ok := strings.CutSuffix(req.Metric, "_bucket"); ok && base != "" {
		series, isPartial, err = fetchSeries(base + "_sum")
		if err == nil && len(series) == 0 {
			series, isPartial, err = fetchSeries(req.Metric)
		}
		if err == nil {
			series = withoutBucketLabels(series)
		}
	} else {
		series, isPartial, err = fetchSeries(req.Metric)
	}
	if err != nil {
		log.DefaultLogger.Error("facets: failed to fetch series", "error", err, "metric", req.Metric, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch metric series: "+err.Error(), requestID)
		return
	}

	facets, seriesReturned, valuesTruncated := calculateFacets(
		series, filters, req.FacetLabels, req.Search, maxValues,
	)
	seriesTruncated := len(series) >= h.router.limits.MaxSeriesScan
	truncated := seriesTruncated || valuesTruncated

	pbFacets := make([]*explorerpb.Facet, 0, len(facets))
	for _, f := range facets {
		pbFacets = append(pbFacets, f.toProto())
	}
	resp := &explorerpb.FacetsResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId: requestID,
			Truncated: truncated,
			Partial:   isPartial,
			ElapsedMs: uint64(time.Since(started).Milliseconds()),
		},
		Facets:         pbFacets,
		PodMatcher:     podMatcher,
		SeriesTotal:    uint32(len(series)),
		SeriesReturned: uint32(seriesReturned),
		CountsExact:    !isPartial && !seriesTruncated,
	}

	data, err := wire.Encode(resp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "marshal_error", "failed to encode response: "+err.Error(), requestID)
		return
	}

	h.router.cache.Set(cacheKey, resp)
	if truncated {
		h.router.obs.RecordTruncation()
	}
	wire.Write(w, http.StatusOK, data)
}

// facetsCacheKey is the cache key of a facets request. filters come from labelFilters, so their
// values are sorted; it sorts req.FacetLabels, whose order does not matter.
func (h *Handlers) facetsCacheKey(req *explorerpb.FacetsRequest, filters map[string][]string, maxValues int, start, end time.Time) string {
	cfg := &h.router.config
	sort.Strings(req.FacetLabels)
	labels := make([]string, 0, len(filters))
	size := cache.KeySize("facets-v2", cfg.UID, cfg.ConfigFingerprint, req.Metric, req.PodGroup, req.Node, req.Search) +
		3*cache.MaxIntKeySize + cache.MaxUintKeySize + cache.KeySize(req.FacetLabels...)
	for label, values := range filters {
		labels = append(labels, label)
		size += cache.KeySize(label) + cache.MaxUintKeySize + cache.KeySize(values...)
	}
	sort.Strings(labels)

	b := make([]byte, 0, size)
	b = cache.AppendKey(b, "facets-v2", cfg.UID, cfg.ConfigFingerprint, req.Metric, req.PodGroup, req.Node, req.Search)
	b = cache.AppendKeyInt(b, int64(maxValues))
	b = cache.AppendKeyInt(b, start.Unix())
	b = cache.AppendKeyInt(b, end.Unix())
	// Each label is followed by its number of values, which keeps one label's values apart from
	// the next label.
	b = cache.AppendKeyUint(b, uint64(len(labels)))
	for _, label := range labels {
		b = cache.AppendKey(b, label)
		b = cache.AppendKeyUint(b, uint64(len(filters[label])))
		b = cache.AppendKey(b, filters[label]...)
	}
	// The facet labels go last, so they need no count.
	b = cache.AppendKey(b, req.FacetLabels...)
	return cache.HashKey(b)
}

// histogramBucketLabels are the labels that split one histogram series into its buckets.
var histogramBucketLabels = [...]string{"le", "vmrange"}

// withoutBucketLabels removes the histogram bucket labels from every series and merges the series
// that only differed by bucket.
func withoutBucketLabels(series []map[string]string) []map[string]string {
	seen := make(map[string]struct{}, len(series))
	result := make([]map[string]string, 0, len(series))
	for _, labels := range series {
		stripped := make(map[string]string, len(labels))
		for label, value := range labels {
			stripped[label] = value
		}
		for _, label := range histogramBucketLabels {
			delete(stripped, label)
		}
		key := labelsKey(stripped, "")
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, stripped)
	}
	return result
}

// calculateFacets is the server-side equivalent of the original MetricsExplorer tag
// processor. It discovers labels from the selected metric's actual series, counts every value,
// and applies OR within one label and AND between labels. AvailableCount excludes the facet's
// own filter so users can still see and select sibling values.
func calculateFacets(
	series []map[string]string,
	filters map[string][]string,
	requestedLabels []string,
	search string,
	limit int,
) ([]facetResult, int, bool) {
	labelSet := make(map[string]struct{})
	if len(requestedLabels) > 0 {
		for _, label := range requestedLabels {
			if label != "__name__" && promLabelNamePattern.MatchString(label) {
				labelSet[label] = struct{}{}
			}
		}
	} else {
		for _, labels := range series {
			for label := range labels {
				if label != "__name__" {
					labelSet[label] = struct{}{}
				}
			}
		}
	}

	labelNames := make([]string, 0, len(labelSet))
	for label := range labelSet {
		labelNames = append(labelNames, label)
	}
	sort.Strings(labelNames)

	seriesReturned := 0
	for _, labels := range series {
		if seriesMatchesFilters(labels, filters, "") {
			seriesReturned++
		}
	}

	normalizedSearch := strings.ToLower(strings.TrimSpace(search))
	truncated := false
	facets := make([]facetResult, 0, len(labelNames))
	for _, label := range labelNames {
		baseCounts := make(map[string]int)
		currentCounts := make(map[string]int)
		availableCounts := make(map[string]int)
		seriesWithLabel := 0
		for _, labels := range series {
			value, exists := labels[label]
			if !exists {
				continue
			}
			seriesWithLabel++
			baseCounts[value]++
			if seriesMatchesFilters(labels, filters, "") {
				currentCounts[value]++
			}
			if seriesMatchesFilters(labels, filters, label) {
				availableCounts[value]++
			}
		}
		if len(baseCounts) == 0 {
			continue
		}

		labelMatches := normalizedSearch == "" || strings.Contains(strings.ToLower(label), normalizedSearch)
		values := make([]facetValueResult, 0, len(baseCounts))
		for value := range baseCounts {
			if !labelMatches && !strings.Contains(strings.ToLower(value), normalizedSearch) {
				continue
			}
			values = append(values, facetValueResult{
				Value:          value,
				Count:          currentCounts[value],
				AvailableCount: availableCounts[value],
			})
		}
		if len(values) == 0 {
			continue
		}

		selected := make(map[string]struct{}, len(filters[label]))
		for _, value := range filters[label] {
			selected[value] = struct{}{}
		}
		// The UI displays AvailableCount, so use that same count for ordering. This
		// keeps the most widely occurring value first while other label filters are
		// active. Value name is the deterministic tie-breaker.
		sort.Slice(values, func(i, j int) bool {
			if values[i].AvailableCount == values[j].AvailableCount {
				return values[i].Value < values[j].Value
			}
			return values[i].AvailableCount > values[j].AvailableCount
		})

		facetTruncated := limit > 0 && len(values) > limit
		if facetTruncated {
			// Keep active selections available even when they fall below the normal
			// value limit, without moving them ahead of more frequent values. They are moved
			// up in place: each lands at or before the position it is read from.
			visibleValues := values[:limit]
			for _, value := range values[limit:] {
				if _, isSelected := selected[value.Value]; isSelected {
					visibleValues = append(visibleValues, value)
				}
			}
			values = visibleValues
			truncated = true
		}
		isConstant := len(baseCounts) == 1 && seriesWithLabel == len(series)
		constantValue := ""
		if isConstant {
			for value := range baseCounts {
				constantValue = value
			}
		}
		maxAvailable := 0
		for _, count := range availableCounts {
			if count > maxAvailable {
				maxAvailable = count
			}
		}
		facets = append(facets, facetResult{
			Label:           label,
			Values:          values,
			TotalValues:     len(baseCounts),
			Truncated:       facetTruncated,
			IsConstant:      isConstant,
			ConstantValue:   constantValue,
			SeriesWithLabel: seriesWithLabel,
			SeriesTotal:     len(series),
			maxAvailable:    maxAvailable,
		})
	}

	// Constants have no filtering value, so group them at the top for the UI's dedicated
	// treatment. Rank every variable label by its most frequent displayed value, regardless
	// of whether the label is present on every series. If those counts tie, the label with
	// fewer distinct values comes first. Label name is the deterministic final tie-breaker.
	sort.SliceStable(facets, func(i, j int) bool {
		if facets[i].IsConstant != facets[j].IsConstant {
			return facets[i].IsConstant
		}
		if facets[i].IsConstant {
			return facets[i].Label < facets[j].Label
		}
		if facets[i].maxAvailable != facets[j].maxAvailable {
			return facets[i].maxAvailable > facets[j].maxAvailable
		}
		if facets[i].TotalValues != facets[j].TotalValues {
			return facets[i].TotalValues < facets[j].TotalValues
		}
		return facets[i].Label < facets[j].Label
	})

	return facets, seriesReturned, truncated
}

func seriesMatchesFilters(series map[string]string, filters map[string][]string, excludedLabel string) bool {
	for label, selectedValues := range filters {
		if label == excludedLabel || len(selectedValues) == 0 {
			continue
		}
		actual, exists := series[label]
		if !exists {
			return false
		}
		matched := false
		for _, selected := range selectedValues {
			if actual == selected {
				matched = true
				break
			}
		}
		if !matched {
			return false
		}
	}
	return true
}

// ============================================================================
// Series
// ============================================================================

func (h *Handlers) handleSeries(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	started := now()

	var req explorerpb.SeriesRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	// Build match[] selectors
	matches := req.Matches
	if req.Metric != "" && len(matches) == 0 {
		matches = []string{buildMetricSelector(req.Metric, nil)}
	}
	if len(matches) == 0 {
		writeError(w, http.StatusBadRequest, "missing_param", "metric or matches is required", requestID)
		return
	}

	// Default limit
	limit := int(req.Limit)
	if limit <= 0 {
		limit = h.router.limits.MaxSeriesScan
	}
	if limit > h.router.limits.MaxSeriesScanHard {
		limit = h.router.limits.MaxSeriesScanHard
	}

	startTime, endTime := h.timeRange(req.Range)

	// Fetch series from upstream
	series, isPartial, err := h.router.client.Series(r.Context(), matches, startTime, endTime, limit)
	if err != nil {
		log.DefaultLogger.Error("series: failed to fetch", "error", err, "requestId", requestID)
		h.router.obs.RecordError("upstream_error")
		writeError(w, http.StatusBadGateway, "upstream_error", "failed to fetch series: "+err.Error(), requestID)
		return
	}

	truncated := len(series) >= limit

	pbSeries := make([]*explorerpb.Series, 0, len(series))
	for _, labels := range series {
		pbSeries = append(pbSeries, &explorerpb.Series{Labels: labels})
	}
	resp := &explorerpb.SeriesResponse{
		Schema: schemaV1(),
		Meta: &explorerpb.ResponseMeta{
			RequestId:     requestID,
			Truncated:     truncated,
			Partial:       isPartial,
			ElapsedMs:     uint64(time.Since(started).Milliseconds()),
			ReturnedCount: uint32(len(series)),
		},
		Series: pbSeries,
	}

	if truncated {
		h.router.obs.RecordTruncation()
	}

	writeMessage(w, resp, requestID)
}

// ============================================================================
// Metadata (stub for now — implemented in M3)
// ============================================================================

func (h *Handlers) handleMetadata(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()

	var req explorerpb.MetadataRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	resp := &explorerpb.MetadataResponse{
		Schema: schemaV1(),
		Meta:   &explorerpb.ResponseMeta{RequestId: requestID},
		Items:  []*explorerpb.MetricMetadata{},
	}

	// Fetch metadata from upstream
	metadata, err := h.router.client.Metadata(r.Context(), req.Metric)
	if err != nil {
		log.DefaultLogger.Warn("metadata: failed to fetch", "error", err, "metric", req.Metric)
		// Return empty metadata instead of error — metadata absence doesn't mean metric doesn't exist
		writeMessage(w, resp, requestID)
		return
	}

	for metric, metas := range metadata {
		for _, m := range metas {
			resp.Items = append(resp.Items, &explorerpb.MetricMetadata{
				Metric:     metric,
				Type:       getString(m, "type"),
				Help:       getString(m, "help"),
				Unit:       getString(m, "unit"),
				Source:     "metadata",
				Confidence: 0.8,
			})
		}
	}

	writeMessage(w, resp, requestID)
}

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// ============================================================================
// Chart Plan (stub for now — implemented in M3)
// ============================================================================

func (h *Handlers) handleChartPlan(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()

	// RateMode picks the counter function from the chart footer: rate, increase or irate.
	// Empty (or anything else) keeps the automatic rate/increase choice.
	var req explorerpb.ChartPlanRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}
	filters := labelFilters(req.Filters)

	// Basic chart plan — will be enhanced in M3 with type inference
	metricType := "unknown"
	metricUnit := ""
	source := "naming"
	confidence := 0.3

	// Naming-based inference
	if strings.HasSuffix(req.Metric, "_total") || strings.HasSuffix(req.Metric, "_sum") {
		metricType = "counter"
		source = "naming"
		confidence = 0.5
	} else if strings.HasSuffix(req.Metric, "_bucket") {
		metricType = "histogram"
		source = "naming"
		confidence = 0.7
	}

	// Fetch metadata to improve inference
	metadata, err := h.router.client.Metadata(r.Context(), req.Metric)
	if err == nil {
		for _, metas := range metadata {
			for _, m := range metas {
				if t := getString(m, "type"); t != "" {
					metricType = t
					source = "metadata"
					confidence = 0.8
				}
				if unit := getString(m, "unit"); unit != "" {
					metricUnit = unit
				}
				break
			}
			break
		}
	}

	// Generate a selector that carries the label choices from the third column into the chart.
	selector := buildMetricSelector(req.Metric, filters, h.podGroupMatcher(req.PodGroup), h.nodeMatcher(req.Node))

	// Determine step
	step := req.Step
	rangeStart := time.Now().Add(-time.Hour)
	rangeEnd := time.Now()
	if ms := req.Range.GetStartMs(); ms > 0 {
		rangeStart = time.UnixMilli(ms)
	}
	if ms := req.Range.GetEndMs(); ms > 0 {
		rangeEnd = time.UnixMilli(ms)
	}
	if !rangeEnd.After(rangeStart) {
		rangeStart = rangeEnd.Add(-time.Hour)
	}
	// Without a step picked in the UI, the step follows the metric's own sample interval.
	if step == "" || step == "auto" {
		step = formatStep(h.autoStepSeconds(r.Context(), selector, rangeEnd, requestID))
	}
	// The step also sets the rate()/increase() lookbehind window, so the query shown to the user
	// follows the step instead of staying on the default.
	window := rateWindowForStep(step)

	// Keep the chart visualization consistent with the type shown in the metric picker. Metadata
	// describes the Prometheus wire type (often gauge), while the Explorer's stat-value type is
	// inferred from unchanged samples over the last hour.
	if nameType, ok := metricTypeFromName(req.Metric); ok {
		metricType = nameType
		source = "naming"
		confidence = 0.9
	} else if metricType != metricTypeHistogram && metricType != "gaugehistogram" {
		if inferredType, inferErr := h.metricTypeForChart(r.Context(), req.Metric); inferErr == nil {
			if inferredType != metricTypeUnknown {
				metricType = inferredType
				source = "behavior"
				confidence = 0.9
			}
		} else {
			log.DefaultLogger.Debug("chart-plan: behavior type inference failed; using metadata or naming",
				"error", inferErr, "metric", req.Metric, "requestId", requestID)
		}
	}

	// Every line visualization is intentionally reduced to one aggregate series. For counters
	// without an explicit rate mode, inspect the requested range at per-second resolution. Matching
	// the original MetricsExplorer behavior, switch low-frequency counters to an increase curve when
	// more than half of the finite rate samples are below one.
	// The probe always sums every series, so splitting the curve by labels never changes between
	// per second and per minute.
	counterFunc := counterFuncRate
	var counterProbeData jsontext.Value
	if metricType == "counter" && isCounterFunc(req.RateMode) {
		counterFunc = req.RateMode
	} else if metricType == "counter" {
		probeQuery := counterQuery(counterFuncRate, selector, window, nil)
		if data, queryErr := h.router.client.QueryRange(r.Context(), probeQuery, rangeStart, rangeEnd, step); queryErr == nil {
			counterProbeData = data
			if shouldUsePerMinute(data) {
				counterFunc = counterFuncIncrease
			}
		} else {
			log.DefaultLogger.Debug("chart-plan: counter scale probe failed; using per-second",
				"error", queryErr, "metric", req.Metric, "requestId", requestID)
		}
	} else if req.RateMode == counterFuncIncrease {
		// A histogram heatmap offers per second (rate, the default) and per minute (increase).
		counterFunc = counterFuncIncrease
	}

	perMinute := counterFunc == counterFuncIncrease
	// Only a counter or gauge curve is split by the labels picked under the chart.
	groupBy := groupByLabels(req.GroupBy)
	if metricType != metricTypeCounter && metricType != metricTypeGauge {
		groupBy = nil
	}
	query, aggregation, viz := buildChartQuery(metricType, selector, window, counterFunc, groupBy)
	// VictoriaMetrics histograms split buckets by vmrange instead of le, so "sum by (le)" would
	// merge every bucket into one series: copy the bucket into le first.
	var histogramTable *histogramTableResult
	if viz == "heatmap" {
		vmrange := h.hasVMRangeBuckets(r.Context(), selector, rangeStart, rangeEnd, requestID)
		if vmrange {
			query = vmrangeHeatmapQuery(selector, window, counterFunc)
		}
		var tableErr error
		histogramTable, tableErr = h.loadHistogramTable(r.Context(), req.Metric, filters, req.PodGroup, req.Node,
			vmrange, rangeStart, rangeEnd)
		if tableErr != nil {
			log.DefaultLogger.Warn("chart-plan: failed to build the histogram table",
				"error", tableErr, "metric", req.Metric, "requestId", requestID)
		}
	}
	if strings.HasSuffix(req.Metric, "_info") {
		query = selector
		aggregation = "last"
		viz = "stat"
		groupBy = nil
	}
	displayUnit := inferDisplayUnit(req.Metric, metricType, metricUnit, perMinute)

	// A stat value lists its distinct values and the labels behind each one under the constant.
	var statTable *statTableResult
	if metricType == metricTypeStatValue && viz == "stat" {
		var tableErr error
		statTable, tableErr = h.loadStatTable(r.Context(), selector, rangeStart, rangeEnd)
		if tableErr != nil {
			log.DefaultLogger.Warn("chart-plan: failed to build the stat value table",
				"error", tableErr, "metric", req.Metric, "requestId", requestID)
		}
	}

	// Calculate the sum in the backend from the same range and step used by the chart. Counter
	// planning already fetched the per-second rate curve, so reuse it only when it is also the
	// planned chart query. Low-frequency counters use increase(), and must query that curve here.
	// Split curves list their own statistics in the legend, so they need no sum.
	var summary *explorerpb.ChartSummary
	if viz == "timeseries" && len(groupBy) == 0 {
		data := counterProbeData
		if metricType == "counter" && counterFunc != counterFuncRate {
			data = nil
		}
		var summaryErr error
		if len(data) == 0 {
			data, summaryErr = h.router.client.QueryRange(r.Context(), query, rangeStart, rangeEnd, step)
		}
		if summaryErr != nil {
			log.DefaultLogger.Warn("chart-plan: failed to calculate server-side sum",
				"error", summaryErr, "metric", req.Metric, "requestId", requestID)
		} else if sum, sampleCount := sumRangeValues(data); sampleCount > 0 {
			if !math.IsNaN(sum) && !math.IsInf(sum, 0) {
				summary = &explorerpb.ChartSummary{Sum: sum, SampleCount: uint64(sampleCount)}
			}
		}
	}

	resp := &explorerpb.ChartPlanResponse{
		Schema: schemaV1(),
		Meta:   &explorerpb.ResponseMeta{RequestId: requestID},
		Plan: &explorerpb.ChartPlan{
			Metric:               req.Metric,
			MetricType:           metricType,
			MetricTypeSource:     source,
			MetricTypeConfidence: float32(confidence),
			Unit:                 displayUnit,
			Query:                query,
			RateWindow:           window,
			Step:                 step,
			Aggregation:          aggregation,
			Visualization:        viz,
			MaxSeries:            uint32(h.router.limits.MaxChartSeries),
			GroupBy:              groupBy,
		},
		Summary: summary,
	}
	if histogramTable != nil {
		resp.HistogramTable = histogramTable.toProto()
	}
	if statTable != nil {
		resp.StatTable = statTable.toProto()
	}
	writeMessage(w, resp, requestID)
}

// defaultRateWindow is the rate()/increase() lookbehind window used when a step is malformed.
const defaultRateWindow = "5m"

const (
	// autoStepWindow is how much raw data is read to measure a metric's sample interval.
	autoStepWindow = time.Hour
	// minAutoStepSeconds is the smallest automatic step: faster sample intervals still chart per
	// minute.
	minAutoStepSeconds = 60
)

// autoStepSeconds picks the step for a chart without a step chosen in the UI: the interval
// between the metric's raw samples in the hour before end, but at least one minute. When the
// interval cannot be measured the step is one minute.
func (h *Handlers) autoStepSeconds(ctx context.Context, selector string, end time.Time, requestID string) int64 {
	b := make([]byte, 0, len(selector)+len("[]")+maxStepLen)
	b = appendStep(append(append(b, selector...), '['), int64(autoStepWindow.Seconds()))
	data, err := h.router.client.Query(ctx, bytesutil.ToUnsafeString(append(b, ']')), end)
	if err != nil {
		log.DefaultLogger.Debug("chart-plan: sample interval probe failed; using the minimum step",
			"error", err, "selector", selector, "requestId", requestID)
		return minAutoStepSeconds
	}
	if interval := sampleIntervalSeconds(data); interval > minAutoStepSeconds {
		return interval
	}
	return minAutoStepSeconds
}

// sampleIntervalSeconds returns the smallest gap, in whole seconds, between two consecutive raw
// samples of any series in a matrix result, or 0 when no series has two samples. The smallest gap
// is the sample interval; larger ones are missed scrapes.
func sampleIntervalSeconds(data jsontext.Value) int64 {
	var matrix struct {
		Result []struct {
			Values [][]jsontext.Value `json:"values"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return 0
	}

	var interval float64
	for _, series := range matrix.Result {
		prev, havePrev := 0.0, false
		for _, sample := range series.Values {
			if len(sample) < 2 {
				continue
			}
			var ts float64
			if err := json.Unmarshal(sample[0], &ts); err != nil {
				continue
			}
			if havePrev && ts > prev && (interval == 0 || ts-prev < interval) {
				interval = ts - prev
			}
			prev, havePrev = ts, true
		}
	}
	return int64(math.Round(interval))
}

// stepDurationPattern matches the single-unit durations offered by the step selector (15s, 1m,
// 1h, ...). The step is spliced into the PromQL text, so anything else must never reach it.
var stepDurationPattern = regexp.MustCompile(`^[1-9][0-9]*(ms|s|m|h|d|w|y)$`)

// rateWindowForStep returns the lookbehind window for a requested step. "auto", empty and
// malformed steps keep the default window.
func rateWindowForStep(step string) string {
	if stepDurationPattern.MatchString(step) {
		return step
	}
	return defaultRateWindow
}

// Counter functions the chart can plot: per second (rate), per minute (increase) and per second
// from the last two samples (irate).
const (
	counterFuncRate     = "rate"
	counterFuncIncrease = "increase"
	counterFuncIRate    = "irate"
)

func isCounterFunc(fn string) bool {
	return fn == counterFuncRate || fn == counterFuncIncrease || fn == counterFuncIRate
}

// groupByLabels keeps the valid, distinct label names of a group-by request in their order. It
// filters labels in place.
func groupByLabels(labels []string) []string {
	groupBy := labels[:0]
	for _, label := range labels {
		if label != "__name__" && promLabelNamePattern.MatchString(label) && !slices.Contains(groupBy, label) {
			groupBy = append(groupBy, label)
		}
	}
	return groupBy
}

// sumByLen is the length appendSumBy appends for groupBy.
func sumByLen(groupBy []string) int {
	n := len("sum by () (")
	for i, label := range groupBy {
		if i > 0 {
			n += len(", ")
		}
		n += len(label)
	}
	return n
}

// appendSumBy appends the opening of a sum over groupBy, e.g. "sum by (job, instance) (". No
// labels sum every series into one.
func appendSumBy(b []byte, groupBy []string) []byte {
	b = append(b, "sum by ("...)
	for i, label := range groupBy {
		if i > 0 {
			b = append(b, ", "...)
		}
		b = append(b, label...)
	}
	return append(b, ") ("...)
}

func counterQuery(counterFunc, selector, window string, groupBy []string) string {
	b := make([]byte, 0, sumByLen(groupBy)+len(counterFunc)+len(selector)+len(window)+len("([]))"))
	b = append(appendSumBy(b, groupBy), counterFunc...)
	b = append(append(append(append(b, '('), selector...), '['), window...)
	return bytesutil.ToUnsafeString(append(b, "]))"...))
}

func gaugeQuery(selector string, groupBy []string) string {
	b := make([]byte, 0, sumByLen(groupBy)+len(selector)+len(")"))
	return bytesutil.ToUnsafeString(append(append(appendSumBy(b, groupBy), selector...), ')'))
}

// vmrangeSampleSeries is how many bucket series hasVMRangeBuckets inspects.
const vmrangeSampleSeries = 20

// hasVMRangeBuckets reports whether the histogram's bucket series carry a vmrange label.
func (h *Handlers) hasVMRangeBuckets(ctx context.Context, selector string, start, end time.Time, requestID string) bool {
	series, _, err := h.router.client.Series(ctx, []string{selector}, start, end, vmrangeSampleSeries)
	if err != nil {
		log.DefaultLogger.Debug("chart-plan: bucket label lookup failed; assuming le",
			"error", err, "selector", selector, "requestId", requestID)
		return false
	}
	for _, labels := range series {
		if _, ok := labels["vmrange"]; ok {
			return true
		}
	}
	return false
}

// histogramFunc is the function a heatmap applies to its buckets: rate, or increase per minute.
func histogramFunc(counterFunc string) string {
	if counterFunc == counterFuncIncrease {
		return counterFuncIncrease
	}
	return counterFuncRate
}

// histogramAggregation is the plan aggregation of a heatmap; the UI reads the rate mode from it.
func histogramAggregation(counterFunc string) string {
	return "sum_by_le_" + histogramFunc(counterFunc)
}

// vmrangeHeatmapQuery is the heatmap query for vmrange buckets: the "<lower>...<upper>" range is
// copied into le, e.g. vmrange="1.000e+00...1.136e+00" becomes le="1.000e+00".
func vmrangeHeatmapQuery(selector, window, counterFunc string) string {
	return "sum by (le) (label_replace(" + histogramFunc(counterFunc) + "(" + selector + "[" + window + "]), " +
		`"le", "$1", "vmrange", "([^\\n]+)\\.\\.\\.([^\\n]+)"))`
}

// buildChartQuery returns the chart query of a metric type. groupBy splits a counter or a plain
// time series into one curve per label value combination; the other types ignore it.
func buildChartQuery(metricType, selector, window, counterFunc string, groupBy []string) (query, aggregation, visualization string) {
	switch metricType {
	case "counter":
		if !isCounterFunc(counterFunc) {
			counterFunc = counterFuncRate
		}
		return counterQuery(counterFunc, selector, window, groupBy), "sum_" + counterFunc, "timeseries"
	case "histogram", "gaugehistogram":
		return "sum by (le) (" + histogramFunc(counterFunc) + "(" + selector + "[" + window + "]))",
			histogramAggregation(counterFunc), "heatmap"
	case metricTypeStatValue:
		return gaugeQuery(selector, nil), "sum", "stat"
	case "info", "stateset":
		return selector, "last", "stat"
	default:
		return gaugeQuery(selector, groupBy), "sum", "timeseries"
	}
}

func shouldUsePerMinute(data jsontext.Value) bool {
	var matrix struct {
		Result []struct {
			Values [][]jsontext.Value `json:"values"`
			Value  []jsontext.Value   `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return false
	}

	total := 0
	belowOne := 0
	countSample := func(sample []jsontext.Value) {
		if len(sample) < 2 {
			return
		}
		value, ok := parsePrometheusValue(sample[1])
		if !ok {
			return
		}
		total++
		if math.Abs(value) < 1 {
			belowOne++
		}
	}
	for _, result := range matrix.Result {
		for _, sample := range result.Values {
			countSample(sample)
		}
		if len(result.Value) > 0 {
			countSample(result.Value)
		}
	}
	return total > 0 && belowOne*2 > total
}

// sumRangeValues adds every finite value in a VictoriaMetrics range-query response. The chart
// plan always produces one series for line charts, but iterating all results keeps this helper
// correct if an upstream response contains more than one series.
func sumRangeValues(data jsontext.Value) (float64, int) {
	var matrix struct {
		Result []struct {
			Values [][]jsontext.Value `json:"values"`
			Value  []jsontext.Value   `json:"value"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &matrix); err != nil {
		return 0, 0
	}

	sum := 0.0
	count := 0
	addSample := func(sample []jsontext.Value) {
		if len(sample) < 2 {
			return
		}
		value, ok := parsePrometheusValue(sample[1])
		if !ok {
			return
		}
		sum += value
		count++
	}
	for _, result := range matrix.Result {
		for _, sample := range result.Values {
			addSample(sample)
		}
		if len(result.Value) > 0 {
			addSample(result.Value)
		}
	}
	if math.IsNaN(sum) || math.IsInf(sum, 0) {
		return 0, 0
	}
	return sum, count
}

func parsePrometheusValue(raw jsontext.Value) (float64, bool) {
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		value, parseErr := strconv.ParseFloat(text, 64)
		return value, parseErr == nil && !math.IsNaN(value) && !math.IsInf(value, 0)
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

func inferDisplayUnit(metric, metricType, metadataUnit string, perMinute bool) string {
	if metricType == "counter" {
		// A counter is plotted as a rate; a byte or second counter keeps its unit in front of it,
		// e.g. "bytes/s" or "s/min".
		per := "/s"
		if perMinute {
			per = "/min"
		}
		switch {
		case strings.HasSuffix(strings.TrimSuffix(metric, "_total"), "_bytes"):
			return "bytes" + per
		case strings.HasSuffix(metric, "_seconds_total"):
			return "s" + per
		default:
			return per
		}
	}

	switch strings.ToLower(strings.TrimSpace(metadataUnit)) {
	case "seconds", "second", "sec":
		return "s"
	case "celsius", "degrees_celsius":
		return "°C"
	case "percent":
		return "%"
	case "1", "unknown":
		return ""
	case "":
		// Fall through to naming-based inference.
	default:
		return metadataUnit
	}

	base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(metric, "_bucket"), "_sum"), "_count")
	switch {
	case strings.HasSuffix(base, "_seconds"):
		return "s"
	case strings.HasSuffix(base, "_bytes"):
		return "bytes"
	case strings.HasSuffix(base, "_celsius"):
		return "°C"
	case strings.HasSuffix(base, "_percent"):
		return "%"
	default:
		return ""
	}
}

var promLabelNamePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// buildMetricSelector turns the UI's filter model into a safe PromQL selector. Multiple values for
// one label are ORed with an anchored regex; different labels remain separate matchers (AND).
// matchers, such as the pod group and node matchers, come last; empty ones are skipped.
func buildMetricSelector(metric string, filters map[string][]string, matchers ...string) string {
	labels := selectorLabels(filters)
	b := make([]byte, 0, metricSelectorLen(metric, filters, labels, matchers))
	return bytesutil.ToUnsafeString(appendMetricSelector(b, metric, filters, labels, matchers))
}

// formatStep formats whole seconds as a duration in the largest unit that keeps it exact, so a
// 90s step stays 90s instead of becoming 1m.
func formatStep(sec int64) string {
	return bytesutil.ToUnsafeString(appendStep(make([]byte, 0, maxStepLen), sec))
}

// ============================================================================
// Diagnostics
// ============================================================================

func (h *Handlers) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()

	snap := h.router.obs.Snapshot()
	cacheStats := h.router.cache.Stats()

	resp := &explorerpb.DiagnosticsResponse{
		Schema:               schemaV1(),
		Meta:                 &explorerpb.ResponseMeta{RequestId: requestID},
		PluginVersion:        "0.1.0",
		KnowledgeBaseVersion: "0.1.0",
		UpstreamVersion:      h.router.client.GetUpstreamVersionPublic(r.Context()),
		HealthStatus:         "ok",
		MaxMetricNames:       uint32(h.router.limits.MaxMetricNames),
		MaxSeriesScan:        uint32(h.router.limits.MaxSeriesScan),
		MaxFacetValues:       uint32(h.router.limits.MaxFacetValues),
		MaxChartSeries:       uint32(h.router.limits.MaxChartSeries),
		CacheEntries:         cacheStats.Entries,
		CacheBytes:           cacheStats.TotalBytes,
		CacheHits:            snap.CacheHits,
		CacheMisses:          snap.CacheMisses,
		CacheEvictions:       snap.CacheEvictions,
		CompressionEnabled:   true, // every response is zstd-compressed
		ErrorCounts:          snap.ErrorCounts,
		UpstreamRequests:     snap.UpstreamRequests,
		UpstreamErrors:       snap.UpstreamErrors,
		AvgUpstreamLatencyMs: snap.AvgUpstreamLatencyMs,
	}

	writeMessage(w, resp, requestID)
}

// ============================================================================
// Cache Stats & Purge
// ============================================================================

func (h *Handlers) handleCacheStats(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()
	// Sizes are of the local cache all datasources share; MaxEntries stays 0 as only bytes are bounded.
	stats := h.router.cache.Stats()
	snap := h.router.obs.Snapshot()

	resp := &explorerpb.CacheStatsResponse{
		Schema:             schemaV1(),
		Meta:               &explorerpb.ResponseMeta{RequestId: requestID},
		Entries:            stats.Entries,
		TotalBytes:         stats.TotalBytes,
		MaxBytes:           stats.MaxBytes,
		Hits:               snap.CacheHits,
		Misses:             snap.CacheMisses,
		Evictions:          snap.CacheEvictions,
		SingleflightMerged: snap.SingleflightMerged,
	}

	writeMessage(w, resp, requestID)
}

func (h *Handlers) handleCachePurge(w http.ResponseWriter, r *http.Request) {
	requestID := generateRequestID()

	var req explorerpb.CachePurgeRequest
	if !h.decodePost(w, r, &req, requestID) {
		return
	}

	// Every entry of this datasource is purged, whatever the prefix: keys are hashed, and the local
	// cache can neither enumerate nor count them, so Purged stays 0.
	h.router.cache.Purge()

	writeMessage(w, &explorerpb.CachePurgeResponse{
		Schema: schemaV1(),
		Meta:   &explorerpb.ResponseMeta{RequestId: requestID},
	}, requestID)
}

// ============================================================================
// Helpers
// ============================================================================
