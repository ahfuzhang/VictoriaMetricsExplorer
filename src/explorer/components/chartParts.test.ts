import { DataFrame, FieldType } from '@grafana/data';

import { heatmapRows } from './chartParts';

function bucket(le: string, values: number[]): DataFrame {
  return {
    name: `{le="${le}"}`,
    length: values.length,
    fields: [
      { name: 'Time', type: FieldType.time, config: {}, values: values.map((_, index) => index * 60000) },
      { name: 'Value', type: FieldType.number, config: {}, values, labels: { le } },
    ],
  };
}

describe('heatmapRows', () => {
  it('leaves out the empty buckets below and above the observations', () => {
    const { rows, candidates } = heatmapRows([
      bucket('1', [0, 0]),
      bucket('2', [1, 0]),
      bucket('3', [0, 0]),
      bucket('4', [0, 2]),
      bucket('5', [0, 0]),
    ]);
    expect(rows.map((row) => row.label)).toEqual(['4', '3', '2']);
    expect(candidates).toBe(3);
  });

  it('keeps the busiest adjacent buckets of a large VictoriaMetrics histogram', () => {
    // 110 vmrange buckets turned into le, observations only between buckets 40 and 59: the highest
    // 30 buckets, all empty, must not crowd them out.
    const frames = Array.from({ length: 110 }, (_, index) =>
      bucket(String(index + 1), [index >= 40 && index < 60 ? 5 : index === 5 ? 1 : 0])
    );
    const { rows, candidates } = heatmapRows(frames);
    expect(candidates).toBe(55);
    expect(rows).toHaveLength(30);
    expect(rows.reduce((sum, row) => sum + row.values[0], 0)).toBe(100);
  });

  it('draws the highest buckets when nothing was observed', () => {
    const frames = Array.from({ length: 40 }, (_, index) => bucket(String(index + 1), [0]));
    const { rows } = heatmapRows(frames);
    expect(rows).toHaveLength(30);
    expect(rows[0].label).toBe('40');
  });
});
