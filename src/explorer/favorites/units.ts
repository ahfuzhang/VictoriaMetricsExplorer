import { DisplayProcessor, Field, GrafanaTheme2, getDisplayProcessor } from '@grafana/data';

import { VisualizationKind } from '../../generated/explorer/user_storage_pb';

// Units shared by the automatic chart (ChartPanel) and saved queries (docs/plan_v3.md §8.2). The
// chart plan speaks display units ("bytes", "s/min", "%"); saved statements store Grafana unit ids.
// Units only format values; they never scale the data.

/** Units from largest to smallest; a value takes the first unit it reaches, or the last one. */
export const DURATION_UNITS: Array<[number, string]> = [
  [1, 's'],
  [1e-3, 'ms'],
  [1e-6, 'us'],
  [1e-9, 'ns'],
];

export const BYTE_UNITS: Array<[number, string]> = [
  [1024 ** 5, 'PB'],
  [1024 ** 4, 'TB'],
  [1024 ** 3, 'GB'],
  [1024 ** 2, 'MB'],
  [1024, 'KB'],
  [1, 'B'],
];

/** Scale a value into the largest unit it reaches, e.g. 0.0042 s -> ["4.2", "ms"]. */
export function scaleValue(value: number, units: Array<[number, string]>): [string, string] {
  if (!Number.isFinite(value) || value === 0) {
    return [Number.isFinite(value) ? '0' : String(value), units[0][1]];
  }
  const [scale, unit] = units.find(([unitScale]) => Math.abs(value) >= unitScale) ?? units[units.length - 1];
  // toPrecision drops float noise such as 0.30000000000000004 and the padding of "1.136e+00".
  return [String(Number((value / scale).toPrecision(4))), unit];
}

export function formatScaledBound(bound: string, units: Array<[number, string]>): string {
  const value = Number(bound);
  if (!Number.isFinite(value) || value === 0) {
    return bound;
  }
  const [text, unit] = scaleValue(value, units);
  return `${text}${unit}`;
}

/** A stat or histogram whose name ends with "_bytes" is shown in B, KB, MB, GB and so on. */
export function isBytesMetric(metric: string): boolean {
  return metric.endsWith('_bytes');
}

/**
 * Histogram bucket bounds are shown in the unit the metric name ends with: "<prefix>_seconds" as s,
 * ms, us or ns, and "<prefix>_bytes" as B, KB, MB, GB and so on. Other histograms keep the bounds as
 * exported.
 */
export function bucketFormatter(metric: string): (bound: string) => string {
  const base = metric.replace(/_bucket$/, '');
  if (base.endsWith('_seconds')) {
    return (bound) => formatScaledBound(bound, DURATION_UNITS);
  }
  if (isBytesMetric(base)) {
    return (bound) => formatScaledBound(bound, BYTE_UNITS);
  }
  return (bound) => bound;
}

/** Bucket bounds formatted by a saved bucket unit id. */
export function bucketFormatterForUnit(unitId: string): (bound: string) => string {
  if (unitId === 's') {
    return (bound) => formatScaledBound(bound, DURATION_UNITS);
  }
  if (unitId === 'bytes') {
    return (bound) => formatScaledBound(bound, BYTE_UNITS);
  }
  return (bound) => bound;
}

// A counter of bytes or seconds is plotted as a rate of that unit, e.g. "bytes/s" or "s/min": the
// values are scaled in the base unit (KiB, MiB…, ms, µs…) and the rate is appended after it.
const RATE_UNIT = /^(bytes|s)(\/(?:s|min))$/;

export function splitRateUnit(unit: string): { base: string; rate: string } {
  const match = RATE_UNIT.exec(unit);
  return match ? { base: match[1], rate: match[2] } : { base: unit, rate: '' };
}

/** Map the plan's display unit to a Grafana unit id; anything unrecognized is shown as a suffix. */
export function grafanaUnit(unit: string): string | undefined {
  switch (unit) {
    case '':
      return undefined;
    case 's':
      return 's';
    case 'bytes':
      return 'bytes';
    case '°C':
      return 'celsius';
    case '%':
      return 'percent';
    default:
      return `suffix:${unit}`;
  }
}

/**
 * The unit id a statement saved from a chart plan stores. Plain units map to Grafana unit ids;
 * bytes/s is Grafana's Bps; the other rates of bytes and seconds keep the "<base>/<s|min>" form this
 * app formats itself (unitDisplay), since Grafana has no such unit.
 */
export function planUnitToUnitId(planUnit: string): string {
  if (planUnit === 'bytes/s') {
    return 'Bps';
  }
  if (RATE_UNIT.test(planUnit)) {
    return planUnit;
  }
  return grafanaUnit(planUnit) ?? 'none';
}

/** Display processor for a field drawn with a saved unit id. */
export function unitDisplay(field: Field, unitId: string, theme: GrafanaTheme2): DisplayProcessor {
  const { base, rate } = splitRateUnit(unitId);
  const unit = rate ? base : unitId === 'none' || unitId === '' ? undefined : unitId;
  const display = getDisplayProcessor({ field: { ...field, config: { ...field.config, unit } }, theme });
  if (!rate) {
    return display;
  }
  if (base === 's') {
    // Grafana's "s" unit scales up to minutes and hours; seconds only scale down to ms, us, ns.
    return (value, decimals) => {
      const formatted = display(value, decimals);
      const [text, scaled] = scaleValue(Number(value), DURATION_UNITS);
      return { ...formatted, text, suffix: ` ${scaled}${rate}` };
    };
  }
  return (value, decimals) => {
    const formatted = display(value, decimals);
    return { ...formatted, suffix: `${formatted.suffix ?? ''}${rate}` };
  };
}

/** The visualization a chart plan names (e.g. "timeseries", "heatmap", "stat"). */
export function visualizationFromPlan(value?: string): VisualizationKind {
  const normalized = value?.toLowerCase() ?? '';
  if (normalized.includes('heatmap')) {
    return VisualizationKind.HEATMAP;
  }
  if (normalized.includes('stat')) {
    return VisualizationKind.STAT;
  }
  return VisualizationKind.TIMESERIES;
}

/** Heatmap units of a histogram chart plan: the bucket bound unit and the per-second or per-minute counts. */
export function heatmapUnitsFromPlan(
  metric: string,
  aggregation: string
): { bucketUnitId: string; valueUnitId: string } {
  const base = metric.replace(/_bucket$/, '');
  return {
    bucketUnitId: base.endsWith('_seconds') ? 's' : isBytesMetric(base) ? 'bytes' : 'none',
    valueUnitId: aggregation === 'sum_by_le_increase' ? 'suffix:/min' : 'suffix:/s',
  };
}

/** The text shown after heatmap cell values for a value unit id, e.g. "/s". */
export function heatmapValueSuffix(unitId: string): string {
  if (unitId.startsWith('suffix:')) {
    return unitId.slice('suffix:'.length);
  }
  return unitId === 'none' || unitId === '' ? '' : ` ${unitId}`;
}

export const VISUALIZATION_LABELS: Record<VisualizationKind, string> = {
  [VisualizationKind.UNSPECIFIED]: 'Unspecified',
  [VisualizationKind.TIMESERIES]: 'Time series',
  [VisualizationKind.STAT]: 'Stat',
  [VisualizationKind.HEATMAP]: 'Heatmap',
};
