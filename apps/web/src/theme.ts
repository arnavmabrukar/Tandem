import { useSyncExternalStore } from 'react';

// Light or dark, applied as data-theme on <html>. The inline script in index.html sets it before
// the first paint, from the saved choice or else the system setting; this module changes it later.
export type Theme = 'light' | 'dark';
const KEY = 'tandem-theme';
const listeners = new Set<() => void>();

const current = (): Theme =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Storage can be blocked. The choice still applies until the page reloads. */
  }
  listeners.forEach((notify) => notify());
}

export function useTheme() {
  const theme = useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    current,
    () => 'light' as Theme,
  );
  return { theme, setTheme };
}
