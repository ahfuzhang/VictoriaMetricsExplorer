import type { Facet, FacetResponse } from '../api';
import { groupableLabels } from './groupBy';

function facet(label: string, counts: Record<string, number>): Facet {
  const values = Object.entries(counts).map(([value, count]) => ({ value, count, availableCount: count }));
  return {
    label,
    values,
    totalValues: values.length,
    truncated: false,
    isConstant: false,
    seriesWithLabel: 0,
    seriesTotal: 0,
  };
}

function response(seriesReturned: number, facets: Facet[]): FacetResponse {
  return {
    schemaVersion: { major: 1, minor: 0 },
    meta: { requestId: '', truncated: false, partial: false, elapsedMs: 0 },
    facets,
    seriesTotal: seriesReturned,
    seriesReturned,
    countsExact: true,
  };
}

describe('groupableLabels', () => {
  it('keeps labels with more than one value among the filtered series, in facet order', () => {
    const labels = groupableLabels(
      response(4, [facet('job', { api: 2, web: 2 }), facet('env', { prod: 4 }), facet('pod', { a: 1, b: 3 })])
    );
    expect(labels).toEqual(['job', 'pod']);
  });

  it('drops a label whose other values have no series left under the filters', () => {
    // Filtering instance="a" leaves job="api" only: job no longer splits the series.
    const labels = groupableLabels(response(2, [facet('job', { api: 2, web: 0 }), facet('instance', { a: 2, b: 0 })]));
    expect(labels).toEqual([]);
  });

  it('counts the series without a label as a curve of their own', () => {
    expect(groupableLabels(response(3, [facet('error', { timeout: 1 })]))).toEqual(['error']);
    expect(groupableLabels(response(3, [facet('error', { timeout: 3 })]))).toEqual([]);
  });

  it('offers nothing when no series match the filters', () => {
    expect(groupableLabels(response(0, [facet('job', { api: 0, web: 0 })]))).toEqual([]);
  });
});
