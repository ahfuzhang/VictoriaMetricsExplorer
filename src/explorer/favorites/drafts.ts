import { clone, create } from '@bufbuild/protobuf';

import {
  QueryStatementSchema,
  SavedLabelFilterSchema,
  SavedQuerySchema,
  SourceScope,
  VisualizationKind,
  type QueryStatement,
  type SavedQuery,
} from '../../generated/explorer/user_storage_pb';
import { FavoritesBusy, FavoritesConflict, FavoritesTooLarge, FavoritesUncertain, UserStorageError } from './types';

// Building and changing draft queries in the editors. Messages in React state are never mutated:
// every change clones (which also keeps unknown fields of newer versions).

export function updateStatement(
  statement: QueryStatement,
  patch: Partial<Omit<QueryStatement, '$typeName'>>
): QueryStatement {
  return Object.assign(clone(QueryStatementSchema, statement), patch);
}

export function updateQuery(query: SavedQuery, patch: Partial<Omit<SavedQuery, '$typeName'>>): SavedQuery {
  return Object.assign(clone(SavedQuerySchema, query), patch);
}

/** A hand-written statement: time series, no unit, no browse source. */
export function newStatement(datasourceUid: string, datasourceNameHint: string): QueryStatement {
  return create(QueryStatementSchema, {
    datasourceUid,
    datasourceNameHint,
    unitId: 'none',
    visualization: VisualizationKind.TIMESERIES,
  });
}

/** A new query; its UUID is made now and kept through retries (§7.4.2). */
export function newQuery(name: string, statements: QueryStatement[]): SavedQuery {
  return create(SavedQuerySchema, { id: crypto.randomUUID(), name, statements });
}

/** Label filters as stored: labels without values dropped, labels and values sorted. */
export function savedFilters(filters: Record<string, string[]>) {
  return Object.keys(filters)
    .filter((name) => filters[name].length > 0)
    .sort()
    .map((name) => create(SavedLabelFilterSchema, { name, values: [...new Set(filters[name])].sort() }));
}

const SCOPE_LABELS: Record<SourceScope, string> = {
  [SourceScope.UNSPECIFIED]: '',
  [SourceScope.BY_NAME]: 'By Name',
  [SourceScope.BY_POD]: 'By Pod',
  [SourceScope.BY_NODE]: 'By Node',
};

/** "By Pod · api-server · namespace = prod", or null for a hand-written statement. */
export function describeSource(statement: QueryStatement): string | null {
  if (statement.sourceScope === SourceScope.UNSPECIFIED) {
    return null;
  }
  const parts = [SCOPE_LABELS[statement.sourceScope] ?? 'Unknown'];
  if (statement.sourceScope === SourceScope.BY_NAME) {
    parts.push(statement.sourceScopeValue || 'All metrics');
  } else {
    parts.push(statement.sourceScopeValue);
  }
  for (const filter of statement.sourceFilters) {
    parts.push(
      filter.values.length === 1
        ? `${filter.name} = ${filter.values[0]}`
        : `${filter.name} ∈ {${filter.values.join(', ')}}`
    );
  }
  return parts.join(' · ');
}

/** A short title for a statement's chart: its source metric, else the start of its expression. */
export function statementTitle(statement: QueryStatement): string {
  if (statement.sourceMetric) {
    return statement.sourceMetric;
  }
  const expression = statement.expression.replace(/\s+/g, ' ').trim();
  return expression.length > 80 ? `${expression.slice(0, 77)}…` : expression || '(empty expression)';
}

export type CommitFailureKind = 'conflict' | 'uncertain' | 'busy' | 'tooLarge' | 'session' | 'other';

export interface CommitFailure {
  kind: CommitFailureKind;
  title: string;
  message: string;
  error: unknown;
}

/** How a failed save is explained; the draft always stays open. */
export function describeCommitFailure(error: unknown): CommitFailure {
  if (error instanceof FavoritesConflict) {
    return { kind: 'conflict', title: 'Favorites changed on the server', message: error.message, error };
  }
  if (error instanceof FavoritesUncertain) {
    return {
      kind: 'uncertain',
      title: 'Save not confirmed',
      message:
        'Grafana did not answer, so it is unknown whether the change was stored. Check again to find out; nothing is saved twice.',
      error,
    };
  }
  if (error instanceof FavoritesBusy) {
    return { kind: 'busy', title: 'Favorites are busy', message: error.message, error };
  }
  if (error instanceof FavoritesTooLarge) {
    return { kind: 'tooLarge', title: 'Too large to save', message: error.message, error };
  }
  if (error instanceof UserStorageError && error.kind === 'unauthenticated') {
    return {
      kind: 'session',
      title: 'Signed out',
      message: 'Your Grafana session expired. Sign in again in another tab, then retry; your changes stay here.',
      error,
    };
  }
  return {
    kind: 'other',
    title: 'Not saved',
    message: error instanceof Error ? error.message : String(error),
    error,
  };
}
