import { config, getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';

import { MIN_WRITABLE_GRAFANA_VERSION, REQUEST_TIMEOUT_MS } from './limits';
import {
  UserStorageError,
  type UserStorageAdapter,
  type UserStorageErrorKind,
  type UserStorageSnapshot,
} from './types';

// The Grafana User Storage REST API, reached with the signed-in user's session through backendSrv
// (docs/plan_v3.md §4.2). The SDK's usePluginUserStorage() is deliberately not used: it falls back
// to localStorage on errors and writes without a resourceVersion precondition.
//
// Contract measured on Grafana 12.1.10, 12.3.1 and 13.2.4 by tests/userstorage/contract.mjs and
// recorded in docs/userstorage_p0.md.

export const USER_STORAGE_GROUP = 'userstorage.grafana.app';
const API_ROOT = `/apis/${USER_STORAGE_GROUP}/v0alpha1`;

export interface StorageIdentity {
  namespace: string;
  pluginId: string;
  userUid: string;
  /** `<pluginId>:<userUid>`, the only name the server lets this user use for this plugin. */
  resourceName: string;
}

/** The signed-in user's resource, or null for an anonymous session. Matches the SDK's naming. */
export function currentIdentity(pluginId: string): StorageIdentity | null {
  const user = config.bootData?.user;
  if (!user?.isSignedIn) {
    return null;
  }
  const userUid = user.uid === '' || user.uid === undefined ? String(user.id) : user.uid;
  return { namespace: config.namespace, pluginId, userUid, resourceName: `${pluginId}:${userUid}` };
}

/** Identifies one user's resource; page caches, drafts and broadcasts are scoped by it. */
export function identityScope(identity: StorageIdentity): string {
  return `${identity.namespace}:${identity.resourceName}`;
}

/** Why this Grafana cannot be written safely, or null when it can. */
export function writeBlockedReason(version = config.buildInfo?.version ?? ''): string | null {
  if (compareVersions(version, MIN_WRITABLE_GRAFANA_VERSION) >= 0) {
    return null;
  }
  return (
    `Saving favorites needs Grafana ${MIN_WRITABLE_GRAFANA_VERSION} or later (this is ${version || 'an unknown version'}): ` +
    'older versions can let two windows overwrite each other. Saved favorites can still be viewed.'
  );
}

/** Compare dotted numeric versions, ignoring pre-release suffixes; unparsable sorts first. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) {
    return a ? 1 : b ? -1 : 0;
  }
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  data?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  data: unknown;
}

/** Sends one request; rejects with an object carrying `status` and `data` on a non-2xx answer. */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** backendSrv with the session's credentials, no Grafana error toasts and a hard timeout. */
export function backendSrvTransport(timeoutMs = REQUEST_TIMEOUT_MS): HttpTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await lastValueFrom(
        getBackendSrv().fetch<unknown>({
          url: request.url,
          method: request.method,
          data: request.data,
          headers: request.headers,
          showErrorAlert: false,
          showSuccessAlert: false,
          abortSignal: controller.signal,
        })
      );
      return { status: response.status, data: response.data };
    } finally {
      clearTimeout(timer);
    }
  };
}

interface ResourceBody {
  metadata?: { resourceVersion?: unknown };
  spec?: { data?: unknown };
}

interface StatusBody {
  kind?: unknown;
  reason?: unknown;
  details?: { group?: unknown; name?: unknown };
}

export class GrafanaUserStorageAdapter implements UserStorageAdapter {
  private readonly collectionUrl: string;
  private readonly itemUrl: string;

  constructor(
    private readonly identity: StorageIdentity,
    private readonly transport: HttpTransport = backendSrvTransport()
  ) {
    this.collectionUrl = `${API_ROOT}/namespaces/${encodeURIComponent(identity.namespace)}/user-storage`;
    this.itemUrl = `${this.collectionUrl}/${encodeURIComponent(identity.resourceName)}`;
  }

  async loadFresh(): Promise<UserStorageSnapshot | null> {
    try {
      const response = await this.transport({ url: this.itemUrl, method: 'GET' });
      return this.snapshotOf(response.data);
    } catch (err) {
      if (this.isMissingResource(err)) {
        return null;
      }
      throw this.classify(err, 'read');
    }
  }

  async create(data: Record<string, string>): Promise<UserStorageSnapshot> {
    try {
      const response = await this.transport({
        url: `${this.collectionUrl}/`,
        method: 'POST',
        data: {
          metadata: {
            name: this.identity.resourceName,
            // Not checked by the server; kept so the resource looks like one the SDK created.
            labels: { user: this.identity.userUid, service: this.identity.pluginId },
          },
          spec: { data },
        },
      });
      return this.snapshotOf(response.data);
    } catch (err) {
      throw this.classify(err, 'write');
    }
  }

  async commit(expectedResourceVersion: string, changes: Record<string, string | null>): Promise<UserStorageSnapshot> {
    // Every write of this feature is conditional; an unconditional one would bypass §7.4.
    if (typeof expectedResourceVersion !== 'string' || expectedResourceVersion === '') {
      throw new UserStorageError('rejected', 'Refusing to write favorites without a resourceVersion precondition.');
    }
    try {
      const response = await this.transport({
        url: this.itemUrl,
        method: 'PATCH',
        headers: { 'Content-Type': 'application/merge-patch+json' },
        data: { metadata: { resourceVersion: expectedResourceVersion }, spec: { data: changes } },
      });
      return this.snapshotOf(response.data);
    } catch (err) {
      throw this.classify(err, 'write');
    }
  }

  private snapshotOf(body: unknown): UserStorageSnapshot {
    const resource = (body ?? {}) as ResourceBody;
    const resourceVersion = resource.metadata?.resourceVersion;
    if (typeof resourceVersion !== 'string' || resourceVersion === '') {
      throw new UserStorageError('uncertain', 'The server answered without a resourceVersion.');
    }
    const data: Record<string, string> = {};
    const raw = resource.spec?.data;
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
          data[key] = value;
        }
      }
    }
    return { resourceVersion, data };
  }

  /** 404 carrying a Kubernetes Status for exactly this resource: the API works, the resource is new. */
  private isMissingResource(err: unknown): boolean {
    const { status, data } = errorParts(err);
    const body = (data ?? {}) as StatusBody;
    return (
      status === 404 &&
      body.kind === 'Status' &&
      body.reason === 'NotFound' &&
      body.details?.group === USER_STORAGE_GROUP &&
      body.details?.name === this.identity.resourceName
    );
  }

  private classify(err: unknown, phase: 'read' | 'write'): UserStorageError {
    if (err instanceof UserStorageError) {
      return err;
    }
    const { status, data, message } = errorParts(err);
    const reason = ((data ?? {}) as StatusBody).reason;
    const kind = classifyStatus(status, reason, phase === 'write' && this.isMissingResource(err));
    return new UserStorageError(kind, describeFailure(kind, status, message), status);
  }
}

function classifyStatus(status: number | undefined, reason: unknown, resourceGone: boolean): UserStorageErrorKind {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 409:
      return reason === 'AlreadyExists' ? 'alreadyExists' : 'versionConflict';
    case 404:
      return resourceGone ? 'resourceGone' : 'unavailable';
    case 400:
    case 413:
    case 422:
      return 'rejected';
    case 429:
      return 'throttled';
    default:
      // No status (timeout, abort, network) or 5xx: the server may have applied the write.
      return 'uncertain';
  }
}

function errorParts(err: unknown): { status?: number; data?: unknown; message: string } {
  if (!err || typeof err !== 'object') {
    return { message: String(err) };
  }
  const e = err as { status?: unknown; data?: unknown; message?: unknown; statusText?: unknown };
  const dataMessage = (e.data as { message?: unknown } | undefined)?.message;
  return {
    status: typeof e.status === 'number' ? e.status : undefined,
    data: e.data,
    message:
      typeof dataMessage === 'string'
        ? dataMessage
        : typeof e.message === 'string'
          ? e.message
          : typeof e.statusText === 'string'
            ? e.statusText
            : '',
  };
}

function describeFailure(kind: UserStorageErrorKind, status: number | undefined, detail: string): string {
  const suffix = detail ? ` (${detail})` : status ? ` (HTTP ${status})` : '';
  switch (kind) {
    case 'unavailable':
      return `Grafana User Storage is not available on this server${suffix}.`;
    case 'unauthenticated':
      return 'Your Grafana session has expired. Sign in again and retry.';
    case 'forbidden':
      return `Grafana refused access to your favorites${suffix}.`;
    case 'versionConflict':
      return 'Favorites were changed in another window.';
    case 'alreadyExists':
      return 'Favorites were created in another window.';
    case 'resourceGone':
      return 'Favorites were deleted on the server.';
    case 'rejected':
      return `Grafana rejected the request${suffix}.`;
    case 'throttled':
      return 'Grafana is busy; retrying shortly.';
    case 'uncertain':
      return `No answer from Grafana${suffix}.`;
  }
}
