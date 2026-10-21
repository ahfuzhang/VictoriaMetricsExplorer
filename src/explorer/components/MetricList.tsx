import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GrafanaTheme2, TimeRange } from '@grafana/data';
import { Alert, Button, Input, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { Capabilities, MetricInfo, MetricKind } from '../model';
import { fetchMetricIndex, fetchMetricTypes, describeError } from '../api';
import type { MetricScope } from './Explorer';

// One request per page of names; the backend caps a request at 500, favorites can exceed a page.
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
  favoriteMetrics: string[];
  timeRange: TimeRange;
  refreshKey: number;
  onSelectMetric: (metric: string) => void;
}

export const MetricList: React.FC<Props> = ({
  datasourceUID,
  capabilities,
  selectedMetric,
  scope,
  favoriteMetrics,
  timeRange,
  refreshKey,
  onSelectMetric,
}) => {
  const styles = useStyles2(getStyles);

  const [search, setSearch] = useState('');
  const [metrics, setMetrics] = useState<MetricInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
    // Histograms already carry their type from the index, but are still asked about so the backend
    // can report the ones without observations.
    const missing = metrics.map((metric) => metric.queryMetric).filter((name) => !typesRequestedRef.current.has(name));
    if (missing.length === 0) {
      return;
    }
    missing.forEach((name) => typesRequestedRef.current.add(name));

    const generation = typeGenerationRef.current;
    for (let offset = 0; offset < missing.length; offset += TYPE_REQUEST_SIZE) {
      const batch = missing.slice(offset, offset + TYPE_REQUEST_SIZE);
      fetchMetricTypes(datasourceUID, { metrics: batch, startMs, endMs })
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
      try {
        const response = await fetchMetricIndex(datasourceUID, {
          search,
          groupMode: 'prefix',
          group: scope.kind === 'group' ? scope.group : undefined,
          podGroup: scope.kind === 'pod' ? scope.group : undefined,
          node: scope.kind === 'node' ? scope.node : undefined,
          metrics: scope.kind === 'favorites' ? favoriteMetrics : undefined,
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
        if (request === requestRef.current) {
          console.error('Failed to load metrics', err);
          setError(describeError(err));
        }
      } finally {
        if (request === requestRef.current) {
          setLoading(false);
        }
      }
    },
    [datasourceUID, favoriteMetrics, pageSize, scope, search, timeRange]
  );

  useEffect(() => {
    requestRef.current += 1;
    setMetrics([]);
    setPage(1);

    if (scope.kind === 'favorites' && favoriteMetrics.length === 0) {
      metricsOwnerRef.current = datasourceUID;
      setTotalCount(0);
      setTotalPages(1);
      setTruncated(false);
      setLoading(false);
      setError('');
      return;
    }

    const timer = window.setTimeout(() => loadMetrics(1, false), 300);
    return () => window.clearTimeout(timer);
  }, [datasourceUID, favoriteMetrics, loadMetrics, refreshKey, scope.kind, search]);

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

  const metricType = (metric: MetricInfo) => metric.type ?? types[metric.queryMetric];
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
          : scope.kind === 'favorites'
            ? 'Favorites'
            : 'All metrics';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headingRow}>
          <span className={styles.stepNumber}>02</span>
          <h2 className={styles.title}>Metric names</h2>
        </div>
        <Input
          aria-label="Search metric names"
          placeholder="Search metrics…"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          prefix={<span aria-hidden="true">⌕</span>}
          className={styles.searchInput}
        />
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
          !error && (
            <div className={styles.empty}>
              {scope.kind === 'favorites' ? 'No favorite metrics match this search.' : 'No metrics found.'}
            </div>
          )
        ) : visibleMetrics.length === 0 && !loading && !typesPending ? (
          <div className={styles.empty}>No metrics of this type.</div>
        ) : (
          <ul className={styles.list}>
            {visibleMetrics.map((metric) => {
              const type = metricType(metric);
              const badge = metricTypeBadge(type);
              // A metric that is always 0 (a stat value or an idle counter) carries no information; it
              // stays listed but greyed out.
              const zeroValue = zeroValues[metric.queryMetric] === true;
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
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
  }),
  searchInput: css({
    width: '100%',
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
