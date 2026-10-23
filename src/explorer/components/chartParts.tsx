import React, { useEffect, useMemo, useState } from 'react';
import {
  DataFrame,
  Field,
  FieldColorModeId,
  FieldType,
  GrafanaTheme2,
  TimeRange,
  dateTimeFormat,
  formattedValueToString,
  getFieldDisplayName,
  getFieldSeriesColor,
} from '@grafana/data';
import { config, getDataSourceSrv } from '@grafana/runtime';
import {
  LegendDisplayMode,
  PointVisibility,
  SeriesTable,
  TimeSeries,
  TooltipPlugin2,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { css } from '@emotion/css';

import { unitDisplay } from '../favorites/units';

// Chart building blocks shared by the automatic chart (ChartPanel) and saved queries.

/** Track an element's content size; reports 0x0 until the element is mounted and measured. */
export function useElementSize<T extends HTMLElement>(): [
  (element: T | null) => void,
  { width: number; height: number },
] {
  const [element, setElement] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return [setElement, size];
}

// Grafana Explore URL with one pane holding the query on the same datasource, time range and step.
// Relative ranges such as now-6h are kept as-is so Explore can still refresh them.
export function exploreUrl(datasourceUID: string, expr: string, step: string, timeRange: TimeRange): string {
  const datasource = { type: getDataSourceSrv().getInstanceSettings(datasourceUID)?.type, uid: datasourceUID };
  const rangeValue = (raw: TimeRange['raw']['from']) => (typeof raw === 'string' ? raw : String(raw.valueOf()));
  const panes = {
    explorer: {
      datasource: datasourceUID,
      queries: [{ refId: 'A', datasource, expr, interval: step, range: true, instant: false }],
      range: { from: rangeValue(timeRange.raw.from), to: rangeValue(timeRange.raw.to) },
    },
  };
  const params = new URLSearchParams({
    schemaVersion: '1',
    panes: JSON.stringify(panes),
    orgId: String(config.bootData.user.orgId),
  });
  return `${config.appSubUrl}/explore?${params.toString()}`;
}

export const Centered: React.FC<React.PropsWithChildren> = ({ children }) => {
  const styles = useStyles2(getStyles);
  return <div className={styles.center}>{children}</div>;
};

// Observation counts come from increase(), which can be fractional.
export const formatCount = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export const HeatmapView: React.FC<{
  frames: DataFrame[];
  formatBucket: (bound: string) => string;
  rateUnit: string;
}> = ({ frames, formatBucket, rateUnit }) => {
  const styles = useStyles2(getStyles);
  const rows = heatmapRows(frames);
  const values = rows.flatMap((row) => row.values);
  const minimum = values.length > 0 ? Math.min(...values) : 0;
  const maximum = Math.max(0, ...values);

  if (rows.length === 0) {
    return <Centered>No histogram buckets were returned.</Centered>;
  }

  return (
    <div className={styles.heatmap} aria-label="Histogram heatmap">
      {rows.map((row) => (
        <div className={styles.heatmapRow} key={row.label}>
          <span className={styles.heatmapLabel} title={row.label}>
            {formatBucket(row.label)}
          </span>
          <div
            className={styles.heatmapCells}
            style={{ gridTemplateColumns: `repeat(${Math.max(row.values.length, 1)}, minmax(3px, 1fr))` }}
          >
            {row.values.map((value, index) => (
              <span
                key={index}
                className={styles.heatmapCell}
                style={{ opacity: maximum > 0 ? Math.max(0.08, value / maximum) : 0.08 }}
                title={`${formatBucket(row.label)}: ${formatCount(value)}${rateUnit}`}
              />
            ))}
          </div>
        </div>
      ))}
      <div className={styles.heatmapLegend}>
        <span>
          lower <b className={styles.heatmapLegendValue}>{formatCount(minimum)}</b>
        </span>
        <span className={styles.heatmapGradient} />
        <span>
          higher <b className={styles.heatmapLegendValue}>{formatCount(maximum)}</b> {rateUnit}
        </span>
      </div>
    </div>
  );
};

interface HeatmapRow {
  label: string;
  values: number[];
}

/** Whether frames look like histogram buckets: every series carries an le or vmrange label. */
export function hasBucketLabels(frames: DataFrame[]): boolean {
  let numeric = 0;
  for (const frame of frames) {
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      numeric++;
      if (field.labels?.le === undefined && field.labels?.vmrange === undefined) {
        return false;
      }
    }
  }
  return numeric > 0;
}

function heatmapRows(frames: DataFrame[]): HeatmapRow[] {
  const rows: HeatmapRow[] = [];
  for (const frame of frames) {
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const label = field.labels?.le ?? field.labels?.vmrange ?? frame.name ?? field.name;
      const values = Array.from({ length: field.values.length }, (_, index) => Number(field.values[index]))
        .filter(Number.isFinite)
        .slice(-100);
      if (values.length > 0) {
        rows.push({ label, values });
      }
    }
  }

  return rows
    .sort((left, right) => bucketSortValue(left.label) - bucketSortValue(right.label))
    .slice(-30)
    .reverse();
}

function bucketSortValue(label: string): number {
  const value = Number(label.replace(/^.*(?:le|vmrange)[=:]/, '').replace(/["{}]/g, ''));
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

// Per-series min/max/mean/last in the legend; they are computed from the returned samples only.
const LEGEND = {
  showLegend: true,
  displayMode: LegendDisplayMode.Table,
  placement: 'bottom' as const,
  calcs: ['min', 'max', 'mean', 'lastNotNull'],
};

const TOOLTIP_HOVER_X_ALL = 1;
const TOOLTIP_MAX_ROWS = 20;

/** Every returned series (up to MAX_DRAWN_SERIES) with its own color and legend entry. */
export const MultiSeriesChart: React.FC<{
  frames: DataFrame[];
  unitId: string;
  range: TimeRange;
  /** Legend name of a series without labels, which is otherwise named after the whole expression. */
  unlabeledName: string;
}> = ({ frames, unitId, range, unlabeledName }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [setContainer, size] = useElementSize<HTMLDivElement>();
  const plotFrames = useMemo(
    () => seriesFrames(frames, unitId, theme, unlabeledName),
    [frames, theme, unitId, unlabeledName]
  );

  return (
    <div ref={setContainer} className={styles.plot}>
      {size.width > 0 && size.height > 0 && plotFrames.length > 0 && (
        <TimeSeries
          frames={plotFrames}
          timeRange={range}
          timeZone="browser"
          width={size.width}
          height={size.height}
          legend={LEGEND}
        >
          {(config, alignedFrame) => (
            <TooltipPlugin2
              config={config}
              hoverMode={TOOLTIP_HOVER_X_ALL}
              maxWidth={560}
              render={(_u, dataIdxs) => {
                const timeField = alignedFrame.fields[0];
                const at = dataIdxs.find((idx) => idx != null);
                if (!timeField || at == null) {
                  return null;
                }
                const rows = alignedFrame.fields
                  .map((field, fieldIndex) => ({ field, idx: dataIdxs[fieldIndex] }))
                  .slice(1)
                  .filter(
                    ({ field, idx }) =>
                      field.type === FieldType.number && idx != null && Number.isFinite(Number(field.values[idx!]))
                  )
                  .map(({ field, idx }) => ({ field, value: Number(field.values[idx!]) }))
                  .sort((left, right) => right.value - left.value);
                if (rows.length === 0) {
                  return null;
                }
                return (
                  <div className={styles.tooltip}>
                    <SeriesTable
                      timestamp={dateTimeFormat(Number(timeField.values[at]), { timeZone: 'browser' })}
                      series={rows.slice(0, TOOLTIP_MAX_ROWS).map(({ field, value }) => ({
                        color: getFieldSeriesColor(field, theme).color,
                        label: getFieldDisplayName(field, alignedFrame),
                        value: formatted(field, value),
                      }))}
                    />
                    {rows.length > TOOLTIP_MAX_ROWS && (
                      <div className={styles.tooltipMore}>and {rows.length - TOOLTIP_MAX_ROWS} more</div>
                    )}
                  </div>
                );
              }}
            />
          )}
        </TimeSeries>
      )}
    </div>
  );
};

/** One frame per series, each colored from the theme palette and formatted with the saved unit. */
function seriesFrames(frames: DataFrame[], unitId: string, theme: GrafanaTheme2, unlabeledName: string): DataFrame[] {
  const palette = theme.visualization.palette;
  const result: DataFrame[] = [];
  frames.forEach((frame, index) => {
    const time = frame.fields.find((field) => field.type === FieldType.time);
    const value = frame.fields.find((field) => field.type === FieldType.number);
    if (!time || !value) {
      return;
    }
    const labeled = Object.keys(value.labels ?? {}).length > 0;
    const name = labeled ? frame.name || getFieldDisplayName(value, frame) : unlabeledName;
    const valueField: Field = {
      ...value,
      config: {
        ...value.config,
        displayName: name,
        color: {
          mode: FieldColorModeId.Fixed,
          fixedColor: theme.visualization.getColorByName(palette[index % palette.length]),
        },
        custom: { lineWidth: 1, fillOpacity: 0, showPoints: PointVisibility.Never, pointSize: 4, spanNulls: false },
      },
    };
    valueField.display = unitDisplay(valueField, unitId, theme);
    result.push({ ...frame, name, fields: [time, valueField] });
  });
  return result;
}

function formatted(field: Field, value: number): string {
  const display = field.display?.(value);
  // Keep "19.2 °C" on one line when the series name is long.
  return (display ? formattedValueToString(display) : String(value)).replace(/ /g, ' ');
}

const getStyles = (theme: GrafanaTheme2) => ({
  center: css({
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    height: '100%',
    minHeight: 0,
    paddingTop: theme.spacing(4),
    color: theme.colors.text.secondary,
    textAlign: 'center',
  }),
  heatmap: css({
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    height: '100%',
    minHeight: '280px',
    overflow: 'auto',
    padding: theme.spacing(1),
  }),
  heatmapRow: css({
    display: 'grid',
    gridTemplateColumns: '76px 1fr',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    flex: 1,
    minHeight: '8px',
  }),
  heatmapLabel: css({
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.size.xs,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  }),
  heatmapCells: css({
    display: 'grid',
    gap: '1px',
    alignSelf: 'stretch',
  }),
  heatmapCell: css({
    display: 'block',
    minHeight: '8px',
    background: theme.colors.primary.main,
  }),
  heatmapLegend: css({
    display: 'flex',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginTop: theme.spacing(0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  heatmapLegendValue: css({
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeightMedium,
    fontVariantNumeric: 'tabular-nums',
  }),
  heatmapGradient: css({
    width: '80px',
    height: '6px',
    background: `linear-gradient(90deg, ${theme.colors.background.secondary}, ${theme.colors.primary.main})`,
  }),
  plot: css({
    width: '100%',
    height: '100%',
  }),
  tooltip: css({
    padding: theme.spacing(1),
    whiteSpace: 'normal',
  }),
  tooltipMore: css({
    marginTop: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
});
