import type { FacetResponse } from '../api';

/**
 * Label names that split the series left by the label filters into more than one curve under
 * `sum by (<label>)`, in the label column's order. A series without the label sums into a curve of
 * its own, so a label only some series carry also splits them.
 *
 * Facet value counts are taken under every filter. Values are listed by count (an unfiltered label)
 * or keep every selected value (a filtered one, whose other values count 0), so a truncated value
 * list never hides a value that still has series.
 */
export function groupableLabels(response: FacetResponse): string[] {
  const labels: string[] = [];
  for (const facet of response.facets) {
    let curves = 0;
    let withLabel = 0;
    for (const value of facet.values) {
      if (value.count > 0) {
        curves++;
        withLabel += value.count;
      }
    }
    if (withLabel < response.seriesReturned) {
      curves++;
    }
    if (curves > 1) {
      labels.push(facet.label);
    }
  }
  return labels;
}
