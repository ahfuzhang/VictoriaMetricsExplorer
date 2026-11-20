/** @jest-environment node */
jest.mock('@grafana/runtime', () => ({
  config: { appSubUrl: '/grafana', bootData: { user: { orgId: 7 } } },
}));

import { fetchWithOAuthSession } from './oauth';

const callback = '/api/plugins/ahfuzhang-victoriametricsexplorer-app/resources/explorer/v1/oauth';
const path = '/api/datasources/proxy/uid/prom/api/v1/labels?limit=10000';
const origin = 'https://grafana.example';
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin } } });
});
afterAll(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});
afterEach(() => jest.restoreAllMocks());

it('uses the browser session and organization for proxy requests and returns the relayed result', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const send = (event: unknown) => stream.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
  const body = new ReadableStream<Uint8Array>({ start: (controller) => (stream = controller) });
  const upstreamBody = '{"status":"success","data":["pod"]}';
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    expect(new Headers(init?.headers).get('X-Grafana-Org-Id')).toBe('7');
    if (String(url) === origin + '/grafana' + path) {
      return new Response(upstreamBody);
    }
    if (String(url) === '/grafana' + callback + '/request-id') {
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('X-Explorer-Upstream-Status')).toBe('200');
      expect(await (init?.body as Blob).text()).toBe(upstreamBody);
      send({ status: 200, body: btoa('result') });
      return new Response(null, { status: 204 });
    }
    expect(new Headers(init?.headers).get('Accept')).toBe('application/x-ndjson');
    send({ id: 'request-id', path, maxBytes: 1024 });
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const result = await fetchWithOAuthSession('/resource', callback, 'prom', { method: 'GET' });
  expect(result.status).toBe(200);
  expect(new TextDecoder().decode(result.data)).toBe('result');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('cancels the relay when the caller aborts', async () => {
  const controller = new AbortController();
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
    return new Response(
      new ReadableStream({
        start(stream) {
          init?.signal?.addEventListener('abort', () => stream.error(new Error('aborted')));
        },
      }),
      { headers: { 'Content-Type': 'application/x-ndjson' } }
    );
  });
  const pending = fetchWithOAuthSession('/resource', callback, 'prom', { signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toThrow('aborted');
  expect(fetch).toHaveBeenCalledTimes(1);
});
