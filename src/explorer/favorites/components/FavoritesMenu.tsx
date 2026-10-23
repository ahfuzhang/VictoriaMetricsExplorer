import React, { useMemo, useState } from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, IconButton, LoadingPlaceholder, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { useFavorites } from '../FavoritesProvider';
import { countMenuNodes, toMenuNodes } from '../menuModel';
import { FavoritesTree } from './FavoritesTree';

/**
 * The user's favorites menu, last in the first column (docs/plan_v3.md §3.5). Loaded from the
 * Grafana server; collapsing it never delays that load.
 */
export const FavoritesMenu: React.FC = () => {
  const styles = useStyles2(getStyles);
  const { status, message, menu, selection, selectFavorite, openManage, refresh, writeBlocked } = useFavorites();
  const [expanded, setExpanded] = useState(true);
  const nodes = useMemo(() => (menu?.state === 'ok' ? toMenuNodes(menu.tree) : []), [menu]);

  let body: React.ReactNode;
  if (status === 'loading') {
    body = <LoadingPlaceholder text="Loading favorites…" className={styles.padded} />;
  } else if (status === 'unavailable') {
    body = <div className={styles.note}>Favorites are not available: {message}</div>;
  } else if (menu?.state === 'corrupt') {
    body = (
      <div className={styles.note}>
        {menu.newerVersion
          ? 'Favorites were saved by a newer version of the app.'
          : 'Your saved favorites cannot be read.'}{' '}
        <Button size="sm" variant="secondary" fill="text" onClick={openManage}>
          Open settings
        </Button>
      </div>
    );
  } else if (nodes.length === 0) {
    // Where saving is blocked, the reason below says it all.
    body = status === 'ready' && !writeBlocked && (
      <div className={styles.note}>No favorites yet. Use ★ Favorite on a chart to save one here.</div>
    );
  } else {
    body = (
      <FavoritesTree
        nodes={nodes}
        selectedRef={selection?.favoriteId ?? null}
        onSelect={(node) => selectFavorite(node.ref)}
        ariaLabel="My favorites"
      />
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.branch}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
          <span>My favorites</span>
          <span className={styles.count}>{nodes.length > 0 ? countMenuNodes(nodes) : '—'}</span>
        </button>
        <IconButton
          name="cog"
          size="sm"
          tooltip="Manage favorites"
          onClick={openManage}
          disabled={status === 'unavailable' || status === 'loading'}
        />
      </div>
      {expanded && (
        <div className={styles.children}>
          {status === 'error' && (
            <div className={styles.error}>
              Cannot read favorites from Grafana: {message}{' '}
              <Button size="sm" variant="secondary" fill="text" onClick={() => void refresh()}>
                Retry
              </Button>
            </div>
          )}
          {body}
          {writeBlocked && status === 'ready' && <div className={styles.note}>{writeBlocked}</div>}
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    marginTop: theme.spacing(0.5),
  }),
  header: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
  }),
  branch: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    flex: 1,
    minWidth: 0,
    padding: theme.spacing(0.75, 0.5),
    border: 0,
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.primary,
    cursor: 'pointer',
    fontWeight: theme.typography.fontWeightMedium,
    textAlign: 'left',
    '&:hover': {
      background: theme.colors.action.hover,
    },
  }),
  chevron: css({
    width: '14px',
    color: theme.colors.text.secondary,
    flexShrink: 0,
  }),
  count: css({
    marginLeft: 'auto',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    fontVariantNumeric: 'tabular-nums',
  }),
  children: css({
    marginLeft: theme.spacing(1.25),
    paddingLeft: theme.spacing(0.25),
    borderLeft: `1px solid ${theme.colors.border.weak}`,
  }),
  padded: css({
    padding: theme.spacing(1),
  }),
  note: css({
    padding: theme.spacing(0.625, 0.75),
    color: theme.colors.text.secondary,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.4,
  }),
  error: css({
    padding: theme.spacing(0.625, 0.75),
    color: theme.colors.warning.text,
    fontSize: theme.typography.size.xs,
    lineHeight: 1.4,
  }),
});
