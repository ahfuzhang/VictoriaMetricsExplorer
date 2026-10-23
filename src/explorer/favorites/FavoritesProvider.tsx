import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppEvents, TimeRange } from '@grafana/data';
import { getAppEvents } from '@grafana/runtime';

import type { QueryStatement, SavedQuery, TreeNode } from '../../generated/explorer/user_storage_pb';
import { compressionSupported } from './codec';
import { openFavoritesChannel, watchVisibility, type FavoritesChannel } from './crossWindow';
import {
  GrafanaUserStorageAdapter,
  currentIdentity,
  identityScope,
  writeBlockedReason,
} from './grafanaUserStorageAdapter';
import { FOCUS_REFRESH_INTERVAL_MS } from './limits';
import { FavoritesRepository, type CommitResult } from './repository';
import { SnapshotView, type ContentRead, type MenuRead } from './snapshotView';
import { locate } from './treeOperations';
import { FavoritesConflict, UserStorageError, type Operation } from './types';
import { SaveFavoriteDialog } from './components/SaveFavoriteDialog';
import { EditFavoriteDialog } from './components/EditFavoriteDialog';
import { ManageFavoritesDialog } from './components/ManageFavoritesDialog';

// Lifecycle of the per-user favorites (docs/plan_v3.md §7, §9): one server snapshot in page memory,
// the saved-mode selection, and the save/edit/manage dialogs. The Grafana server is the only place
// favorites are kept; nothing here touches browser storage.

export interface DatasourceOption {
  uid: string;
  name: string;
}

export type FavoritesStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export interface SavedSelection {
  favoriteId: string;
  queryId: string | null;
}

/** What the Favorite button hands to the save dialog: the chart's statement, prefilled. */
export interface SaveRequest {
  queryName: string;
  statement: QueryStatement;
}

export interface FavoritesContextValue {
  status: FavoritesStatus;
  /** Why favorites are unavailable or the last read failed. */
  message: string;
  /** Why saving is impossible here (anonymous, unsupported Grafana or browser), or null. */
  writeBlocked: string | null;
  /** The last snapshot read from or confirmed by the server. */
  view: SnapshotView | null;
  menu: MenuRead | null;
  /** Another window saved while an editor was open here. */
  remoteChanged: boolean;

  datasources: DatasourceOption[];
  /** The toolbar's datasource, used as the default for new statements. */
  defaultDatasourceUid: string;
  timeRange: TimeRange;
  step: string;
  refreshKey: number;

  refresh(): Promise<void>;
  /** Read the server for an editor's base snapshot. */
  loadBase(): Promise<SnapshotView>;
  /** Commit a batch; the caller handles FavoritesConflict and the other failures. */
  commit(ops: Operation[], base: SnapshotView | null): Promise<CommitResult>;
  /** An editor holds a draft while the returned function has not been called. */
  registerDraft(): () => void;

  selection: SavedSelection | null;
  selectedNode: TreeNode | null;
  /** Content of the selected favorite; null while it loads. */
  selectedContent: ContentRead | null;
  selectedQuery: SavedQuery | null;
  selectFavorite(favoriteId: string): void;
  selectQuery(queryId: string): void;
  exitSavedMode(): void;

  openSave(request: SaveRequest): void;
  openEdit(favoriteId: string): void;
  openManage(): void;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function useFavorites(): FavoritesContextValue {
  const value = useContext(FavoritesContext);
  if (!value) {
    throw new Error('useFavorites() needs a FavoritesProvider');
  }
  return value;
}

/** Show a Grafana success toast; only called once the server confirmed a write. */
export function notifySaved(message: string): void {
  getAppEvents().publish({ type: AppEvents.alertSuccess.name, payload: [message] });
}

interface Props {
  pluginId: string;
  datasources: DatasourceOption[];
  selectedDatasource: string;
  timeRange: TimeRange;
  step: string;
  refreshKey: number;
}

interface LoadState {
  status: FavoritesStatus;
  message: string;
  view: SnapshotView | null;
  menu: MenuRead | null;
}

export const FavoritesProvider: React.FC<React.PropsWithChildren<Props>> = ({
  pluginId,
  datasources,
  selectedDatasource,
  timeRange,
  step,
  refreshKey,
  children,
}) => {
  const identity = useMemo(() => currentIdentity(pluginId), [pluginId]);
  const scope = identity ? identityScope(identity) : null;
  const unavailableReason = !identity
    ? 'Sign in to Grafana to keep favorites.'
    : !compressionSupported()
      ? 'This browser cannot compress data (CompressionStream is missing), so favorites cannot be used.'
      : null;
  const repository = useMemo(
    () => (identity && !unavailableReason ? new FavoritesRepository(new GrafanaUserStorageAdapter(identity)) : null),
    [identity, unavailableReason]
  );

  const [load, setLoad] = useState<LoadState>({
    status: repository ? 'loading' : 'unavailable',
    message: unavailableReason ?? '',
    view: null,
    menu: null,
  });
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [selection, setSelection] = useState<SavedSelection | null>(null);
  const [selectedContent, setSelectedContent] = useState<{ view: SnapshotView; id: string; read: ContentRead } | null>(
    null
  );
  const [saveRequest, setSaveRequest] = useState<SaveRequest | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);

  // Reads and commits finish out of order; only a result newer than the one shown replaces it.
  const sequenceRef = useRef(0);
  const appliedRef = useRef(0);
  const viewRef = useRef<SnapshotView | null>(null);
  const lastReadRef = useRef(0);
  const draftsRef = useRef(0);
  const remotePendingRef = useRef(false);
  const channelRef = useRef<FavoritesChannel | null>(null);

  const applyView = useCallback(async (view: SnapshotView, sequence: number) => {
    if (sequence < appliedRef.current) {
      return;
    }
    appliedRef.current = sequence;
    const menu = await view.menu();
    if (sequence !== appliedRef.current) {
      return;
    }
    viewRef.current = view;
    setLoad({ status: 'ready', message: '', view, menu });
  }, []);

  const refresh = useCallback(async () => {
    if (!repository) {
      return;
    }
    const sequence = ++sequenceRef.current;
    lastReadRef.current = Date.now();
    try {
      await applyView(await repository.loadFresh(), sequence);
    } catch (err) {
      if (sequence < appliedRef.current) {
        return;
      }
      const unavailable = err instanceof UserStorageError && err.kind === 'unavailable';
      // A failed read never becomes an empty menu: what was loaded stays visible, read-only.
      setLoad((previous) => ({
        ...previous,
        status: unavailable ? 'unavailable' : 'error',
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [applyView, repository]);

  const loadBase = useCallback(async () => {
    if (!repository) {
      throw new UserStorageError('unavailable', unavailableReason ?? 'Favorites are not available.');
    }
    const sequence = ++sequenceRef.current;
    lastReadRef.current = Date.now();
    const view = await repository.loadFresh();
    void applyView(view, sequence);
    return view;
  }, [applyView, repository, unavailableReason]);

  const commit = useCallback(
    async (ops: Operation[], base: SnapshotView | null) => {
      if (!repository) {
        throw new UserStorageError('unavailable', unavailableReason ?? 'Favorites are not available.');
      }
      try {
        const result = await repository.commit(ops, base);
        await applyView(result.view, ++sequenceRef.current);
        if (!result.alreadyApplied && result.view.resourceVersion) {
          channelRef.current?.post(result.view.resourceVersion);
        }
        return result;
      } catch (err) {
        // The conflict carries the server's current data: show it behind the dialog right away.
        if (err instanceof FavoritesConflict && err.latest) {
          void applyView(new SnapshotView(err.latest, repository.cache), ++sequenceRef.current);
        }
        throw err;
      }
    },
    [applyView, repository, unavailableReason]
  );

  const registerDraft = useCallback(() => {
    draftsRef.current++;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      draftsRef.current--;
      if (draftsRef.current === 0 && remotePendingRef.current) {
        remotePendingRef.current = false;
        setRemoteChanged(false);
        void refresh();
      }
    };
  }, [refresh]);

  // First read, then other windows' saves and returning to this window.
  useEffect(() => {
    if (!repository || !scope) {
      return;
    }
    void refresh();
    const channel = openFavoritesChannel(scope, (resourceVersion) => {
      if (resourceVersion === viewRef.current?.resourceVersion) {
        return;
      }
      if (draftsRef.current > 0) {
        // Never touch an open draft or its base; the save will merge or report a conflict.
        remotePendingRef.current = true;
        setRemoteChanged(true);
      } else {
        void refresh();
      }
    });
    channelRef.current = channel;
    const stopWatching = watchVisibility(() => {
      if (draftsRef.current === 0 && Date.now() - lastReadRef.current >= FOCUS_REFRESH_INTERVAL_MS) {
        void refresh();
      }
    });
    return () => {
      channel.close();
      channelRef.current = null;
      stopWatching();
    };
  }, [refresh, repository, scope]);

  // The selected favorite's content, decoded from the snapshot shown.
  const selectedId = selection?.favoriteId ?? null;
  useEffect(() => {
    const view = load.view;
    if (!selectedId || !view) {
      setSelectedContent(null);
      return;
    }
    let cancelled = false;
    void view.content(BigInt(selectedId)).then((read) => {
      if (!cancelled) {
        setSelectedContent({ view, id: selectedId, read });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load.view, selectedId]);

  // While a newer snapshot is decoded, keep showing the favorite's previous content: blanking it
  // would unmount the charts and query every statement again. An unchanged stored value decodes to
  // the very same objects (DecodeCache), so nothing re-runs once the new snapshot is in.
  const currentContent = selectedContent && selectedContent.id === selectedId ? selectedContent.read : null;
  const selectedNode = useMemo(() => {
    if (!selectedId || load.menu?.state !== 'ok') {
      return null;
    }
    return locate(load.menu.tree, BigInt(selectedId))?.node ?? null;
  }, [load.menu, selectedId]);
  const queries = currentContent?.state === 'ok' ? currentContent.content.queries : [];
  const selectedQuery = queries.find((query) => query.id === selection?.queryId) ?? queries[0] ?? null;

  const selectFavorite = useCallback((favoriteId: string) => {
    setSelection((previous) => (previous?.favoriteId === favoriteId ? previous : { favoriteId, queryId: null }));
  }, []);
  const selectQuery = useCallback((queryId: string) => {
    setSelection((previous) => (previous ? { ...previous, queryId } : previous));
  }, []);
  const exitSavedMode = useCallback(() => setSelection(null), []);
  const openManage = useCallback(() => setManageOpen(true), []);

  const value: FavoritesContextValue = {
    status: load.status,
    message: load.message,
    writeBlocked: unavailableReason ?? (load.status === 'unavailable' ? load.message : null) ?? writeBlockedReason(),
    view: load.view,
    menu: load.menu,
    remoteChanged,
    datasources,
    defaultDatasourceUid: selectedDatasource,
    timeRange,
    step,
    refreshKey,
    refresh,
    loadBase,
    commit,
    registerDraft,
    selection,
    selectedNode,
    selectedContent: currentContent,
    selectedQuery,
    selectFavorite,
    selectQuery,
    exitSavedMode,
    openSave: setSaveRequest,
    openEdit: setEditId,
    openManage,
  };

  return (
    <FavoritesContext.Provider value={value}>
      {children}
      {saveRequest && <SaveFavoriteDialog request={saveRequest} onClose={() => setSaveRequest(null)} />}
      {manageOpen && <ManageFavoritesDialog onClose={() => setManageOpen(false)} />}
      {editId && <EditFavoriteDialog favoriteId={editId} onClose={() => setEditId(null)} />}
    </FavoritesContext.Provider>
  );
};
