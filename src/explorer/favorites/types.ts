import type { SavedQuery } from '../../generated/explorer/user_storage_pb';

// ============================================================================
// Server snapshots (docs/plan_v3.md §4.2)
// ============================================================================

/** One read of the Grafana User Storage resource. Kept in page memory only. */
export interface UserStorageSnapshot {
  /** Opaque metadata.resourceVersion; sent back unchanged so a stale write is rejected. */
  resourceVersion: string;
  /** spec.data: key → string value. Holds other features' keys too, which writes leave alone. */
  data: Record<string, string>;
}

/** Reads and conditional writes of the User Storage resource. Never touches browser storage. */
export interface UserStorageAdapter {
  /** Read the resource from the server; null only when the API works and the resource does not exist yet. */
  loadFresh(): Promise<UserStorageSnapshot | null>;
  /** Create the resource; throws alreadyExists when another window created it first. */
  create(data: Record<string, string>): Promise<UserStorageSnapshot>;
  /** Change the listed keys (null deletes) if the resource is still at expectedResourceVersion. */
  commit(expectedResourceVersion: string, changes: Record<string, string | null>): Promise<UserStorageSnapshot>;
}

export type UserStorageErrorKind =
  | 'unavailable' // The API route is missing, the user is anonymous or the host is unsupported.
  | 'unauthenticated' // 401: the session expired.
  | 'forbidden' // 403: the resource name does not belong to this user.
  | 'versionConflict' // 409 Conflict: resourceVersion is stale.
  | 'alreadyExists' // 409 AlreadyExists: another window created the resource first.
  | 'resourceGone' // 404 on a write: the resource was deleted after it was read.
  | 'rejected' // 400/413/422: the request itself is invalid or too large; not retried.
  | 'throttled' // 429: not executed, can be retried after a pause.
  | 'uncertain'; // Timeout, lost connection, 5xx: the write may or may not have happened.

export class UserStorageError extends Error {
  constructor(
    readonly kind: UserStorageErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'UserStorageError';
  }
}

// ============================================================================
// Operations (§7.2, §7.4.4)
// ============================================================================

/**
 * A node named by an operation: ROOT, a stored id in decimal, or a draft id `tmp-<uuid>` for a node
 * created earlier in the same batch. Draft ids are never stored.
 */
export type NodeRef = string;

export const ROOT: NodeRef = 'root';
export const TEMP_PREFIX = 'tmp-';

export function newTempId(): NodeRef {
  return `${TEMP_PREFIX}${crypto.randomUUID()}`;
}

export function isTempId(ref: NodeRef): boolean {
  return ref.startsWith(TEMP_PREFIX);
}

/** Where a node goes: under parentId, right after afterId (null: first). */
export interface Position {
  parentId: NodeRef;
  afterId: NodeRef | null;
}

export type Operation =
  | { kind: 'createFolder'; position: Position; name: string; tempId: NodeRef }
  | { kind: 'createFavorite'; position: Position; name: string; tempId: NodeRef; queries: SavedQuery[] }
  | { kind: 'appendQuery'; favoriteId: NodeRef; query: SavedQuery }
  | { kind: 'replaceQuery'; favoriteId: NodeRef; query: SavedQuery }
  | { kind: 'editFavoriteQueries'; favoriteId: NodeRef; queries: SavedQuery[] }
  | { kind: 'renameNode'; nodeId: NodeRef; name: string }
  | { kind: 'moveNode'; nodeId: NodeRef; position: Position }
  | { kind: 'deleteFavorite'; nodeId: NodeRef }
  | { kind: 'deleteFolder'; nodeId: NodeRef }
  // Recovery from a damaged menu (§10.1): drop every favorites.* key and start an empty menu.
  | { kind: 'resetFavorites' };

export type ConflictReason =
  | 'menuUnreadable' // The menu cannot be decoded or was written by a newer version.
  | 'parentMissing'
  | 'parentNotFolder'
  | 'nameTaken'
  | 'nodeMissing'
  | 'notFavorite'
  | 'notFolder'
  | 'contentUnreadable'
  | 'favoriteFull'
  | 'queryMissing'
  | 'queryChanged'
  | 'contentChanged'
  | 'nameChanged'
  | 'moveInvalid'
  | 'folderNotEmpty'
  | 'limit'
  | 'invalid'; // A name, query or statement that cannot be saved.

export interface Conflict {
  reason: ConflictReason;
  /** Index of the first operation of the batch that could not be applied. */
  opIndex: number;
  /** The node the conflict is about, in decimal, when there is one. */
  nodeId?: string;
  /** For nameTaken: whether the entry already using the name is a folder. */
  nodeIsFolder?: boolean;
  message: string;
}

/** Draft id → stored id, for every node a committed batch created (or found already created). */
export type IdMap = Map<NodeRef, bigint>;

// ============================================================================
// Commit failures surfaced to the UI (§7.4.6, §7.5)
// ============================================================================

/** The batch cannot be applied to the server's current data; the user decides what to do. */
export class FavoritesConflict extends Error {
  constructor(
    readonly conflict: Conflict,
    /** The server's data the batch was replayed on, so the UI can show what changed. */
    readonly latest: UserStorageSnapshot | null
  ) {
    super(conflict.message);
    this.name = 'FavoritesConflict';
  }
}

/** Every attempt ended without an answer from the server; the outcome is unknown. */
export class FavoritesUncertain extends Error {
  constructor() {
    super('The server did not confirm the save. It may or may not have been stored.');
    this.name = 'FavoritesUncertain';
  }
}

/** Other windows kept changing favorites during every attempt. */
export class FavoritesBusy extends Error {
  constructor() {
    super('Favorites are being changed in another window. Try again in a moment.');
    this.name = 'FavoritesBusy';
  }
}

/** The result would exceed the size budget of the User Storage resource. */
export class FavoritesTooLarge extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FavoritesTooLarge';
  }
}
