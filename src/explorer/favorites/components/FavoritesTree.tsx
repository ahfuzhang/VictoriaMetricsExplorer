import React, { useCallback, useMemo, useRef, useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';
import { css, cx } from '@emotion/css';

import { NodeKind } from '../../../generated/explorer/user_storage_pb';
import type { MenuNode } from '../menuModel';

interface Props {
  nodes: MenuNode[];
  selectedRef: string | null;
  /** A favorite was activated; folders too when selectFolders is set. */
  onSelect: (node: MenuNode) => void;
  /** Activating a folder selects it (location picker) instead of only toggling it. */
  selectFolders?: boolean;
  ariaLabel: string;
  /** Extra content after a node's name. */
  renderMeta?: (node: MenuNode) => React.ReactNode;
  /** Extra row attributes, e.g. drag and drop handlers. */
  rowProps?: (node: MenuNode) => React.HTMLAttributes<HTMLDivElement>;
}

interface VisibleItem {
  node: MenuNode;
  parentRef: string | null;
  depth: number;
}

/**
 * The favorites menu as an ARIA tree: arrow keys move, Right/Left expand/collapse or go to the first
 * child/parent, Enter or Space activates. Expansion is page-memory UI state only.
 */
export const FavoritesTree: React.FC<Props> = ({
  nodes,
  selectedRef,
  onSelect,
  selectFolders = false,
  ariaLabel,
  renderMeta,
  rowProps,
}) => {
  const styles = useStyles2(getStyles);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedRef, setFocusedRef] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());

  const visible = useMemo(() => {
    const items: VisibleItem[] = [];
    const walk = (siblings: MenuNode[], parentRef: string | null, depth: number) => {
      for (const node of siblings) {
        items.push({ node, parentRef, depth });
        if (node.kind === NodeKind.FOLDER && !collapsed.has(node.ref)) {
          walk(node.children, node.ref, depth + 1);
        }
      }
    };
    walk(nodes, null, 1);
    return items;
  }, [collapsed, nodes]);

  // Reveal a newly selected node by expanding its ancestors once; the user can still collapse them
  // later. Adjusting state while rendering when a prop changes, as React recommends over an effect.
  const [revealed, setRevealed] = useState<string | null>(null);
  if (selectedRef !== revealed) {
    setRevealed(selectedRef);
    const ancestors = selectedRef ? (ancestorsOf(nodes, selectedRef) ?? []) : [];
    if (ancestors.some((ref) => collapsed.has(ref))) {
      setCollapsed(new Set([...collapsed].filter((ref) => !ancestors.includes(ref))));
    }
  }

  const tabStop =
    visible.find((item) => item.node.ref === focusedRef)?.node.ref ??
    visible.find((item) => item.node.ref === selectedRef)?.node.ref ??
    visible[0]?.node.ref;

  const focus = useCallback((ref: string | undefined) => {
    if (ref) {
      setFocusedRef(ref);
      itemRefs.current.get(ref)?.focus();
    }
  }, []);

  const toggle = useCallback((ref: string, expand?: boolean) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      const isCollapsed = next.has(ref);
      if (expand === undefined ? isCollapsed : expand) {
        next.delete(ref);
      } else {
        next.add(ref);
      }
      return next;
    });
  }, []);

  const activate = (node: MenuNode) => {
    if (node.kind === NodeKind.FOLDER && !selectFolders) {
      toggle(node.ref);
      return;
    }
    onSelect(node);
  };

  const onKeyDown = (event: React.KeyboardEvent, item: VisibleItem) => {
    const index = visible.findIndex((candidate) => candidate.node.ref === item.node.ref);
    const isFolder = item.node.kind === NodeKind.FOLDER;
    const expanded = isFolder && !collapsed.has(item.node.ref);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        focus(visible[index + 1]?.node.ref);
        break;
      case 'ArrowUp':
        focus(visible[index - 1]?.node.ref);
        break;
      case 'Home':
        focus(visible[0]?.node.ref);
        break;
      case 'End':
        focus(visible[visible.length - 1]?.node.ref);
        break;
      case 'ArrowRight':
        if (isFolder && !expanded) {
          toggle(item.node.ref, true);
        } else if (expanded && item.node.children.length > 0) {
          focus(item.node.children[0].ref);
        }
        break;
      case 'ArrowLeft':
        if (expanded) {
          toggle(item.node.ref, false);
        } else if (item.parentRef) {
          focus(item.parentRef);
        }
        break;
      case 'Enter':
      case ' ':
        activate(item.node);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const renderLevel = (siblings: MenuNode[], parentRef: string | null, depth: number): React.ReactNode =>
    siblings.map((node) => {
      const isFolder = node.kind === NodeKind.FOLDER;
      const expanded = isFolder && !collapsed.has(node.ref);
      const selected = node.ref === selectedRef;
      const item: VisibleItem = { node, parentRef, depth };
      const extra = rowProps?.(node);
      return (
        <li
          key={node.ref}
          role="treeitem"
          aria-level={depth}
          aria-expanded={isFolder ? expanded : undefined}
          aria-selected={selected}
          tabIndex={node.ref === tabStop ? 0 : -1}
          ref={(element) => {
            if (element) {
              itemRefs.current.set(node.ref, element);
            } else {
              itemRefs.current.delete(node.ref);
            }
          }}
          className={styles.item}
          onKeyDown={(event) => onKeyDown(event, item)}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              setFocusedRef(node.ref);
            }
          }}
        >
          <div
            {...extra}
            className={cx(styles.row, selected && styles.rowSelected, extra?.className)}
            style={{ paddingLeft: `${(depth - 1) * 14 + 4}px` }}
            title={node.name}
            onClick={(event) => {
              event.stopPropagation();
              setFocusedRef(node.ref);
              activate(node);
            }}
          >
            {isFolder ? (
              <span
                className={styles.chevron}
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node.ref);
                }}
                aria-hidden
              >
                <Icon name={expanded ? 'angle-down' : 'angle-right'} size="sm" />
              </span>
            ) : (
              <span className={styles.chevron} aria-hidden />
            )}
            <Icon
              name={isFolder ? (expanded ? 'folder-open' : 'folder') : 'star'}
              size="sm"
              className={isFolder ? styles.folderIcon : styles.favoriteIcon}
            />
            <span className={styles.name}>{node.name}</span>
            {renderMeta?.(node)}
          </div>
          {isFolder && expanded && node.children.length > 0 && (
            <ul role="group" className={styles.group}>
              {renderLevel(node.children, node.ref, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <ul role="tree" aria-label={ariaLabel} className={styles.tree}>
      {renderLevel(nodes, null, 1)}
    </ul>
  );
};

function ancestorsOf(nodes: MenuNode[], ref: string, path: string[] = []): string[] | null {
  for (const node of nodes) {
    const found = node.ref === ref ? path : ancestorsOf(node.children, ref, [...path, node.ref]);
    if (found) {
      return found;
    }
  }
  return null;
}

const getStyles = (theme: GrafanaTheme2) => ({
  tree: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
  }),
  group: css({
    listStyle: 'none',
    margin: 0,
    padding: 0,
  }),
  item: css({
    outline: 'none',
    '&:focus-visible > div': {
      boxShadow: `inset 0 0 0 2px ${theme.colors.primary.border}`,
    },
  }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    minHeight: '28px',
    paddingRight: theme.spacing(0.75),
    borderRadius: theme.shape.radius.default,
    color: theme.colors.text.primary,
    cursor: 'pointer',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  rowSelected: css({
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    '&:hover': {
      background: theme.colors.primary.transparent,
    },
  }),
  chevron: css({
    display: 'inline-flex',
    width: '16px',
    flexShrink: 0,
    color: theme.colors.text.secondary,
  }),
  folderIcon: css({
    flexShrink: 0,
    color: theme.colors.text.secondary,
  }),
  favoriteIcon: css({
    flexShrink: 0,
    color: theme.colors.warning.text,
  }),
  name: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: theme.typography.size.sm,
  }),
});
