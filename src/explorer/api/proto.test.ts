/** @jest-environment node */
jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn(), getDataSourceSrv: jest.fn() }));
jest.mock('./oauth', () => ({ fetchWithOAuthSession: jest.fn() }));

import { create, toBinary } from '@bufbuild/protobuf';
import { getBackendSrv, getDataSourceSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import { CapabilitiesResponseSchema, ErrorSchema } from '../../generated/explorer/explorer_pb';
import { fetchWithOAuthSession } from './oauth';
import { callProto, dsURL, RESOURCES } from './proto';
import { zstdFrame } from './zstd';

const fetch = jest.fn();
const getInstanceSettings = jest.fn();
const data = zstdFrame(
  toBinary(
    CapabilitiesResponseSchema,
    create(CapabilitiesResponseSchema, {
      upstreamProduct: 'Prometheus',
    })
  )
).buffer;
const call = { url: dsURL('prom', '/capabilities'), method: 'GET' as const, response: CapabilitiesResponseSchema };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getBackendSrv).mockReturnValue({ fetch } as unknown as ReturnType<typeof getBackendSrv>);
  jest
    .mocked(getDataSourceSrv)
    .mockReturnValue({ getInstanceSettings } as unknown as ReturnType<typeof getDataSourceSrv>);
  jest.mocked(fetchWithOAuthSession).mockResolvedValue({ status: 200, data });
});

it('uses the session relay for an OAuth datasource', async () => {
  getInstanceSettings.mockReturnValue({ jsonData: { oauthPassThru: true } });
  expect((await callProto(call)).upstreamProduct).toBe('Prometheus');
  expect(fetch).not.toHaveBeenCalled();
  expect(fetchWithOAuthSession).toHaveBeenCalledWith(call.url, `${RESOURCES}/oauth`, 'prom', expect.any(Object));
});

it('keeps the existing backend path for other datasources', async () => {
  getInstanceSettings.mockReturnValue({ jsonData: {} });
  fetch.mockReturnValue(of({ data }));
  expect((await callProto(call)).upstreamProduct).toBe('Prometheus');
  expect(fetchWithOAuthSession).not.toHaveBeenCalled();
});

it('retries with the session when the backend reports newer OAuth settings', async () => {
  getInstanceSettings.mockReturnValue({ jsonData: {} });
  const error = zstdFrame(toBinary(ErrorSchema, create(ErrorSchema, { code: 'oauth_session_required' }))).buffer;
  fetch.mockReturnValue(throwError(() => ({ status: 409, data: error })));
  expect((await callProto(call)).upstreamProduct).toBe('Prometheus');
  expect(fetchWithOAuthSession).toHaveBeenCalledTimes(1);
});
