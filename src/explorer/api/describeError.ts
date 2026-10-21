const MAX_DETAIL_LENGTH = 300;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DETAIL_LENGTH ? `${oneLine.slice(0, MAX_DETAIL_LENGTH)}…` : oneLine;
}

function stringify(value: unknown): string {
  try {
    return clip(JSON.stringify(value) ?? String(value));
  } catch {
    return clip(String(value));
  }
}

/**
 * Turn whatever a failed request throws into readable text that says what failed and where.
 *
 * Grafana's fetch rejects with a FetchError ({ status, statusText, data, config }) that has no
 * `message` of its own. `data` is the app backend's `{ code, message, requestId }`, Grafana's own
 * `{ message, traceID }`, or a plain-text/HTML body from a proxy in between. The result looks like
 *
 *   cannot read labels from the datasource: … (HTTP 502 · upstream_error · GET /api/plugins/… · request 3f2a…)
 *
 * and never degrades to "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err == null) {
    return 'unknown error';
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err !== 'object') {
    return String(err);
  }

  const e = err as {
    status?: number;
    statusText?: string;
    data?: unknown;
    config?: { url?: string; method?: string };
    cancelled?: boolean;
    message?: unknown;
    name?: string;
  };

  if (e.cancelled) {
    return 'the request was cancelled';
  }

  const data = e.data;
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;

  let detail = '';
  if (body) {
    const fromBody = body.message ?? body.error;
    detail = typeof fromBody === 'string' ? fromBody : fromBody != null ? stringify(fromBody) : stringify(body);
  } else if (typeof data === 'string' && data.trim() !== '') {
    detail = clip(data);
  }
  if (!detail && typeof e.message === 'string') {
    detail = e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message;
  }
  if (!detail) {
    detail = e.statusText || (e.status === 0 ? 'no response from Grafana (network error or blocked request)' : '');
  }
  if (!detail) {
    detail = stringify(err);
  }

  const where: string[] = [];
  if (e.status) {
    where.push(`HTTP ${e.status}`);
  }
  if (typeof body?.code === 'string') {
    where.push(body.code);
  }
  if (e.config?.url) {
    where.push(`${e.config.method ?? 'GET'} ${e.config.url}`);
  }
  const id = body?.requestId ?? body?.traceID;
  if (typeof id === 'string' && id) {
    where.push(`request ${id}`);
  }

  return where.length > 0 ? `${detail} (${where.join(' · ')})` : detail;
}
