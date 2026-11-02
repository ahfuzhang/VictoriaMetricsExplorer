import { DataFrame, FieldConfigSource, FieldType } from '@grafana/data';

import type { ConfiguredChart, ConfiguredQuery } from '../../generated/explorer/metric_config_pb';

interface Axis {
  unitId: string;
  label?: string;
  min?: number;
  max?: number;
  decimals?: number;
}

export interface Visualization {
  type: string;
  height?: number;
  width?: number;
  axes?: Record<string, Axis>;
  options?: Record<string, unknown>;
  fieldConfig?: FieldConfigSource;
}

/** Only schema translation lives here. Native Grafana settings pass through from YAML. */
export function panelConfig(chart: ConfiguredChart) {
  const visualization = chart.visualization as unknown as Visualization;
  const axes = visualization.axes;
  const fieldConfig: FieldConfigSource = { defaults: {}, overrides: [], ...visualization.fieldConfig };
  const overrides = [...(fieldConfig.overrides ?? [])];
  if (axes) {
    for (const query of chart.queries) {
      const side = query.axis || 'left';
      const axis = axes[side];
      if (!axis) {
        continue;
      }
      overrides.push({
        matcher: { id: 'byFrameRefID', options: query.refId },
        properties: [
          { id: 'unit', value: axis.unitId },
          { id: 'custom.axisPlacement', value: side },
          { id: 'custom.axisLabel', value: axis.label ?? '' },
          ...(['min', 'max', 'decimals'] as const)
            .filter((key) => axis[key] !== undefined)
            .map((key) => ({ id: key, value: axis[key] })),
        ],
      });
    }
  }
  const alias = ['line', 'stacked', 'dual_axis'].includes(visualization.type);
  return {
    ...visualization,
    pluginId: alias ? 'timeseries' : visualization.type,
    fieldConfig: {
      ...fieldConfig,
      defaults: {
        ...fieldConfig.defaults,
        custom: {
          ...(alias ? { stacking: { mode: visualization.type === 'stacked' ? 'normal' : 'none', group: 'A' } } : {}),
          ...(fieldConfig.defaults?.custom ?? {}),
        },
      },
      overrides,
    },
  };
}

/** Keep refId and field names so Grafana's byName and byFrameRefID overrides work. */
export function queryFrames(frames: DataFrame[], query: ConfiguredQuery): DataFrame[] {
  return frames.map((frame) => {
    const value = frame.fields.find((field) => field.type === FieldType.number);
    const labels = value?.labels ?? {};
    const legend = query.legend
      ? query.legend.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, label) => labels[label] ?? '')
      : Object.entries(labels)
          .filter(([name]) => name !== '__name__')
          .map(([name, value]) => `${name}="${value}"`)
          .join(', ') || query.refId;
    return {
      ...frame,
      refId: query.refId,
      name: legend,
      fields: frame.fields.map((field) =>
        field.type === FieldType.number
          ? { ...field, name: legend, config: { ...field.config, displayNameFromDS: legend } }
          : field
      ),
    };
  });
}
