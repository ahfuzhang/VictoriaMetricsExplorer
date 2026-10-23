jest.mock('@grafana/runtime', () => ({
  config: {
    namespace: 'default',
    buildInfo: { version: '12.3.1' },
    bootData: { user: { isSignedIn: true, uid: 'u1', id: 1 } },
  },
  getBackendSrv: jest.fn(),
}));

import { contentKey } from './codec';
import { GrafanaUserStorageAdapter, type HttpRequest, type HttpTransport } from './grafanaUserStorageAdapter';
import { FavoritesRepository } from './repository';
import { DecodeCache } from './snapshotView';
import { query } from './testUtils';
import { FavoritesUncertain, ROOT } from './types';

// The Grafana server is the only place favorites are kept (docs/plan_v3.md §1.1, §13.1): reads,
// saves, failed saves and retries must never touch browser storage.

const identity = { namespace: 'default', pluginId: 'p', userUid: 'u1', resourceName: 'p:u1' };

/** A User Storage resource behind a transport, with optional failures. */
function server(fail: (request: HttpRequest) => boolean = () => false): HttpTransport {
  let resource: { resourceVersion: string; data: Record<string, string> } | null = null;
  let version = 1;
  const body = () => ({ metadata: { resourceVersion: resource!.resourceVersion }, spec: { data: resource!.data } });
  return async (request) => {
    if (fail(request)) {
      throw { status: 503, data: 'unavailable' };
    }
    if (request.method === 'GET') {
      if (!resource) {
        throw {
          status: 404,
          data: { kind: 'Status', reason: 'NotFound', details: { group: 'userstorage.grafana.app', name: 'p:u1' } },
        };
      }
      return { status: 200, data: body() };
    }
    const payload = request.data as { spec: { data: Record<string, string | null> } };
    if (request.method === 'POST') {
      resource = { resourceVersion: String(++version), data: payload.spec.data as Record<string, string> };
      return { status: 201, data: body() };
    }
    const data = { ...resource!.data };
    for (const [key, value] of Object.entries(payload.spec.data)) {
      if (value === null) {
        delete data[key];
      } else {
        data[key] = value;
      }
    }
    resource = { resourceVersion: String(++version), data };
    return { status: 200, data: body() };
  };
}

describe('favorites persistence', () => {
  const touched: string[] = [];
  beforeEach(() => {
    touched.length = 0;
    for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
      jest.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage) {
        touched.push(`${this === window.localStorage ? 'localStorage' : 'sessionStorage'}.${method}`);
        return null as never;
      });
    }
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      value: { open: () => touched.push('indexedDB.open') },
    });
    Object.defineProperty(window, 'caches', {
      configurable: true,
      value: { open: () => touched.push('caches.open') },
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads and saves through the server only', async () => {
    const repository = new FavoritesRepository(new GrafanaUserStorageAdapter(identity, server()), new DecodeCache(), {
      sleep: async () => undefined,
    });
    const base = await repository.loadFresh();
    const result = await repository.commit(
      [
        {
          kind: 'createFavorite',
          position: { parentId: ROOT, afterId: null },
          name: 'F',
          tempId: 'tmp-f',
          queries: [query('q')],
        },
      ],
      base.snapshot ? base : null
    );
    expect(result.view.raw(contentKey(BigInt(1)))).toBeDefined();
    const again = await repository.loadFresh();
    expect((await again.content(BigInt(1))).state).toBe('ok');
    expect(touched).toEqual([]);
  });

  it('does not fall back to browser storage when the server fails', async () => {
    const repository = new FavoritesRepository(
      new GrafanaUserStorageAdapter(
        identity,
        server((request) => request.method !== 'GET')
      ),
      new DecodeCache(),
      { sleep: async () => undefined }
    );
    await expect(
      repository.commit(
        [{ kind: 'createFolder', position: { parentId: ROOT, afterId: null }, name: 'A', tempId: 'tmp-a' }],
        null
      )
    ).rejects.toBeInstanceOf(FavoritesUncertain);
    expect(touched).toEqual([]);
  });
});
