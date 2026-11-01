jest.mock('@grafana/runtime', () => ({ getDataSourceSrv: jest.fn() }));
jest.mock('./proto', () => ({ callProto: jest.fn() }));

import { create } from '@bufbuild/protobuf';
import { getDataSourceSrv } from '@grafana/runtime';
import { DatasourcesResponseSchema } from '../../generated/explorer/explorer_pb';
import { getDatasources } from './index';
import { callProto } from './proto';

it('lists both datasource types while respecting Grafana visibility and the backend allowlist', async () => {
  const getInstanceSettings = jest.fn((uid: string) => (uid === 'hidden' ? undefined : { uid }));
  jest.mocked(getDataSourceSrv).mockReturnValue({ getInstanceSettings } as unknown as ReturnType<typeof getDataSourceSrv>);
  jest.mocked(callProto).mockResolvedValue(
    create(DatasourcesResponseSchema, {
      datasources: [
        { uid: 'prom', name: 'Prometheus', type: 'prometheus', isDefault: true },
        { uid: 'vm', name: 'VictoriaMetrics', type: 'victoriametrics-metrics-datasource' },
        { uid: 'hidden', name: 'Hidden Prometheus', type: 'prometheus' },
      ],
    })
  );

  expect(await getDatasources()).toEqual([
    { uid: 'prom', name: 'Prometheus', type: 'prometheus', isDefault: true },
    { uid: 'vm', name: 'VictoriaMetrics', type: 'victoriametrics-metrics-datasource', isDefault: false },
  ]);
});
