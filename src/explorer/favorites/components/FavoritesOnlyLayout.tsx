import React from 'react';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';

import { useFavorites } from '../FavoritesProvider';
import { columnStyles } from './columnStyles';
import { FavoritesMenu } from './FavoritesMenu';
import { SavedModeColumns } from './SavedModeColumns';

/**
 * Favorites when the Explorer cannot be shown (no datasource, or its capabilities failed): the menu
 * alone in the first column and the saved-mode columns beside it. Statements run on the toolbar's
 * datasource when one is selected; with none, on the datasource each was saved with.
 */
export const FavoritesOnlyLayout: React.FC = () => {
  const styles = useStyles2(getStyles);
  const column = useStyles2(columnStyles);
  const { selection } = useFavorites();

  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        <section className={styles.column} aria-label="Favorites">
          <div className={column.header}>
            <div className={column.headingRow}>
              <span className={column.stepNumber}>01</span>
              <h2 className={column.title}>Favorites</h2>
            </div>
          </div>
          <div className={styles.menu}>
            <FavoritesMenu />
          </div>
        </section>
        {selection ? (
          <SavedModeColumns>
            {({ list, panel }) => (
              <>
                <section className={styles.column} aria-label="Saved queries">
                  {list}
                </section>
                <section className={styles.column} aria-label="Visualization">
                  {panel}
                </section>
              </>
            )}
          </SavedModeColumns>
        ) : (
          <section className={`${styles.column} ${styles.wide}`}>
            <div className={column.empty}>
              <strong>Saved favorites</strong>
              <span>
                Open a favorite from the menu to run its queries. With no datasource selected, they run on the ones they
                were saved with.
              </span>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  scroll: css({
    flex: 1,
    minHeight: '360px',
    minWidth: 0,
    overflowX: 'auto',
    overflowY: 'hidden',
  }),
  grid: css({
    display: 'grid',
    gridTemplateColumns: '220px 260px minmax(640px, 1fr)',
    gap: theme.spacing(1),
    height: '100%',
    minHeight: 0,
  }),
  column: css({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    background: theme.colors.background.primary,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    overflow: 'hidden',
  }),
  wide: css({
    gridColumn: 'span 2',
  }),
  menu: css({
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    padding: theme.spacing(0.5),
  }),
});
