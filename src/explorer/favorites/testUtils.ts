import { create } from '@bufbuild/protobuf';

import {
  NodeKind,
  QueryStatementSchema,
  SavedQuerySchema,
  TreeNodeSchema,
  TreeSchema,
  VisualizationKind,
  FavoriteContentSchema,
  type SavedQuery,
  type Tree,
  type TreeNode,
} from '../../generated/explorer/user_storage_pb';
import { MENU_KEY, SCHEMA_VERSION, contentKey, encodeContent, encodeTree } from './codec';
import { DecodeCache, SnapshotView } from './snapshotView';
import {
  UserStorageError,
  type UserStorageAdapter,
  type UserStorageErrorKind,
  type UserStorageSnapshot,
} from './types';

// Test helpers only; nothing in the app imports this file.

export function statement(expression = 'up', datasourceUid = 'ds1') {
  return create(QueryStatementSchema, {
    expression,
    datasourceUid,
    unitId: 'none',
    visualization: VisualizationKind.TIMESERIES,
  });
}

export function query(id: string, name = id, expression = 'up'): SavedQuery {
  return create(SavedQuerySchema, { id, name, statements: [statement(expression)] });
}

export function folder(id: number, name: string, children: TreeNode[] = []): TreeNode {
  return create(TreeNodeSchema, { id: BigInt(id), name, kind: NodeKind.FOLDER, children });
}

export function favorite(id: number, name: string): TreeNode {
  return create(TreeNodeSchema, { id: BigInt(id), name, kind: NodeKind.FAVORITE });
}

export function tree(maxId: number, children: TreeNode[]): Tree {
  return create(TreeSchema, { schemaVersion: SCHEMA_VERSION, maxTreeNodeId: BigInt(maxId), children });
}

/** Encode a menu and the queries of its favorites into a resource's data map. */
export async function encodeData(
  menu: Tree,
  contents: Record<number, SavedQuery[]>,
  extra: Record<string, string> = {}
): Promise<Record<string, string>> {
  const data: Record<string, string> = { ...extra, [MENU_KEY]: await encodeTree(menu) };
  for (const [id, queries] of Object.entries(contents)) {
    data[contentKey(BigInt(id))] = await encodeContent(
      create(FavoriteContentSchema, { schemaVersion: SCHEMA_VERSION, nodeId: BigInt(id), queries })
    );
  }
  return data;
}

export async function view(
  menu: Tree,
  contents: Record<number, SavedQuery[]>,
  resourceVersion = '1',
  extra: Record<string, string> = {}
): Promise<SnapshotView> {
  return new SnapshotView({ resourceVersion, data: await encodeData(menu, contents, extra) }, new DecodeCache());
}

type FaultMode = 'before' | 'after' | 'delayed';

interface Fault {
  call: 'load' | 'create' | 'commit';
  kind: UserStorageErrorKind;
  /** before: fail without applying; after: apply, then lose the response; delayed: apply later on deliver(). */
  mode: FaultMode;
}

/** An in-memory User Storage resource with Grafana's resourceVersion semantics. */
export class FakeUserStorageServer {
  resource: UserStorageSnapshot | null = null;
  writes = 0;
  private version = 100;
  private faults: Fault[] = [];
  private delayed: Array<() => UserStorageSnapshot> = [];
  /** Runs just before a write is checked, e.g. to let another window write first. */
  beforeWrite?: () => Promise<void> | void;

  fail(call: Fault['call'], kind: UserStorageErrorKind, mode: FaultMode = 'before', times = 1): void {
    for (let index = 0; index < times; index++) {
      this.faults.push({ call, kind, mode });
    }
  }

  /** Let the delayed writes reach the "database" now; returns the errors they would have got. */
  deliver(): Array<UserStorageSnapshot | UserStorageError> {
    const results = this.delayed.map((write) => {
      try {
        return write();
      } catch (err) {
        return err as UserStorageError;
      }
    });
    this.delayed = [];
    return results;
  }

  adapter(): UserStorageAdapter {
    return {
      loadFresh: async () => {
        this.takeFault('load', () => undefined);
        return this.resource ? copy(this.resource) : null;
      },
      create: async (data) => {
        await this.beforeWrite?.();
        const apply = () => {
          if (this.resource) {
            throw new UserStorageError('alreadyExists', 'exists', 409);
          }
          this.resource = { resourceVersion: this.nextVersion(), data: { ...data } };
          this.writes++;
          return copy(this.resource);
        };
        return this.takeFault('create', apply) ?? apply();
      },
      commit: async (expected, changes) => {
        if (!expected) {
          throw new UserStorageError('rejected', 'no precondition');
        }
        await this.beforeWrite?.();
        const apply = () => {
          if (!this.resource) {
            throw new UserStorageError('resourceGone', 'gone', 404);
          }
          if (this.resource.resourceVersion !== expected) {
            throw new UserStorageError('versionConflict', 'conflict', 409);
          }
          const data = { ...this.resource.data };
          for (const [key, value] of Object.entries(changes)) {
            if (value === null) {
              delete data[key];
            } else {
              data[key] = value;
            }
          }
          this.resource = { resourceVersion: this.nextVersion(), data };
          this.writes++;
          return copy(this.resource);
        };
        return this.takeFault('commit', apply) ?? apply();
      },
    };
  }

  private takeFault(
    call: Fault['call'],
    apply: () => UserStorageSnapshot | undefined
  ): UserStorageSnapshot | undefined {
    const index = this.faults.findIndex((fault) => fault.call === call);
    if (index < 0) {
      return undefined;
    }
    const [fault] = this.faults.splice(index, 1);
    if (fault.mode === 'after') {
      apply();
    } else if (fault.mode === 'delayed') {
      this.delayed.push(() => apply() as UserStorageSnapshot);
    }
    throw new UserStorageError(fault.kind, `injected ${fault.kind}`);
  }

  private nextVersion(): string {
    this.version += 1;
    return String(this.version);
  }
}

function copy(snapshot: UserStorageSnapshot): UserStorageSnapshot {
  return { resourceVersion: snapshot.resourceVersion, data: { ...snapshot.data } };
}
