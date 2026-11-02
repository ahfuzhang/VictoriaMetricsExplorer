import { create } from '@bufbuild/protobuf';
import { FieldType } from '@grafana/data';

import { ConfiguredChartSchema, ConfiguredQuerySchema } from '../../generated/explorer/metric_config_pb';
import { panelConfig, queryFrames } from './panels';

it('passes native panel settings and field overrides through without metric rules', () => {
  const fieldConfig = {
    defaults: { unit: 'percentunit' },
    overrides: [
      { matcher: { id: 'byFrameRefID', options: 'B' }, properties: [{ id: 'custom.axisPlacement', value: 'right' }] },
    ],
  };
  const chart = create(ConfiguredChartSchema, {
    visualization: { type: 'piechart', width: 12, height: 288, options: { pieType: 'donut' }, fieldConfig },
  });
  const result = panelConfig(chart);
  expect(result.pluginId).toBe('piechart');
  expect(result.options).toEqual({ pieType: 'donut' });
  expect(result.fieldConfig.overrides).toEqual(fieldConfig.overrides);
  expect(result.fieldConfig.defaults.unit).toBe('percentunit');
  expect(result.height).toBe(288);
});

it('maps axis declarations to query refId overrides', () => {
  const chart = create(ConfiguredChartSchema, {
    queries: [
      { refId: 'A', axis: 'left' },
      { refId: 'B', axis: 'right' },
    ],
    visualization: {
      type: 'dual_axis',
      axes: { left: { unitId: 'bytes', min: 0 }, right: { unitId: 'percent', max: 100 } },
    },
  });
  const panel = panelConfig(chart);
  expect(panel.pluginId).toBe('timeseries');
  expect(panel.fieldConfig.overrides[1]).toMatchObject({
    matcher: { options: 'B' },
    properties: expect.arrayContaining([
      { id: 'unit', value: 'percent' },
      { id: 'custom.axisPlacement', value: 'right' },
    ]),
  });
});

it('expands label legends and retains refId for Grafana native overrides', () => {
  const query = create(ConfiguredQuerySchema, { refId: 'A', legend: 'generation-{{generation}}/min' });
  const frame = {
    length: 1,
    fields: [{ name: 'Value', type: FieldType.number, labels: { generation: '2' }, values: [3], config: {} }],
  };
  const [result] = queryFrames([frame], query);
  expect(result.refId).toBe('A');
  expect(result.name).toBe('generation-2/min');
  expect(result.fields[0].name).toBe('generation-2/min');
  expect(frame.fields[0].name).toBe('Value');
});
