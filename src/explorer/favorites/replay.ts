import { clone, create, equals } from '@bufbuild/protobuf';

import {
  FavoriteContentSchema,
  NodeKind,
  SavedQuerySchema,
  TreeNodeSchema,
  TreeSchema,
  type FavoriteContent,
  type SavedQuery,
  type Tree,
  type TreeNode,
} from '../../generated/explorer/user_storage_pb';
import { FAVORITES_KEY_PREFIX, MENU_KEY, SCHEMA_VERSION, contentKey, emptyTree, nodeIdOfContentKey } from './codec';
import { MAX_QUERIES_PER_FAVORITE, MAX_TREE_DEPTH, MAX_TREE_NODES } from './limits';
import type { ContentRead, SnapshotView } from './snapshotView';
import {
  containsId,
  countNodes,
  insertAfter,
  insertionIndex,
  locate,
  siblingNamed,
  subtreeHeight,
  type Located,
} from './treeOperations';
import { ROOT, isTempId, type Conflict, type IdMap, type NodeRef, type Operation, type Position } from './types';
import { checkTree, nameProblem, normalizeName, queryListProblems, queryProblems } from './validation';

// Replaying a batch of operations on the server's latest data (docs/plan_v3.md §7.4.4). Nothing
// here sends a request: given the snapshot the user started from (base) and the one just read
// (latest), it decides whether the batch already happened, conflicts, or which keys to write.

export type ReplayResult =
  | { kind: 'alreadyApplied'; idMap: IdMap }
  | { kind: 'conflict'; conflict: Conflict }
  | {
      kind: 'apply';
      /** The new menu, or null when the batch leaves it unchanged. */
      tree: Tree | null;
      /** Content key → new content, or null to delete the key. */
      contents: Map<string, FavoriteContent | null>;
      idMap: IdMap;
    };

const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);

type Outcome = 'applied' | 'changed' | Omit<Conflict, 'opIndex'>;

export async function replay(
  ops: Operation[],
  base: SnapshotView | null,
  latest: SnapshotView | null,
  nowMs: number
): Promise<ReplayResult> {
  if (ops.some((op) => op.kind === 'resetFavorites')) {
    return replayReset(ops, base, latest);
  }

  let latestTree = emptyTree();
  if (latest) {
    const menu = await latest.menu();
    if (menu.state !== 'ok') {
      return {
        kind: 'conflict',
        conflict: { reason: 'menuUnreadable', opIndex: 0, message: `The saved menu cannot be read: ${menu.message}` },
      };
    }
    latestTree = menu.tree;
  }

  const replayer = new Replayer(base, latest, latestTree, BigInt(Math.trunc(nowMs)));
  for (let index = 0; index < ops.length; index++) {
    const outcome = await replayer.apply(ops[index]);
    if (typeof outcome !== 'string') {
      return { kind: 'conflict', conflict: { ...outcome, opIndex: index } };
    }
  }

  if (replayer.treeChanged) {
    // Every operation keeps the menu consistent; this guards against a bug writing a broken one.
    const { structural } = checkTree(replayer.work);
    if (structural.length > 0) {
      return {
        kind: 'conflict',
        conflict: { reason: 'invalid', opIndex: ops.length - 1, message: structural.join(' ') },
      };
    }
  }
  if (!replayer.treeChanged && replayer.contents.size === 0) {
    return { kind: 'alreadyApplied', idMap: replayer.idMap };
  }
  return {
    kind: 'apply',
    tree: replayer.treeChanged ? replayer.work : null,
    contents: replayer.contents,
    idMap: replayer.idMap,
  };
}

/** Start over with an empty menu, dropping every favorites.* key. Only when nobody else wrote the menu since. */
async function replayReset(
  ops: Operation[],
  base: SnapshotView | null,
  latest: SnapshotView | null
): Promise<ReplayResult> {
  if (ops.length !== 1) {
    return {
      kind: 'conflict',
      conflict: { reason: 'invalid', opIndex: 0, message: 'A reset cannot be combined with other changes.' },
    };
  }
  if (latest?.raw(MENU_KEY) !== base?.raw(MENU_KEY)) {
    return {
      kind: 'conflict',
      conflict: {
        reason: 'contentChanged',
        opIndex: 0,
        message: 'The saved menu changed since you looked at it. Review it again before resetting.',
      },
    };
  }
  const contents = new Map<string, FavoriteContent | null>();
  for (const key of Object.keys(latest?.data ?? {})) {
    if (key.startsWith(FAVORITES_KEY_PREFIX) && key !== MENU_KEY) {
      contents.set(key, null);
    }
  }
  const menu = latest ? await latest.menu() : null;
  if (menu?.state === 'ok' && menu.tree.children.length === 0 && contents.size === 0) {
    return { kind: 'alreadyApplied', idMap: new Map() };
  }
  // The new menu keeps counting from the highest id known, so an id another window still holds
  // (e.g. a save dialog targeting favorite 3) can never name a different favorite later.
  const tree = emptyTree();
  tree.maxTreeNodeId = highestStoredId(latest);
  if (menu?.state === 'ok' && menu.tree.maxTreeNodeId > tree.maxTreeNodeId) {
    tree.maxTreeNodeId = menu.tree.maxTreeNodeId;
  }
  return { kind: 'apply', tree, contents, idMap: new Map() };
}

/** The largest node id of any stored content key; ids at or below it are taken even if no menu entry names them. */
function highestStoredId(view: SnapshotView | null): bigint {
  let highest = BigInt(0);
  for (const key of Object.keys(view?.data ?? {})) {
    const id = nodeIdOfContentKey(key);
    if (id !== null && id > highest) {
      highest = id;
    }
  }
  return highest;
}

interface ParentSlot {
  siblings: TreeNode[];
  /** Depth of the parent: 0 for the root. */
  depth: number;
}

class Replayer {
  readonly work: Tree;
  readonly idMap: IdMap = new Map();
  readonly contents = new Map<string, FavoriteContent | null>();
  treeChanged = false;
  private baseTree: Tree | null | undefined;

  constructor(
    private readonly base: SnapshotView | null,
    private readonly latest: SnapshotView | null,
    private readonly latestTree: Tree,
    private readonly now: bigint
  ) {
    this.work = clone(TreeSchema, latestTree);
    // Never hand out an id whose content key is still stored (an orphan, or a menu that went
    // missing): that would overwrite queries the user may still want (§10.1).
    const floor = highestStoredId(latest);
    if (floor > this.work.maxTreeNodeId) {
      this.work.maxTreeNodeId = floor;
    }
  }

  async apply(op: Operation): Promise<Outcome> {
    switch (op.kind) {
      case 'createFolder':
        return this.create(op.position, op.name, op.tempId, []);
      case 'createFavorite':
        return this.create(op.position, op.name, op.tempId, op.queries, true);
      case 'appendQuery':
        return this.appendQuery(op.favoriteId, op.query);
      case 'replaceQuery':
        return this.replaceQuery(op.favoriteId, op.query);
      case 'editFavoriteQueries':
        return this.editQueries(op.favoriteId, op.queries);
      case 'renameNode':
        return this.rename(op.nodeId, op.name);
      case 'moveNode':
        return this.move(op.nodeId, op.position);
      case 'deleteFavorite':
        return this.deleteFavorite(op.nodeId);
      case 'deleteFolder':
        return this.deleteFolder(op.nodeId);
      case 'resetFavorites':
        return { reason: 'invalid', message: 'A reset cannot be combined with other changes.' };
    }
  }

  // --------------------------------------------------------------------------
  // Operations

  private async create(
    position: Position,
    rawName: string,
    tempId: NodeRef,
    queries: SavedQuery[],
    favorite = false
  ): Promise<Outcome> {
    const parent = this.parentSlot(position.parentId);
    if (!('siblings' in parent)) {
      return parent;
    }
    const name = normalizeName(rawName);
    const problem = nameProblem(name);
    if (problem) {
      return { reason: 'invalid', message: problem };
    }
    const existing = siblingNamed(parent.siblings, name);
    if (existing) {
      // A favorite holding every query of this batch is this batch's own earlier, unconfirmed write.
      if (favorite && queries.length > 0 && existing.kind === NodeKind.FAVORITE) {
        const read = await this.contentOf(existing.id);
        if (read.state === 'ok' && queries.every((query) => read.content.queries.some((q) => q.id === query.id))) {
          this.idMap.set(tempId, existing.id);
          return 'applied';
        }
      }
      return {
        reason: 'nameTaken',
        nodeId: existing.id.toString(),
        nodeIsFolder: existing.kind === NodeKind.FOLDER,
        message:
          `“${name}” already exists in this folder` +
          (favorite && queries.length > 0 ? '.' : ' (it may be your previous save that went through).'),
      };
    }
    if (parent.depth + 1 > MAX_TREE_DEPTH) {
      return { reason: 'limit', message: `Folders can be nested at most ${MAX_TREE_DEPTH} levels deep.` };
    }
    if (countNodes(this.work) + 1 > MAX_TREE_NODES) {
      return { reason: 'limit', message: `The menu already holds ${MAX_TREE_NODES} entries.` };
    }
    if (favorite) {
      const problems = queryListProblems(queries);
      if (problems.length > 0) {
        return { reason: 'invalid', message: problems.join(' ') };
      }
    }
    if (this.work.maxTreeNodeId >= MAX_UINT64) {
      return { reason: 'limit', message: 'No more ids are available.' };
    }
    this.work.maxTreeNodeId += BigInt(1);
    const id = this.work.maxTreeNodeId;
    const node = create(TreeNodeSchema, { id, name, kind: favorite ? NodeKind.FAVORITE : NodeKind.FOLDER });
    insertAfter(parent.siblings, node, this.afterOf(position));
    this.idMap.set(tempId, id);
    this.treeChanged = true;
    if (favorite) {
      this.contents.set(
        contentKey(id),
        create(FavoriteContentSchema, {
          schemaVersion: SCHEMA_VERSION,
          nodeId: id,
          queries: queries.map((query) => clone(SavedQuerySchema, query)),
          updatedAtMs: this.now,
        })
      );
    }
    return 'changed';
  }

  private async appendQuery(favoriteRef: NodeRef, query: SavedQuery): Promise<Outcome> {
    const favorite = this.favorite(favoriteRef);
    if (!('node' in favorite)) {
      return favorite;
    }
    const read = await this.contentOf(favorite.node.id);
    if (read.state !== 'ok') {
      return unreadable(favorite.node, read);
    }
    if (read.content.queries.some((existing) => existing.id === query.id)) {
      return 'applied';
    }
    if (read.content.queries.length >= MAX_QUERIES_PER_FAVORITE) {
      return {
        reason: 'favoriteFull',
        nodeId: favorite.node.id.toString(),
        message: `“${favorite.node.name}” already holds ${MAX_QUERIES_PER_FAVORITE} queries.`,
      };
    }
    const problems = queryProblems(query);
    if (problems.length > 0) {
      return { reason: 'invalid', message: problems.join(' ') };
    }
    const next = clone(FavoriteContentSchema, read.content);
    next.queries.push(clone(SavedQuerySchema, query));
    this.writeContent(next);
    return 'changed';
  }

  private async replaceQuery(favoriteRef: NodeRef, query: SavedQuery): Promise<Outcome> {
    const favorite = this.favorite(favoriteRef);
    if (!('node' in favorite)) {
      return favorite;
    }
    const read = await this.contentOf(favorite.node.id);
    if (read.state !== 'ok') {
      return unreadable(favorite.node, read);
    }
    const index = read.content.queries.findIndex((existing) => existing.id === query.id);
    if (index < 0) {
      return {
        reason: 'queryMissing',
        nodeId: favorite.node.id.toString(),
        message: `The query to replace was deleted from “${favorite.node.name}”.`,
      };
    }
    const current = read.content.queries[index];
    if (equals(SavedQuerySchema, current, query)) {
      return 'applied';
    }
    const baseRead = this.base ? await this.base.content(favorite.node.id) : null;
    const baseQuery = baseRead?.state === 'ok' ? baseRead.content.queries.find((q) => q.id === query.id) : undefined;
    if (!baseQuery || !equals(SavedQuerySchema, baseQuery, current)) {
      return {
        reason: 'queryChanged',
        nodeId: favorite.node.id.toString(),
        message: `“${current.name}” was changed in another window.`,
      };
    }
    const problems = queryProblems(query);
    if (problems.length > 0) {
      return { reason: 'invalid', message: problems.join(' ') };
    }
    const next = clone(FavoriteContentSchema, read.content);
    next.queries[index] = clone(SavedQuerySchema, query);
    this.writeContent(next);
    return 'changed';
  }

  private async editQueries(favoriteRef: NodeRef, queries: SavedQuery[]): Promise<Outcome> {
    const favorite = this.favorite(favoriteRef);
    if (!('node' in favorite)) {
      return favorite;
    }
    const id = favorite.node.id;
    const read = await this.contentOf(id);
    if (read.state === 'corrupt') {
      return unreadable(favorite.node, read);
    }
    if (read.state === 'ok' && sameQueries(read.content.queries, queries)) {
      return 'applied';
    }
    const key = contentKey(id);
    if (this.latest?.raw(key) !== this.base?.raw(key)) {
      return {
        reason: 'contentChanged',
        nodeId: id.toString(),
        message: `The queries of “${favorite.node.name}” were changed in another window.`,
      };
    }
    const problems = queryListProblems(queries);
    if (problems.length > 0) {
      return { reason: 'invalid', message: problems.join(' ') };
    }
    // A missing content key is only rebuilt by this explicit edit (§10.1).
    const next =
      read.state === 'ok'
        ? clone(FavoriteContentSchema, read.content)
        : create(FavoriteContentSchema, { schemaVersion: SCHEMA_VERSION, nodeId: id });
    next.queries = queries.map((query) => clone(SavedQuerySchema, query));
    this.writeContent(next);
    return 'changed';
  }

  private async rename(nodeRef: NodeRef, rawName: string): Promise<Outcome> {
    const located = this.locateRef(nodeRef);
    if (!located) {
      return { reason: 'nodeMissing', message: 'The entry to rename was deleted in another window.' };
    }
    const name = normalizeName(rawName);
    const problem = nameProblem(name);
    if (problem) {
      return { reason: 'invalid', message: problem };
    }
    if (normalizeName(located.node.name) === name) {
      return 'applied';
    }
    // Someone else renamed it since the user looked: the user's rename was meant for the old name.
    const before = await this.baseNode(located.node.id);
    const now = locate(this.latestTree, located.node.id)?.node;
    if (before && now && normalizeName(before.name) !== normalizeName(now.name)) {
      return {
        reason: 'nameChanged',
        nodeId: located.node.id.toString(),
        message: `“${before.name}” was renamed to “${now.name}” in another window.`,
      };
    }
    const clash = siblingNamed(located.siblings, name, located.node.id);
    if (clash) {
      return {
        reason: 'nameTaken',
        nodeId: clash.id.toString(),
        message: `“${name}” already exists in this folder.`,
      };
    }
    located.node.name = name;
    this.treeChanged = true;
    return 'changed';
  }

  private async move(nodeRef: NodeRef, position: Position): Promise<Outcome> {
    const located = this.locateRef(nodeRef);
    if (!located) {
      return { reason: 'nodeMissing', message: 'The entry to move was deleted in another window.' };
    }
    const parent = this.parentSlot(position.parentId);
    if (!('siblings' in parent)) {
      return parent;
    }
    const parentId = this.resolve(position.parentId);
    const after = this.afterOf(position);
    if (
      (parentId !== null && parentId !== undefined && containsId(located.node, parentId)) ||
      after === located.node.id
    ) {
      return {
        reason: 'moveInvalid',
        nodeId: located.node.id.toString(),
        message: 'A folder cannot be moved into itself.',
      };
    }
    if (located.siblings === parent.siblings) {
      const others = located.siblings.filter((node) => node !== located.node);
      if (insertionIndex(others, after) === located.index) {
        return 'applied';
      }
    }
    const clash = siblingNamed(parent.siblings, located.node.name, located.node.id);
    if (clash) {
      return {
        reason: 'nameTaken',
        nodeId: clash.id.toString(),
        message: `The target folder already has an entry named “${clash.name}”.`,
      };
    }
    if (parent.depth + subtreeHeight(located.node) > MAX_TREE_DEPTH) {
      return { reason: 'limit', message: `Folders can be nested at most ${MAX_TREE_DEPTH} levels deep.` };
    }
    located.siblings.splice(located.index, 1);
    insertAfter(parent.siblings, located.node, after);
    this.treeChanged = true;
    return 'changed';
  }

  private async deleteFavorite(nodeRef: NodeRef): Promise<Outcome> {
    const located = this.locateRef(nodeRef);
    if (!located) {
      return 'applied';
    }
    if (located.node.kind !== NodeKind.FAVORITE) {
      return {
        reason: 'notFavorite',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” is a folder.`,
      };
    }
    const key = contentKey(located.node.id);
    if (this.latest?.raw(key) !== this.base?.raw(key)) {
      const read = await this.contentOf(located.node.id);
      const count = read.state === 'ok' ? ` It now holds ${read.content.queries.length} queries.` : '';
      return {
        reason: 'contentChanged',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” was changed in another window.${count} Confirm the delete again.`,
      };
    }
    located.siblings.splice(located.index, 1);
    this.contents.set(key, null);
    this.treeChanged = true;
    return 'changed';
  }

  private async deleteFolder(nodeRef: NodeRef): Promise<Outcome> {
    const located = this.locateRef(nodeRef);
    if (!located) {
      return 'applied';
    }
    if (located.node.kind !== NodeKind.FOLDER) {
      return {
        reason: 'notFolder',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” is a favorite.`,
      };
    }
    if (located.node.children.length > 0) {
      return {
        reason: 'folderNotEmpty',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” is not empty; only empty folders can be deleted.`,
      };
    }
    located.siblings.splice(located.index, 1);
    this.treeChanged = true;
    return 'changed';
  }

  // --------------------------------------------------------------------------
  // Helpers

  /** null for the root, the stored id, or undefined for a draft id this batch has not created. */
  private resolve(ref: NodeRef): bigint | null | undefined {
    if (ref === ROOT) {
      return null;
    }
    if (isTempId(ref)) {
      return this.idMap.get(ref);
    }
    return /^[1-9][0-9]*$/.test(ref) ? BigInt(ref) : undefined;
  }

  private locateRef(ref: NodeRef): Located | null {
    const id = this.resolve(ref);
    return id === null || id === undefined ? null : locate(this.work, id);
  }

  private afterOf(position: Position): bigint | null | undefined {
    if (position.afterId === null) {
      return null;
    }
    const id = this.resolve(position.afterId);
    return id === null ? undefined : id;
  }

  private parentSlot(parentRef: NodeRef): ParentSlot | Omit<Conflict, 'opIndex'> {
    const id = this.resolve(parentRef);
    if (id === null) {
      return { siblings: this.work.children, depth: 0 };
    }
    const located = id === undefined ? null : locate(this.work, id);
    if (!located) {
      return { reason: 'parentMissing', message: 'The target folder was deleted in another window.' };
    }
    if (located.node.kind !== NodeKind.FOLDER) {
      return {
        reason: 'parentNotFolder',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” is a favorite, not a folder.`,
      };
    }
    return { siblings: located.node.children, depth: located.depth };
  }

  private favorite(ref: NodeRef): Located | Omit<Conflict, 'opIndex'> {
    const located = this.locateRef(ref);
    if (!located) {
      return { reason: 'nodeMissing', message: 'The favorite was deleted in another window.' };
    }
    if (located.node.kind !== NodeKind.FAVORITE) {
      return {
        reason: 'notFavorite',
        nodeId: located.node.id.toString(),
        message: `“${located.node.name}” is a folder.`,
      };
    }
    return located;
  }

  /** The content as this batch left it so far, else as the server has it. */
  private async contentOf(id: bigint): Promise<ContentRead> {
    const key = contentKey(id);
    if (this.contents.has(key)) {
      const content = this.contents.get(key);
      return content ? { state: 'ok', content } : { state: 'missing' };
    }
    return this.latest ? this.latest.content(id) : { state: 'missing' };
  }

  private writeContent(content: FavoriteContent): void {
    content.updatedAtMs = this.now;
    this.contents.set(contentKey(content.nodeId), content);
  }

  private async baseNode(id: bigint): Promise<TreeNode | undefined> {
    if (this.baseTree === undefined) {
      const menu = this.base ? await this.base.menu() : null;
      this.baseTree = menu?.state === 'ok' ? menu.tree : null;
    }
    return this.baseTree ? locate(this.baseTree, id)?.node : undefined;
  }
}

function unreadable(node: TreeNode, read: ContentRead): Omit<Conflict, 'opIndex'> {
  return {
    reason: 'contentUnreadable',
    nodeId: node.id.toString(),
    message:
      read.state === 'corrupt'
        ? `The queries of “${node.name}” cannot be read: ${read.message}`
        : `The queries of “${node.name}” are missing.`,
  };
}

function sameQueries(left: SavedQuery[], right: SavedQuery[]): boolean {
  return left.length === right.length && left.every((query, index) => equals(SavedQuerySchema, query, right[index]));
}
