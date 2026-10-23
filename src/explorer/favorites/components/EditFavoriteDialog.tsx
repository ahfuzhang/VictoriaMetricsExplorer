import React, { useEffect, useMemo, useState } from 'react';
import { clone } from '@bufbuild/protobuf';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, ConfirmModal, IconButton, Input, LoadingPlaceholder, Modal, useStyles2 } from '@grafana/ui';
import { css, cx } from '@emotion/css';

import { SavedQuerySchema, type FavoriteContent, type SavedQuery } from '../../../generated/explorer/user_storage_pb';
import { notifySaved, useFavorites } from '../FavoritesProvider';
import { describeCommitFailure, newQuery, newStatement, updateQuery, type CommitFailure } from '../drafts';
import { MAX_QUERIES_PER_FAVORITE, MAX_STATEMENTS_PER_QUERY } from '../limits';
import { findMenuNode, freeName, toMenuNodes } from '../menuModel';
import type { SnapshotView } from '../snapshotView';
import { locate } from '../treeOperations';
import { FavoritesConflict, newTempId, type Operation } from '../types';
import { nameProblem, normalizeName, queryListProblems } from '../validation';
import { ConflictNotice, type NoticeAction } from './ConflictNotice';
import { QueryStatementEditor } from './QueryStatementEditor';
import { useUnsavedWarning } from './useUnsavedWarning';

interface Props {
  favoriteId: string;
  onClose: () => void;
}

interface Loaded {
  base: SnapshotView;
  name: string;
  /** Position of the favorite, for "save mine as a new favorite". */
  parentRef: string;
  /** null when the content key is missing: saving rebuilds it (§10.1). */
  content: FavoriteContent | null;
}

/**
 * Edit every query of one favorite (docs/plan_v3.md §3.6): names, statements, order. Saved as one
 * editFavoriteQueries operation, which only goes through when nobody changed the favorite since it
 * was opened here.
 */
export const EditFavoriteDialog: React.FC<Props> = ({ favoriteId, onClose }) => {
  const styles = useStyles2(getStyles);
  const { loadBase, commit, registerDraft, writeBlocked, defaultDatasourceUid, datasources, remoteChanged } =
    useFavorites();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<SavedQuery[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [serverQueries, setServerQueries] = useState<SavedQuery[] | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, setPending] = useState<{ ops: Operation[]; base: SnapshotView } | null>(null);

  useEffect(() => registerDraft(), [registerDraft]);
  useUnsavedWarning(dirty);

  // Bumped to read the server again ("Edit the latest version").
  const [loadCount, setLoadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const base = await loadBase();
      const menu = await base.menu();
      if (menu.state !== 'ok') {
        return { error: `Your saved menu cannot be read: ${menu.message}` };
      }
      const located = locate(menu.tree, BigInt(favoriteId));
      if (!located) {
        return { error: 'This favorite no longer exists; it may have been deleted in another window.' };
      }
      const read = await base.content(BigInt(favoriteId));
      if (read.state === 'corrupt') {
        return {
          error: read.newerVersion
            ? 'Its queries were saved by a newer version of this app and cannot be changed here.'
            : `Its queries cannot be read: ${read.message}`,
        };
      }
      return {
        loaded: {
          base,
          name: located.node.name,
          parentRef: located.parent ? located.parent.id.toString() : 'root',
          content: read.state === 'ok' ? read.content : null,
        },
      };
    };
    load()
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (!result.loaded) {
          setLoadError(result.error);
          return;
        }
        const queries = (result.loaded.content?.queries ?? []).map((query) => clone(SavedQuerySchema, query));
        setLoadError('');
        setLoaded(result.loaded);
        setDraft(queries);
        setOpenId(queries[0]?.id ?? null);
        setDirty(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [favoriteId, loadBase, loadCount]);

  const change = (next: SavedQuery[]) => {
    setDraft(next);
    setDirty(true);
  };
  const changeQuery = (index: number, query: SavedQuery) => change(draft.map((q, i) => (i === index ? query : q)));
  const moveQuery = (index: number, delta: -1 | 1) => {
    const next = [...draft];
    const [moved] = next.splice(index, 1);
    next.splice(index + delta, 0, moved);
    change(next);
  };

  const normalizedDraft = useMemo(
    () => draft.map((query) => updateQuery(query, { name: normalizeName(query.name) })),
    [draft]
  );
  const problems = useMemo(() => queryListProblems(normalizedDraft), [normalizedDraft]);

  const run = async (ops: Operation[], base: SnapshotView) => {
    setPending({ ops, base });
    setSaving(true);
    setFailure(null);
    try {
      await commit(ops, base.snapshot ? base : null);
      notifySaved(
        ops[0]?.kind === 'createFavorite'
          ? 'Saved as a new favorite on the Grafana server.'
          : 'Favorite saved on the Grafana server.'
      );
      onClose();
    } catch (err) {
      setFailure(describeCommitFailure(err));
      if (err instanceof FavoritesConflict) {
        // Show what the server holds now next to the draft.
        const view = await loadBase().catch(() => null);
        const read = view ? await view.content(BigInt(favoriteId)) : null;
        setServerQueries(read?.state === 'ok' ? read.content.queries : []);
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    setShowProblems(true);
    if (!loaded || problems.length > 0) {
      return;
    }
    void run([{ kind: 'editFavoriteQueries', favoriteId, queries: normalizedDraft }], loaded.base);
  };

  const saveAsNew = async () => {
    if (!loaded) {
      return;
    }
    try {
      // Placed right after the original, on the server's latest menu.
      const latest = await loadBase();
      const menu = await latest.menu();
      const nodes = menu.state === 'ok' ? toMenuNodes(menu.tree) : [];
      const siblings =
        loaded.parentRef === 'root' ? nodes : (findMenuNode(nodes, loaded.parentRef)?.node.children ?? nodes);
      await run(
        [
          {
            kind: 'createFavorite',
            position: { parentId: loaded.parentRef, afterId: favoriteId },
            name: freeName(siblings, `${loaded.name} (copy)`),
            tempId: newTempId(),
            // The copy's queries are new queries; their ids are made once here and kept by retries,
            // which reuse this exact batch.
            queries: normalizedDraft.map((query) => updateQuery(query, { id: crypto.randomUUID() })),
          },
        ],
        latest
      );
    } catch (err) {
      setFailure(describeCommitFailure(err));
    }
  };

  const failureActions = (): NoticeAction[] => {
    if (!failure || !pending) {
      return [];
    }
    if (failure.kind === 'uncertain') {
      return [{ label: 'Check again', variant: 'primary', onClick: () => void run(pending.ops, pending.base) }];
    }
    if (failure.kind === 'busy' || failure.kind === 'session') {
      return [{ label: 'Retry', variant: 'primary', onClick: () => void run(pending.ops, pending.base) }];
    }
    if (failure.kind === 'conflict') {
      return [
        {
          label: 'Edit the latest version',
          variant: 'primary',
          onClick: () => {
            setFailure(null);
            setServerQueries(null);
            setLoadCount((count) => count + 1);
          },
        },
        { label: 'Save mine as a new favorite', onClick: () => void saveAsNew() },
      ];
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

  const addQuery = () => {
    const datasourceUid = defaultDatasourceUid || draft[0]?.statements[0]?.datasourceUid || datasources[0]?.uid || '';
    const name = datasources.find((ds) => ds.uid === datasourceUid)?.name ?? '';
    const query = newQuery(freeQueryName(draft), [newStatement(datasourceUid, name)]);
    change([...draft, query]);
    setOpenId(query.id);
  };

  return (
    <Modal
      title={loaded ? `Edit “${loaded.name}”` : 'Edit favorite'}
      isOpen
      onDismiss={requestClose}
      className={styles.modal}
    >
      {writeBlocked && (
        <Alert title="Favorites cannot be saved here" severity="warning">
          {writeBlocked}
        </Alert>
      )}
      {remoteChanged && (
        <Alert title="Favorites changed in another window" severity="info">
          Saving merges your changes when they do not overlap; otherwise you will be asked what to do.
        </Alert>
      )}
      {loadError ? (
        <Alert title="Cannot edit this favorite" severity="error">
          {loadError}
        </Alert>
      ) : !loaded ? (
        <LoadingPlaceholder text="Loading queries…" />
      ) : (
        <div className={styles.body}>
          {!loaded.content && (
            <Alert title="The queries of this favorite were missing" severity="warning">
              Saving stores the list below (empty unless you add queries) for this favorite.
            </Alert>
          )}
          {draft.length === 0 && (
            <div className={styles.hint}>No queries. Add one below, or save to keep the favorite empty.</div>
          )}
          {draft.map((query, index) => {
            const open = query.id === openId;
            const queryNameProblem = showProblems ? nameProblem(query.name) : null;
            return (
              <section
                key={query.id}
                className={cx(styles.query, open && styles.queryOpen)}
                aria-label={`Query ${query.name}`}
              >
                <div className={styles.queryHeader}>
                  <IconButton
                    name={open ? 'angle-down' : 'angle-right'}
                    tooltip={open ? 'Collapse' : 'Expand'}
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? null : query.id)}
                  />
                  <Input
                    className={styles.queryName}
                    value={query.name}
                    aria-label="Query name"
                    invalid={!!queryNameProblem}
                    onChange={(event) => changeQuery(index, updateQuery(query, { name: event.currentTarget.value }))}
                  />
                  <span className={styles.hint}>
                    {query.statements.length} statement{query.statements.length === 1 ? '' : 's'}
                  </span>
                  <IconButton
                    name="arrow-up"
                    tooltip="Move up"
                    disabled={index === 0}
                    onClick={() => moveQuery(index, -1)}
                  />
                  <IconButton
                    name="arrow-down"
                    tooltip="Move down"
                    disabled={index === draft.length - 1}
                    onClick={() => moveQuery(index, 1)}
                  />
                  <IconButton
                    name="trash-alt"
                    tooltip="Delete query"
                    onClick={() => change(draft.filter((_, i) => i !== index))}
                  />
                </div>
                {queryNameProblem && <div className={styles.error}>{queryNameProblem}</div>}
                {open && (
                  <div className={styles.statements}>
                    {query.statements.map((statement, statementIndex) => (
                      <QueryStatementEditor
                        key={statementIndex}
                        statement={statement}
                        index={statementIndex}
                        count={query.statements.length}
                        canTryRun
                        showProblems={showProblems}
                        onChange={(next) =>
                          changeQuery(
                            index,
                            updateQuery(query, {
                              statements: query.statements.map((s, i) => (i === statementIndex ? next : s)),
                            })
                          )
                        }
                        onMove={(delta) => {
                          const statements = [...query.statements];
                          const [moved] = statements.splice(statementIndex, 1);
                          statements.splice(statementIndex + delta, 0, moved);
                          changeQuery(index, updateQuery(query, { statements }));
                        }}
                        onRemove={() =>
                          changeQuery(
                            index,
                            updateQuery(query, { statements: query.statements.filter((_, i) => i !== statementIndex) })
                          )
                        }
                      />
                    ))}
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="plus"
                      disabled={query.statements.length >= MAX_STATEMENTS_PER_QUERY}
                      onClick={() => {
                        const previous = query.statements[query.statements.length - 1];
                        changeQuery(
                          index,
                          updateQuery(query, {
                            statements: [
                              ...query.statements,
                              newStatement(
                                previous?.datasourceUid ?? defaultDatasourceUid,
                                previous?.datasourceNameHint ?? ''
                              ),
                            ],
                          })
                        );
                      }}
                    >
                      Add statement
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
          <div>
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              onClick={addQuery}
              disabled={draft.length >= MAX_QUERIES_PER_FAVORITE}
            >
              Add query
            </Button>
          </div>
        </div>
      )}

      {failure && (
        <ConflictNotice failure={failure} actions={failureActions()} onDismiss={() => setFailure(null)}>
          {serverQueries && (
            <div className={styles.compare}>
              <div>
                <strong>On the server now</strong>
                <ol>
                  {serverQueries.length === 0 && <li>(no queries)</li>}
                  {serverQueries.map((query) => (
                    <li key={query.id}>{query.name}</li>
                  ))}
                </ol>
              </div>
              <div>
                <strong>Your draft</strong>
                <ol>
                  {draft.length === 0 && <li>(no queries)</li>}
                  {draft.map((query) => (
                    <li key={query.id}>{query.name}</li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </ConflictNotice>
      )}
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
        <Button variant="secondary" fill="outline" onClick={requestClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon={saving ? 'spinner' : 'save'}
          onClick={save}
          disabled={saving || !loaded || !!writeBlocked}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </Modal.ButtonRow>

      <ConfirmModal
        isOpen={confirmClose}
        title="Discard changes?"
        body="Your changes to these queries are not saved. Close anyway?"
        confirmText="Discard"
        dismissText="Keep editing"
        onConfirm={onClose}
        onDismiss={() => setConfirmClose(false)}
      />
    </Modal>
  );
};

function freeQueryName(queries: SavedQuery[]): string {
  const names = new Set(queries.map((query) => normalizeName(query.name)));
  for (let index = queries.length + 1; ; index++) {
    const name = `Query ${index}`;
    if (!names.has(name)) {
      return name;
    }
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  modal: css({
    width: 'min(1000px, calc(100vw - 32px))',
  }),
  body: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    maxHeight: 'calc(100vh - 280px)',
    overflowY: 'auto',
  }),
  query: css({
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(0.5, 1),
  }),
  queryOpen: css({
    borderColor: theme.colors.border.medium,
  }),
  queryHeader: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  }),
  queryName: css({
    flex: 1,
  }),
  statements: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    padding: theme.spacing(1, 0),
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    whiteSpace: 'nowrap',
  }),
  error: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.size.xs,
  }),
  compare: css({
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: theme.spacing(2),
    marginTop: theme.spacing(1),
    ol: {
      margin: theme.spacing(0.5, 0, 0),
      paddingLeft: theme.spacing(2.5),
    },
  }),
  problemList: css({
    margin: 0,
    paddingLeft: theme.spacing(2),
  }),
});
