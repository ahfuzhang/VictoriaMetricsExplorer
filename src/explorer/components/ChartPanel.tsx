import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DataFrame,
  DisplayValue,
  Field,
  FieldColorModeId,
  FieldType,
  GrafanaTheme2,
  TimeRange,
  dateTimeFormat,
  getDisplayProcessor,
  getFieldDisplayName,
  getFieldSeriesColor,
  colorManipulator,
} from '@grafana/data';
import {
  Alert,
  BigValue,
  BigValueColorMode,
  BigValueGraphMode,
  BigValueJustifyMode,
  BigValueTextMode,
  Button,
  ClipboardButton,
  GraphGradientMode,
  LinkButton,
  LegendDisplayMode,
  LoadingPlaceholder,
  PointVisibility,
  RadioButtonGroup,
  SeriesTable,
  TimeSeries,
  TooltipPlugin2,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { css } from '@emotion/css';

import { ChartPlan, HistogramTable, StatTable } from '../model';
import { fetchChartPlan, queryChartData, describeError } from '../api';
import {
  BYTE_UNITS,
  DURATION_UNITS,
  bucketFormatter,
  formatScaledBound,
  grafanaUnit,
  isBytesMetric,
  planUnitToUnitId,
  scaleValue,
  splitRateUnit,
} from '../favorites/units';
import { HISTOGRAM_RATE_MODE_OPTIONS, RATE_MODE_OPTIONS, type RateMode } from '../favorites/rateMode';
import { MAX_DRAWN_SERIES } from '../favorites/limits';
import { Centered, HeatmapView, MultiSeriesChart, exploreUrl, formatCount, useElementSize } from './chartParts';
import type { SelectedFilters } from './Explorer';

interface Props {
  datasourceUID: string;
  metric: string;
  filters: SelectedFilters;
  podGroup?: string;
  node?: string;
  timeRange: TimeRange;
  step: string;
  refreshKey: number;
  /** Labels a counter or gauge curve is summed by, one curve per value combination. */
  groupBy: string[];
  /** The labels the current filters leave more than one value of; groupBy picks among them. */
  groupByOptions: string[];
  /** groupByOptions are still those of the previous filters: a grouped chart waits for the new ones. */
  groupByPending: boolean;
  onGroupByChange: (labels: string[]) => void;
  /** Open the save dialog with the plan of the chart currently shown. */
  onFavorite: (snapshot: ChartSnapshot) => void;
  /** Why saving to favorites is impossible here; the button is disabled with this as its tooltip. */
  favoriteBlocked?: string | null;
}

/** The chart a Favorite click saves: the plan of the request currently on screen. */
export interface ChartSnapshot {
  datasourceUID: string;
  metric: string;
  plan: ChartPlan;
}

type VisualizationKind = 'timeseries' | 'heatmap' | 'stat';

// The backend reports the counter function it used as the plan aggregation (sum_rate,
// sum_increase, sum_irate); a heatmap's is sum_by_le_rate or sum_by_le_increase.
function rateModeFromAggregation(aggregation: string | undefined): RateMode | undefined {
  return RATE_MODE_OPTIONS.find((option) => aggregation === `sum_${option.value}`)?.value;
}

function histogramRateModeFromAggregation(aggregation: string | undefined): RateMode {
  return aggregation === 'sum_by_le_increase' ? 'increase' : 'rate';
}

interface ChartResult {
  requestKey: string;
  plan: ChartPlan | null;
  sum: number | null;
  histogramTable: HistogramTable | null;
  statTable: StatTable | null;
  frames: DataFrame[];
  error: string;
  stage: 'plan' | 'data' | 'done';
}

export const ChartPanel: React.FC<Props> = ({
  datasourceUID,
  metric,
  filters,
  podGroup,
  node,
  timeRange,
  step,
  refreshKey,
  groupBy,
  groupByOptions,
  groupByPending,
  onGroupByChange,
  onFavorite,
  favoriteBlocked,
}) => {
  const styles = useStyles2(getStyles);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);
  const groupKey = groupBy.join(',');
  const startMs = timeRange.from.valueOf();
  const endMs = timeRange.to.valueOf();
  // A rate mode picked in the footer applies to the metric it was picked for; another metric starts
  // with the backend's automatic choice again.
  const [rateModeChoice, setRateModeChoice] = useState<{ metric: string; mode: RateMode } | null>(null);
  const rateMode = rateModeChoice?.metric === metric ? rateModeChoice.mode : undefined;
  const requestKey = `${datasourceUID}:${metric}:${podGroup ?? ''}:${node ?? ''}:${filterKey}:${startMs}:${endMs}:${step}:${rateMode ?? ''}:${groupKey}:${refreshKey}`;
  const [result, setResult] = useState<ChartResult>({
    requestKey: '',
    plan: null,
    sum: null,
    histogramTable: null,
    statTable: null,
    frames: [],
    error: '',
    stage: 'plan',
  });
  const generationRef = useRef(0);
  const currentResult = result.requestKey === requestKey ? result : null;
  const plan = currentResult?.plan ?? null;
  const serverSum = currentResult?.sum ?? null;
  const histogramTable = currentResult?.histogramTable ?? null;
  const statTable = currentResult?.statTable ?? null;
  const frameData = currentResult?.frames ?? [];
  const queryError = currentResult?.error ?? '';
  const loadingPlan = !currentResult || currentResult.stage === 'plan';
  const loadingData = currentResult?.stage === 'data';

  useEffect(() => {
    if (groupByPending) {
      return;
    }
    const generation = ++generationRef.current;
    let nextPlan: ChartPlan | null = null;

    const load = async () => {
      try {
        const response = await fetchChartPlan(datasourceUID, {
          metric,
          filters,
          podGroup,
          node,
          startMs,
          endMs,
          step,
          rateMode,
          groupBy,
        });
        if (generation !== generationRef.current) {
          return;
        }
        nextPlan = response.plan;
        const nextSum = response.summary && Number.isFinite(response.summary.sum) ? response.summary.sum : null;
        const nextTable = response.histogramTable ?? null;
        const nextStatTable = response.statTable ?? null;
        setResult({
          requestKey,
          plan: nextPlan,
          sum: nextSum,
          histogramTable: nextTable,
          statTable: nextStatTable,
          frames: [],
          error: '',
          stage: 'data',
        });

        const frames = await queryChartData(datasourceUID, {
          expr: nextPlan.query,
          step: nextPlan.step,
          range: timeRange,
        });
        if (generation === generationRef.current) {
          setResult({
            requestKey,
            plan: nextPlan,
            sum: nextSum,
            histogramTable: nextTable,
            statTable: nextStatTable,
            frames,
            error: '',
            stage: 'done',
          });
        }
      } catch (err: unknown) {
        if (generation === generationRef.current) {
          setResult({
            requestKey,
            plan: nextPlan,
            sum: null,
            histogramTable: null,
            statTable: null,
            frames: [],
            error: describeError(err),
            stage: 'done',
          });
        }
      }
    };

    void load();
    return () => {
      generationRef.current += 1;
    };
    // filterKey and groupKey are the stable, serializable dependencies for the filter map and the
    // group-by labels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    datasourceUID,
    endMs,
    filterKey,
    groupByPending,
    groupKey,
    metric,
    node,
    podGroup,
    rateMode,
    refreshKey,
    requestKey,
    startMs,
    step,
    timeRange,
  ]);

  const visualization = visualizationKind(plan?.visualization);
  const activeRateMode = visualization === 'timeseries' ? rateModeFromAggregation(plan?.aggregation) : undefined;
  const selectedFilterCount = Object.values(filters).reduce((count, values) => count + values.length, 0);
  const planGroupBy = plan?.groupBy ?? [];
  // The labels stay on screen while a new chart loads: the last plan of this metric decides.
  const lastPlan = plan ?? (result.plan?.metric === metric ? result.plan : null);
  const groupable =
    lastPlan !== null &&
    visualizationKind(lastPlan.visualization) === 'timeseries' &&
    (lastPlan.metricType === 'counter' || lastPlan.metricType === 'gauge');
  const toggleGroupBy = (label: string) =>
    onGroupByChange(groupBy.includes(label) ? groupBy.filter((picked) => picked !== label) : [...groupBy, label]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.stepNumber}>04</span>
          <div className={styles.metricHeading}>
            <h2 className={styles.title}>{metric}</h2>
            <div className={styles.badges}>
              {plan && <span className={styles.typeBadge}>{plan.metricType}</span>}
              {plan && <span className={styles.vizBadge}>{visualization}</span>}
              {plan?.unit && <span className={styles.unitBadge}>{plan.unit}</span>}
              {selectedFilterCount > 0 && (
                <span className={styles.filterBadge}>{selectedFilterCount} filter values</span>
              )}
            </div>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon="star"
          aria-label="Save this chart to favorites"
          // Only once the plan of the current request is known: that is the query a favorite saves.
          // A failed data query can still be saved.
          disabled={!plan || !!favoriteBlocked}
          tooltip={favoriteBlocked ?? (plan ? undefined : 'Available once the chart query is ready')}
          onClick={() => plan && onFavorite({ datasourceUID, metric, plan })}
        >
          Favorite
        </Button>
      </div>

      {plan && (
        <div className={styles.queryBar} title={plan.query}>
          <ClipboardButton
            size="sm"
            variant="secondary"
            icon="copy"
            aria-label="Copy PromQL expression"
            getText={() => plan.query}
          >
            Copy
          </ClipboardButton>
          <code className={styles.queryCode}>{plan.query}</code>
          <span className={styles.stepBadge}>step {plan.step}</span>
          <LinkButton
            size="sm"
            variant="secondary"
            icon="compass"
            href={exploreUrl(datasourceUID, plan.query, plan.step, timeRange)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open PromQL expression in Grafana Explore"
          >
            Explore
          </LinkButton>
        </div>
      )}

      {plan?.warnings && plan.warnings.length > 0 && (
        <Alert title="Query warnings" severity="warning">
          {plan.warnings.join(', ')}
        </Alert>
      )}

      <div className={styles.chartArea}>
        {loadingPlan && !plan ? (
          <Centered>
            <LoadingPlaceholder text="Preparing visualization…" />
          </Centered>
        ) : queryError ? (
          <Alert title="Query failed" severity="error">
            {queryError}
          </Alert>
        ) : loadingData && frameData.length === 0 ? (
          <Centered>
            <LoadingPlaceholder text="Loading data…" />
          </Centered>
        ) : frameData.length === 0 ? (
          <Centered>
            <span className={styles.noData}>No data for this metric and time range.</span>
          </Centered>
        ) : (
          <Visualization
            kind={visualization}
            frames={frameData}
            timeRange={timeRange}
            metric={metric}
            unit={plan?.unit ?? ''}
            serverSum={serverSum}
            heatmapRateUnit={histogramRateModeFromAggregation(plan?.aggregation) === 'increase' ? '/min' : '/s'}
            groupBy={planGroupBy}
          />
        )}
        {loadingData && frameData.length > 0 && <div className={styles.refreshing}>Refreshing…</div>}
      </div>

      {groupable && (
        <div className={styles.groupBy} role="group" aria-label="Sum by labels">
          <span className={styles.groupByTitle}>sum by</span>
          {groupByOptions.length === 0 ? (
            <span className={styles.groupByEmpty}>No label splits the matching series</span>
          ) : (
            groupByOptions.map((label) => {
              const picked = groupBy.includes(label);
              return (
                <button
                  key={label}
                  type="button"
                  className={`${styles.groupByLabel} ${picked ? styles.groupByLabelPicked : ''}`}
                  aria-pressed={picked}
                  title={picked ? `Stop splitting the curve by ${label}` : `One curve per ${label} value`}
                  onClick={() => toggleGroupBy(label)}
                >
                  {picked && <span className={styles.checkMark}>✓</span>}
                  {label}
                </button>
              );
            })
          )}
        </div>
      )}

      {visualization === 'heatmap' && plan && !queryError && (
        <div className={styles.histogramRateMode}>
          <RadioButtonGroup
            size="sm"
            options={HISTOGRAM_RATE_MODE_OPTIONS}
            value={histogramRateModeFromAggregation(plan.aggregation)}
            onChange={(mode) => setRateModeChoice({ metric, mode })}
          />
        </div>
      )}

      {visualization === 'heatmap' && histogramTable && !queryError && (
        <HistogramTableView table={histogramTable} metric={metric} />
      )}

      {visualization === 'stat' && statTable && !queryError && <StatTableView table={statTable} metric={metric} />}

      <div className={styles.footer}>
        <span>
          {visualization !== 'timeseries'
            ? `${frameData.length} data frame${frameData.length === 1 ? '' : 's'}`
            : planGroupBy.length > 0
              ? `${frameData.length} series · sum by (${planGroupBy.join(', ')})${
                  frameData.length > MAX_DRAWN_SERIES ? ` · first ${MAX_DRAWN_SERIES} drawn` : ''
                }`
              : '1 chart · aggregated series'}
        </span>
        {activeRateMode && (
          <RadioButtonGroup
            size="sm"
            options={RATE_MODE_OPTIONS}
            value={activeRateMode}
            onChange={(mode) => setRateModeChoice({ metric, mode })}
          />
        )}
      </div>
    </div>
  );
};

interface VisualizationProps {
  kind: VisualizationKind;
  frames: DataFrame[];
  timeRange: TimeRange;
  metric: string;
  unit: string;
  serverSum: number | null;
  /** Rate unit of the heatmap cells: /s for rate, /min for increase. */
  heatmapRateUnit: string;
  /** Labels a time series is summed by; with any, each returned series is its own curve. */
  groupBy: string[];
}

const Visualization: React.FC<VisualizationProps> = ({
  kind,
  frames,
  timeRange,
  metric,
  unit,
  serverSum,
  heatmapRateUnit,
  groupBy,
}) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const displayFrames = useMemo(
    () =>
      frames.map((frame) => ({
        ...frame,
        fields: frame.fields.map((field) => ({
          ...field,
          display: field.display ?? getDisplayProcessor({ field, theme }),
        })),
      })),
    [frames, theme]
  );

  return (
    <div className={styles.visualization}>
      {kind === 'stat' ? (
        <StatView frames={displayFrames} metric={metric} unit={unit} />
      ) : kind === 'heatmap' ? (
        <HeatmapView frames={displayFrames} formatBucket={bucketFormatter(metric)} rateUnit={heatmapRateUnit} />
      ) : groupBy.length > 0 ? (
        // The legend under the plot names the label values of each curve's color.
        <MultiSeriesChart
          frames={displayFrames.slice(0, MAX_DRAWN_SERIES)}
          unitId={planUnitToUnitId(unit)}
          range={timeRange}
          unlabeledName={`{${groupBy.map((label) => `${label}=""`).join(',')}}`}
        />
      ) : (
        <LineChartView frames={displayFrames} timeRange={timeRange} unit={unit} serverSum={serverSum} />
      )}
    </div>
  );
};

interface LinePoint {
  time: number;
  value: number;
}

interface LineSeries {
  name: string;
  points: LinePoint[];
}

// The metric name already appears in the panel header. Keep the native legend hidden and render
// the requested min/max/avg/sum summary in a compact, stable block at the plot's lower-right edge.
// This must stay one stable object because TimeSeries rebuilds its plot config when its identity
// changes.
const LINE_LEGEND = {
  showLegend: false,
  displayMode: LegendDisplayMode.Hidden,
  placement: 'bottom' as const,
  calcs: [],
};

// TooltipHoverMode.xAll: the tooltip follows the cursor along x wherever it is vertically, like the
// time series panel's "All" tooltip mode (xOne only shows it while the cursor is close to the
// line). The enum is not part of @grafana/ui's public entry point, so its value is spelled out.
const TOOLTIP_HOVER_X_ALL = 1;

const LineChartView: React.FC<{
  frames: DataFrame[];
  timeRange: TimeRange;
  unit: string;
  serverSum: number | null;
}> = ({ frames, timeRange, unit, serverSum }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [setContainer, size] = useElementSize<HTMLDivElement>();
  // The backend query is aggregated to one series. Keep this guard so a datasource response can
  // never accidentally turn the fourth column into several overlapping charts/curves.
  const frame = useMemo(() => plotFrame(lineSeries(frames).slice(0, 1), unit, theme), [frames, theme, unit]);
  const stats = useMemo(() => (frame ? seriesStats(frame) : null), [frame]);

  if (!frame) {
    return <Centered>No plottable time series were returned.</Centered>;
  }

  return (
    <div className={styles.lineChart}>
      <div ref={setContainer} className={styles.lineChartPlot}>
        {size.width > 0 && size.height > 0 && (
          <TimeSeries
            frames={[frame]}
            timeRange={timeRange}
            timeZone="browser"
            width={size.width}
            height={size.height}
            legend={LINE_LEGEND}
          >
            {(config, alignedFrame) => (
              <TooltipPlugin2
                config={config}
                hoverMode={TOOLTIP_HOVER_X_ALL}
                maxWidth={520}
                render={(_u, dataIdxs) => {
                  // Index 0 is the x axis, so the single plotted series is index 1.
                  const dataIdx = dataIdxs[1];
                  const [timeField, valueField] = alignedFrame.fields;
                  if (dataIdx == null || !timeField || !valueField) {
                    return null;
                  }
                  const value = Number(valueField.values[dataIdx]);
                  if (!Number.isFinite(value)) {
                    return null;
                  }
                  return (
                    <div className={styles.tooltip}>
                      <SeriesTable
                        timestamp={dateTimeFormat(Number(timeField.values[dataIdx]), { timeZone: 'browser' })}
                        series={[
                          {
                            color: getFieldSeriesColor(valueField, theme).color,
                            label: getFieldDisplayName(valueField, alignedFrame),
                            // Keep "19.2 °C" on one line when the series name is long.
                            value: formatFieldValue(valueField, value).replace(/ /g, '\u00a0'),
                            isActive: true,
                          },
                        ]}
                      />
                    </div>
                  );
                }}
              />
            )}
          </TimeSeries>
        )}
      </div>
      {stats && (
        <div className={styles.lineStats} aria-label="Series statistics">
          <ChartStat label="min" value={stats.min} styles={styles} />
          <ChartStat label="max" value={stats.max} styles={styles} />
          <ChartStat label="avg" value={stats.avg} styles={styles} />
          {serverSum !== null && <ChartStat label="sum" value={serverSum} styles={styles} />}
        </div>
      )}
    </div>
  );
};

interface SeriesStats {
  min: number;
  max: number;
  avg: number;
}

function seriesStats(frame: DataFrame): SeriesStats | null {
  const field = frame.fields.find((candidate) => candidate.type === FieldType.number);
  if (!field) {
    return null;
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let totalForAverage = 0;
  let count = 0;
  for (let index = 0; index < field.values.length; index++) {
    const value = Number(field.values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    totalForAverage += value;
    count += 1;
  }

  return count > 0 ? { min, max, avg: totalForAverage / count } : null;
}

// The summary shows raw numbers with no unit. field.display would rescale the value (0.5 s ->
// "500 ms"), so dropping only its suffix would leave a misleading number.
const ChartStat: React.FC<{
  label: 'min' | 'max' | 'avg' | 'sum';
  value: number;
  styles: ReturnType<typeof getStyles>;
}> = ({ label, value, styles }) => (
  <div className={styles.lineStat}>
    <span>{label}</span>
    <strong>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)}</strong>
  </div>
);

/** Turn the one plotted series into a DataFrame TimeSeries can draw, or null when there is none. */
function plotFrame(series: LineSeries[], unit: string, theme: GrafanaTheme2): DataFrame | null {
  const [first] = series;
  if (!first) {
    return null;
  }
  const timeField: Field = {
    name: 'Time',
    type: FieldType.time,
    config: {},
    values: first.points.map((point) => point.time),
  };
  const { base, rate } = splitRateUnit(unit);
  const valueField: Field = {
    name: first.name,
    type: FieldType.number,
    config: {
      displayName: first.name,
      unit: grafanaUnit(base),
      color: { mode: FieldColorModeId.Fixed, fixedColor: theme.colors.primary.main },
      custom: {
        lineWidth: 2,
        fillOpacity: 10,
        gradientMode: GraphGradientMode.Opacity,
        showPoints: PointVisibility.Auto,
        // Also sizes the dot that follows the cursor along the line.
        pointSize: 5,
      },
    },
    values: first.points.map((point) => point.value),
  };
  const display = getDisplayProcessor({ field: valueField, theme });
  // The axis and the tooltip both format through field.display, so the rate suffix shows in both.
  valueField.display = !rate
    ? display
    : base === 's'
      ? (value, decimals) => {
          // Grafana's "s" unit scales up to minutes and hours; seconds only scale down to ms, us, ns.
          const formatted = display(value, decimals);
          const [text, unit] = scaleValue(Number(value), DURATION_UNITS);
          return { ...formatted, text, suffix: ` ${unit}${rate}` };
        }
      : (value, decimals) => {
          const formatted = display(value, decimals);
          return { ...formatted, suffix: `${formatted.suffix ?? ''}${rate}` };
        };
  return { name: first.name, fields: [timeField, valueField], length: first.points.length };
}

const StatView: React.FC<{ frames: DataFrame[]; metric: string; unit: string }> = ({ frames, metric, unit }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [setValueContainer, valueSize] = useElementSize<HTMLDivElement>();
  const stat = lastNumericValue(frames);

  if (!stat) {
    return <Centered>No numeric value is available.</Centered>;
  }

  const display = stat.field.display?.(stat.value);
  const prefix = display?.prefix ?? '';
  let value = display?.text ?? new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(stat.value);
  let suffix = display?.suffix || unit;
  if (isBytesMetric(metric)) {
    [value, suffix] = scaleValue(stat.value, BYTE_UNITS);
    suffix = ` ${suffix}`;
  }
  const name = stat.field.config.displayName || stat.field.name || metric;
  const accessibleValue = [prefix, value, suffix].filter(Boolean).join(' ');
  const bigValue: DisplayValue = {
    numeric: stat.value,
    text: value,
    prefix,
    suffix,
    color: display?.color ?? theme.colors.text.primary,
    title: name,
  };

  return (
    <div className={styles.statView} role="figure" aria-label={`${name}: ${accessibleValue}`}>
      <div className={styles.statCard}>
        <div ref={setValueContainer} className={styles.statBigValue}>
          {valueSize.width > 0 && valueSize.height > 0 && (
            <BigValue
              theme={theme}
              width={valueSize.width}
              height={valueSize.height}
              value={bigValue}
              colorMode={BigValueColorMode.Value}
              graphMode={BigValueGraphMode.None}
              justifyMode={BigValueJustifyMode.Center}
              textMode={BigValueTextMode.Value}
            />
          )}
        </div>
        <div className={styles.statMeta}>
          <div className={styles.statName}>{name}</div>
          {stat.field.labels && (
            <div className={styles.statLabels}>
              {Object.entries(stat.field.labels)
                .map(([labelName, labelValue]) => `${labelName}=${labelValue}`)
                .join(' · ')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Percentages keep two decimals.
const formatPercent = (value: number) => `${value.toFixed(2)}%`;

type Percentile = 'p50' | 'p90' | 'p95' | 'p99';

const PERCENTILES: Array<{ name: Percentile; threshold: number }> = [
  { name: 'p50', threshold: 50 },
  { name: 'p90', threshold: 90 },
  { name: 'p95', threshold: 95 },
  { name: 'p99', threshold: 99 },
];

// percentileMarks maps a row index to the percentiles that fall in that bucket: the first row whose
// cumulative percent reaches each threshold. One bucket can hold several percentiles.
function percentileMarks(rows: HistogramTable['rows']): Map<number, Percentile[]> {
  const marks = new Map<number, Percentile[]>();
  for (const { name, threshold } of PERCENTILES) {
    // A small tolerance keeps float sums such as 98.99999999 from missing a threshold.
    const index = rows.findIndex((row) => row.cumulativePercent >= threshold - 1e-9);
    if (index >= 0) {
      marks.set(index, [...(marks.get(index) ?? []), name]);
    }
  }
  return marks;
}

const StatTableView: React.FC<{ table: StatTable; metric: string }> = ({ table, metric }) => {
  const styles = useStyles2(getStyles);
  const formatValue = isBytesMetric(metric)
    ? (value: string) => formatScaledBound(value, BYTE_UNITS)
    : (value: string) => value;

  return (
    <div className={styles.dataTable}>
      <table aria-label="Distinct values">
        <thead>
          <tr>
            <th>Value</th>
            <th data-wrap>Labels</th>
            <th>Series</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => {
            const labels = Object.entries(row.labels).sort(([left], [right]) => left.localeCompare(right));
            return (
              <tr key={row.noData ? 'no-data' : row.value}>
                <td>
                  {row.noData ? (
                    <span className={styles.statNoData} title="Listed for this time range, but no sample falls in it">
                      no samples in range
                    </span>
                  ) : (
                    <span title={row.value}>{formatValue(row.value)}</span>
                  )}
                </td>
                <td data-wrap>
                  {labels.length === 0
                    ? '—'
                    : labels.map(([name, value]) => (
                        <span key={name} className={styles.statLabel}>
                          {name}=&quot;{value}&quot;
                        </span>
                      ))}
                </td>
                <td>{row.seriesCount}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>{table.truncated ? `First ${table.rows.length} values` : `${table.rows.length} values`}</td>
            <td />
            <td>{table.seriesTotal}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

const HistogramTableView: React.FC<{ table: HistogramTable; metric: string }> = ({ table, metric }) => {
  const styles = useStyles2(getStyles);
  const base = metric.replace(/_bucket$/, '');
  const formatBucket = bucketFormatter(metric);
  const marks = percentileMarks(table.rows);

  return (
    <div className={styles.dataTable}>
      {table.rows.length === 0 && <p className={styles.histogramEmpty}>No observations in this time range.</p>}
      <table aria-label={`Histogram buckets over ${table.window}`}>
        <thead>
          <tr>
            <th>Range</th>
            <th>Count</th>
            <th>Percent</th>
            <th>Cumulative</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => {
            const percentiles = marks.get(index) ?? [];
            // A bucket holding several percentiles takes the color of the highest one.
            const highest = percentiles[percentiles.length - 1];
            return (
              <tr key={`${row.from}-${row.to}`} className={highest ? styles.percentileRow[highest] : undefined}>
                <td>
                  {formatBucket(row.from)} - {formatBucket(row.to)}
                </td>
                <td>{formatCount(row.count)}</td>
                <td>{formatPercent(row.percent)}</td>
                <td>
                  {percentiles.map((name) => (
                    <span key={name} className={styles.percentileTag}>
                      {name}
                    </span>
                  ))}
                  {formatPercent(row.cumulativePercent)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>{base}_count</td>
            <td colSpan={3}>{table.count === null ? '—' : formatCount(table.count)}</td>
          </tr>
          <tr>
            <td>{base}_sum</td>
            <td colSpan={3}>{table.sum === null ? '—' : formatCount(table.sum)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
};

function visualizationKind(value?: string): VisualizationKind {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.includes('heatmap')) {
    return 'heatmap';
  }
  if (normalized.includes('stat')) {
    return 'stat';
  }
  return 'timeseries';
}

function lastNumericValue(frames: DataFrame[]): { field: Field; value: number } | null {
  for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex--) {
    const numericFields = frames[frameIndex].fields.filter((field) => field.type === FieldType.number);
    for (let fieldIndex = numericFields.length - 1; fieldIndex >= 0; fieldIndex--) {
      const field = numericFields[fieldIndex];
      for (let valueIndex = field.values.length - 1; valueIndex >= 0; valueIndex--) {
        const value = Number(field.values[valueIndex]);
        if (Number.isFinite(value)) {
          return { field, value };
        }
      }
    }
  }
  return null;
}

function formatFieldValue(field: Field, value: number): string {
  const display = field.display?.(value);
  if (display) {
    return `${display.prefix ?? ''}${display.text}${display.suffix ?? ''}`;
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

function lineSeries(frames: DataFrame[]): LineSeries[] {
  const result: LineSeries[] = [];
  for (const frame of frames) {
    const timeField = frame.fields.find((field) => field.type === FieldType.time);
    if (!timeField) {
      continue;
    }
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const points: LinePoint[] = [];
      const length = Math.min(timeField.values.length, field.values.length);
      for (let index = 0; index < length; index++) {
        const time = Number(timeField.values[index]);
        const value = Number(field.values[index]);
        if (Number.isFinite(time) && Number.isFinite(value)) {
          points.push({ time, value });
        }
      }
      if (points.length > 0) {
        const labels = field.labels
          ? `{${Object.entries(field.labels)
              .map(([name, value]) => `${name}="${value}"`)
              .join(',')}}`
          : '';
        result.push({ name: frame.name || `${field.name}${labels}`, points });
      }
    }
  }
  return result;
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    display: 'flex',
    flexDirection: 'column',
    height: 'auto',
    minHeight: 0,
  }),
  header: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: theme.spacing(1),
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
    gap: theme.spacing(1),
  }),
  headerLeft: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minWidth: 0,
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
    flexShrink: 0,
  }),
  metricHeading: css({
    minWidth: 0,
  }),
  title: css({
    margin: 0,
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightBold,
    fontFamily: theme.typography.fontFamilyMonospace,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  badges: css({
    display: 'flex',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(0.5),
  }),
  typeBadge: css({
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
  }),
  vizBadge: css({
    fontSize: theme.typography.size.xs,
    color: theme.colors.success.text,
  }),
  unitBadge: css({
    padding: theme.spacing(0, 0.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.info.transparent,
    color: theme.colors.info.text,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  filterBadge: css({
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
  }),
  queryBar: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.75, 1),
    background: theme.colors.background.secondary,
    borderBottom: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  queryCode: css({
    flex: 1,
    minWidth: 0,
    fontSize: theme.typography.size.xs,
    fontFamily: theme.typography.fontFamilyMonospace,
    color: theme.colors.text.primary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  stepBadge: css({
    fontSize: theme.typography.size.xs,
    color: theme.colors.text.secondary,
    flexShrink: 0,
  }),
  chartArea: css({
    position: 'relative',
    flex: '0 0 auto',
    height: 'clamp(320px, 48vh, 500px)',
    minHeight: '320px',
    overflow: 'hidden',
    padding: theme.spacing(1),
  }),
  visualization: css({
    width: '100%',
    height: '100%',
    minHeight: 0,
  }),
  noData: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.sm,
  }),
  refreshing: css({
    position: 'absolute',
    top: theme.spacing(1),
    right: theme.spacing(1),
    padding: theme.spacing(0.25, 0.75),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  groupBy: css({
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.75, 1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  groupByTitle: css({
    marginRight: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
  }),
  groupByEmpty: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  // Styled like the label value buttons of the label column.
  groupByLabel: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.25, 0.75),
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    color: theme.colors.text.primary,
    cursor: 'pointer',
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.35,
    '&:hover': {
      borderColor: theme.colors.primary.border,
      background: theme.colors.action.hover,
    },
  }),
  groupByLabelPicked: css({
    borderColor: theme.colors.primary.border,
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    '&:hover': {
      background: theme.colors.primary.transparent,
    },
  }),
  checkMark: css({
    fontFamily: theme.typography.fontFamily,
    fontSize: '10px',
  }),
  footer: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    flexShrink: 0,
  }),
  statView: css({
    width: '100%',
    height: '100%',
    minHeight: '280px',
  }),
  statCard: css({
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '280px',
    padding: theme.spacing(3),
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    overflow: 'hidden',
    textAlign: 'center',
  }),
  statBigValue: css({
    position: 'absolute',
    top: theme.spacing(1),
    right: theme.spacing(1),
    bottom: theme.spacing(7),
    left: theme.spacing(1),
    minHeight: 0,
  }),
  lineChart: css({
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minHeight: '280px',
  }),
  lineChartPlot: css({
    flex: 1,
    width: '100%',
    minHeight: '220px',
  }),
  lineStats: css({
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.spacing(2),
    minHeight: '40px',
    padding: theme.spacing(0.75, 1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    flexShrink: 0,
  }),
  lineStat: css({
    display: 'flex',
    alignItems: 'baseline',
    gap: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    '& span': {
      textTransform: 'uppercase',
    },
    '& strong': {
      color: theme.colors.text.primary,
      fontFamily: theme.typography.fontFamilyMonospace,
      fontWeight: theme.typography.fontWeightMedium,
    },
  }),
  tooltip: css({
    padding: theme.spacing(1),
    whiteSpace: 'normal',
  }),
  statMeta: css({
    position: 'absolute',
    right: theme.spacing(2),
    bottom: theme.spacing(2),
    left: theme.spacing(2),
  }),
  statName: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.sm,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  statLabels: css({
    marginTop: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    overflowWrap: 'anywhere',
  }),
  histogramRateMode: css({
    display: 'flex',
    justifyContent: 'flex-end',
    padding: theme.spacing(0, 1, 1),
  }),
  statNoData: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamily,
    fontStyle: 'italic',
  }),
  statLabel: css({
    display: 'inline-block',
    marginRight: theme.spacing(1),
    fontFamily: theme.typography.fontFamilyMonospace,
  }),
  // Tables under a visualization: the histogram buckets and the distinct stat values.
  dataTable: css({
    padding: theme.spacing(0, 1, 1),
    overflowX: 'auto',
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: theme.typography.size.xs,
      fontVariantNumeric: 'tabular-nums',
    },
    'th, td': {
      padding: theme.spacing(0.375, 0.75),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'right',
      whiteSpace: 'nowrap',
    },
    'th:first-child, td:first-child': {
      textAlign: 'left',
      fontFamily: theme.typography.fontFamilyMonospace,
    },
    // A free-text column, e.g. the labels behind a stat value.
    '[data-wrap]': {
      textAlign: 'left',
      whiteSpace: 'normal',
    },
    th: {
      color: theme.colors.text.secondary,
      fontWeight: theme.typography.fontWeightMedium,
    },
    // Highlight the hovered bucket so its range lines up with its count and percentages.
    'tbody tr:hover td': {
      background: theme.colors.action.hover,
      color: theme.colors.text.primary,
    },
    tfoot: {
      color: theme.colors.text.secondary,
      td: {
        borderBottom: 0,
      },
      'tr:first-child td': {
        borderTop: `1px solid ${theme.colors.border.medium}`,
      },
    },
  }),
  // p50 → p99 run from cool to hot so the tail of the distribution stands out.
  percentileRow: {
    p50: percentileRowStyle(theme, 'blue'),
    p90: percentileRowStyle(theme, 'yellow'),
    p95: percentileRowStyle(theme, 'orange'),
    p99: percentileRowStyle(theme, 'red'),
  },
  percentileTag: css({
    marginRight: theme.spacing(0.75),
    padding: theme.spacing(0, 0.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  histogramEmpty: css({
    margin: theme.spacing(0.5, 0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
});

function percentileRowStyle(theme: GrafanaTheme2, color: string) {
  return css({
    td: {
      background: colorManipulator.alpha(theme.visualization.getColorByName(color), 0.22),
      color: theme.colors.text.primary,
    },
  });
}
