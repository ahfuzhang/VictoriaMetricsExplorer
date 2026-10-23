/**
 * @jest-environment node
 */
jest.mock('@grafana/runtime', () => ({
  config: {
    namespace: 'default',
    buildInfo: { version: '12.3.1' },
    bootData: { user: { isSignedIn: true, uid: '', id: 42 } },
  },
  getBackendSrv: jest.fn(),
}));

import {
  GrafanaUserStorageAdapter,
  compareVersions,
  currentIdentity,
  writeBlockedReason,
  type HttpRequest,
  type HttpTransport,
} from './grafanaUserStorageAdapter';
import { UserStorageError } from './types';

const PLUGIN = 'ahfuzhang-victoriametricsexplorer-app';
const identity = { namespace: 'default', pluginId: PLUGIN, userUid: 'u1', resourceName: `${PLUGIN}:u1` };
const ITEM = `/apis/userstorage.grafana.app/v0alpha1/namespaces/default/user-storage/${encodeURIComponent(`${PLUGIN}:u1`)}`;

// Response bodies recorded from Grafana 13.2.4 (docs/userstorage_p0.md).
const notFoundResource = {
  kind: 'Status',
  apiVersion: 'v1',
  status: 'Failure',
  reason: 'NotFound',
  details: { name: `${PLUGIN}:u1`, group: 'userstorage.grafana.app', kind: 'user-storage' },
  code: 404,
};
const notFoundRoute = {
  kind: 'Status',
  apiVersion: 'v1',
  status: 'Failure',
  message: 'the server could not find the requested resource',
  reason: 'NotFound',
  details: {},
  code: 404,
};
const resource = (rv: string, data: Record<string, string>) => ({
  kind: 'UserStorage',
  metadata: { name: `${PLUGIN}:u1`, resourceVersion: rv },
  spec: { data },
});

function failing(status: number | undefined, data?: unknown): HttpTransport {
  return async () => {
    throw status === undefined ? { cancelled: true } : { status, data };
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(UserStorageError);
    return (err as UserStorageError).kind;
  }
  return 'resolved';
}

describe('GrafanaUserStorageAdapter', () => {
  it('reads a snapshot, keeping resourceVersion as an opaque string and only string values', async () => {
    const requests: HttpRequest[] = [];
    const adapter = new GrafanaUserStorageAdapter(identity, async (request) => {
      requests.push(request);
      return { status: 200, data: resource('1792659451467995', { a: '1', bad: 3 as unknown as string }) };
    });
    expect(await adapter.loadFresh()).toEqual({ resourceVersion: '1792659451467995', data: { a: '1' } });
    expect(requests[0]).toMatchObject({ url: ITEM, method: 'GET' });
  });

  it('tells a missing resource from a missing API', async () => {
    expect(await new GrafanaUserStorageAdapter(identity, failing(404, notFoundResource)).loadFresh()).toBeNull();
    expect(await kindOf(new GrafanaUserStorageAdapter(identity, failing(404, notFoundRoute)).loadFresh())).toBe(
      'unavailable'
    );
    expect(await kindOf(new GrafanaUserStorageAdapter(identity, failing(404, 'Not found')).loadFresh())).toBe(
      'unavailable'
    );
    const otherName = { ...notFoundResource, details: { ...notFoundResource.details, name: 'someone:else' } };
    expect(await kindOf(new GrafanaUserStorageAdapter(identity, failing(404, otherName)).loadFresh())).toBe(
      'unavailable'
    );
  });

  it('sends a conditional merge patch', async () => {
    const requests: HttpRequest[] = [];
    const adapter = new GrafanaUserStorageAdapter(identity, async (request) => {
      requests.push(request);
      return { status: 200, data: resource('2', { b: 'B' }) };
    });
    expect(await adapter.commit('1', { a: null, b: 'B' })).toEqual({ resourceVersion: '2', data: { b: 'B' } });
    expect(requests[0]).toEqual({
      url: ITEM,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/merge-patch+json' },
      data: { metadata: { resourceVersion: '1' }, spec: { data: { a: null, b: 'B' } } },
    });
  });

  it('refuses a write without a precondition', async () => {
    const transport = jest.fn();
    expect(await kindOf(new GrafanaUserStorageAdapter(identity, transport).commit('', { a: 'b' }))).toBe('rejected');
    expect(transport).not.toHaveBeenCalled();
  });

  it('creates with the SDK-compatible name and labels', async () => {
    const requests: HttpRequest[] = [];
    const adapter = new GrafanaUserStorageAdapter(identity, async (request) => {
      requests.push(request);
      return { status: 201, data: resource('1', { a: '1' }) };
    });
    await adapter.create({ a: '1' });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      data: { metadata: { name: `${PLUGIN}:u1`, labels: { user: 'u1', service: PLUGIN } }, spec: { data: { a: '1' } } },
    });
  });

  it.each([
    [401, undefined, 'unauthenticated'],
    [403, { reason: 'Forbidden' }, 'forbidden'],
    [409, { reason: 'Conflict' }, 'versionConflict'],
    [409, { reason: 'AlreadyExists' }, 'alreadyExists'],
    [404, notFoundResource, 'resourceGone'],
    [404, notFoundRoute, 'unavailable'],
    [400, undefined, 'rejected'],
    [413, undefined, 'rejected'],
    [422, { reason: 'Invalid' }, 'rejected'],
    [429, undefined, 'throttled'],
    [500, undefined, 'uncertain'],
    [503, undefined, 'uncertain'],
    [undefined, undefined, 'uncertain'],
  ])('classifies a write failing with %s %j as %s', async (status, data, kind) => {
    expect(await kindOf(new GrafanaUserStorageAdapter(identity, failing(status, data)).commit('1', {}))).toBe(kind);
  });

  it('treats a success without resourceVersion as uncertain', async () => {
    const adapter = new GrafanaUserStorageAdapter(identity, async () => ({
      status: 200,
      data: { spec: { data: {} } },
    }));
    expect(await kindOf(adapter.commit('1', {}))).toBe('uncertain');
  });
});

describe('identity and host checks', () => {
  it('names the resource like the SDK, falling back to the numeric id', () => {
    expect(currentIdentity(PLUGIN)).toEqual({
      namespace: 'default',
      pluginId: PLUGIN,
      userUid: '42',
      resourceName: `${PLUGIN}:42`,
    });
  });

  it('only writes on verified Grafana versions', () => {
    expect(writeBlockedReason('12.3.1')).toBeNull();
    expect(writeBlockedReason('13.2.4')).toBeNull();
    expect(writeBlockedReason('12.4.0-pre')).toBeNull();
    expect(writeBlockedReason('12.1.10')).toContain('12.3.0');
    expect(writeBlockedReason('11.6.0')).toContain('12.3.0');
    expect(writeBlockedReason('')).toContain('unknown version');
    expect(compareVersions('12.10.0', '12.9.9')).toBeGreaterThan(0);
  });
});
