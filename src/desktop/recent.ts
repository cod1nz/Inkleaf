/**
 * Recent files = desk.recent.list(): the main process is the single source of truth
 * (ids usable for handoff, display name, lastOpened in ms since epoch).
 */
import { DeskFile, getDesk } from './desk';

export interface RecentEntry extends DeskFile {
  /** ms since epoch; 0/undefined = unknown (legacy entry). */
  lastOpened?: number;
}

export async function listRecent(): Promise<RecentEntry[]> {
  const desk = getDesk();
  if (!desk?.recent) return [];
  try {
    return await desk.recent.list();
  } catch {
    return [];
  }
}

/** Bump these files to the top of the recent list (main stamps lastOpened). Dropped (stash) files are not recorded. */
export function noteOpened(files: DeskFile[]): void {
  const add = getDesk()?.recent?.add;
  if (!add) return;
  for (const f of files) {
    if (f.id.startsWith('stash:')) continue;
    void Promise.resolve(add(f.id)).catch(() => {});
  }
}

/** Really removes one entry (persisted by the main process). */
export async function dismissRecent(f: DeskFile): Promise<void> {
  try {
    await getDesk()?.recent?.remove?.(f.id);
  } catch {
    /* already gone */
  }
}

export async function clearRecent(): Promise<void> {
  try {
    await getDesk()?.recent?.clear();
  } catch {
    /* ignore */
  }
}
