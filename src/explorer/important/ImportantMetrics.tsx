import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DataFrame,
  FieldType,
  GrafanaTheme2,
  LoadingState,
  TimeRange,
  getDisplayProcessor,
  formattedValueToString,
} from '@grafana/data';
import { PanelRenderer } from '@grafana/runtime';
import { Alert, Button, LoadingPlaceholder, useStyles2, useTheme2 } from '@grafana/ui';
import { css } from '@emotion/css';

import type { ConfiguredChart, ConfiguredChartsResponse } from '../../generated/explorer/metric_config_pb';
import { describeError, queryRange } from '../api';
import { Limiter, isAbortError } from '../favorites/queryExecution';
import { useElementSize } from '../components/chartParts';
import { fetchConfiguredCharts } from './api';
import { panelConfig, queryFrames } from './panels';

interface Props {
  datasourceUID: string;
  podGroup: string;
  filters: Record<string, string[]>;
  timeRange: TimeRange;
  step: string;
  refreshKey: number;
  maxConcurrentRequests: number;
  onClearFilters: () => void;
}

export const ImportantMetrics: React.FC<Props> = (props) => {
  const styles = useStyles2(getStyles);
  const { datasourceUID, podGroup, timeRange, filters, refreshKey, maxConcurrentRequests } = props;
  const requestKey = JSON.stringify([
    datasourceUID,
    podGroup,
    timeRange.from.valueOf(),
    timeRange.to.valueOf(),
    filters,
    refreshKey,
    props.step,
  ]);
  const [loaded, setLoaded] = useState<{ key: string; response?: ConfiguredChartsResponse; error?: string }>();
  const limiter = useMemo(() => new Limiter(Math.max(1, maxConcurrentRequests || 1)), [maxConcurrentRequests]);
  useEffect(() => {
    const controller = new AbortController();
    fetchConfiguredCharts(datasourceUID, podGroup, timeRange, filters, controller.signal)
      .then((response) => {
        if (!controller.signal.aborted) {
          setLoaded({ key: requestKey, response });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoaded({ key: requestKey, error: describeError(error) });
        }
      });
    return () => controller.abort();
  }, [datasourceUID, filters, podGroup, requestKey, timeRange]);
  const response = loaded?.key === requestKey ? loaded.response : undefined;
  const error = loaded?.key === requestKey ? loaded.error : undefined;
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2>Important Metrics</h2>
        <span>{podGroup || 'All pods'}</span>
        {Object.entries(filters).map(([label, values]) => (
          <span key={label}>
            {label}={values.join(' | ')}
          </span>
        ))}
        {Object.keys(filters).length > 0 && (
          <Button variant="secondary" size="sm" onClick={props.onClearFilters}>
            Clear label filters
          </Button>
        )}
      </header>
      {error ? (
        <Alert severity="error" title="Failed to load Important Metrics">
          {error}
        </Alert>
      ) : !response ? (
        <LoadingPlaceholder text="Loading Important Metrics…" />
      ) : (
        <>
          {response.partial && (
            <Alert severity="warning" title="Metric discovery is incomplete">
              Some configured charts may be missing.
            </Alert>
          )}
          {!response.enabled ? (
            <p>No metric chart directory is configured.</p>
          ) : response.categories.length === 0 ? (
            <p>No configured charts match the metrics in this Pod scope and datasource.</p>
          ) : (
            response.categories.map((category) => (
              <section key={category.id} aria-label={category.title}>
                <h3>{category.title}</h3>
                {category.description && <p>{category.description}</p>}
                <div className={styles.grid}>
                  {category.charts.map((chart) => (
                    <ConfiguredPanel key={`${requestKey}:${chart.id}`} chart={chart} props={props} limiter={limiter} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  );
};

const ConfiguredPanel: React.FC<{ chart: ConfiguredChart; props: Props; limiter: Limiter }> = ({
  chart,
  props,
  limiter,
}) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [container, size] = useElementSize<HTMLDivElement>();
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState<{ frames: DataFrame[]; errors: string[]; truncated: boolean }>();
  const panel = useMemo(() => panelConfig(chart), [chart]);
  useEffect(() => {
    if (!element.current) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) {
      return;
    }
    const controller = new AbortController();
    const queries = chart.queries.filter((query) => !query.hidden);
    Promise.allSettled(
      queries.map((query) =>
        limiter.run(async () => {
          const result = await queryRange(props.datasourceUID, {
            expr: query.expr,
            instant: query.instant,
            range: props.timeRange,
            step: props.step,
            abortSignal: controller.signal,
          });
          return { ...result, frames: queryFrames(result.frames, query) };
        }, controller.signal)
      )
    ).then((results) => {
      if (controller.signal.aborted) {
        return;
      }
      const frames: DataFrame[] = [];
      const errors: string[] = [];
      let truncated = false;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          frames.push(...result.value.frames);
          truncated ||= result.value.meta.truncated;
        } else if (!isAbortError(result.reason)) {
          errors.push(`${queries[index].refId}: ${describeError(result.reason)}`);
        }
      });
      setResult({ frames, errors, truncated });
    });
    return () => controller.abort();
  }, [chart, limiter, props.datasourceUID, props.step, props.timeRange, visible]);

  let summary = '';
  if (chart.summary && result) {
    const ref = String(chart.summary.queryRef);
    const series = result.frames.filter((frame) => frame.refId === ref);
    if (series.length > 1) {
      summary = 'Summary requires one series';
    } else if (series.length === 1) {
      const field = series[0].fields.find((field) => field.type === FieldType.number);
      const value =
        field &&
        Array.from(field.values)
          .reverse()
          .find((value) => value != null && Number.isFinite(value));
      const query = chart.queries.find((query) => query.refId === ref);
      const axis = panel.axes?.[query?.axis || 'left'];
      if (field && value !== undefined) {
        summary = formattedValueToString(
          getDisplayProcessor({
            field: {
              ...field,
              config: {
                ...panel.fieldConfig.defaults,
                unit: axis?.unitId ?? panel.fieldConfig.defaults.unit,
                decimals: axis?.decimals,
              },
            },
            theme,
          })(value)
        );
      }
    }
  }
  return (
    <article
      ref={element}
      className={styles.card}
      style={{ gridColumn: `span ${panel.width || 24}` }}
      aria-label={chart.title}
    >
      <h4 title={chart.description}>{chart.title}</h4>
      {summary && <strong>{summary}</strong>}
      <div ref={container} style={{ height: panel.height || 300, minWidth: 0 }}>
        {!result ? (
          <LoadingPlaceholder text={visible ? 'Loading chart…' : 'Chart loads when visible'} />
        ) : (
          <>
            {result.errors.map((error) => (
              <Alert key={error} title="Query failed" severity="error">
                {error}
              </Alert>
            ))}
            {result.truncated && (
              <Alert title="Series limit reached" severity="warning">
                This chart shows a truncated result.
              </Alert>
            )}
            {result.frames.length === 0
              ? result.errors.length === 0 && <p>No data</p>
              : size.width > 0 && (
                  <PanelRenderer
                    pluginId={panel.pluginId}
                    title={chart.title}
                    width={size.width}
                    height={panel.height || 300}
                    options={panel.options}
                    fieldConfig={panel.fieldConfig}
                    timeZone="browser"
                    data={{ state: LoadingState.Done, series: result.frames, timeRange: props.timeRange }}
                  />
                )}
          </>
        )}
      </div>
    </article>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ overflow: 'auto', padding: theme.spacing(2), height: '100%', containerType: 'inline-size' }),
  header: css({
    display: 'flex',
    alignItems: 'baseline',
    gap: theme.spacing(2),
    flexWrap: 'wrap',
    marginBottom: theme.spacing(2),
  }),
  grid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(24, minmax(0, 1fr))',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(3),
    '@container (max-width: 700px)': { '> article': { gridColumn: '1 / -1 !important' } },
  }),
  card: css({
    minWidth: 0,
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    h4: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  }),
});
