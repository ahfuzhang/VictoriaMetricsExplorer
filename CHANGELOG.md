# Changelog

## 0.1.0 (Unreleased)

### Added

- App plugin with VictoriaMetrics Explorer page; it uses your existing `victoriametrics-metrics-datasource`
  datasources (no datasource plugin of its own, see ADR-007)
- App backend reaches datasources through Grafana's datasource proxy with a managed service account
- Resource API: datasources, capabilities, metric-index, metadata, chart-plan, diagnostics
- Metric names column shows each metric's type (counter, gauge, histogram, stat value) instead of its
  prefix group. The backend pulls the last hour of every metric: samples that never change are a stat
  value, samples that only grow are a counter, anything else is a gauge; a `_bucket` metric with
  matching `_count` and `_sum` metrics makes all three a histogram
- Classic histogram `_bucket`, `_count`, and `_sum` members are collapsed into one metric-picker row
  displaying only their shared prefix; the row still queries the bucket metric for labels and charts
- Four-column Explorer UI: hierarchical scope tree, searchable metric names, label filters, and
  automatic time series / heatmap / stat visualization
- Global time-range and query-step controls, prefix-group navigation, and browser-local favorites
- Draggable, keyboard-accessible column separators with versioned browser-local width persistence
- Collapsible explorer tree column that restores its previous width when expanded
- Dynamic label facets derived from the selected metric's real series, including common labels,
  occurrence counts, and OR-within/AND-between filtering
- Label facets ordered by their highest value occurrence count, then by lower value cardinality,
  with metric-wide constants highlighted separately at the top
- Single-series chart aggregation, visible units, and automatic counter scaling from per-second to
  per-minute when most rate samples are below one
- Line charts use Grafana's own time series component (uPlot), including hover crosshair, point and
  tooltip, with a dedicated bottom-right summary for min, max, average and a server-calculated sum
- Behavior-detected stat values use Grafana's `BigValue` stat card with a prominent formatted
  value and unit, without rendering a time-series curve
- Top-aligned visualization content that remains anchored when adjacent columns contain long lists
- Independent vertical scrolling for the tree, metric-name, and label-filter columns
- L1 in-memory LRU cache with TTL and byte/entry limits
- VictoriaMetrics API client (via the Grafana datasource proxy; the datasource owns URL, tenant, auth and TLS)
- Configurable Kubernetes label mappings (pod, namespace, node, cluster)
- Automatic metric type inference (naming + metadata based)
- Auto-generated PromQL from chart plans
- Grafana provisioning files for development
