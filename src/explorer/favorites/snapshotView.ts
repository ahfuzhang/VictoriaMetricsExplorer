import type { FavoriteContent, Tree } from '../../generated/explorer/user_storage_pb';
import { CodecError, MENU_KEY, contentKey, decodeContent, decodeTree, emptyTree } from './codec';
import { MAX_DECODED_CACHE_BYTES } from './limits';
import type { UserStorageSnapshot } from './types';
import { checkTree, contentProblems } from './validation';

export type MenuRead =
  { state: 'ok'; tree: Tree; overLimit: string[] } | { state: 'corrupt'; message: string; newerVersion: boolean };

export type ContentRead =
  | { state: 'ok'; content: FavoriteContent }
  | { state: 'missing' }
  | { state: 'corrupt'; message: string; newerVersion: boolean };

/**
 * Decoded values by stored string, so a value nobody changed is decoded once per page. Bounded by
 * the Base64 size of its entries and evicted least recently used. Lives in page memory only.
 * Decoded messages are shared: callers clone before changing them.
 */
export class DecodeCache {
  private entries = new Map<string, { size: number; value: Promise<unknown> }>();
  private size = 0;

  constructor(private readonly maxBytes = MAX_DECODED_CACHE_BYTES) {}

  get<T>(key: string, raw: string, decode: (raw: string) => Promise<T>): Promise<T> {
    const id = `${key}\n${raw}`;
    const hit = this.entries.get(id);
    if (hit) {
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit.value as Promise<T>;
    }
    const value = decode(raw);
    const entry = { size: raw.length, value };
    this.entries.set(id, entry);
    this.size += entry.size;
    for (const [oldest, old] of this.entries) {
      if (this.size <= this.maxBytes || oldest === id) {
        break;
      }
      this.entries.delete(oldest);
      this.size -= old.size;
    }
    return value;
  }
}

/** A snapshot of the resource with lazily decoded menu and contents. */
export class SnapshotView {
  constructor(
    /** null: the resource does not exist yet. */
    readonly snapshot: UserStorageSnapshot | null,
    private readonly cache: DecodeCache
  ) {}

  get resourceVersion(): string | null {
    return this.snapshot?.resourceVersion ?? null;
  }

  get data(): Record<string, string> {
    return this.snapshot?.data ?? {};
  }

  raw(key: string): string | undefined {
    return this.snapshot?.data[key];
  }

  /** The menu; a missing menu key is an empty menu (first use). */
  async menu(): Promise<MenuRead> {
    const raw = this.raw(MENU_KEY);
    if (raw === undefined) {
      return { state: 'ok', tree: emptyTree(), overLimit: [] };
    }
    try {
      const tree = await this.cache.get(MENU_KEY, raw, decodeTree);
      const check = checkTree(tree);
      if (check.structural.length > 0) {
        return { state: 'corrupt', message: check.structural.join(' '), newerVersion: false };
      }
      return { state: 'ok', tree, overLimit: check.overLimit };
    } catch (err) {
      return corrupt(err);
    }
  }

  async content(nodeId: bigint): Promise<ContentRead> {
    const key = contentKey(nodeId);
    const raw = this.raw(key);
    if (raw === undefined) {
      return { state: 'missing' };
    }
    try {
      const content = await this.cache.get(key, raw, decodeContent);
      const problems = contentProblems(content, nodeId);
      if (problems.length > 0) {
        return { state: 'corrupt', message: problems.join(' '), newerVersion: false };
      }
      return { state: 'ok', content };
    } catch (err) {
      return corrupt(err);
    }
  }
}

function corrupt(err: unknown): { state: 'corrupt'; message: string; newerVersion: boolean } {
  return {
    state: 'corrupt',
    message: err instanceof Error ? err.message : String(err),
    newerVersion: err instanceof CodecError && err.kind === 'newerVersion',
  };
}
