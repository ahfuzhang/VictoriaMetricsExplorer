/** @jest-environment node */
jest.mock('@grafana/runtime', () => ({ getBackendSrv: jest.fn() }));

import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { getBackendSrv } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import { CapabilitiesResponseSchema, ErrorSchema, RangeQueryRequestSchema } from '../../generated/explorer/explorer_pb';
import { callProto, dsURL } from './proto';
import { zstdDecompress, zstdFrame } from './zstd';

const fetch = jest.fn();
const data = zstdFrame(
  toBinary(CapabilitiesResponseSchema, create(CapabilitiesResponseSchema, { upstreamProduct: 'Prometheus' }))
).buffer;
const call = { url: dsURL('prom', '/capabilities'), method: 'GET' as const, response: CapabilitiesResponseSchema };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getBackendSrv).mockReturnValue({ fetch } as unknown as ReturnType<typeof getBackendSrv>);
});

it('queries only the app backend and decodes its binary response', async () => {
  fetch.mockReturnValue(of({ data }));
  expect((await callProto(call)).upstreamProduct).toBe('Prometheus');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(
    expect.objectContaining({
      url: call.url,
      method: 'GET',
      responseType: 'arraybuffer',
      headers: { Accept: 'application/x-protobuf' },
    })
  );
});

it('sends the chart query as binary without uploading upstream JSON', async () => {
  fetch.mockReturnValue(of({ data }));
  const controller = new AbortController();
  await callProto({
    ...call,
    url: dsURL('prom', '/query-range'),
    method: 'POST',
    request: { schema: RangeQueryRequestSchema, init: { query: 'up' } },
    abortSignal: controller.signal,
  });
  const request = fetch.mock.calls[0][0];
  expect(request.headers['Content-Type']).toBe('application/x-protobuf');
  expect(request.headers['X-Payload-Encoding']).toBe('zstd');
  expect(request.abortSignal).toBe(controller.signal);
  expect(request.data).toBeInstanceOf(Blob);
  const message = fromBinary(RangeQueryRequestSchema, zstdDecompress(new Uint8Array(await request.data.arrayBuffer())));
  expect(message.query).toBe('up');
});

it.each(['oauth_forwarding_unsupported', 'oauth_session_required'])(
  'surfaces %s without a browser relay or retry',
  async (code) => {
    const message = 'Grafana does not provide the user OAuth token to app backends';
    const error = zstdFrame(toBinary(ErrorSchema, create(ErrorSchema, { code, message }))).buffer;
    fetch.mockReturnValue(throwError(() => ({ status: 422, data: error })));
    await expect(callProto(call)).rejects.toMatchObject({ status: 422, data: { code, message } });
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);
