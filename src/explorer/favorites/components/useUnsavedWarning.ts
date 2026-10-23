import { useEffect } from 'react';

/** Ask before the page is closed or reloaded while a draft exists only in page memory. */
export function useUnsavedWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}
