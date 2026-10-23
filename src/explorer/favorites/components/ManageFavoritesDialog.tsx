import React, { useEffect, useMemo, useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, ConfirmModal, LoadingPlaceholder, Modal, useStyles2 } from '@grafana/ui';
import { css, cx } from '@emotion/css';

import { NodeKind } from '../../../generated/explorer/user_storage_pb';
import { notifySaved, useFavorites } from '../FavoritesProvider';
import { FAVORITES_KEY_PREFIX, MENU_KEY, nodeIdOfContentKey } from '../codec';
import { describeCommitFailure, type CommitFailure } from '../drafts';
import { MAX_TREE_DEPTH } from '../limits';
import {
  childrenOf,
  cloneMenu,
  findMenuNode,
  insertMenuNode,
  menuContains,
  menuHeight,
  nameTaken,
  positionOf,
  removeMenuNode,
  toMenuNodes,
  type MenuNode,
} from '../menuModel';
import type { MenuRead, SnapshotView } from '../snapshotView';
import { favoriteIds } from '../treeOperations';
import { FavoritesConflict, ROOT, isTempId, newTempId, type NodeRef, type Operation, type Position } from '../types';
import { normalizeName } from '../validation';
import { ConflictNotice, type NoticeAction } from './ConflictNotice';
import { FavoritesTree } from './FavoritesTree';
import { NewFolderDialog } from './NewFolderDialog';
import { RenameDialog } from './RenameDialog';
import { useUnsavedWarning } from './useUnsavedWarning';

type DropZone = 'before' | 'inside' | 'after';

/**
 * Settings: the whole menu as a draft (docs/plan_v3.md §9). Every change is recorded as an
 * operation; Apply commits them as one batch, Cancel drops them.
 */
export const ManageFavoritesDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const styles = useStyles2(getStyles);
  const { loadBase, commit, registerDraft, writeBlocked, openEdit, remoteChanged } = useFavorites();

  const [base, setBase] = useState<SnapshotView | null>(null);
  const [menuRead, setMenuRead] = useState<MenuRead | null>(null);
  const [loadError, setLoadError] = useState('');
  const [nodes, setNodes] = useState<MenuNode[]>([]);
  const [ops, setOps] = useState<Operation[]>([]);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [actionError, setActionError] = useState('');
  const [dragRef, setDragRef] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ ref: string; zone: DropZone } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ ref: string; name: string; queries: number | null } | null>(
    null
  );
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [pending, setPending] = useState<{ ops: Operation[]; base: SnapshotView | null } | null>(null);

  const dirty = ops.length > 0;
  useEffect(() => registerDraft(), [registerDraft]);
  useUnsavedWarning(dirty);

  // Bumped to read the server again, dropping the draft.
  const [loadCount, setLoadCount] = useState(0);
  const reload = () => setLoadCount((count) => count + 1);

  useEffect(() => {
    let cancelled = false;
    loadBase()
      .then(async (view) => {
        const read = await view.menu();
        if (cancelled) {
          return;
        }
        setLoadError('');
        setBase(view);
        setMenuRead(read);
        setNodes(read.state === 'ok' ? toMenuNodes(read.tree) : []);
        setOps([]);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadBase, loadCount]);

  const selected = selectedRef ? findMenuNode(nodes, selectedRef) : null;
  const readOnly = !!writeBlocked || menuRead?.state !== 'ok';

  // Stored favorites keys no menu entry points to (§10.1): reported and kept, never cleaned up
  // automatically.
  const unreferencedKeys = useMemo(() => {
    if (!base || menuRead?.state !== 'ok') {
      return [];
    }
    const referenced = new Set(favoriteIds(menuRead.tree).map((id) => id.toString()));
    return Object.keys(base.data).filter((key) => {
      if (!key.startsWith(FAVORITES_KEY_PREFIX) || key === MENU_KEY) {
        return false;
      }
      const id = nodeIdOfContentKey(key);
      return id === null || !referenced.has(id.toString());
    });
  }, [base, menuRead]);

  // ------------------------------------------------------------------------
  // Draft changes: each updates the drawn menu and records the operation that replays it.

  const record = (next: MenuNode[], op: Operation) => {
    setNodes(next);
    setOps((previous) => [...previous, op]);
    setActionError('');
  };

  /** Why ref cannot go under parentRef, or null. */
  const moveProblem = (menu: MenuNode[], ref: NodeRef, parentRef: NodeRef): string | null => {
    const moving = findMenuNode(menu, ref);
    const parent = childrenOf(menu, parentRef);
    if (!moving || !parent) {
      return 'Only folders can hold entries.';
    }
    if (parentRef !== ROOT && menuContains(moving.node, parentRef)) {
      return 'A folder cannot be moved into itself.';
    }
    if (parent.depth + menuHeight(moving.node) > MAX_TREE_DEPTH) {
      return `Folders can be nested at most ${MAX_TREE_DEPTH} levels deep.`;
    }
    if (nameTaken(parent.siblings, moving.node.name, ref)) {
      return `That folder already has an entry named “${moving.node.name}”.`;
    }
    return null;
  };

  const move = (ref: NodeRef, position: Position) => {
    const problem = moveProblem(nodes, ref, position.parentId);
    if (problem) {
      setActionError(problem);
      return;
    }
    const next = cloneMenu(nodes);
    const node = removeMenuNode(next, ref);
    if (!node) {
      return;
    }
    insertMenuNode(next, node, position);
    record(next, { kind: 'moveNode', nodeId: ref, position: positionOf(next, ref) });
  };

  /** Add a folder named and placed in NewFolderDialog, which has checked both, at the end of its parent. */
  const createFolder = (name: string, parentRef: NodeRef) => {
    const parent = childrenOf(nodes, parentRef);
    if (!parent) {
      return;
    }
    const node: MenuNode = { ref: newTempId(), name, kind: NodeKind.FOLDER, children: [], draft: true };
    const next = cloneMenu(nodes);
    const afterId = parent.siblings.length > 0 ? parent.siblings[parent.siblings.length - 1].ref : null;
    insertMenuNode(next, node, { parentId: parentRef, afterId });
    record(next, { kind: 'createFolder', position: positionOf(next, node.ref), name: node.name, tempId: node.ref });
    setSelectedRef(node.ref);
    setNewFolderOpen(false);
  };

  /** Rename the selected entry to a name RenameDialog has checked. */
  const rename = (name: string) => {
    setRenameOpen(false);
    if (!selected || name === normalizeName(selected.node.name)) {
      return;
    }
    const next = cloneMenu(nodes);
    findMenuNode(next, selected.node.ref)!.node.name = name;
    const ref = selected.node.ref;
    if (selected.node.draft) {
      // A folder created here is created under its final name, so renaming it also resolves a
      // "name already taken" conflict of its creation.
      setNodes(next);
      setOps((previous) =>
        previous.map((op) => (op.kind === 'createFolder' && op.tempId === ref ? { ...op, name } : op))
      );
      setActionError('');
      return;
    }
    record(next, { kind: 'renameNode', nodeId: ref, name });
  };

  const shift = (delta: -1 | 1) => {
    if (!selected) {
      return;
    }
    const { siblings, index, parent } = selected;
    const target = index + delta;
    if (target < 0 || target >= siblings.length) {
      return;
    }
    const others = siblings.filter((node) => node.ref !== selected.node.ref);
    move(selected.node.ref, { parentId: parent?.ref ?? ROOT, afterId: target === 0 ? null : others[target - 1].ref });
  };

  const askDelete = async () => {
    if (!selected) {
      return;
    }
    if (selected.node.kind === NodeKind.FOLDER) {
      if (selected.node.children.length > 0) {
        setActionError('Only empty folders can be deleted. Move or delete what is inside first.');
        return;
      }
      const next = cloneMenu(nodes);
      removeMenuNode(next, selected.node.ref);
      record(next, { kind: 'deleteFolder', nodeId: selected.node.ref });
      setSelectedRef(null);
      return;
    }
    let queries: number | null = 0;
    if (!selected.node.draft && base) {
      const read = await base.content(BigInt(selected.node.ref));
      queries = read.state === 'ok' ? read.content.queries.length : null;
    }
    setConfirmDelete({ ref: selected.node.ref, name: selected.node.name, queries });
  };

  const deleteFavorite = (ref: string) => {
    const next = cloneMenu(nodes);
    removeMenuNode(next, ref);
    record(next, { kind: 'deleteFavorite', nodeId: ref });
    setSelectedRef(null);
    setConfirmDelete(null);
  };

  // ------------------------------------------------------------------------
  // Drag and drop: before/after a row, or inside a folder row.

  const dropPosition = (targetRef: string, zone: DropZone, movingRef: string): Position | null => {
    const target = findMenuNode(nodes, targetRef);
    if (!target || targetRef === movingRef) {
      return null;
    }
    if (zone === 'inside') {
      const children = target.node.children.filter((node) => node.ref !== movingRef);
      return { parentId: target.node.ref, afterId: children.length > 0 ? children[children.length - 1].ref : null };
    }
    const siblings = target.siblings.filter((node) => node.ref !== movingRef);
    const index = siblings.findIndex((node) => node.ref === targetRef);
    const parentId = target.parent?.ref ?? ROOT;
    if (zone === 'after') {
      return { parentId, afterId: targetRef };
    }
    return { parentId, afterId: index > 0 ? siblings[index - 1].ref : null };
  };

  const rowProps = (node: MenuNode): React.HTMLAttributes<HTMLDivElement> => {
    if (readOnly) {
      return {};
    }
    const zoneClass =
      drop?.ref === node.ref
        ? drop.zone === 'inside'
          ? styles.dropInside
          : drop.zone === 'before'
            ? styles.dropBefore
            : styles.dropAfter
        : undefined;
    return {
      draggable: true,
      className: cx(dragRef === node.ref && styles.dragging, zoneClass),
      onDragStart: (event) => {
        event.dataTransfer.setData('text/plain', node.ref);
        event.dataTransfer.effectAllowed = 'move';
        setDragRef(node.ref);
      },
      onDragEnd: () => {
        setDragRef(null);
        setDrop(null);
      },
      onDragOver: (event) => {
        if (!dragRef) {
          return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const offset = (event.clientY - rect.top) / rect.height;
        const zone: DropZone =
          node.kind === NodeKind.FOLDER
            ? offset < 0.25
              ? 'before'
              : offset > 0.75
                ? 'after'
                : 'inside'
            : offset < 0.5
              ? 'before'
              : 'after';
        const position = dropPosition(node.ref, zone, dragRef);
        if (!position || moveProblem(nodes, dragRef, position.parentId)) {
          setDrop(null);
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (drop?.ref !== node.ref || drop.zone !== zone) {
          setDrop({ ref: node.ref, zone });
        }
      },
      onDragLeave: () => setDrop((current) => (current?.ref === node.ref ? null : current)),
      onDrop: (event) => {
        event.preventDefault();
        const moving = dragRef;
        setDragRef(null);
        setDrop(null);
        const position = drop && moving ? dropPosition(node.ref, drop.zone, moving) : null;
        if (moving && position) {
          move(moving, position);
        }
      },
    };
  };

  // ------------------------------------------------------------------------
  // Commit

  const run = async (batch: Operation[], commitBase: SnapshotView | null, message: string) => {
    setPending({ ops: batch, base: commitBase });
    setSaving(true);
    setFailure(null);
    try {
      await commit(batch, commitBase);
      notifySaved(message);
      onClose();
    } catch (err) {
      setFailure(describeCommitFailure(err));
    } finally {
      setSaving(false);
    }
  };

  const apply = () => {
    if (base && ops.length > 0) {
      void run(ops, base.snapshot ? base : null, 'Favorites updated on the Grafana server.');
    }
  };

  const failureActions = (): NoticeAction[] => {
    if (!failure || !pending) {
      return [];
    }
    if (failure.kind === 'uncertain') {
      return [
        {
          label: 'Check again',
          variant: 'primary',
          onClick: () => void run(pending.ops, pending.base, 'Favorites updated.'),
        },
      ];
    }
    if (failure.kind === 'busy' || failure.kind === 'session') {
      return [
        {
          label: 'Retry',
          variant: 'primary',
          onClick: () => void run(pending.ops, pending.base, 'Favorites updated.'),
        },
      ];
    }
    if (failure.kind === 'conflict' && failure.error instanceof FavoritesConflict) {
      const { conflict } = failure.error;
      const actions: NoticeAction[] = [];
      if (conflict.reason === 'contentChanged' && pending.ops[conflict.opIndex]?.kind === 'deleteFavorite') {
        // The user saw the new query count in the message: delete on the server's current data.
        actions.push({ label: 'Delete anyway', variant: 'primary', onClick: () => void applyOnLatest(pending.ops) });
      }
      actions.push(
        { label: 'Keep editing', onClick: () => setFailure(null) },
        {
          label: 'Discard my changes and reload',
          onClick: () => {
            setFailure(null);
            reload();
          },
        }
      );
      return actions;
    }
    return [];
  };

  /** Commit the same changes again, judged against the server's current data instead of the old base. */
  const applyOnLatest = async (batch: Operation[]) => {
    try {
      const latest = await loadBase();
      setBase(latest);
      await run(batch, latest.snapshot ? latest : null, 'Favorites updated on the Grafana server.');
    } catch (err) {
      setFailure(describeCommitFailure(err));
    }
  };

  const exportRaw = () => {
    if (!base) {
      return;
    }
    const data = Object.fromEntries(Object.entries(base.data).filter(([key]) => key.startsWith(FAVORITES_KEY_PREFIX)));
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), resourceVersion: base.resourceVersion, data }, null, 2)],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'victoriametrics-explorer-favorites.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const requestClose = () => {
    if (saving) {
      return;
    }
    if (dirty) {
      setConfirmClose(true);
    } else {
      onClose();
    }
  };

  return (
    <Modal title="Manage favorites" isOpen onDismiss={requestClose} className={styles.modal}>
      {writeBlocked && (
        <Alert title="Favorites cannot be changed here" severity="warning">
          {writeBlocked}
        </Alert>
      )}
      {remoteChanged && (
        <Alert title="Favorites changed in another window" severity="info">
          Applying merges your changes when they do not overlap; otherwise you will be asked what to do.
        </Alert>
      )}
      {loadError && (
        <Alert title="Cannot read your favorites from Grafana" severity="error">
          {loadError}
          <div>
            <Button size="sm" variant="secondary" onClick={() => reload()}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {menuRead?.state === 'corrupt' ? (
        <Alert
          title={menuRead.newerVersion ? 'Favorites were saved by a newer version' : 'Your saved menu cannot be read'}
          severity="error"
        >
          <p>
            {menuRead.newerVersion
              ? 'Upgrade the app to change them. They stay read-only here and are never overwritten.'
              : `${menuRead.message} Export the stored data before anything else, then reset to start over with an empty menu.`}
          </p>
          <div className={styles.actions}>
            <Button size="sm" variant="secondary" icon="download-alt" onClick={exportRaw}>
              Export stored data
            </Button>
            {!menuRead.newerVersion && (
              <Button size="sm" variant="destructive" onClick={() => setConfirmReset(true)} disabled={!!writeBlocked}>
                Reset favorites…
              </Button>
            )}
          </div>
        </Alert>
      ) : !menuRead && !loadError ? (
        <LoadingPlaceholder text="Loading favorites…" />
      ) : menuRead ? (
        <div className={styles.layout}>
          <section className={styles.treeColumn} aria-label="Favorites menu">
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                icon="folder-plus"
                onClick={() => setNewFolderOpen(true)}
                disabled={readOnly}
              >
                New folder
              </Button>
            </div>
            <div className={styles.treeBox}>
              {nodes.length === 0 ? (
                <div className={styles.hint}>No favorites yet.</div>
              ) : (
                <FavoritesTree
                  nodes={nodes}
                  selectedRef={selectedRef}
                  onSelect={(node) => {
                    setSelectedRef(node.ref);
                    setActionError('');
                  }}
                  selectFolders
                  ariaLabel="Favorites menu, drag entries to move them"
                  rowProps={rowProps}
                  renderMeta={(node) => (node.draft ? <span className={styles.newBadge}>new</span> : null)}
                />
              )}
            </div>
            <div className={styles.hint}>
              Drag an entry before, after or into a folder, or use the actions on the right.
            </div>
            {unreferencedKeys.length > 0 && (
              <div className={styles.hint} title={unreferencedKeys.join('\n')}>
                {unreferencedKeys.length} stored entr{unreferencedKeys.length === 1 ? 'y is' : 'ies are'} not in the
                menu. They are kept as they are.
              </div>
            )}
          </section>

          <section className={styles.detailColumn} aria-label="Selected entry">
            {!selected ? (
              <div className={styles.hint}>Select an entry to rename, move or delete it.</div>
            ) : (
              <>
                <h3 className={styles.selectedTitle}>
                  {selected.node.kind === NodeKind.FOLDER ? 'Folder' : 'Favorite'} “{selected.node.name}”
                </h3>
                <div className={styles.actions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="pen"
                    onClick={() => setRenameOpen(true)}
                    disabled={readOnly}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="arrow-up"
                    onClick={() => shift(-1)}
                    disabled={readOnly || selected.index === 0}
                  >
                    Move up
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="arrow-down"
                    onClick={() => shift(1)}
                    disabled={readOnly || selected.index === selected.siblings.length - 1}
                  >
                    Move down
                  </Button>
                  {selected.node.kind === NodeKind.FAVORITE && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="edit"
                      onClick={() => openEdit(selected.node.ref)}
                      disabled={readOnly}
                    >
                      Edit queries
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="destructive"
                    icon="trash-alt"
                    onClick={() => void askDelete()}
                    disabled={readOnly || (selected.node.kind === NodeKind.FOLDER && selected.node.children.length > 0)}
                    tooltip={
                      selected.node.kind === NodeKind.FOLDER && selected.node.children.length > 0
                        ? 'Only empty folders can be deleted'
                        : undefined
                    }
                  >
                    Delete
                  </Button>
                </div>
                {isTempId(selected.node.ref) && <div className={styles.hint}>Created here; saved when you apply.</div>}
              </>
            )}
            {actionError && <div className={styles.error}>{actionError}</div>}
          </section>
        </div>
      ) : null}

      {failure && <ConflictNotice failure={failure} actions={failureActions()} onDismiss={() => setFailure(null)} />}

      <Modal.ButtonRow>
        <Button variant="secondary" fill="outline" onClick={requestClose} disabled={saving}>
          {dirty ? 'Cancel' : 'Close'}
        </Button>
        <Button
          variant="primary"
          icon={saving ? 'spinner' : 'save'}
          onClick={apply}
          disabled={saving || !dirty || readOnly}
        >
          {saving ? 'Applying…' : `Apply${dirty ? ` (${ops.length})` : ''}`}
        </Button>
      </Modal.ButtonRow>

      {newFolderOpen && (
        <NewFolderDialog
          nodes={nodes}
          selectedFolder={selected?.node.kind === NodeKind.FOLDER ? selected.node : null}
          onCreate={createFolder}
          onDismiss={() => setNewFolderOpen(false)}
        />
      )}
      {renameOpen && selected && (
        <RenameDialog
          node={selected.node}
          siblings={selected.siblings}
          onRename={rename}
          onDismiss={() => setRenameOpen(false)}
        />
      )}
      <ConfirmModal
        isOpen={confirmDelete !== null}
        title={`Delete “${confirmDelete?.name ?? ''}”?`}
        body={
          confirmDelete?.queries === null
            ? 'Its queries cannot be read. Deleting removes the favorite and whatever is stored for it.'
            : `This favorite holds ${confirmDelete?.queries ?? 0} quer${confirmDelete?.queries === 1 ? 'y' : 'ies'}; they are deleted with it when you apply.`
        }
        confirmText="Delete"
        onConfirm={() => {
          if (confirmDelete) {
            deleteFavorite(confirmDelete.ref);
          }
        }}
        onDismiss={() => setConfirmDelete(null)}
      />
      <ConfirmModal
        isOpen={confirmReset}
        title="Reset favorites?"
        body="This removes every stored favorite and starts an empty menu. Export the stored data first if you may need it. Other data in your Grafana user storage is kept."
        confirmText="Reset"
        onConfirm={() => {
          setConfirmReset(false);
          void run([{ kind: 'resetFavorites' }], base?.snapshot ? base : null, 'Favorites were reset.');
        }}
        onDismiss={() => setConfirmReset(false)}
      />
      <ConfirmModal
        isOpen={confirmClose}
        title="Discard changes?"
        body={`${ops.length} change${ops.length === 1 ? ' is' : 's are'} not applied. Close anyway?`}
        confirmText="Discard"
        dismissText="Keep editing"
        onConfirm={onClose}
        onDismiss={() => setConfirmClose(false)}
      />
    </Modal>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  modal: css({
    width: 'min(960px, calc(100vw - 32px))',
  }),
  layout: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 3fr) minmax(240px, 2fr)',
    gap: theme.spacing(2),
    [theme.breakpoints.down('md')]: {
      gridTemplateColumns: '1fr',
    },
  }),
  treeColumn: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  detailColumn: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  treeBox: css({
    height: 'min(420px, calc(100vh - 360px))',
    overflowY: 'auto',
    padding: theme.spacing(0.5),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  actions: css({
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
  }),
  selectedTitle: css({
    margin: 0,
    fontSize: theme.typography.size.md,
    overflowWrap: 'anywhere',
  }),
  newBadge: css({
    padding: theme.spacing(0, 0.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.success.transparent,
    color: theme.colors.success.text,
    fontSize: theme.typography.size.xs,
  }),
  dragging: css({
    opacity: 0.5,
  }),
  dropInside: css({
    background: theme.colors.primary.transparent,
    boxShadow: `inset 0 0 0 1px ${theme.colors.primary.border}`,
  }),
  dropBefore: css({
    boxShadow: `inset 0 2px 0 ${theme.colors.primary.main}`,
  }),
  dropAfter: css({
    boxShadow: `inset 0 -2px 0 ${theme.colors.primary.main}`,
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  error: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.size.sm,
  }),
});
