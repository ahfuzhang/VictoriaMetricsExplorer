import { getDataSourceSrv } from '@grafana/runtime';
import { DataFrame, FieldType, TimeRange } from '@grafana/data';
import {
  CachePurgeRequestSchema,
  CachePurgeResponseSchema,
  CapabilitiesResponseSchema,
  ChartPlanRequestSchema,
  ChartPlanResponseSchema,
  DatasourcesResponseSchema,
  DiagnosticsResponseSchema,
  FacetsRequestSchema,
  FacetsResponseSchema,
  GroupMode,
  MetadataRequestSchema,
  MetadataResponseSchema,
  MetricIndexRequestSchema,
  MetricIndexResponseSchema,
  MetricTypesRequestSchema,
  MetricTypesResponseSchema,
  NodeGroupsRequestSchema,
  NodeGroupsResponseSchema,
  PodGroupsRequestSchema,
  PodGroupsResponseSchema,
  RangePrecision,
  RangeQueryRequestSchema,
  RangeQueryResponseSchema,
  SeriesRequestSchema,
  SeriesResponseSchema,
} from '../../generated/explorer/explorer_pb';
import { callProto, labelFilters, rangeFromProto, schemaFromProto, timeRange } from './proto';

export { describeError } from './describeError';

// ============================================================================
// Types
// ============================================================================

export interface DatasourceInfo {
  uid: string;
  name: string;
  type: string;
  isDefault?: boolean;
}

export interface LabelMapping {
  role: string;
  labelName: string;
  confidence: number;
  detected: boolean;
}

export interface Capabilities {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    cacheHit: boolean;
    rangePrecision: string;
  };
  upstreamVersion: string;
  upstreamProduct: string;
  supportsNativeHistogram: boolean;
  supportsMetricsql: boolean;
  labelMappings: LabelMapping[];
  maxMetricNames: number;
  maxSeriesScan: number;
  maxFacetValues: number;
  maxChartSeries: number;
  maxConcurrentRequests: number;
  knowledgeBaseVersion: string;
}

export interface MetricInfo {
  /** Name displayed by the metric picker; histogram suffixes are already removed by the backend. */
  name: string;
  /** Real metric name used by facet and chart queries. */
  queryMetric: string;
  /** Types known while building the index, currently used for collapsed histograms. */
  type?: MetricKind;
  group?: string;
}

export interface MetricGroup {
  name: string;
  count: number;
}

/** Pods whose names share a workload prefix once generated suffixes are removed. */
export interface PodGroup {
  name: string;
  count: number;
  pods: string[];
}

export interface PodGroupsResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    partial: boolean;
    elapsedMs: number;
  };
  /** The label holding pod names in this datasource. */
  label: string;
  groups: PodGroup[];
  podCount: number;
}

export interface NodeGroupsResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    partial: boolean;
    elapsedMs: number;
  };
  /** The label holding node names in this datasource. */
  label: string;
  nodes: string[];
}

export interface MetricIndexResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    cacheHit: boolean;
    rangePrecision: string;
    truncated: boolean;
    partial: boolean;
    elapsedMs: number;
    totalCount: number;
    returnedCount: number;
    requestedRange: { startMs: number; endMs: number };
    effectiveRange: { startMs: number; endMs: number };
    warnings?: string[];
  };
  metrics: MetricInfo[];
  groups?: MetricGroup[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * What the backend inferred a metric to be from its last hour of data (or, for histograms, from
 * its name and siblings). 'unknown' means there was no usable data or the query failed.
 */
export type MetricKind = 'counter' | 'gauge' | 'histogram' | 'stat_value' | 'unknown';

export interface MetricTypesResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    elapsedMs: number;
    failed: number;
  };
  types: Record<string, MetricKind>;
  /** Metrics whose every sample in the last hour is 0 (stat values and counters). */
  zeroValues?: Record<string, boolean>;
}

export interface MetricMetadata {
  metric: string;
  type: string;
  help: string;
  unit: string;
  source: string;
  confidence: number;
}

export interface MetadataResponse {
  schemaVersion: { major: number; minor: number };
  meta: { requestId: string };
  items: MetricMetadata[];
}

export interface ChartPlan {
  metric: string;
  metricType: string;
  metricTypeSource: string;
  metricTypeConfidence: number;
  unit: string;
  query: string;
  rateWindow: string;
  step: string;
  aggregation: string;
  visualization: string;
  maxSeries: number;
  warnings: string[];
  alternatives: string[];
}

/** One histogram bucket: the observations that fell in (from, to] over the chart's time range. */
export interface HistogramTableRow {
  from: string;
  to: string;
  count: number;
  /** count / <base>_count × 100, or relative to the bucket total without a _count metric. */
  percent: number;
  cumulativePercent: number;
}

export interface HistogramTable {
  rows: HistogramTableRow[];
  /** Increase of <base>_count and <base>_sum over the time range; null when the metric is absent. */
  count: number | null;
  sum: number | null;
  window: string;
}

/** One distinct value of a stat-value metric. */
export interface StatTableRow {
  value: string;
  /**
   * Series the series index lists for the time range but that have no sample in it. The index works
   * per day, so it can list series that stopped before the range started; value is empty then.
   */
  noData?: boolean;
  /** Labels every series with this value shares and that not all series share. */
  labels: Record<string, string>;
  seriesCount: number;
}

export interface StatTable {
  rows: StatTableRow[];
  seriesTotal: number;
  truncated: boolean;
}

export interface ChartPlanResponse {
  schemaVersion: { major: number; minor: number };
  meta: { requestId: string };
  plan: ChartPlan;
  summary?: {
    /** Sum of every finite sample returned for the planned range query, calculated by the backend. */
    sum: number;
    sampleCount: number;
  };
  /** Bucket table of a histogram, only present with a heatmap visualization. */
  histogramTable?: HistogramTable;
  /** Distinct values of a stat value, only present for the stat-value type. */
  statTable?: StatTable;
}

export interface FacetValue {
  value: string;
  count: number;
  availableCount: number;
}

export interface Facet {
  label: string;
  values: FacetValue[];
  totalValues: number;
  truncated: boolean;
  isConstant: boolean;
  constantValue?: string;
  seriesWithLabel: number;
  seriesTotal: number;
}

export interface FacetResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    truncated: boolean;
    partial: boolean;
    elapsedMs: number;
  };
  facets: Facet[];
  /** The pod-prefix matcher every series was selected with, e.g. pod=~"mahjong-ways-.*"; empty when none. */
  podMatcher?: string;
  seriesTotal: number;
  seriesReturned: number;
  countsExact: boolean;
}

export interface SeriesEntry {
  [label: string]: string;
}

export interface SeriesResponse {
  schemaVersion: { major: number; minor: number };
  meta: {
    requestId: string;
    truncated: boolean;
    partial: boolean;
    returnedCount: number;
  };
  series: SeriesEntry[];
}

export interface DiagnosticsResponse {
  schemaVersion: { major: number; minor: number };
  meta: { requestId: string };
  pluginVersion: string;
  knowledgeBaseVersion: string;
  upstreamVersion: string;
  healthStatus: string;
  maxMetricNames: number;
  maxSeriesScan: number;
  maxFacetValues: number;
  maxChartSeries: number;
  cacheEntries: number;
  cacheBytes: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  compressionEnabled: boolean;
  errorCounts: Record<string, number>;
  upstreamRequests: number;
  upstreamErrors: number;
  avgUpstreamLatencyMs: number;
}

// ============================================================================
// API calls
//
// Every backend call is protobuf + zstd in both directions (see ./proto.ts). Each fetcher maps the
// decoded message onto the plain shapes above, so components never see protobuf types or bigints.
// ============================================================================

/** The Explorer app's ID; its backend is reached through Grafana's plugin resource proxy. */
export const PLUGIN_ID = 'ahfuzhang-victoriametricsexplorer-app';

/** The only datasource type the Explorer works with: the official VictoriaMetrics datasource. */
export const VM_DATASOURCE_TYPE = 'victoriametrics-metrics-datasource';

const RESOURCES = `/api/plugins/${PLUGIN_ID}/resources/explorer/v1`;

/**
 * Build the app backend URL for one VictoriaMetrics datasource and Explorer endpoint, e.g.
 * dsURL('vm-uid', '/capabilities'). The backend reaches the datasource through Grafana with the
 * plugin's service account; the browser only ever names the datasource by UID.
 */
function dsURL(uid: string, endpoint: string): string {
  return `${RESOURCES}/ds/${encodeURIComponent(uid)}${endpoint}`;
}

/**
 * Get the VictoriaMetrics datasources the Explorer can use. The backend decides which ones exist
 * (type and the admin's allowlist); the list is then narrowed to the datasources this user can see
 * in Grafana, so people are not offered datasources Grafana hides from them.
 */
export async function getDatasources(): Promise<DatasourceInfo[]> {
  const pb = await callProto({
    url: `${RESOURCES}/datasources`,
    method: 'GET',
    response: DatasourcesResponseSchema,
    showErrorAlert: false,
  });
  const srv = getDataSourceSrv();
  return pb.datasources
    .map((d) => ({ uid: d.uid, name: d.name, type: d.type, isDefault: d.isDefault }))
    .filter((d) => srv.getInstanceSettings(d.uid) != null);
}

/**
 * Fetch capabilities from the datasource.
 */
export async function fetchCapabilities(uid: string): Promise<Capabilities> {
  const pb = await callProto({ url: dsURL(uid, '/capabilities'), method: 'GET', response: CapabilitiesResponseSchema });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      cacheHit: pb.meta?.cacheHit ?? false,
      rangePrecision: RangePrecision[pb.meta?.rangePrecision ?? RangePrecision.UNSPECIFIED],
    },
    upstreamVersion: pb.upstreamVersion,
    upstreamProduct: pb.upstreamProduct,
    supportsNativeHistogram: pb.supportsNativeHistogram,
    supportsMetricsql: pb.supportsMetricsql,
    labelMappings: pb.labelMappings.map((m) => ({
      role: m.role,
      labelName: m.labelName,
      confidence: m.confidence,
      detected: m.detected,
    })),
    maxMetricNames: pb.maxMetricNames,
    maxSeriesScan: pb.maxSeriesScan,
    maxFacetValues: pb.maxFacetValues,
    maxChartSeries: pb.maxChartSeries,
    maxConcurrentRequests: pb.maxConcurrentRequests,
    knowledgeBaseVersion: pb.knowledgeBaseVersion,
  };
}

/**
 * Fetch the metric index (list of metric names with optional search and grouping).
 */
export async function fetchMetricIndex(
  uid: string,
  params: {
    search?: string;
    groupMode?: string;
    group?: string;
    podGroup?: string;
    node?: string;
    metrics?: string[];
    page?: number;
    pageSize?: number;
    sort?: string;
    startMs?: number;
    endMs?: number;
  }
): Promise<MetricIndexResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/metric-index'),
    method: 'POST',
    response: MetricIndexResponseSchema,
    request: {
      schema: MetricIndexRequestSchema,
      init: {
        range: timeRange(params.startMs, params.endMs),
        search: params.search,
        groupMode: params.groupMode === 'prefix' ? GroupMode.PREFIX : GroupMode.ALL,
        group: params.group,
        page: params.page,
        pageSize: params.pageSize,
        sort: params.sort,
        metrics: params.metrics,
        podGroup: params.podGroup,
        node: params.node,
      },
    },
  });
  const meta = pb.meta;
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: meta?.requestId ?? '',
      cacheHit: meta?.cacheHit ?? false,
      rangePrecision: RangePrecision[meta?.rangePrecision ?? RangePrecision.UNSPECIFIED],
      truncated: meta?.truncated ?? false,
      partial: meta?.partial ?? false,
      elapsedMs: Number(meta?.elapsedMs ?? 0),
      totalCount: meta?.totalCount ?? 0,
      returnedCount: meta?.returnedCount ?? 0,
      requestedRange: rangeFromProto(meta?.requestedRange),
      effectiveRange: rangeFromProto(meta?.effectiveRange),
      warnings: meta?.warnings.length ? meta.warnings : undefined,
    },
    metrics: pb.metrics.map((m) => ({
      name: m.name,
      queryMetric: m.queryMetric,
      type: (m.type || undefined) as MetricKind | undefined,
      group: m.group || undefined,
    })),
    groups: pb.groups.map((g) => ({ name: g.name, count: g.count })),
    totalCount: pb.totalCount,
    page: pb.page,
    pageSize: pb.pageSize,
    totalPages: pb.totalPages,
  };
}

/**
 * Fetch the pod names in the time range, grouped by workload prefix.
 */
export async function fetchPodGroups(
  uid: string,
  params: {
    startMs?: number;
    endMs?: number;
  }
): Promise<PodGroupsResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/pod-groups'),
    method: 'POST',
    response: PodGroupsResponseSchema,
    request: { schema: PodGroupsRequestSchema, init: { range: timeRange(params.startMs, params.endMs) } },
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      partial: pb.meta?.partial ?? false,
      elapsedMs: Number(pb.meta?.elapsedMs ?? 0),
    },
    label: pb.label,
    groups: pb.groups.map((g) => ({ name: g.name, count: g.count, pods: g.pods })),
    podCount: pb.podCount,
  };
}

/**
 * Fetch the node names in the time range.
 */
export async function fetchNodeGroups(
  uid: string,
  params: {
    startMs?: number;
    endMs?: number;
  }
): Promise<NodeGroupsResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/node-groups'),
    method: 'POST',
    response: NodeGroupsResponseSchema,
    request: { schema: NodeGroupsRequestSchema, init: { range: timeRange(params.startMs, params.endMs) } },
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      partial: pb.meta?.partial ?? false,
      elapsedMs: Number(pb.meta?.elapsedMs ?? 0),
    },
    label: pb.label,
    nodes: pb.nodes,
  };
}

/**
 * Infer the type (counter, gauge, histogram, stat value) of the given metrics. The backend pulls
 * the last hour of each metric's data, so this is slower than the metric index and is requested
 * separately, once the names are already on screen.
 */
export async function fetchMetricTypes(
  uid: string,
  params: {
    metrics: string[];
    startMs?: number;
    endMs?: number;
  }
): Promise<MetricTypesResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/metric-types'),
    method: 'POST',
    response: MetricTypesResponseSchema,
    request: {
      schema: MetricTypesRequestSchema,
      init: { metrics: params.metrics, range: timeRange(params.startMs, params.endMs) },
    },
    showErrorAlert: false,
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      elapsedMs: Number(pb.meta?.elapsedMs ?? 0),
      failed: pb.failed,
    },
    types: pb.types as Record<string, MetricKind>,
    zeroValues: pb.zeroValues,
  };
}

/**
 * Fetch metadata for a specific metric.
 */
export async function fetchMetadata(uid: string, metric: string): Promise<MetadataResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/metadata'),
    method: 'POST',
    response: MetadataResponseSchema,
    request: { schema: MetadataRequestSchema, init: { metric } },
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: { requestId: pb.meta?.requestId ?? '' },
    items: pb.items.map((m) => ({
      metric: m.metric,
      type: m.type,
      help: m.help,
      unit: m.unit,
      source: m.source,
      confidence: m.confidence,
    })),
  };
}

/**
 * Fetch a chart plan (query recommendation) for a metric.
 */
export async function fetchChartPlan(
  uid: string,
  params: {
    metric: string;
    filters?: Record<string, string[]>;
    podGroup?: string;
    node?: string;
    startMs?: number;
    endMs?: number;
    step?: string;
    /** Counter function to plot: rate, increase or irate. Omitted lets the backend choose. */
    rateMode?: string;
  }
): Promise<ChartPlanResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/chart-plan'),
    method: 'POST',
    response: ChartPlanResponseSchema,
    request: {
      schema: ChartPlanRequestSchema,
      init: {
        metric: params.metric,
        filters: labelFilters(params.filters),
        podGroup: params.podGroup,
        node: params.node,
        range: timeRange(params.startMs, params.endMs),
        step: params.step,
        rateMode: params.rateMode,
      },
    },
  });
  const plan = pb.plan;
  const hist = pb.histogramTable;
  const stat = pb.statTable;
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: { requestId: pb.meta?.requestId ?? '' },
    plan: {
      metric: plan?.metric ?? '',
      metricType: plan?.metricType ?? '',
      metricTypeSource: plan?.metricTypeSource ?? '',
      metricTypeConfidence: plan?.metricTypeConfidence ?? 0,
      unit: plan?.unit ?? '',
      query: plan?.query ?? '',
      rateWindow: plan?.rateWindow ?? '',
      step: plan?.step ?? '',
      aggregation: plan?.aggregation ?? '',
      visualization: plan?.visualization ?? '',
      maxSeries: plan?.maxSeries ?? 0,
      warnings: plan?.warnings ?? [],
      alternatives: plan?.alternatives ?? [],
    },
    summary: pb.summary ? { sum: pb.summary.sum, sampleCount: Number(pb.summary.sampleCount) } : undefined,
    histogramTable: hist
      ? {
          rows: hist.rows.map((r) => ({
            from: r.from,
            to: r.to,
            count: r.count,
            percent: r.percent,
            cumulativePercent: r.cumulativePercent,
          })),
          count: hist.count ?? null,
          sum: hist.sum ?? null,
          window: hist.window,
        }
      : undefined,
    statTable: stat
      ? {
          rows: stat.rows.map((r) => ({
            value: r.value,
            noData: r.noData || undefined,
            labels: r.labels,
            seriesCount: r.seriesCount,
          })),
          seriesTotal: stat.seriesTotal,
          truncated: stat.truncated,
        }
      : undefined,
  };
}

/**
 * Fetch facet values for a label.
 */
export async function fetchFacets(
  uid: string,
  params: {
    metric: string;
    filters?: Record<string, string[]>;
    podGroup?: string;
    node?: string;
    facetLabels?: string[];
    search?: string;
    startMs?: number;
    endMs?: number;
    maxValuesPerFacet?: number;
  }
): Promise<FacetResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/facets'),
    method: 'POST',
    response: FacetsResponseSchema,
    request: {
      schema: FacetsRequestSchema,
      init: {
        metric: params.metric,
        filters: labelFilters(params.filters),
        facetLabels: params.facetLabels,
        podGroup: params.podGroup,
        node: params.node,
        search: params.search,
        range: timeRange(params.startMs, params.endMs),
        maxValuesPerFacet: params.maxValuesPerFacet,
      },
    },
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      truncated: pb.meta?.truncated ?? false,
      partial: pb.meta?.partial ?? false,
      elapsedMs: Number(pb.meta?.elapsedMs ?? 0),
    },
    facets: pb.facets.map((f) => ({
      label: f.label,
      values: f.values.map((v) => ({ value: v.value, count: v.count, availableCount: v.availableCount })),
      totalValues: f.totalValues,
      truncated: f.truncated,
      isConstant: f.isConstant,
      constantValue: f.constantValue || undefined,
      seriesWithLabel: f.seriesWithLabel,
      seriesTotal: f.seriesTotal,
    })),
    podMatcher: pb.podMatcher || undefined,
    seriesTotal: pb.seriesTotal,
    seriesReturned: pb.seriesReturned,
    countsExact: pb.countsExact,
  };
}

/**
 * Fetch series for a metric.
 */
export async function fetchSeries(
  uid: string,
  params: {
    metric?: string;
    matches?: string[];
    startMs?: number;
    endMs?: number;
    limit?: number;
  }
): Promise<SeriesResponse> {
  const pb = await callProto({
    url: dsURL(uid, '/series'),
    method: 'POST',
    response: SeriesResponseSchema,
    request: {
      schema: SeriesRequestSchema,
      init: {
        metric: params.metric,
        matches: params.matches,
        range: timeRange(params.startMs, params.endMs),
        limit: params.limit,
      },
    },
  });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: {
      requestId: pb.meta?.requestId ?? '',
      truncated: pb.meta?.truncated ?? false,
      partial: pb.meta?.partial ?? false,
      returnedCount: pb.meta?.returnedCount ?? 0,
    },
    series: pb.series.map((s) => s.labels),
  };
}

/**
 * Fetch diagnostics.
 */
export async function fetchDiagnostics(uid: string): Promise<DiagnosticsResponse> {
  const pb = await callProto({ url: dsURL(uid, '/diagnostics'), method: 'GET', response: DiagnosticsResponseSchema });
  return {
    schemaVersion: schemaFromProto(pb.schema),
    meta: { requestId: pb.meta?.requestId ?? '' },
    pluginVersion: pb.pluginVersion,
    knowledgeBaseVersion: pb.knowledgeBaseVersion,
    upstreamVersion: pb.upstreamVersion,
    healthStatus: pb.healthStatus,
    maxMetricNames: pb.maxMetricNames,
    maxSeriesScan: pb.maxSeriesScan,
    maxFacetValues: pb.maxFacetValues,
    maxChartSeries: pb.maxChartSeries,
    cacheEntries: Number(pb.cacheEntries),
    cacheBytes: Number(pb.cacheBytes),
    cacheHits: Number(pb.cacheHits),
    cacheMisses: Number(pb.cacheMisses),
    cacheEvictions: Number(pb.cacheEvictions),
    compressionEnabled: pb.compressionEnabled,
    errorCounts: Object.fromEntries(Object.entries(pb.errorCounts).map(([code, n]) => [code, Number(n)])),
    upstreamRequests: Number(pb.upstreamRequests),
    upstreamErrors: Number(pb.upstreamErrors),
    avgUpstreamLatencyMs: pb.avgUpstreamLatencyMs,
  };
}

/**
 * Purge cache.
 */
export async function purgeCache(uid: string, prefix?: string): Promise<{ purged: number }> {
  const pb = await callProto({
    url: dsURL(uid, '/cache/purge'),
    method: 'POST',
    response: CachePurgeResponseSchema,
    request: { schema: CachePurgeRequestSchema, init: { prefix: prefix ?? '' } },
  });
  return { purged: pb.purged };
}

/** The chart asks for about this many points per series; the backend raises the step to fit. */
const CHART_MAX_DATA_POINTS = 1000;

/**
 * Run the chart's range query through the app backend (VictoriaMetrics /api/v1/query_range via the
 * Grafana datasource proxy) and return one DataFrame per series: a time field and a value field
 * carrying the series labels, the shape Grafana's own query path produced.
 */
export async function queryChartData(
  uid: string,
  params: { expr: string; step: string; range: TimeRange }
): Promise<DataFrame[]> {
  const pb = await callProto({
    url: dsURL(uid, '/query-range'),
    method: 'POST',
    response: RangeQueryResponseSchema,
    request: {
      schema: RangeQueryRequestSchema,
      init: {
        query: params.expr,
        range: timeRange(params.range.from.valueOf(), params.range.to.valueOf()),
        step: params.step,
        maxDataPoints: CHART_MAX_DATA_POINTS,
      },
    },
  });
  const intervalMs = (stepSecondsOf(pb.step) ?? 60) * 1000;
  return pb.series.map((series) => {
    const times = series.timestampsMs.map(Number);
    const labels = { ...series.labels };
    const name = seriesName(labels, params.expr);
    return {
      name,
      length: times.length,
      fields: [
        { name: 'Time', type: FieldType.time, config: { interval: intervalMs }, values: times },
        {
          name: 'Value',
          type: FieldType.number,
          config: { displayNameFromDS: name },
          values: series.values,
          labels,
        },
      ],
    };
  });
}

/**
 * Name a series the way Grafana's Prometheus-style datasources do without a legend format:
 * metric{label="value",...} with sorted labels, or the query itself for a series without labels.
 */
function seriesName(labels: Record<string, string>, expr: string): string {
  const { __name__: metric = '', ...rest } = labels;
  const pairs = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${JSON.stringify(rest[key])}`);
  if (!metric && pairs.length === 0) {
    return expr;
  }
  return `${metric}{${pairs.join(',')}}`;
}

/** Seconds in a step such as "90s", "2m" or "1h" as written by the backend; undefined otherwise. */
function stepSecondsOf(step: string): number | undefined {
  const match = /^(\d+)(s|m|h|d)$/.exec(step);
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
}
