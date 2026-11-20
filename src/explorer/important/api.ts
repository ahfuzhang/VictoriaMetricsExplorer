import { TimeRange } from '@grafana/data';

import {
  ConfiguredChartsRequestSchema,
  ConfiguredChartsResponseSchema,
} from '../../generated/explorer/metric_config_pb';
import { callProto, dsURL, labelFilters, timeRange } from '../api/proto';

export async function fetchConfiguredCharts(
  uid: string,
  podGroup: string,
  range: TimeRange,
  filters: Record<string, string[]>,
  abortSignal: AbortSignal
) {
  return callProto({
    url: dsURL(uid, '/configured-charts'),
    method: 'POST',
    response: ConfiguredChartsResponseSchema,
    request: {
      schema: ConfiguredChartsRequestSchema,
      init: {
        podGroup,
        range: timeRange(range.from.valueOf(), range.to.valueOf()),
        filters: labelFilters(filters),
      },
    },
    showErrorAlert: false,
    abortSignal,
  });
}
