import { config } from '@grafana/runtime';

const STREAM_TYPE = 'application/x-ndjson';
// Keep HTTP/1.1 connections available for the proxy requests and their replies.
const MAX_OPEN_STREAMS = 3;
const openStreams = new Set<Promise<void>>();

type OAuthEvent = { id: string; path: string; maxBytes: number } | { status: number; body?: string };

/** Run datasource proxy requests in the current Grafana session and return the Explorer response. */
export async function fetchWithOAuthSession(url: string, callback: string, uid: string, init: RequestInit) {
  while (openStreams.size >= MAX_OPEN_STREAMS) {
    init.signal?.throwIfAborted();
    await Promise.race(openStreams);
  }
  init.signal?.throwIfAborted();
  let release!: () => void;
  const stream = new Promise<void>((resolve) => {
    release = resolve;
  });
  openStreams.add(stream);
  try {
    return await requestInSession(url, callback, uid, init);
  } finally {
    openStreams.delete(stream);
    release();
  }
}

async function requestInSession(url: string, callback: string, uid: string, init: RequestInit) {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const headers = new Headers(init.headers);
  headers.set('Accept', STREAM_TYPE);
  const org = String(config.bootData.user.orgId);
  headers.set('X-Grafana-Org-Id', org);
  const settings: RequestInit = { signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' };
  let relayError: unknown;

  async function reply(event: Extract<OAuthEvent, { id: string }>) {
    const prefix = `/api/datasources/proxy/uid/${uid}/api/v1/`;
    const target = new URL(config.appSubUrl + event.path, window.location.origin);
    if (target.origin !== window.location.origin || !target.pathname.startsWith(config.appSubUrl + prefix)) {
      throw new Error('Invalid OAuth datasource proxy path');
    }

    let status: number;
    let body: Blob | string;
    try {
      const response = await fetch(target, { ...settings, headers: { 'X-Grafana-Org-Id': org } });
      status = response.status;
      body = await readProxyBody(response, event.maxBytes);
    } catch (err) {
      if (signal.aborted) {
        throw err;
      }
      status = 502;
      body = err instanceof Error ? err.message : 'Could not read the datasource response';
    }
    const response = await fetch(`${config.appSubUrl}${callback}/${encodeURIComponent(event.id)}`, {
      ...settings,
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Grafana-Org-Id': org,
        'X-Explorer-Upstream-Status': String(status),
      },
      body,
    });
    // A timed-out upstream request may already have been removed from the backend.
    if (!response.ok && response.status !== 404) {
      throw new Error(`Grafana could not return the datasource response (HTTP ${response.status})`);
    }
  }

  try {
    const response = await fetch(config.appSubUrl + url, { ...init, ...settings, headers });
    if (!response.ok || !response.body || response.headers.get('Content-Type') !== STREAM_TYPE) {
      return { status: response.status, data: await response.arrayBuffer() };
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          throw new Error('Grafana ended the OAuth request before returning a result');
        }
        const lines = (buffer + value).split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const event: OAuthEvent = JSON.parse(line);
          if ('status' in event) {
            const bytes = Uint8Array.from(atob(event.body ?? ''), (character) => character.charCodeAt(0));
            return { status: event.status, data: bytes.buffer };
          }
          void reply(event).catch((error) => {
            if (!signal.aborted) {
              relayError = error;
              controller.abort();
            }
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    throw relayError ?? err;
  } finally {
    controller.abort();
  }
}

async function readProxyBody(response: Response, maxBytes: number): Promise<Blob> {
  if (!response.body) {
    return new Blob();
  }
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return new Blob(chunks);
      }
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error('Datasource response exceeds the Explorer response size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
