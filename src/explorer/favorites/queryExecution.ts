import { TimeRange, rangeUtil } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';

import type { QueryStatement } from '../../generated/explorer/user_storage_pb';
import { CHART_MAX_DATA_POINTS, queryRange, type RangeQueryResult } from '../api';
import { updateStatement } from './drafts';
import type { DatasourceOption } from './FavoritesProvider';
import { MAX_CONCURRENT_STATEMENTS } from './limits';
import { templateVariableIn } from './validation';

// Running saved statements (docs/plan_v3.md §8.1, §8.4): each statement is one query-range call on
// the toolbar's datasource; the saved expression is never rebuilt from its browse source.

/**
 * A saved statement as it runs: on the datasource selected in the toolbar, so one favorite can be
 * looked at on any datasource. The datasource it was saved with is used only when the toolbar has
 * none, e.g. when no datasource could be listed.
 */
export function onDatasource(statement: QueryStatement, datasource: DatasourceOption | undefined): QueryStatement {
  if (!datasource || datasource.uid === statement.datasourceUid) {
    return statement;
  }
  return updateStatement(statement, { datasourceUid: datasource.uid, datasourceNameHint: datasource.name });
}

// The backend's query-range step rule (pkg/resource/query_range.go, rangeQueryStep): steps a too
// small step is raised to, in seconds.
const NICE_STEPS = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const STEP_PATTERN = /^([1-9][0-9]*)(ms|s|m|h|d|w|y)$/;
const STEP_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 7 * 86400,
  y: 365 * 86400,
};

/**
 * The step saved statements run with, worked out as the backend would: the toolbar's step, 1m for
 * auto, raised to the next round step when the range would need more than CHART_MAX_DATA_POINTS
 * points. Knowing it before the request lets a statement's rate window follow it; sent as is, the
 * backend keeps it. The browse chart's auto step (the metric's sample interval) needs a single
 * metric selector, which an arbitrary expression does not have.
 */
export function statementStep(toolbarStep: string, range: TimeRange): string {
  const match = STEP_PATTERN.exec(toolbarStep);
  let seconds = match ? Math.max(Math.ceil(Number(match[1]) * STEP_UNIT_SECONDS[match[2]]), 1) : 60;
  const minimum = Math.ceil((range.to.valueOf() - range.from.valueOf()) / 1000 / CHART_MAX_DATA_POINTS);
  if (seconds < minimum) {
    seconds = NICE_STEPS.find((nice) => nice >= minimum) ?? minimum;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600}h`;
  }
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** The absolute range to run with now: a relative range ("last 1h") is recomputed so each run moves "now". */
export function resolveRange(range: TimeRange): TimeRange {
  if (typeof range.raw.from === 'string' || typeof range.raw.to === 'string') {
    return rangeUtil.convertRawToRange(range.raw, 'browser');
  }
  return range;
}

/** Runs at most `max` tasks at once; queued tasks whose signal aborts leave the queue. */
export class Limiter {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw abortError();
    }
    if (this.active < this.max) {
      this.active++;
    } else {
      // A finishing task hands its slot straight to the next waiter, so `active` never overshoots.
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          this.waiting = this.waiting.filter((waiter) => waiter !== start);
          reject(abortError());
        };
        this.waiting.push(start);
        signal?.addEventListener('abort', cancel, { once: true });
      });
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}

function abortError(): Error {
  const error = new Error('The query was cancelled.');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof Error && err.name === 'AbortError') ||
    (typeof err === 'object' && err !== null && (err as { cancelled?: unknown }).cancelled === true)
  );
}

/** Saved runs and try-runs share one queue so a page never has more than MAX_CONCURRENT_STATEMENTS in flight. */
const statementLimiter = new Limiter(MAX_CONCURRENT_STATEMENTS);

export type StatementErrorKind = 'template' | 'datasource';

/** A statement that cannot be sent at all; query failures surface as the API's own errors. */
export class StatementError extends Error {
  constructor(
    readonly kind: StatementErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'StatementError';
  }
}

/** Whether the statement's datasource exists and this user can see it. */
export function datasourceAvailable(uid: string): boolean {
  return uid !== '' && getDataSourceSrv().getInstanceSettings(uid) != null;
}

export function datasourceName(statement: QueryStatement): string {
  return getDataSourceSrv().getInstanceSettings(statement.datasourceUid)?.name ?? statement.datasourceNameHint;
}

export async function runStatement(
  statement: QueryStatement,
  range: TimeRange,
  step: string,
  signal?: AbortSignal
): Promise<RangeQueryResult> {
  const variable = templateVariableIn(statement.expression);
  if (variable) {
    throw new StatementError(
      'template',
      `${variable} is a dashboard variable, which is not expanded here. Replace it with a real value (e.g. [5m]) in the expression.`
    );
  }
  if (!datasourceAvailable(statement.datasourceUid)) {
    throw new StatementError(
      'datasource',
      `Datasource “${statement.datasourceNameHint || statement.datasourceUid}” is not available: it was deleted or you cannot access it. Select a datasource in the toolbar.`
    );
  }
  return statementLimiter.run(
    () =>
      queryRange(statement.datasourceUid, {
        expr: statement.expression,
        step,
        range,
        abortSignal: signal,
      }),
    signal
  );
}
