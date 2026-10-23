import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Alert, Button, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css, cx } from '@emotion/css';

import { useFavorites } from '../FavoritesProvider';
import { columnStyles } from './columnStyles';
import { savedQuerySectionId } from './SavedQueriesPanel';

/** Column 2 in saved mode: the queries of the selected favorite, in saved order; a click scrolls to its charts. */
export const SavedQueryList: React.FC = () => {
  const styles = useStyles2(getStyles);
  const column = useStyles2(columnStyles);
  const {
    selectedNode,
    selectedContent,
    selectedQuery,
    selectQuery,
    exitSavedMode,
    openEdit,
    openManage,
    writeBlocked,
    selection,
  } = useFavorites();

  let body: React.ReactNode;
  if (!selectedNode) {
    body = (
      <div className={column.empty}>This favorite no longer exists; it may have been deleted in another window.</div>
    );
  } else if (!selectedContent) {
    body = (
      <div className={column.empty}>
        <LoadingPlaceholder text="Loading queries…" />
      </div>
    );
  } else if (selectedContent.state === 'missing') {
    body = (
      <Alert title="The queries of this favorite are missing" severity="error">
        The menu lists this favorite, but its queries are not stored. You can delete the favorite, or start it over with
        an empty list in Edit.
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => openEdit(selection!.favoriteId)}
            disabled={!!writeBlocked}
          >
            Edit
          </Button>
          <Button size="sm" variant="secondary" onClick={openManage}>
            Manage favorites
          </Button>
        </div>
      </Alert>
    );
  } else if (selectedContent.state === 'corrupt') {
    body = (
      <Alert title="The queries of this favorite cannot be read" severity="error">
        {selectedContent.newerVersion
          ? 'They were saved by a newer version of this app. Upgrade the app to view or change them.'
          : selectedContent.message}
        <div className={styles.actions}>
          <Button size="sm" variant="secondary" onClick={openManage}>
            Manage favorites
          </Button>
        </div>
      </Alert>
    );
  } else if (selectedContent.content.queries.length === 0) {
    body = (
      <div className={column.empty}>
        <strong>No queries yet</strong>
        <span>Use ★ Favorite on a chart to save one here, or write one in Edit.</span>
        <Button
          size="sm"
          variant="secondary"
          icon="pen"
          onClick={() => openEdit(selection!.favoriteId)}
          disabled={!!writeBlocked}
        >
          Edit
        </Button>
      </div>
    );
  } else {
    body = (
      <ul className={styles.list} aria-label="Saved queries">
        {selectedContent.content.queries.map((query) => {
          const active = query.id === selectedQuery?.id;
          return (
            <li key={query.id}>
              <button
                type="button"
                className={cx(styles.item, active && styles.itemActive)}
                aria-current={active}
                onClick={() => {
                  selectQuery(query.id);
                  document
                    .getElementById(savedQuerySectionId(query.id))
                    ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                }}
                title={query.name}
              >
                <span className={styles.name}>{query.name}</span>
                <span className={styles.count}>
                  {query.statements.length} statement{query.statements.length === 1 ? '' : 's'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={column.container}>
      <div className={column.header}>
        <div className={column.headingRow}>
          <span className={column.stepNumber}>02</span>
          <h2 className={column.title}>Queries</h2>
        </div>
        <div className={styles.favoriteName} title={selectedNode?.name}>
          ★ {selectedNode?.name ?? 'Favorite'}
        </div>
      </div>
      <div className={column.body}>{body}</div>
      <div className={column.footer}>
        <Button size="sm" variant="secondary" fill="text" icon="arrow-left" onClick={exitSavedMode}>
          Back to browsing
        </Button>
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  favoriteName: css({
    marginTop: theme.spacing(0.5),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.sm,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  list: css({
    listStyle: 'none',
    margin: 0,
    padding: theme.spacing(0.5),
  }),
  item: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: theme.spacing(0.25),
    width: '100%',
    padding: theme.spacing(0.75, 1),
    border: 0,
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    textAlign: 'left',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  itemActive: css({
    background: theme.colors.primary.transparent,
    color: theme.colors.primary.text,
    '&:hover': {
      background: theme.colors.primary.transparent,
    },
  }),
  name: css({
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: theme.typography.size.sm,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  count: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
  }),
  actions: css({
    display: 'flex',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  }),
});
