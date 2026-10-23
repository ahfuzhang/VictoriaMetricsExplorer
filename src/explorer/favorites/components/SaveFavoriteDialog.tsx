import React, { useEffect, useId, useMemo, useState } from 'react';
import { create } from '@bufbuild/protobuf';
import { GrafanaTheme2 } from '@grafana/data';
import {
  Alert,
  Button,
  ConfirmModal,
  Field,
  Input,
  LoadingPlaceholder,
  Modal,
  RadioButtonGroup,
  useStyles2,
} from '@grafana/ui';
import { css } from '@emotion/css';

import { NodeKind, SavedQuerySchema, type QueryStatement } from '../../../generated/explorer/user_storage_pb';
import { notifySaved, useFavorites, type SaveRequest } from '../FavoritesProvider';
import { describeCommitFailure, newStatement, type CommitFailure } from '../drafts';
import { MAX_QUERIES_PER_FAVORITE, MAX_STATEMENTS_PER_QUERY, MAX_TREE_DEPTH, MAX_TREE_NODES } from '../limits';
import {
  childrenOf,
  cloneMenu,
  countMenuNodes,
  findMenuNode,
  folderChoices,
  insertMenuNode,
  nameTaken,
  toMenuNodes,
  type MenuNode,
} from '../menuModel';
import type { ContentRead, SnapshotView } from '../snapshotView';
import { FavoritesConflict, ROOT, newTempId, type NodeRef, type Operation } from '../types';
import { nameProblem, normalizeName, queryProblems } from '../validation';
import { ConflictNotice, type NoticeAction } from './ConflictNotice';
import { FavoritesTree } from './FavoritesTree';
import { NewFolderDialog } from './NewFolderDialog';
import { QueryStatementEditor } from './QueryStatementEditor';
import { useUnsavedWarning } from './useUnsavedWarning';

interface Props {
  request: SaveRequest;
  onClose: () => void;
}

type SaveMode = 'append' | 'replace';

/**
 * Save the current chart as one query (docs/plan_v3.md §3.4): pick or create a favorite, edit the
 * query's statements, then commit everything at once. Until then nothing reaches the server.
 */
export const SaveFavoriteDialog: React.FC<Props> = ({ request, onClose }) => {
  const styles = useStyles2(getStyles);
  const id = useId();
  const { loadBase, commit, registerDraft, writeBlocked, datasources } = useFavorites();

  const [base, setBase] = useState<SnapshotView | null>(null);
  const [loadError, setLoadError] = useState('');
  const [menuError, setMenuError] = useState('');
  const [menu, setMenu] = useState<MenuNode[] | null>(null);
  const [targetRef, setTargetRef] = useState<string | null>(null);
  const [loadedContent, setLoadedContent] = useState<{ view: SnapshotView; ref: string; read: ContentRead } | null>(
    null
  );
  // A name here creates a new favorite instead of saving into one picked in the menu.
  const [newName, setNewName] = useState('');
  // Kept through retries, like queryId, so the new favorite is created once.
  const [newFavoriteRef] = useState(() => newTempId());
  const [queryName, setQueryName] = useState(request.queryName);
  const [statements, setStatements] = useState<QueryStatement[]>([request.statement]);
  // Made when the dialog opens and kept through retries, so a lost response is never saved twice.
  const [queryId] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<SaveMode>('append');
  const [replaceChoice, setReplaceChoice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, setPending] = useState<{ ops: Operation[]; base: SnapshotView | null } | null>(null);

  useEffect(() => registerDraft(), [registerDraft]);
  useUnsavedWarning(dirty);

  // Each request reads the server again; target is the node to select afterwards.
  const [reloadRequest, setReloadRequest] = useState<{ count: number; target?: string | null }>({ count: 0 });
  const reload = (target?: string | null) => setReloadRequest((previous) => ({ count: previous.count + 1, target }));

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
        if (read.state !== 'ok') {
          setMenu(null);
          setMenuError(read.message);
          return;
        }
        setMenuError('');
        const nodes = toMenuNodes(read.tree);
        setMenu(nodes);
        setTargetRef((previous) => {
          const wanted = reloadRequest.target !== undefined ? reloadRequest.target : previous;
          return wanted && findMenuNode(nodes, wanted) ? wanted : null;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadBase, reloadRequest]);

  const target = menu && targetRef ? findMenuNode(menu, targetRef) : null;
  const targetIsFavorite = target?.node.kind === NodeKind.FAVORITE;
  const creating = normalizeName(newName) !== '';
  const existingTarget = !creating && targetIsFavorite ? target!.node.ref : null;
  // A new favorite goes into the selected folder (or the selected favorite's folder), else the top level.
  const newParentRef = !target
    ? ROOT
    : target.node.kind === NodeKind.FOLDER
      ? target.node.ref
      : (target.parent?.ref ?? ROOT);
  const newParent = menu ? childrenOf(menu, newParentRef) : null;
  const newParentLabel =
    newParentRef === ROOT
      ? null
      : (folderChoices(menu ?? []).find((choice) => choice.ref === newParentRef)?.label ?? '');

  useEffect(() => {
    if (!existingTarget || !base) {
      return;
    }
    let cancelled = false;
    void base.content(BigInt(existingTarget)).then((read) => {
      if (!cancelled) {
        setLoadedContent({ view: base, ref: existingTarget, read });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [base, existingTarget]);

  const targetContent =
    loadedContent && loadedContent.view === base && loadedContent.ref === existingTarget ? loadedContent.read : null;
  const existingQueries = targetContent?.state === 'ok' ? targetContent.content.queries : [];
  const full = existingQueries.length >= MAX_QUERIES_PER_FAVORITE;
  const effectiveMode: SaveMode = full ? 'replace' : mode;
  const replaceId = existingQueries.some((existing) => existing.id === replaceChoice) ? replaceChoice : null;

  const edit =
    <T,>(setter: React.Dispatch<React.SetStateAction<T>>) =>
    (value: React.SetStateAction<T>) => {
      setter(value);
      setDirty(true);
    };

  // ------------------------------------------------------------------------
  // Location

  /**
   * Add a folder named and placed in NewFolderDialog, which has checked both, at the end of its
   * parent. It is created on the server with the save, and selected so a new favorite goes into it.
   */
  const addFolder = (name: string, parentRef: NodeRef) => {
    const parent = menu ? childrenOf(menu, parentRef) : null;
    if (!menu || !parent) {
      return;
    }
    const node: MenuNode = { ref: newTempId(), name, kind: NodeKind.FOLDER, children: [], draft: true };
    const next = cloneMenu(menu);
    const afterId = parent.siblings.length > 0 ? parent.siblings[parent.siblings.length - 1].ref : null;
    insertMenuNode(next, node, { parentId: parentRef, afterId });
    setMenu(next);
    setTargetRef(node.ref);
    setDirty(true);
    setNewFolderOpen(false);
  };

  // ------------------------------------------------------------------------
  // Save

  const query = useMemo(
    () =>
      create(SavedQuerySchema, {
        id: effectiveMode === 'replace' && existingTarget && replaceId ? replaceId : queryId,
        name: normalizeName(queryName),
        statements,
      }),
    [effectiveMode, existingTarget, queryId, queryName, replaceId, statements]
  );

  const newNameProblem = useMemo(() => {
    if (!creating) {
      return null;
    }
    const name = normalizeName(newName);
    if (!newParent) {
      return 'The chosen folder no longer exists.';
    }
    if (newParent.depth + 1 > MAX_TREE_DEPTH || countMenuNodes(menu ?? []) >= MAX_TREE_NODES) {
      return `Favorites hold at most ${MAX_TREE_NODES} entries, nested at most ${MAX_TREE_DEPTH} levels deep.`;
    }
    return (
      nameProblem(name) ?? (nameTaken(newParent.siblings, name) ? `“${name}” already exists in that folder.` : null)
    );
  }, [creating, menu, newName, newParent]);

  const problems = useMemo(() => {
    const list = [...queryProblems(query)];
    if (newNameProblem) {
      list.push(`New favorite: ${newNameProblem}`);
    } else if (!creating && !targetIsFavorite) {
      list.push('Choose a favorite to save into, or enter a name for a new one.');
    }
    if (existingTarget) {
      if (targetContent?.state !== 'ok') {
        list.push('The queries of the chosen favorite cannot be read.');
      } else if (effectiveMode === 'replace' && !replaceId) {
        list.push('Choose the query to replace.');
      }
    }
    return list;
  }, [creating, effectiveMode, existingTarget, newNameProblem, query, replaceId, targetContent, targetIsFavorite]);

  const buildOps = (): Operation[] => {
    const ops: Operation[] = [];
    // Pre-order: a parent and the sibling a node follows are always created before it.
    const walk = (siblings: MenuNode[], parentRef: string) => {
      siblings.forEach((node, index) => {
        if (node.draft) {
          const position = { parentId: parentRef, afterId: index > 0 ? siblings[index - 1].ref : null };
          ops.push({ kind: 'createFolder', position, name: node.name, tempId: node.ref });
        }
        walk(node.children, node.ref);
      });
    };
    walk(menu ?? [], ROOT);
    if (creating && newParent) {
      // Last in its folder, after any folder created there above.
      const { siblings } = newParent;
      ops.push({
        kind: 'createFavorite',
        position: { parentId: newParentRef, afterId: siblings.length > 0 ? siblings[siblings.length - 1].ref : null },
        name: normalizeName(newName),
        tempId: newFavoriteRef,
        queries: [query],
      });
    } else if (existingTarget) {
      ops.push(
        effectiveMode === 'replace'
          ? { kind: 'replaceQuery', favoriteId: existingTarget, query }
          : { kind: 'appendQuery', favoriteId: existingTarget, query }
      );
    }
    return ops;
  };

  const run = async (ops: Operation[], commitBase: SnapshotView | null) => {
    setPending({ ops, base: commitBase });
    setSaving(true);
    setFailure(null);
    try {
      const result = await commit(ops, commitBase);
      notifySaved(
        result.alreadyApplied
          ? 'The query was already saved on the Grafana server.'
          : 'Saved to favorites on the Grafana server.'
      );
      onClose();
    } catch (err) {
      setFailure(describeCommitFailure(err));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    setShowProblems(true);
    if (problems.length > 0 || !base) {
      return;
    }
    void run(buildOps(), base.snapshot ? base : null);
  };

  const failureActions = (): NoticeAction[] => {
    if (!failure) {
      return [];
    }
    if (failure.kind === 'uncertain' && pending) {
      return [{ label: 'Check again', variant: 'primary', onClick: () => void run(pending.ops, pending.base) }];
    }
    if ((failure.kind === 'busy' || failure.kind === 'session') && pending) {
      return [{ label: 'Retry', variant: 'primary', onClick: () => void run(pending.ops, pending.base) }];
    }
    if (failure.kind === 'conflict' && failure.error instanceof FavoritesConflict) {
      const { conflict } = failure.error;
      const op = pending?.ops[conflict.opIndex];
      if (
        conflict.reason === 'nameTaken' &&
        !conflict.nodeIsFolder &&
        op?.kind === 'createFavorite' &&
        op.tempId === newFavoriteRef &&
        conflict.nodeId
      ) {
        const existing = conflict.nodeId;
        return [
          {
            label: 'Add to the existing favorite',
            variant: 'primary',
            onClick: () => {
              setMode('append');
              setNewName('');
              reload(existing);
              setFailure(null);
            },
          },
          { label: 'Choose another name', onClick: () => setFailure(null) },
        ];
      }
      const reloadAction: NoticeAction = {
        label: 'Reload locations',
        variant: 'primary',
        onClick: () => {
          reload();
          setFailure(null);
        },
      };
      // A clash with the new favorite's name is fixed by typing another one; reloading would drop the
      // new folders. A new folder cannot be renamed here, so its clash reloads to pick the folder
      // that now exists instead.
      return conflict.reason === 'nameTaken' && op?.kind === 'createFavorite'
        ? [
            { label: 'Choose another name', variant: 'primary', onClick: () => setFailure(null) },
            { ...reloadAction, variant: 'secondary' },
          ]
        : [reloadAction];
    }
    return [];
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

  const updateStatements = (next: QueryStatement[]) => {
    setStatements(next);
    setDirty(true);
  };

  return (
    <Modal title="Save to favorites" isOpen onDismiss={requestClose} className={styles.modal}>
      {writeBlocked && (
        <Alert title="Favorites cannot be saved here" severity="warning">
          {writeBlocked}
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
      {menuError && (
        <Alert title="Your saved menu cannot be read" severity="error">
          {menuError} Open Manage favorites to export or reset it; nothing can be saved until then.
        </Alert>
      )}

      <div className={styles.layout}>
        <section className={styles.location} aria-label="Location">
          <h3 className={styles.sectionTitle}>Location</h3>
          {!menu && !loadError && !menuError ? (
            <LoadingPlaceholder text="Loading favorites…" />
          ) : menu ? (
            <>
              <div className={styles.locationActions}>
                <Button size="sm" variant="secondary" icon="folder-plus" onClick={() => setNewFolderOpen(true)}>
                  New folder
                </Button>
              </div>
              <div className={styles.treeBox}>
                {menu.length === 0 ? (
                  <div className={styles.hint}>No favorites yet. Enter a name below to create one.</div>
                ) : (
                  <FavoritesTree
                    nodes={menu}
                    selectedRef={targetRef}
                    onSelect={(node) => {
                      setTargetRef(node.ref);
                      // Picking a favorite saves into it, so a new name typed before no longer applies.
                      if (node.kind === NodeKind.FAVORITE) {
                        setNewName('');
                      }
                    }}
                    selectFolders
                    ariaLabel="Choose where to save"
                    renderMeta={(node) => (node.draft ? <span className={styles.newBadge}>new</span> : null)}
                  />
                )}
              </div>
              <Field
                label="New favorite name"
                description={
                  creating
                    ? `Created ${newParentLabel === null ? 'at the top level' : `in “${newParentLabel}”`}.`
                    : 'Select a favorite above to save into it, or type a name to create a new one.'
                }
                htmlFor={`${id}-new-favorite`}
                invalid={showProblems && !!newNameProblem}
                error={showProblems ? newNameProblem : undefined}
              >
                <Input
                  id={`${id}-new-favorite`}
                  value={newName}
                  onChange={(event) => {
                    edit(setNewName)(event.currentTarget.value);
                    // The new favorite is saved instead of the picked one; keep its folder as the place.
                    if (targetIsFavorite) {
                      setTargetRef(target!.parent?.ref ?? null);
                    }
                  }}
                />
              </Field>
            </>
          ) : null}

          {existingTarget && (
            <div className={styles.existing}>
              <h4 className={styles.subTitle}>Already in “{target!.node.name}”</h4>
              {!targetContent ? (
                <LoadingPlaceholder text="Loading queries…" />
              ) : targetContent.state !== 'ok' ? (
                <div className={styles.error}>
                  {targetContent.state === 'missing' ? 'Its queries are missing.' : targetContent.message}
                </div>
              ) : (
                <>
                  <ul className={styles.existingList}>
                    {existingQueries.length === 0 && <li className={styles.hint}>No queries yet.</li>}
                    {existingQueries.map((existing) => (
                      <li key={existing.id}>
                        <label className={styles.existingItem}>
                          {effectiveMode === 'replace' && (
                            <input
                              type="radio"
                              name="replace-query"
                              checked={replaceId === existing.id}
                              onChange={() => edit(setReplaceChoice)(existing.id)}
                            />
                          )}
                          <span className={styles.existingName}>{existing.name}</span>
                          <span className={styles.hint}>
                            {existing.statements.length} statement{existing.statements.length === 1 ? '' : 's'}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {existingQueries.length > 0 && (
                    <Field
                      label="Save as"
                      description={
                        full ? `This favorite already holds ${MAX_QUERIES_PER_FAVORITE} queries.` : undefined
                      }
                    >
                      <RadioButtonGroup<SaveMode>
                        size="sm"
                        options={[
                          { label: 'Append at the end', value: 'append', disabled: full },
                          { label: 'Replace a query', value: 'replace' },
                        ]}
                        value={effectiveMode}
                        onChange={edit(setMode)}
                      />
                    </Field>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        <section className={styles.query} aria-label="Query">
          <h3 className={styles.sectionTitle}>Query</h3>
          <Field
            label="Name"
            htmlFor={`${id}-query-name`}
            invalid={showProblems && !!nameProblem(queryName)}
            error={showProblems ? nameProblem(queryName) : undefined}
          >
            <Input
              id={`${id}-query-name`}
              value={queryName}
              onChange={(event) => edit(setQueryName)(event.currentTarget.value)}
            />
          </Field>
          <div className={styles.statements}>
            {statements.map((statement, index) => (
              <QueryStatementEditor
                key={index}
                statement={statement}
                index={index}
                count={statements.length}
                showProblems={showProblems}
                onChange={(next) => updateStatements(statements.map((s, i) => (i === index ? next : s)))}
                onMove={(delta) => {
                  const next = [...statements];
                  const [moved] = next.splice(index, 1);
                  next.splice(index + delta, 0, moved);
                  updateStatements(next);
                }}
                onRemove={() => updateStatements(statements.filter((_, i) => i !== index))}
              />
            ))}
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={statements.length >= MAX_STATEMENTS_PER_QUERY}
            onClick={() => {
              const previous = statements[statements.length - 1];
              updateStatements([
                ...statements,
                newStatement(
                  previous?.datasourceUid ?? '',
                  previous?.datasourceNameHint ??
                    datasources.find((ds) => ds.uid === previous?.datasourceUid)?.name ??
                    ''
                ),
              ]);
            }}
          >
            Add statement
          </Button>
        </section>
      </div>

      {failure && <ConflictNotice failure={failure} actions={failureActions()} onDismiss={() => setFailure(null)} />}
      {showProblems && problems.length > 0 && (
        <Alert title="Not ready to save" severity="info">
          <ul className={styles.problemList}>
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Modal.ButtonRow>
        <span className={styles.footerNote}>
          Saved to your Grafana user on the server; changes stay here until you save.
        </span>
        <Button variant="secondary" fill="outline" onClick={requestClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={saving ? 'spinner' : 'save'}
          onClick={save}
          disabled={saving || !base || !menu || !!writeBlocked}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.ButtonRow>

      {newFolderOpen && menu && (
        <NewFolderDialog
          nodes={menu}
          selectedFolder={target?.node.kind === NodeKind.FOLDER ? target.node : null}
          onCreate={addFolder}
          onDismiss={() => setNewFolderOpen(false)}
        />
      )}
      <ConfirmModal
        isOpen={confirmClose}
        title="Discard changes?"
        body="Your changes are not saved. Close the dialog anyway?"
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
    width: 'min(1100px, calc(100vw - 32px))',
  }),
  layout: css({
    display: 'grid',
    gridTemplateColumns: 'minmax(260px, 1fr) minmax(320px, 2fr)',
    gap: theme.spacing(2),
    maxHeight: 'calc(100vh - 280px)',
    overflowY: 'auto',
    [theme.breakpoints.down('md')]: {
      gridTemplateColumns: '1fr',
    },
  }),
  location: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  query: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    minWidth: 0,
  }),
  sectionTitle: css({
    margin: 0,
    fontSize: theme.typography.h5.fontSize,
  }),
  subTitle: css({
    margin: theme.spacing(1, 0, 0.5),
    fontSize: theme.typography.size.sm,
  }),
  locationActions: css({
    display: 'flex',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  treeBox: css({
    maxHeight: '320px',
    overflowY: 'auto',
    padding: theme.spacing(0.5),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
  }),
  newBadge: css({
    padding: theme.spacing(0, 0.5),
    borderRadius: theme.shape.radius.default,
    background: theme.colors.success.transparent,
    color: theme.colors.success.text,
    fontSize: theme.typography.size.xs,
  }),
  existing: css({
    borderTop: `1px solid ${theme.colors.border.weak}`,
  }),
  existingList: css({
    listStyle: 'none',
    margin: theme.spacing(0, 0, 1),
    padding: 0,
  }),
  existingItem: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    padding: theme.spacing(0.25, 0),
    fontSize: theme.typography.size.sm,
  }),
  existingName: css({
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  statements: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  error: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.size.sm,
  }),
  problemList: css({
    margin: 0,
    paddingLeft: theme.spacing(2),
  }),
  footerNote: css({
    marginRight: 'auto',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
});
