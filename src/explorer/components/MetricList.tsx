import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, Icon, Input, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { Capabilities, MetricInfo, MetricKind } from '../model';
import { backendError, fetchMetricIndex, fetchMetricTypes, describeError } from '../api';
import type { MetricScope } from './Explorer';

// One request per page of names; the backend caps a request at 500.
const TYPE_REQUEST_SIZE = 200;

const NO_TYPES: Record<string, MetricKind> = {};
const NO_ZERO_VALUES: Record<string, boolean> = {};

type TypeFilter = Exclude<MetricKind, 'unknown'>;

const TYPE_FILTERS: Array<{ label: string; value: TypeFilter }> = [
  { label: 'Counter', value: 'counter' },
  { label: 'Gauge', value: 'gauge' },
  { label: 'Histogram', value: 'histogram' },
  { label: 'Stat', value: 'stat_value' },
];

interface Props {
  datasourceUID: string;
  capabilities: Capabilities;
  selectedMetric: string;
  scope: MetricScope;
  timeRange: TimeRange;
  refreshKey: number;
  onSelectMetric: (metric: string) => void;
  showImportantMetrics?: boolean;
  importantMetricsSelected?: boolean;
  onSelectImportantMetrics?: () => void;
}

export const MetricList: React.FC<Props> = ({
  datasourceUID,
  capabilities,
  selectedMetric,
  scope,
  timeRange,
  refreshKey,
  onSelectMetric,
  showImportantMetrics,
  importantMetricsSelected,
  onSelectImportantMetrics,
}) => {
  const styles = useStyles2(getStyles);

  const [search, setSearch] = useState('');
  const [metrics, setMetrics] = useState<MetricInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The backend's reason for rejecting the search as a regular expression, shown under the input.
  const [searchError, setSearchError] = useState('');
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [truncated, setTruncated] = useState(false);
  // At most one type is shown at a time; clicking the active type again shows every type.
  const [typeFilter, setTypeFilter] = useState<TypeFilter | null>(null);

  // Inferred types belong to one datasource and are inferred again on an explicit refresh (the
  // backend still answers from its own short-lived cache), so results carry the key they were
  // fetched for and are ignored once it changes.
  const typesKey = `${datasourceUID}:${refreshKey}`;
  const [typeResults, setTypeResults] = useState<{
    key: string;
    types: Record<string, MetricKind>;
    zeroValues: Record<string, boolean>;
  }>({
    key: '',
    types: NO_TYPES,
    zeroValues: NO_ZERO_VALUES,
  });
  const types = typeResults.key === typesKey ? typeResults.types : NO_TYPES;
  const zeroValues = typeResults.key === typesKey ? typeResults.zeroValues : NO_ZERO_VALUES;

  const requestRef = useRef(0);
  const typeGenerationRef = useRef(0);
  const typesRequestedRef = useRef<Set<string>>(new Set());
  // The datasource the current `metrics` came from; right after a datasource switch the list is
  // still the previous datasource's until its reload lands.
  const metricsOwnerRef = useRef('');
  // The scope the current `metrics` were listed in; type requests name it so the backend can write
  // the types into that list.
  const metricsScopeRef = useRef<ScopeParams>({});
  const pageSize = Math.max(1, Math.min(200, capabilities.maxMetricNames));
  const startMs = timeRange.from.valueOf();
  const endMs = timeRange.to.valueOf();

  useEffect(() => {
    typeGenerationRef.current += 1;
    typesRequestedRef.current = new Set();
  }, [typesKey]);

  // The names render first; their types follow once the backend has looked at each metric's data.
  useEffect(() => {
    if (metricsOwnerRef.current !== datasourceUID) {
      return;
    }
    // The index carries the type and zero flag of every metric the backend has looked at, so only the
    // others are asked about. Histograms and _total counters already have their type, but are still
    // asked about so the backend can report the ones that are always 0.
    const missing = metrics
      .filter((metric) => !metric.zeroChecked && !typesRequestedRef.current.has(metric.queryMetric))
      .map((metric) => metric.queryMetric);
    if (missing.length === 0) {
      return;
    }
    missing.forEach((name) => typesRequestedRef.current.add(name));

    const generation = typeGenerationRef.current;
    const scopeParams = metricsScopeRef.current;
    for (let offset = 0; offset < missing.length; offset += TYPE_REQUEST_SIZE) {
      const batch = missing.slice(offset, offset + TYPE_REQUEST_SIZE);
      fetchMetricTypes(datasourceUID, { metrics: batch, ...scopeParams, startMs, endMs })
        .then((response) => {
          if (generation === typeGenerationRef.current) {
            setTypeResults((previous) => ({
              key: typesKey,
              types: { ...(previous.key === typesKey ? previous.types : NO_TYPES), ...response.types },
              zeroValues: {
                ...(previous.key === typesKey ? previous.zeroValues : NO_ZERO_VALUES),
                ...response.zeroValues,
              },
            }));
          }
        })
        .catch((err: unknown) => {
          // The type is only a hint next to the name, so a failure leaves it blank rather than
          // raising an error; the names are asked for again with the next page.
          console.warn('Failed to infer metric types', err);
          if (generation === typeGenerationRef.current) {
            batch.forEach((name) => typesRequestedRef.current.delete(name));
          }
        });
    }
  }, [datasourceUID, endMs, metrics, startMs, typesKey]);

  const loadMetrics = useCallback(
    async (pageNumber: number, append: boolean) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError('');
      setSearchError('');
      try {
        const params = scopeParams(scope);
        const response = await fetchMetricIndex(datasourceUID, {
          search,
          groupMode: 'prefix',
          ...params,
          page: pageNumber,
          pageSize,
          sort: 'name',
          startMs: timeRange.from.valueOf(),
          endMs: timeRange.to.valueOf(),
        });
        if (request !== requestRef.current) {
          return;
        }

        metricsOwnerRef.current = datasourceUID;
        metricsScopeRef.current = params;
        setMetrics((previous) => {
          if (!append) {
            return response.metrics;
          }
          const names = new Set(previous.map((metric) => metric.queryMetric));
          return [...previous, ...response.metrics.filter((metric) => !names.has(metric.queryMetric))];
        });
        setTotalCount(response.totalCount);
        setTotalPages(response.totalPages);
        setTruncated(response.meta.truncated);
        setPage(response.page);
      } catch (err: unknown) {
        if (request !== requestRef.current) {
          return;
        }
        const rejected = backendError(err);
        if (rejected?.code === 'invalid_search') {
          setSearchError(rejected.message);
          setTotalCount(0);
          setTotalPages(1);
          setTruncated(false);
        } else {
          console.error('Failed to load metrics', err);
          setError(describeError(err));
        }
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
        }
      }
    },
    [datasourceUID, pageSize, scope, search, timeRange]
  );

  useEffect(() => {
    requestRef.current += 1;
    setMetrics([]);
    setPage(1);

    const timer = window.setTimeout(() => loadMetrics(1, false), 300);
    return () => window.clearTimeout(timer);
  }, [datasourceUID, loadMetrics, refreshKey, scope.kind, search]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const isNearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
      if (isNearBottom && !loading && page < totalPages) {
        loadMetrics(page + 1, true);
      }
    },
    [loadMetrics, loading, page, totalPages]
  );

  // undefined while the backend has not looked at a metric whose name does not tell its type.
  const metricType = (metric: MetricInfo): MetricKind | undefined =>
    types[metric.queryMetric] ?? (metric.zeroChecked || metric.type !== 'unknown' ? metric.type : undefined);
  // Types are only known for loaded pages, so the filter applies to the loaded metrics; metrics whose
  // type has not come back yet stay hidden until it does.
  const visibleMetrics = typeFilter ? metrics.filter((metric) => metricType(metric) === typeFilter) : metrics;
  const typesPending = metrics.some((metric) => metricType(metric) === undefined);

  // A filter can hide most of a page, leaving nothing to scroll; keep loading pages until it shows a
  // page worth of metrics. Waiting for the loaded types first keeps this to one page at a time.
  useEffect(() => {
    if (typeFilter && !loading && !typesPending && page < totalPages && visibleMetrics.length < pageSize) {
      const timer = window.setTimeout(() => loadMetrics(page + 1, true), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [loadMetrics, loading, page, pageSize, totalPages, typeFilter, typesPending, visibleMetrics.length]);

  const scopeLabel =
    scope.kind === 'group'
      ? `Group: ${scope.group}`
      : scope.kind === 'pod'
        ? `Pod: ${scope.group} (${scope.pods.length} pod${scope.pods.length !== 1 ? 's' : ''})`
        : scope.kind === 'node'
          ? `Node: ${scope.node}`
          : 'All metrics';
  // The first-column branch the list came from, named in the heading; All metrics names none.
  const scopeSource =
    scope.kind === 'pod'
      ? { label: 'pod prefix', value: scope.group }
      : scope.kind === 'node'
        ? { label: 'node', value: scope.node }
        : scope.kind === 'group'
          ? { label: 'metric name prefix', value: scope.group }
          : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headingRow}>
          <span className={styles.stepNumber}>02</span>
          <h2 className={styles.title}>Metric names</h2>
          {scopeSource && (
            <span className={styles.scopeSource} title={`${scopeSource.label} ${scopeSource.value}`}>
              {scopeSource.label} <span className={styles.scopeSourceValue}>{scopeSource.value}</span>
            </span>
          )}
        </div>
        {showImportantMetrics && (
          <a
            href="#important-metrics"
            className={styles.importantMetricsLink}
            aria-current={importantMetricsSelected ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onSelectImportantMetrics?.();
            }}
          >
            <Icon name="chart-line" size="lg" aria-hidden="true" />
            <span>Important Metrics</span>
            <Icon name="arrow-right" className={styles.importantMetricsArrow} aria-hidden="true" />
          </a>
        )}
        <Input
          aria-label="Search metric names"
          placeholder="Search metrics (regex)…"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          prefix={<span aria-hidden="true">⌕</span>}
          className={styles.searchInput}
          invalid={searchError !== ''}
        />
        {searchError && (
          <div className={styles.searchError} role="alert">
            Invalid regular expression: {searchError}
          </div>
        )}
        <div className={styles.scopeLabel}>{scopeLabel}</div>
      </div>

      <div className={styles.listContainer} onScroll={handleScroll}>
        {error && (
          <Alert title="Failed to load metrics" severity="error">
            {error}
          </Alert>
        )}
        {loading && metrics.length === 0 ? (
          <div className={styles.loading}>
            <LoadingPlaceholder text="Loading metrics…" />
          </div>
        ) : metrics.length === 0 ? (
          !error && !searchError && <div className={styles.empty}>No metrics found.</div>
        ) : visibleMetrics.length === 0 && !loading && !typesPending ? (
          <div className={styles.empty}>No metrics of this type.</div>
        ) : (
          <ul className={styles.list}>
            {visibleMetrics.map((metric) => {
              const type = metricType(metric);
              const badge = metricTypeBadge(type);
              // A metric that is always 0 (a stat value or an idle counter) carries no information; it
              // stays listed but greyed out.
              const zeroValue = zeroValues[metric.queryMetric] === true || (metric.zeroChecked && metric.zero);
              return (
                <li key={metric.queryMetric}>
                  <button
                    type="button"
                    className={`${styles.metricItem} ${
                      selectedMetric === metric.queryMetric ? styles.metricItemSelected : ''
                    }`}
                    data-zero-value={zeroValue || undefined}
                    onClick={() => onSelectMetric(metric.queryMetric)}
                    title={
                      metric.name === metric.queryMetric ? metric.name : `${metric.name} (uses ${metric.queryMetric})`
                    }
                    aria-pressed={selectedMetric === metric.queryMetric}
                  >
                    <span className={styles.metricName}>{metric.name}</span>
                    <span
                      className={styles.metricType}
                      title={zeroValue ? `${badge.title}; always 0 in the last hour` : badge.title}
                    >
                      {badge.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {loading && metrics.length > 0 && (
          <div className={styles.loadingMore}>
            <LoadingPlaceholder text="Loading more…" />
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <span>
          {totalCount} metric{totalCount !== 1 ? 's' : ''}
          {truncated && ' · truncated'}
        </span>
        {totalPages > 1 && (
          <span>
            {metrics.length}/{totalCount}
          </span>
        )}
      </div>

      <div className={styles.typeFilters} role="group" aria-label="Filter by metric type">
        {TYPE_FILTERS.map((filter) => (
          <Button
            key={filter.value}
            size="sm"
            variant={typeFilter === filter.value ? 'primary' : 'secondary'}
            fill={typeFilter === filter.value ? 'solid' : 'outline'}
            aria-pressed={typeFilter === filter.value}
            onClick={() => setTypeFilter((current) => (current === filter.value ? null : filter.value))}
          >
            {filter.label}
          </Button>
        ))}
      </div>
    </div>
  );
};

/** The metric-index scope of the metrics listed for a scope. */
type ScopeParams = { group?: string; podGroup?: string; node?: string };

function scopeParams(scope: MetricScope): ScopeParams {
  return {
    group: scope.kind === 'group' ? scope.group : undefined,
    podGroup: scope.kind === 'pod' ? scope.group : undefined,
    node: scope.kind === 'node' ? scope.node : undefined,
  };
}

const TYPE_LABELS: Record<Exclude<MetricKind, 'unknown'>, string> = {
  counter: 'counter',
  gauge: 'gauge',
  histogram: 'histogram',
  stat_value: 'stat value',
};

/** The text shown after a metric name; undefined means the type has not come back yet. */
function metricTypeBadge(type: MetricKind | undefined): { text: string; title: string } {
  if (type === undefined) {
    return { text: '…', title: 'Inferring the metric type from the last hour of data' };
  }
  if (type === 'unknown') {
    return { text: '–', title: 'No data in the last hour to infer the metric type from' };
  }
  return { text: TYPE_LABELS[type] ?? type, title: `Metric type: ${TYPE_LABELS[type] ?? type}` };
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 0,
  }),
  header: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  headingRow: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  stepNumber: css({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    borderRadius: '50%',
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightBold,
  }),
  title: css({
    margin: 0,
    flexShrink: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
  }),
  scopeSource: css({
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  scopeSourceValue: css({
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  searchInput: css({
    width: '100%',
  }),
  searchError: css({
    marginTop: theme.spacing(-0.5),
    color: theme.colors.error.text,
    fontSize: theme.typography.size.xs,
    overflowWrap: 'anywhere',
  }),
  importantMetricsLink: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minHeight: 44,
    padding: theme.spacing(1, 1.5),
    border: `1px solid ${theme.colors.primary.main}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.primary.main,
    color: theme.colors.primary.contrastText,
    fontSize: theme.typography.body.fontSize,
    fontWeight: theme.typography.fontWeightBold,
    cursor: 'pointer',
    textDecoration: 'none',
    transition: 'background-color 150ms ease, border-color 150ms ease',
    '&:hover': {
      background: theme.colors.primary.shade,
      borderColor: theme.colors.primary.shade,
      color: theme.colors.primary.contrastText,
      textDecoration: 'none',
    },
    '&:focus-visible': {
      outline: `2px solid ${theme.colors.primary.text}`,
      outlineOffset: 2,
    },
    '&:active': {
      transform: 'translateY(1px)',
    },
    '&[aria-current="page"]': {
      boxShadow: `inset 0 0 0 1px ${theme.colors.primary.contrastText}`,
    },
  }),
  importantMetricsArrow: css({
    marginLeft: 'auto',
    flexShrink: 0,
  }),
  scopeLabel: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  listContainer: css({
    flex: 1,
    overflowY: 'auto',
    minHeight: 0,
  }),
  loading: css({
    display: 'flex',
    justifyContent: 'center',
    padding: theme.spacing(2),
  }),
  loadingMore: css({
    padding: theme.spacing(1),
  }),
  empty: css({
    padding: theme.spacing(2),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.sm,
    textAlign: 'center',
  }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
  }),
  metricItem: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: theme.spacing(0.75, 1),
    border: 0,
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    textAlign: 'left',
    gap: theme.spacing(1),
    '&:hover': {
      background: theme.colors.action.hover,
    },
    // A metric that is always 0. Scoped to this class rather than a separate color-only class:
    // emotion shares a class between identical styles, so a bare color rule may be inserted before
    // this one and lose to it.
    '&[data-zero-value]': {
      color: theme.colors.text.disabled,
    },
  }),
  metricItemSelected: css({
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    boxShadow: `inset 3px 0 0 ${theme.colors.primary.main}`,
    '&:hover': {
      background: theme.colors.primary.transparent,
    },
  }),
  metricName: css({
    fontSize: theme.typography.size.sm,
    fontFamily: theme.typography.fontFamilyMonospace,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  }),
  metricType: css({
    fontSize: theme.typography.size.xs,
    opacity: 0.7,
    flexShrink: 0,
  }),
  footer: css({
    display: 'flex',
    justifyContent: 'space-between',
    padding: theme.spacing(0.5, 1),
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
    borderTop: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  typeFilters: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0, 1, 1),
    flexShrink: 0,
  }),
});
