import { NodeKind, type Tree, type TreeNode } from '../../generated/explorer/user_storage_pb';
import { normalizeName } from './validation';

// Pure helpers over a menu. The ones that change a tree mutate the tree they are given; callers
// pass a clone (replay.ts) or a draft copy (the dialogs).

export interface Located {
  node: TreeNode;
  /** The parent folder, or null for an entry at the root. */
  parent: TreeNode | null;
  /** The array holding the node: the parent's children or the tree's root entries. */
  siblings: TreeNode[];
  index: number;
  /** 1 for root entries. */
  depth: number;
}

export function locate(tree: Tree, id: bigint): Located | null {
  const search = (siblings: TreeNode[], parent: TreeNode | null, depth: number): Located | null => {
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index];
      if (node.id === id) {
        return { node, parent, siblings, index, depth };
      }
      const found = search(node.children, node, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return search(tree.children, null, 1);
}

/** Visit every node, depth first, in display order. */
export function walk(tree: Tree, visit: (node: TreeNode, parent: TreeNode | null, depth: number) => void): void {
  const step = (nodes: TreeNode[], parent: TreeNode | null, depth: number) => {
    for (const node of nodes) {
      visit(node, parent, depth);
      step(node.children, node, depth + 1);
    }
  };
  step(tree.children, null, 1);
}

export function countNodes(tree: Tree): number {
  let count = 0;
  walk(tree, () => count++);
  return count;
}

export function favoriteIds(tree: Tree): bigint[] {
  const ids: bigint[] = [];
  walk(tree, (node) => {
    if (node.kind === NodeKind.FAVORITE) {
      ids.push(node.id);
    }
  });
  return ids;
}

/** Levels a subtree occupies: 1 for a single node. */
export function subtreeHeight(node: TreeNode): number {
  let height = 0;
  for (const child of node.children) {
    height = Math.max(height, subtreeHeight(child));
  }
  return height + 1;
}

/** Whether id is the node itself or anywhere below it. */
export function containsId(node: TreeNode, id: bigint): boolean {
  return node.id === id || node.children.some((child) => containsId(child, id));
}

/** A sibling with the same normalized name, other than the node `except`. */
export function siblingNamed(siblings: TreeNode[], name: string, except?: bigint): TreeNode | undefined {
  const wanted = normalizeName(name);
  return siblings.find((node) => node.id !== except && normalizeName(node.name) === wanted);
}

/**
 * Insert node into siblings right after the sibling afterId; null puts it first. When afterId is not
 * among the siblings any more (another window moved or deleted it), the node goes last: order only
 * affects display, so this is not a conflict.
 */
export function insertAfter(siblings: TreeNode[], node: TreeNode, afterId: bigint | null | undefined): void {
  if (afterId === null) {
    siblings.unshift(node);
    return;
  }
  const index = afterId === undefined ? -1 : siblings.findIndex((sibling) => sibling.id === afterId);
  if (index < 0) {
    siblings.push(node);
  } else {
    siblings.splice(index + 1, 0, node);
  }
}

/** Index insertAfter would give the node in siblings (which must not contain it). */
export function insertionIndex(siblings: TreeNode[], afterId: bigint | null | undefined): number {
  if (afterId === null) {
    return 0;
  }
  const index = afterId === undefined ? -1 : siblings.findIndex((sibling) => sibling.id === afterId);
  return index < 0 ? siblings.length : index + 1;
}

/** Path of folder names from the root to the node, the node included. */
export function pathTo(tree: Tree, id: bigint): TreeNode[] {
  const search = (nodes: TreeNode[], path: TreeNode[]): TreeNode[] | null => {
    for (const node of nodes) {
      const next = [...path, node];
      if (node.id === id) {
        return next;
      }
      const found = search(node.children, next);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return search(tree.children, []) ?? [];
}
