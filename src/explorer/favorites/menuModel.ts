import { NodeKind, type Tree, type TreeNode } from '../../generated/explorer/user_storage_pb';
import { ROOT, type NodeRef, type Position } from './types';
import { normalizeName } from './validation';

// The menu as the dialogs draw and edit it: stored nodes (ref = id in decimal) and draft nodes
// (ref = tmp-<uuid>) side by side. Drafts live in page memory until the dialog commits them.

export interface MenuNode {
  ref: NodeRef;
  name: string;
  kind: NodeKind;
  children: MenuNode[];
  /** Created in this dialog, not on the server yet. */
  draft: boolean;
}

export function toMenuNodes(tree: Tree): MenuNode[] {
  const convert = (node: TreeNode): MenuNode => ({
    ref: node.id.toString(),
    name: node.name,
    kind: node.kind,
    children: node.children.map(convert),
    draft: false,
  });
  return tree.children.map(convert);
}

export function cloneMenu(nodes: MenuNode[]): MenuNode[] {
  return nodes.map((node) => ({ ...node, children: cloneMenu(node.children) }));
}

export interface MenuLocation {
  node: MenuNode;
  parent: MenuNode | null;
  siblings: MenuNode[];
  index: number;
  /** 1 for root entries. */
  depth: number;
}

export function findMenuNode(nodes: MenuNode[], ref: NodeRef): MenuLocation | null {
  const search = (siblings: MenuNode[], parent: MenuNode | null, depth: number): MenuLocation | null => {
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index];
      if (node.ref === ref) {
        return { node, parent, siblings, index, depth };
      }
      const found = search(node.children, node, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  };
  return search(nodes, null, 1);
}

/** The children array of a parent ref (ROOT for the root), or null when it is not a folder. */
export function childrenOf(nodes: MenuNode[], parentRef: NodeRef): { siblings: MenuNode[]; depth: number } | null {
  if (parentRef === ROOT) {
    return { siblings: nodes, depth: 0 };
  }
  const located = findMenuNode(nodes, parentRef);
  if (!located || located.node.kind !== NodeKind.FOLDER) {
    return null;
  }
  return { siblings: located.node.children, depth: located.depth };
}

/** Where a node sits, as an operation position. */
export function positionOf(nodes: MenuNode[], ref: NodeRef): Position {
  const located = findMenuNode(nodes, ref);
  if (!located) {
    return { parentId: ROOT, afterId: null };
  }
  return {
    parentId: located.parent?.ref ?? ROOT,
    afterId: located.index > 0 ? located.siblings[located.index - 1].ref : null,
  };
}

export function menuHeight(node: MenuNode): number {
  return 1 + node.children.reduce((height, child) => Math.max(height, menuHeight(child)), 0);
}

export function menuContains(node: MenuNode, ref: NodeRef): boolean {
  return node.ref === ref || node.children.some((child) => menuContains(child, ref));
}

export function countMenuNodes(nodes: MenuNode[]): number {
  return nodes.reduce((count, node) => count + 1 + countMenuNodes(node.children), 0);
}

export function nameTaken(siblings: MenuNode[], name: string, exceptRef?: NodeRef): MenuNode | undefined {
  const wanted = normalizeName(name);
  return siblings.find((node) => node.ref !== exceptRef && normalizeName(node.name) === wanted);
}

/** A name not used by the siblings: base, then "base 2", "base 3"... */
export function freeName(siblings: MenuNode[], base: string): string {
  if (!nameTaken(siblings, base)) {
    return base;
  }
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!nameTaken(siblings, candidate)) {
      return candidate;
    }
  }
}

/** Insert at the given position into a cloned menu; returns false when the parent is not a folder. */
export function insertMenuNode(nodes: MenuNode[], node: MenuNode, position: Position): boolean {
  const parent = childrenOf(nodes, position.parentId);
  if (!parent) {
    return false;
  }
  const afterIndex = position.afterId === null ? -1 : parent.siblings.findIndex((s) => s.ref === position.afterId);
  parent.siblings.splice(
    position.afterId === null ? 0 : afterIndex < 0 ? parent.siblings.length : afterIndex + 1,
    0,
    node
  );
  return true;
}

/** Remove a node from a cloned menu and return it. */
export function removeMenuNode(nodes: MenuNode[], ref: NodeRef): MenuNode | null {
  const located = findMenuNode(nodes, ref);
  if (!located) {
    return null;
  }
  located.siblings.splice(located.index, 1);
  return located.node;
}

/** Folder paths for "Move to…": every folder with its path, root first. */
export function folderChoices(nodes: MenuNode[]): Array<{ ref: NodeRef; label: string; depth: number }> {
  const choices: Array<{ ref: NodeRef; label: string; depth: number }> = [{ ref: ROOT, label: 'Top level', depth: 0 }];
  const walk = (siblings: MenuNode[], path: string, depth: number) => {
    for (const node of siblings) {
      if (node.kind === NodeKind.FOLDER) {
        const label = path ? `${path} / ${node.name}` : node.name;
        choices.push({ ref: node.ref, label, depth });
        walk(node.children, label, depth + 1);
      }
    }
  };
  walk(nodes, '', 1);
  return choices;
}
