import React, { useMemo } from 'react';

import { useFavorites } from '../FavoritesProvider';
import { resolveRange } from '../queryExecution';
import { SavedQueriesPanel } from './SavedQueriesPanel';
import { SavedQueryList } from './SavedQueryList';

export interface SavedColumns {
  list: React.ReactNode;
  panel: React.ReactNode;
}

/**
 * Columns 2–3 of saved mode, laid out by the caller: the Explorer puts them in its resizable grid,
 * the favorites-only layout (no usable datasource) in its own.
 */
export const SavedModeColumns: React.FC<{ children: (columns: SavedColumns) => React.ReactNode }> = ({ children }) => {
  const { timeRange, refreshKey, selection } = useFavorites();
  const favoriteId = selection?.favoriteId;
  // One absolute range per run: a relative range is resolved again when the favorite, the range or
  // Refresh changes, so every statement of a run shares the same "now".
  const range = useMemo(
    () => resolveRange(timeRange),
    // favoriteId and refreshKey only trigger the recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeRange, refreshKey, favoriteId]
  );
  return (
    <>
      {children({
        list: <SavedQueryList />,
        panel: <SavedQueriesPanel range={range} runKey={String(refreshKey)} />,
      })}
    </>
  );
};
