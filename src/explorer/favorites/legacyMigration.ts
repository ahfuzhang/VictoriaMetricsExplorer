import { create } from '@bufbuild/protobuf';

import {
  NodeKind,
  QueryStatementSchema,
  VisualizationKind,
  type SavedQuery,
} from '../../generated/explorer/user_storage_pb';
import { newQuery } from './drafts';
import { MAX_QUERIES_PER_FAVORITE } from './limits';
import type { MenuNode } from './menuModel';
import type { SnapshotView } from './snapshotView';
import { normalizeName } from './validation';

// One-time import of the favorites the previous version kept in this browser (docs/plan_v3.md
// §10.2). The old list holds bare metric names, not tied to a user, organization or datasource, so
// it is only read when the user asks, and only written to the server after they confirm. The old
// key is never changed or removed here.

export const LEGACY_FAVORITES_KEY = 'vm_explorer_favorites';
export const IMPORT_FOLDER_NAME = 'Imported favorites';

/** The old list of metric names. Only call this after the user asked to import. */
export function readLegacyFavorites(): { metrics: string[]; error?: string } {
  try {
    const raw = window.localStorage.getItem(LEGACY_FAVORITES_KEY);
    if (!raw) {
      return { metrics: [] };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return { metrics: [], error: 'The stored list is not a list of metric names.' };
    }
    const metrics = parsed.filter((value): value is string => typeof value === 'string' && value.trim() !== '');
    return { metrics: [...new Set(metrics.map((metric) => metric.trim()))] };
  } catch (err) {
    return { metrics: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A query for one old favorite: its name and the bare metric as expression. The old favorites kept
 * no browse mode, filters, rate or heatmap setting, so none are restored.
 */
export function legacyQuery(metric: string, datasource: { uid: string; name: string }): SavedQuery {
  return newQuery(metric, [
    create(QueryStatementSchema, {
      expression: metric,
      datasourceUid: datasource.uid,
      datasourceNameHint: datasource.name,
      unitId: 'none',
      visualization: VisualizationKind.TIMESERIES,
      sourceMetric: metric,
    }),
  ]);
}

function duplicateKey(expression: string, datasourceUid: string): string {
  return `${datasourceUid}\n${expression.trim()}`;
}

/** Single-statement queries already in the import folder, by expression and datasource. */
export async function importedKeys(view: SnapshotView, folder: MenuNode | undefined): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!folder) {
    return keys;
  }
  for (const child of folder.children) {
    if (child.kind !== NodeKind.FAVORITE || child.draft) {
      continue;
    }
    const read = await view.content(BigInt(child.ref));
    if (read.state !== 'ok') {
      continue;
    }
    for (const query of read.content.queries) {
      if (query.statements.length === 1) {
        keys.add(duplicateKey(query.statements[0].expression, query.statements[0].datasourceUid));
      }
    }
  }
  return keys;
}

/** The queries of a batch not yet in the import folder; a batch whose earlier save was unconfirmed is not repeated. */
export function notYetImported(batch: SavedQuery[], existing: Set<string>): SavedQuery[] {
  return batch.filter((query) => {
    const [statement] = query.statements;
    return !existing.has(duplicateKey(statement.expression, statement.datasourceUid));
  });
}

export interface ImportPlan {
  /** One query per favorite to create, at most MAX_QUERIES_PER_FAVORITE per batch. */
  batches: SavedQuery[][];
  skipped: string[];
}

/** Drop metrics already imported for this datasource and group the rest by favorite. */
export function planImport(
  metrics: string[],
  datasource: { uid: string; name: string },
  existing: Set<string>
): ImportPlan {
  const skipped: string[] = [];
  const queries: SavedQuery[] = [];
  for (const metric of metrics) {
    if (existing.has(duplicateKey(metric, datasource.uid))) {
      skipped.push(metric);
    } else {
      queries.push(legacyQuery(metric, datasource));
    }
  }
  const batches: SavedQuery[][] = [];
  for (let index = 0; index < queries.length; index += MAX_QUERIES_PER_FAVORITE) {
    batches.push(queries.slice(index, index + MAX_QUERIES_PER_FAVORITE));
  }
  return { batches, skipped };
}

/** The import folder at the root, if there is one. */
export function findImportFolder(nodes: MenuNode[], name: string): MenuNode | undefined {
  const wanted = normalizeName(name);
  return nodes.find((node) => node.kind === NodeKind.FOLDER && normalizeName(node.name) === wanted);
}
