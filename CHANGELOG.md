# Changelog

## Unreleased

### Added

- Per-user favorites kept on the Grafana server (User Storage API), restored in any browser after
  signing in: a menu of folders and favorites, each favorite holding up to 20 saved queries of 1–10
  statements (expression, datasource, unit, visualization and the browse source they came from)
- ★ Favorite on the chart opens a save dialog prefilled with the chart's final expression, unit and
  visualization; save into a new or existing favorite (append or replace a query)
- Opening a favorite replaces columns 2–4 with its query list and one wide column that charts every
  query top to bottom, one row per statement. Clicking a query in the list scrolls to it
- Saved charts run on the toolbar's datasource, time range and Step, so one favorite can be looked
  at on any datasource; the datasource a statement was saved with is used only when none is
  selected, and the statement editor no longer asks for one. In statements saved from a chart, the
  window of rate(), increase() and irate() (the Step when it was saved) follows the current Step.
  Hand-written expressions keep their windows
- Beside each saved counter chart, per second / per minute / per second (irate) switch the
  expression's rate(), increase() or irate() for the current view (heatmaps: per second / per
  minute); the saved statement is not changed
- Edit dialog for a favorite's queries (with per-statement try run) and a Settings dialog to create
  folders and to rename, reorder, move (drag and drop or keyboard) and delete folders and favorites
- Concurrent windows and browsers never overwrite each other: every write is conditional on the
  resource version, conflicting saves are replayed on the latest data, and a save whose response was
  lost is checked instead of repeated
- Favorites stay usable when no datasource can be reached
- Saving needs Grafana 12.3.0 or later (older versions can lose concurrent updates); favorites are
  read-only below that (docs/userstorage_p0.md)
- "sum by" under a counter or gauge chart: pick one or more label names to draw one curve per label
  value combination (`sum by (job, instance)`), with a legend naming each curve's label values and
  its min, max, mean and last. Only labels with more than one value among the series the label
  filters leave are offered; a label the filters reduce to one value is unpicked

### Changed

- Refresh moves a relative time range ("last 1 hour") to the current time

### Removed

- Browser-local favorites (`vm_explorer_favorites`) and the Workspace › Favorites scope

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
