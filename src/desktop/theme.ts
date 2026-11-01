/**
 * Theme: system by default (prefers-color-scheme, which Electron's
 * nativeTheme drives), manual light/dark override stored in localStorage.
 * desk.theme is used as the source of truth for "system" when available.
 */
import { getDesk, store } from './desk';

export type ThemePref = 'system' | 'light' | 'dark';
export type Effective = 'light' | 'dark';

const KEY = 'inkleaf.theme';
let nativeTheme: Effective | null = null;
const listeners = new Set<(t: Effective) => void>();

export function getPref(): ThemePref {
  const v = store.get(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function effectiveTheme(): Effective {
  const p = getPref();
  if (p !== 'system') return p;
  if (nativeTheme) return nativeTheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function apply(): void {
  const root = document.documentElement;
  const p = getPref();
  if (p === 'system') {
    // Follow the OS. If desk told us the native theme, pin it so both agree.
    if (nativeTheme) root.setAttribute('data-theme', nativeTheme);
    else root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', p);
  }
  const eff = effectiveTheme();
  root.setAttribute('data-theme-effective', eff);
  listeners.forEach((l) => l(eff));
}

export function setPref(p: ThemePref): void {
  if (p === 'system') store.remove(KEY);
  else store.set(KEY, p);
  apply();
}

export function toggleTheme(): Effective {
  const next: Effective = effectiveTheme() === 'dark' ? 'light' : 'dark';
  setPref(next);
  return next;
}

export function onThemeChange(cb: (t: Effective) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function initTheme(): void {
  apply();
  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener?.('change', () => {
      if (!nativeTheme) apply();
    });
  const desk = getDesk();
  if (desk?.theme) {
    desk.theme
      .get()
      .then((t) => {
        nativeTheme = t === 'dark' ? 'dark' : 'light';
        apply();
      })
      .catch(() => {});
    try {
      desk.theme.onChange((t) => {
        nativeTheme = t === 'dark' ? 'dark' : 'light';
        apply();
      });
    } catch {
      /* ignore */
    }
  }
  // Keep multiple open views of the app in step.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) apply();
  });
}
