// Telling other windows about a save (docs/plan_v3.md §7.4.6). This only shortens how long another
// window shows old data; correctness comes from the conditional writes, so a browser without
// BroadcastChannel simply skips it.

export interface FavoritesChannel {
  /** Announce the resourceVersion this window just saved. */
  post(resourceVersion: string): void;
  close(): void;
}

/** One channel per user resource, named vmexplorer-favorites:<namespace>:<resource name>. */
export function openFavoritesChannel(scope: string, onVersion: (resourceVersion: string) => void): FavoritesChannel {
  if (typeof BroadcastChannel === 'undefined') {
    return { post: () => undefined, close: () => undefined };
  }
  const channel = new BroadcastChannel(`vmexplorer-favorites:${scope}`);
  channel.onmessage = (event: MessageEvent) => {
    const resourceVersion = (event.data as { resourceVersion?: unknown } | null)?.resourceVersion;
    if (typeof resourceVersion === 'string') {
      onVersion(resourceVersion);
    }
  };
  return {
    post: (resourceVersion) => channel.postMessage({ resourceVersion }),
    close: () => channel.close(),
  };
}

/** Call onVisible whenever the window gains focus or becomes visible; returns the unsubscribe. */
export function watchVisibility(onVisible: () => void): () => void {
  const handler = () => {
    if (document.visibilityState === 'visible') {
      onVisible();
    }
  };
  window.addEventListener('focus', handler);
  document.addEventListener('visibilitychange', handler);
  return () => {
    window.removeEventListener('focus', handler);
    document.removeEventListener('visibilitychange', handler);
  };
}
