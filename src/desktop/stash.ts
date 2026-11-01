/**
 * Drag-and-drop on the home screen gives us File objects, but the renderer
 * never sees real paths and the preload API has no "grant a dropped file"
 * call. So dropped files are parked in IndexedDB and handed to the next page
 * as ids of the form `stash:<uuid>` inside the same `desk-file` query param.
 *
 * Consumers (tool flows) do:
 *   if (isStashId(id)) file = await takeStashed(id)   // File | null, deleted on read
 *   else bytes = await desk.readFile(id)
 */

const DB = 'inkleaf-handoff';
const STORE = 'files';
const PREFIX = 'stash:';

export const isStashId = (id: string): boolean => id.startsWith(PREFIX);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        t.onerror = t.onabort = () => {
          db.close();
          reject(t.error);
        };
      })
  );
}

/** Hand-offs are consumed within seconds; anything older was abandoned (crash, failed navigation). */
export const STASH_TTL_MS = 10 * 60 * 1000;

/** Drops abandoned entries so dropped documents do not linger on disk in the profile's IndexedDB. */
export async function pruneStash(now = Date.now()): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction(STORE, 'readwrite');
      const req = t.objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        const at = (c.value as { at?: number } | undefined)?.at;
        if (typeof at !== 'number' || now - at > STASH_TTL_MS) c.delete();
        c.continue();
      };
      t.oncomplete =
        t.onerror =
        t.onabort =
          () => {
            db.close();
            resolve();
          };
    });
  } catch {
    /* IndexedDB unavailable */
  }
}

export async function stashFiles(files: File[]): Promise<string[]> {
  await pruneStash();
  const ids: string[] = [];
  for (const f of files) {
    const id = PREFIX + crypto.randomUUID();
    await tx('readwrite', (s) =>
      s.put({ blob: f, name: f.name, type: f.type, at: Date.now() }, id)
    );
    ids.push(id);
  }
  return ids;
}

/** Returns the file and removes it from the stash. */
export async function takeStashed(id: string): Promise<File | null> {
  if (!isStashId(id)) return null;
  const rec = await tx<{ blob: Blob; name: string; type: string } | undefined>(
    'readonly',
    (s) => s.get(id)
  );
  if (!rec) return null;
  await tx('readwrite', (s) => s.delete(id)).catch(() => {});
  return new File([rec.blob], rec.name, {
    type: rec.type || 'application/pdf',
  });
}
