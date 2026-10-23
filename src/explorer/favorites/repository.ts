import { CodecError, MENU_KEY, encodeContent, encodeTree } from './codec';
import { MAX_COMMIT_ATTEMPTS, MAX_RESOURCE_JSON_BYTES } from './limits';
import { replay, type ReplayResult } from './replay';
import { DecodeCache, SnapshotView } from './snapshotView';
import {
  FavoritesBusy,
  FavoritesConflict,
  FavoritesTooLarge,
  FavoritesUncertain,
  UserStorageError,
  type IdMap,
  type Operation,
  type UserStorageAdapter,
  type UserStorageErrorKind,
} from './types';
import { utf8Length } from './validation';

export interface CommitResult {
  /** The server's data after the commit (or as read, when the batch had already happened). */
  view: SnapshotView;
  idMap: IdMap;
  /** Nothing was written: the server already held the result (§7.5). */
  alreadyApplied: boolean;
}

export interface RepositoryOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Errors after which a fresh read and replay may still succeed. */
const RETRYABLE: ReadonlySet<UserStorageErrorKind> = new Set([
  'versionConflict',
  'alreadyExists',
  'resourceGone',
  'throttled',
  'uncertain',
]);

// Rough size of the metadata Grafana keeps next to spec.data, counted against the resource budget.
const METADATA_ALLOWANCE = 2048;

/**
 * Reads and commits favorites (docs/plan_v3.md §7.3, §7.4.3). Commits of one page run one at a
 * time; across windows and browsers the resourceVersion precondition keeps them apart.
 */
export class FavoritesRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly adapter: UserStorageAdapter,
    readonly cache = new DecodeCache(),
    options: RepositoryOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /** Read the server's current data; never answered from page memory. */
  async loadFresh(): Promise<SnapshotView> {
    return new SnapshotView(await this.adapter.loadFresh(), this.cache);
  }

  /**
   * Apply a batch of operations to the server's latest data. base is what the user saw when the
   * editor opened. Throws FavoritesConflict, FavoritesUncertain, FavoritesBusy, FavoritesTooLarge
   * or a non-retryable UserStorageError.
   */
  commit(ops: Operation[], base: SnapshotView | null): Promise<CommitResult> {
    const run = () => this.commitNow(ops, base);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async commitNow(ops: Operation[], base: SnapshotView | null): Promise<CommitResult> {
    let lastError: UserStorageError | undefined;
    let unconfirmedWrite = false;
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await this.sleep((100 + this.random() * 300) * (attempt - 1));
      }
      let latest: SnapshotView;
      try {
        latest = await this.loadFresh();
      } catch (err) {
        if (err instanceof UserStorageError && RETRYABLE.has(err.kind)) {
          lastError = err;
          continue;
        }
        throw err;
      }

      const plan = await replay(ops, base, latest.snapshot ? latest : null, this.now());
      if (plan.kind === 'alreadyApplied') {
        return { view: latest, idMap: plan.idMap, alreadyApplied: true };
      }
      if (plan.kind === 'conflict') {
        throw new FavoritesConflict(plan.conflict, latest.snapshot);
      }

      const { changes, data } = await encodeChanges(plan, latest);
      try {
        const snapshot = latest.snapshot
          ? await this.adapter.commit(latest.snapshot.resourceVersion, changes)
          : await this.adapter.create(data);
        return { view: new SnapshotView(snapshot, this.cache), idMap: plan.idMap, alreadyApplied: false };
      } catch (err) {
        if (!(err instanceof UserStorageError) || !RETRYABLE.has(err.kind)) {
          throw err;
        }
        lastError = err;
        unconfirmedWrite ||= err.kind === 'uncertain';
      }
    }
    if (unconfirmedWrite) {
      throw new FavoritesUncertain();
    }
    if (lastError && lastError.kind !== 'versionConflict' && lastError.kind !== 'alreadyExists') {
      throw lastError;
    }
    throw new FavoritesBusy();
  }
}

/** Encode the keys a plan writes and check the resource stays within its budget. */
async function encodeChanges(
  plan: Extract<ReplayResult, { kind: 'apply' }>,
  latest: SnapshotView
): Promise<{ changes: Record<string, string | null>; data: Record<string, string> }> {
  const changes: Record<string, string | null> = {};
  try {
    if (plan.tree) {
      changes[MENU_KEY] = await encodeTree(plan.tree);
    }
    for (const [key, content] of plan.contents) {
      changes[key] = content ? await encodeContent(content) : null;
    }
  } catch (err) {
    if (err instanceof CodecError && err.kind === 'tooLarge') {
      throw new FavoritesTooLarge(err.message);
    }
    throw err;
  }

  const data: Record<string, string> = { ...latest.data };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) {
      delete data[key];
    } else {
      data[key] = value;
    }
  }
  const after = resourceSize(data);
  // A change that does not grow the resource (deletes, renames) stays possible over the budget.
  if (after > MAX_RESOURCE_JSON_BYTES && after > resourceSize(latest.data)) {
    throw new FavoritesTooLarge(
      `Saving would grow your favorites to ${Math.ceil(after / 1024)} KiB; at most ${MAX_RESOURCE_JSON_BYTES / 1024} KiB are allowed. Delete some queries first.`
    );
  }
  return { changes, data };
}

function resourceSize(data: Record<string, string>): number {
  return utf8Length(JSON.stringify({ spec: { data } })) + METADATA_ALLOWANCE;
}
