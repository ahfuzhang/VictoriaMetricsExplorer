package resource

import (
	json "encoding/json/v2"
	"fmt"
	"net/http"
	"regexp"
	"strconv"

	"google.golang.org/protobuf/types/known/structpb"

	"github.com/ahfuzhang/victoriametricsexplorer/pkg/metricconfig"
	explorerpb "github.com/ahfuzhang/victoriametricsexplorer/pkg/proto/explorer"
)

func (h *Handlers) handleConfiguredCharts(w http.ResponseWriter, r *http.Request) {
	id := generateRequestID()
	var req explorerpb.ConfiguredChartsRequest
	if !h.decodePost(w, r, &req, id) {
		return
	}
	resp := &explorerpb.ConfiguredChartsResponse{}
	catalog := h.router.metricCatalog
	if catalog == nil || !catalog.Enabled {
		writeMessage(w, resp, id)
		return
	}
	resp.Enabled = true
	start, end := h.timeRange(req.Range)
	if !end.After(start) {
		writeError(w, http.StatusBadRequest, "invalid_range", "range end must be after start", id)
		return
	}
	// Empty means the By Pod branch as a whole. Still require the pod label on every selector.
	dayStart, dayEnd := dayRange(start, end)
	list, _, err := h.metricIndexList(r.Context(), "", req.PodGroup, "", dayStart, dayEnd)
	if err != nil {
		writeError(w, http.StatusBadGateway, "upstream_error", err.Error(), id)
		return
	}
	names := map[string]bool{}
	for _, m := range list.Metrics {
		names[m.QueryMetric] = true
		// Histogram discovery collapses members into one row. Check each member against
		// the datasource below rather than inventing availability for missing siblings.
	}
	// Query exact dependency names as one union selector. This also handles histogram
	// members hidden by the picker, limits discovery to configured metrics and applies
	// filters. The ordinary metric-index cache remains useful for unrestricted scopes.
	filters := labelFilters(req.Filters)
	missing := map[string]bool{}
	for _, f := range catalog.Files {
		for _, c := range f.Charts {
			for _, n := range c.Match.MetricNames {
				if !names[n] || len(filters) > 0 || req.PodGroup == "" {
					missing[n] = true
				}
			}
		}
	}
	if len(missing) > 0 {
		var matches []string
		for n := range missing {
			matches = append(matches, buildMetricSelector(n, filters, h.configuredPodMatcher(req.PodGroup)))
		}
		found, partial, err := h.router.client.LabelValues(r.Context(), "__name__", matches, start, end, h.router.limits.MaxMetricNamesHard)
		if err != nil {
			writeError(w, http.StatusBadGateway, "upstream_error", err.Error(), id)
			return
		}
		for n := range missing {
			delete(names, n)
		}
		for _, n := range found {
			names[n] = true
		}
		resp.Partial = partial
	}
	resp.Partial = resp.Partial || list.Partial
	ctx := h.configuredContext(req.PodGroup, filters)
	for _, f := range catalog.Files {
		category := &explorerpb.ConfiguredCategory{Id: f.Category.ID, Title: f.Category.Title, Description: f.Category.Description}
		for _, c := range f.Charts {
			if !c.Matches(names, h.router.config.SupportsMetricsQL()) {
				continue
			}
			chart := &explorerpb.ConfiguredChart{Id: f.Category.ID + "/" + c.ID, Title: c.Title, Description: c.Description}
			chart.Visualization, err = configStruct(c.Visualization)
			if err == nil && c.Summary != nil {
				chart.Summary, err = configStruct(c.Summary)
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, "config_error", err.Error(), id)
				return
			}
			for _, q := range c.Queries {
				expr, _, err := c.Render(q, ctx)
				if err != nil {
					writeError(w, http.StatusBadRequest, "config_error", fmt.Sprintf("%s/%s: %s", chart.Id, q.RefID, err), id)
					return
				}
				chart.Queries = append(chart.Queries, &explorerpb.ConfiguredQuery{RefId: q.RefID, Expr: expr, Legend: q.Legend, Axis: q.Axis, Instant: q.Instant, Hidden: q.Hidden})
			}
			category.Charts = append(category.Charts, chart)
		}
		if len(category.Charts) > 0 {
			resp.Categories = append(resp.Categories, category)
		}
	}
	writeMessage(w, resp, id)
}

func (h *Handlers) configuredPodMatcher(group string) string {
	if group == "" {
		return h.podLabel() + `!=""`
	}
	// A group may be a complete pod name when it has no generated suffix.
	return h.podLabel() + "=~" + strconv.Quote(regexp.QuoteMeta(group)+"(?:-.*)?")
}

func (h *Handlers) configuredContext(group string, filters map[string][]string) metricconfig.Context {
	cfg := &h.router.config
	return metricconfig.Context{
		Labels: map[string]string{"pod": h.podLabel(), "namespace": cfg.NamespaceLabel, "node": cfg.NodeLabel, "cluster": cfg.ClusterLabel},
		Selector: func(metric string, matchers []metricconfig.Matcher) (string, error) {
			parts := []string{h.configuredPodMatcher(group)}
			for _, m := range matchers {
				parts = append(parts, m.Label+m.Op+strconv.Quote(m.Value))
			}
			return buildMetricSelector(metric, filters, parts...), nil
		},
	}
}

func configStruct(v any) (*structpb.Struct, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return structpb.NewStruct(m)
}
