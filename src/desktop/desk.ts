/**
 * Thin, defensive access to the preload API (`window.desk`, top frame only).
 * Everything works without it so pages also run in a plain browser.
 * Types are local on purpose: no global augmentation, so other modules can
 * declare their own view of the same API without conflicts.
 */

export interface DeskFile {
  id: string;
  name: string;
  size: number;
  /** Recent-list entries only: ms since epoch (0 = unknown). */
  lastOpened?: number;
}

export interface DeskApi {
  platform?: string;
  version?: string;
  openFiles(kind?: 'pdf' | 'any'): Promise<DeskFile[]>;
  readFile?(id: string): Promise<ArrayBuffer>;
  revealInFolder?(id: string): Promise<unknown>;
  recent?: {
    list(): Promise<DeskFile[]>;
    clear(): Promise<unknown>;
    add?(id: string): Promise<unknown>;
    remove?(id: string): Promise<unknown>;
  };
  onOpenWith?(cb: (files: DeskFile[]) => void): () => void;
  onMenu?(cb: (id: string) => void): () => void;
  theme?: {
    get(): Promise<'light' | 'dark'>;
    onChange(cb: (t: 'light' | 'dark') => void): () => void;
  };
}

export function getDesk(): DeskApi | undefined {
  try {
    const d = (window as unknown as { desk?: DeskApi }).desk;
    return typeof d === 'object' && d ? d : undefined;
  } catch {
    return undefined;
  }
}

export function platform(): 'mac' | 'win' | 'linux' {
  const p = getDesk()?.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'win';
  if (p === 'linux') return 'linux';
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'mac';
  if (/Windows/i.test(ua)) return 'win';
  return 'linux';
}

/** "[code] text" -> friendly text. */
export function deskErrorMessage(
  e: unknown,
  fallback = 'Something went wrong'
): string {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = /^\[[a-z_]+\]\s*(.*)$/i.exec(msg);
  return (m ? m[1] : msg) || fallback;
}

// --- tiny safe localStorage wrapper ---
export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / blocked */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = store.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: unknown): void {
    store.set(key, JSON.stringify(value));
  },
};
