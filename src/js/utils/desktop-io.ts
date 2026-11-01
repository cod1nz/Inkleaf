/**
 * Inkleaf desktop file I/O bridge (M5).
 *
 * Loaded ONLY in desktop mode: M4's chrome.ts must call `bootstrapFlows()` from
 * `src/desktop/flows/bootstrap.ts`, which calls `initDesktopIO()`. Nothing in the web
 * build imports this file, so web behaviour is unchanged.
 *
 * Output: every tool saves by creating an `<a download href=blob:>` and clicking it, often
 * WITHOUT attaching it to the DOM (so a document click listener never sees it). We therefore
 * patch HTMLAnchorElement.prototype.click/dispatchEvent (top window and every same-origin
 * iframe, e.g. the pdf.js viewers) and also keep a capture-phase click listener for real
 * clicks. Native pickers (showSaveFilePicker & co.) are removed so tools fall back to anchors.
 * Only the top frame has `window.desk`; same-origin iframes are handled by top-frame code
 * attaching to their windows, and getDesk() also falls back to `window.parent.desk`.
 *
 * No network calls. File contents, ids and paths are never logged or put in toasts.
 */

import { isStashId, takeStashed } from '../../desktop/stash';

export interface DeskApi {
  readFile(id: string): Promise<ArrayBuffer>;
  saveAs(o: {
    suggestedName?: string;
    mime?: string;
  }): Promise<{ id: string } | null>;
  write(id: string, data: ArrayBuffer): Promise<unknown>;
  revealInFolder(id: string): Promise<unknown>;
}

/** C0/C1 controls, zero-width, bidi overrides/isolates, BOM (built from code points on purpose). */
const UNSAFE_CHARS = new RegExp(
  '[' +
    [
      [0, 0x1f],
      [0x7f, 0x9f],
      [0x200b, 0x200f],
      [0x202a, 0x202e],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
    ]
      .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b))
      .join('') +
    ']',
  'g'
);

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export const MAX_FILES = 50;
export const MAX_NAME_LEN = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // matches main's 2 GB cap
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDeskId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v);
}

/**
 * Makes a name safe on every OS: NFC, no path separators / `..` / control or bidi chars,
 * no trailing dots or spaces, no Windows device names, <= 200 chars including extension.
 */
export function sanitizeFileName(raw: string, fallback = 'document'): string {
  let n = String(raw ?? '');
  try {
    n = n.normalize('NFC');
  } catch {
    /* keep as is */
  }
  if (n.length > 4096) n = n.slice(0, 4096);
  n = n
    .replace(UNSAFE_CHARS, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  // Windows takes everything before the FIRST dot as the device name (CON.tar.gz)
  const firstLen = n.split('.')[0].length;
  const first = n.slice(0, firstLen).replace(/ +$/, '');
  if (!first || WIN_RESERVED.test(first)) n = fallback + n.slice(firstLen);
  if (n.length > MAX_NAME_LEN) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : '';
    let stem = n.slice(0, MAX_NAME_LEN - ext.length);
    if (/[\ud800-\udbff]$/.test(stem)) stem = stem.slice(0, -1); // no split surrogate
    n = stem.replace(/[. ]+$/, '') + ext;
  }
  return n || fallback;
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  xml: 'application/xml',
  zip: 'application/zip',
};

const MIME_FORMAT =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,95}$/;
const MIME_EXACT = new Set([
  'application/pdf',
  'application/zip',
  'application/json',
  'application/xml',
  'application/octet-stream',
  'application/rtf',
  'application/epub+zip',
  'application/x-cbz',
  'application/x-pkcs12',
  'application/pkcs7-signature',
]);

/** Well-formed, allow-listed mime type, else application/octet-stream. */
export function sanitizeMime(raw: unknown): string {
  const m = String(raw ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!MIME_FORMAT.test(m)) return 'application/octet-stream';
  if (
    MIME_EXACT.has(m) ||
    m.startsWith('image/') ||
    m.startsWith('text/') ||
    m.startsWith('application/vnd.')
  )
    return m;
  return 'application/octet-stream';
}

function mimeFromName(name: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && EXT_MIME[ext]) || '';
}

/** Parses the "[code] text" prefix of errors thrown by window.desk. */
export function parseDeskError(e: unknown): { code: string; text: string } {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const m = /^\[(\w+)\]\s*([\s\S]*)$/.exec(msg);
  return m
    ? { code: m[1], text: m[2] }
    : { code: 'internal', text: msg || 'Unknown error' };
}

/** Fixed, path-free messages only: nothing from the error text is ever shown. */
export function friendlyError(e: unknown, action: 'open' | 'save'): string {
  const { code } = parseDeskError(e);
  if (/size|large|cap|limit/i.test(code))
    return `This file is too large to ${action} in the app.`;
  if (/denied|perm|access/i.test(code))
    return `Inkleaf does not have permission to ${action} this file.`;
  if (/notfound|missing|enoent|unknown|expired|grant/i.test(code))
    return action === 'open'
      ? 'That file is no longer available. Please open it again.'
      : 'Could not save the file. Please choose the location again.';
  return `Could not ${action} the file. Please try again.`;
}

export function getDesk(): DeskApi | undefined {
  const w = window as unknown as { desk?: DeskApi };
  if (w.desk) return w.desk;
  try {
    if (window !== window.top) {
      return (window.parent as unknown as { desk?: DeskApi }).desk;
    }
  } catch {
    /* cross-origin parent */
  }
  return undefined;
}

// ---- toast ----------------------------------------------------------------

function toast(
  message: string,
  opts: { action?: { label: string; run: () => void }; error?: boolean } = {}
): void {
  if (!document.body) return;
  let host = document.getElementById('inkleaf-io-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'inkleaf-io-toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;max-width:360px';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'inkleaf-io-toast';
  el.style.cssText = `padding:10px 14px;border-radius:8px;font:14px system-ui,sans-serif;color:#fff;background:${opts.error ? '#b3261e' : '#1f2937'};box-shadow:0 4px 16px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center`;
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (opts.action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opts.action.label;
    b.style.cssText =
      'background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit';
    b.addEventListener('click', () => {
      opts.action!.run();
      el.remove();
    });
    el.appendChild(b);
  }
  host.appendChild(el);
  setTimeout(() => el.remove(), opts.action ? 8000 : 5000);
}

// ---- blob registry (so saving never needs fetch(blob:), which CSP blocks) -----

const blobs = new Map<string, Blob>();
const patchedWindows = new WeakSet<object>();

function isBlobLike(o: unknown): o is Blob {
  // duck-typed: blobs created inside iframes are another realm's Blob
  return (
    !!o &&
    typeof o === 'object' &&
    typeof (o as Blob).arrayBuffer === 'function' &&
    typeof (o as Blob).size === 'number'
  );
}

function patchObjectUrls(win: Window): void {
  const U = (win as unknown as { URL: typeof URL }).URL;
  const create = U.createObjectURL.bind(U);
  const revoke = U.revokeObjectURL.bind(U);
  U.createObjectURL = (obj: Blob | MediaSource): string => {
    const url = create(obj);
    if (isBlobLike(obj)) blobs.set(url, obj);
    return url;
  };
  U.revokeObjectURL = (url: string): void => {
    // grace period: helpers revoke right after click()
    setTimeout(() => blobs.delete(url), 60_000);
    revoke(url);
  };
}

function dataUrlToBlob(url: string): Blob | undefined {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url);
  if (!m) return undefined;
  try {
    const type = sanitizeMime(m[1]);
    if (m[2]) {
      const bin = atob(m[3]);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type });
    }
    return new Blob([decodeURIComponent(m[3])], { type });
  } catch {
    return undefined;
  }
}

async function blobFromUrl(url: string): Promise<Blob | undefined> {
  const known = blobs.get(url);
  if (known) return known;
  if (/^data:/i.test(url)) return dataUrlToBlob(url);
  try {
    return await (await fetch(url)).blob();
  } catch {
    return undefined;
  }
}

// ---- output ---------------------------------------------------------------

export async function saveBlob(blob: Blob, name: string): Promise<boolean> {
  const desk = getDesk();
  if (!desk) return false;
  const suggestedName = sanitizeFileName(name, 'output');
  if (blob.size > MAX_FILE_BYTES) {
    toast(friendlyError(new Error('[too_large]'), 'save'), { error: true });
    return true;
  }
  try {
    const target = await desk.saveAs({
      suggestedName,
      mime: sanitizeMime(blob.type),
    });
    if (!target) return true; // user cancelled: silent
    await desk.write(target.id, await blob.arrayBuffer());
    toast(`Saved ${suggestedName}`, {
      action: {
        label: 'Show in folder',
        run: () => void desk.revealInFolder(target.id).catch(() => {}),
      },
    });
  } catch (e) {
    toast(friendlyError(e, 'save'), { error: true });
  }
  return true;
}

/** Returns true when the anchor was a blob/data download we took over. */
function interceptAnchor(a: Element | null): boolean {
  if (!a || !a.hasAttribute || !a.hasAttribute('download')) return false;
  const href = a.getAttribute('href') || '';
  if (!/^(blob:|data:)/i.test(href)) return false;
  if (!getDesk()) return false;
  const name = a.getAttribute('download') || 'output';
  void blobFromUrl(href).then((b) => {
    if (b) return saveBlob(b, name);
    toast('Could not save the file. Please try again.', { error: true });
  });
  return true;
}

function onClickCapture(ev: Event): void {
  const t = ev.target as Element | null;
  const a = t && t.closest ? t.closest('a[download]') : null;
  if (!a || !interceptAnchor(a)) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
}

const NATIVE_PICKERS = [
  'showSaveFilePicker',
  'showOpenFilePicker',
  'showDirectoryPicker',
];

/**
 * Options forced on every embedded pdf.js viewer (pdfjs-viewer/, pdfjs-annotation-viewer/). Viewers are same-origin
 * iframes and can reach window.desk through the parent, so PDF-supplied JavaScript must never run there; link
 * annotations open as _blank so they go through the main-process confirm dialog instead of navigating the frame.
 */
export const PDFJS_VIEWER_OPTIONS: Readonly<Record<string, unknown>> =
  Object.freeze({
    disablePreferences: true, // stored viewer preferences must not undo the options below
    enableScripting: false,
    isEvalSupported: false,
    externalLinkTarget: 2, // LinkTarget.BLANK
    pdfBugEnabled: false,
  });

/** `webviewerloaded` is dispatched synchronously on the parent document before the viewer reads its options. */
export function onViewerLoaded(ev: Event): void {
  try {
    const src = (ev as CustomEvent<{ source?: Window }>).detail?.source as
      | (Window & {
          PDFViewerApplicationOptions?: {
            set(name: string, value: unknown): void;
          };
        })
      | undefined;
    const opts = src?.PDFViewerApplicationOptions;
    if (!opts || typeof opts.set !== 'function') return;
    for (const [k, v] of Object.entries(PDFJS_VIEWER_OPTIONS)) {
      try {
        opts.set(k, v);
      } catch {
        /* option unknown to this viewer version */
      }
    }
  } catch {
    /* cross-origin source */
  }
}

/** Idempotently patches one window (top or same-origin iframe). Never throws. */
function patchWindow(win: Window): void {
  try {
    if (patchedWindows.has(win)) return;
    patchedWindows.add(win);
    patchObjectUrls(win);
    const AP = (
      win as unknown as { HTMLAnchorElement: typeof HTMLAnchorElement }
    ).HTMLAnchorElement.prototype;
    const origClick = AP.click;
    AP.click = function (this: HTMLAnchorElement) {
      if (interceptAnchor(this)) return;
      return origClick.call(this);
    };
    const origDispatch = AP.dispatchEvent;
    AP.dispatchEvent = function (this: HTMLAnchorElement, ev: Event) {
      if (ev && ev.type === 'click' && interceptAnchor(this)) return true;
      return origDispatch.call(this, ev);
    };
    // Tools feature-detect these; without them they use the anchor path (or hide the feature).
    for (const k of NATIVE_PICKERS) {
      try {
        delete (win as unknown as Record<string, unknown>)[k];
        if (k in win)
          Object.defineProperty(win, k, {
            value: undefined,
            configurable: true,
            writable: true,
          });
      } catch {
        /* ignore */
      }
    }
    win.document.addEventListener('click', onClickCapture, true);
    win.document.addEventListener('webviewerloaded', onViewerLoaded, true);
  } catch {
    /* cross-origin frame */
  }
}

function attachFrame(f: HTMLIFrameElement): void {
  const run = () => {
    try {
      if (f.contentWindow && f.contentDocument) patchWindow(f.contentWindow);
    } catch {
      /* cross-origin */
    }
  };
  f.addEventListener('load', run); // a navigation yields a new window object
  run();
}

let frameObserver: MutationObserver | null = null;

function watchFrames(): void {
  const scan = (root: Document | Element) =>
    root.querySelectorAll('iframe').forEach((f) => attachFrame(f));
  scan(document);
  if (typeof MutationObserver === 'undefined') return;
  frameObserver = new MutationObserver((muts) => {
    for (const m of muts)
      m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = n as Element;
        if (el.tagName === 'IFRAME') attachFrame(el as HTMLIFrameElement);
        else if (el.querySelectorAll) scan(el);
      });
  });
  frameObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

// ---- input: hand-off + drop ---------------------------------------------------

/** Tracks 'change'/'drop' listeners so hand-off can wait until the page's JS is wired. */
const listened = new WeakSet<object>();
let listenersPatched = false;
let earlyPatch = false;

function patchListenerTracking(): void {
  if (listenersPatched || typeof EventTarget === 'undefined') return;
  listenersPatched = true;
  const orig = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (
    this: EventTarget,
    ...args: Parameters<EventTarget['addEventListener']>
  ) {
    if (args[0] === 'change' || args[0] === 'drop') listened.add(this);
    return orig.apply(this, args);
  };
}

const PREFERRED_IDS = [
  'file-input',
  'pdf-file-input',
  'pdfFileInput',
  'pdfFile',
  'pdfFiles',
  'base-file-input',
  'file-input-1',
  'jsonFiles',
  'file',
];

function acceptsFile(input: HTMLInputElement, f: File): boolean {
  const accept = (input.getAttribute('accept') || '').trim().toLowerCase();
  if (!accept) return true;
  const name = f.name.toLowerCase();
  const type = (f.type || mimeFromName(f.name)).toLowerCase();
  return accept.split(',').some((raw) => {
    const t = raw.trim();
    if (!t) return false;
    if (t.startsWith('.')) return name.endsWith(t);
    if (t.endsWith('/*')) return type.startsWith(t.slice(0, -1));
    return type === t;
  });
}

function findDropZone(): HTMLElement | null {
  return (
    document.getElementById('drop-zone') ||
    document.querySelector<HTMLElement>('[data-dropzone], .drop-zone')
  );
}

/** Compatible file inputs for the first file, best first (explicit accept beats "any"). */
function rankedInputs(file: File): HTMLInputElement[] {
  const all = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type=file]')
  ).filter((i) => !i.disabled && acceptsFile(i, file));
  const rank = (i: HTMLInputElement) => {
    const p = PREFERRED_IDS.indexOf(i.id);
    const explicit = (i.getAttribute('accept') || '').trim() ? 0 : 100;
    return explicit + (p >= 0 ? p : 50);
  };
  return all
    .map((el, idx) => ({ el, idx, r: rank(el) }))
    .sort((a, b) => a.r - b.r || a.idx - b.idx)
    .map((x) => x.el);
}

function setInputFiles(input: HTMLInputElement, list: File[]): boolean {
  try {
    const dt = new DataTransfer();
    list.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function dropOnZone(zone: HTMLElement, files: File[]): boolean {
  try {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    let ev: Event;
    try {
      ev = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      if (!(ev as DragEvent).dataTransfer) throw new Error('no dt');
    } catch {
      ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
    }
    zone.dispatchEvent(ev);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous delivery to whatever the page offers right now. */
export function deliverFiles(files: File[]): boolean {
  if (!files.length) return false;
  const ranked = rankedInputs(files[0]);
  const input = ranked[0];
  if (input) {
    if (input.multiple) {
      const ok = files.filter((f) => acceptsFile(input, f));
      if (ok.length && setInputFiles(input, ok)) return true;
    } else {
      // one file per input: spread over sibling inputs of the same kind (compare, overlay)
      const accept = input.getAttribute('accept') || '';
      const same = ranked.filter(
        (i) => !i.multiple && (i.getAttribute('accept') || '') === accept
      );
      let any = false;
      files.forEach((f, idx) => {
        const target = same[idx];
        if (target && acceptsFile(target, f))
          any = setInputFiles(target, [f]) || any;
      });
      if (any) {
        if (files.length > same.length)
          toast('This tool takes fewer files. The rest were not added.');
        return true;
      }
    }
  }
  const zone = findDropZone();
  return zone ? dropOnZone(zone, files) : false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits (<= timeoutMs) until the page has a target AND its JS has wired a listener.
 * With early patching we know exactly when 'change'/'drop' listeners appear; otherwise we
 * settle for window load plus a short grace.
 */
async function waitForTarget(
  file: File,
  opts: { timeoutMs?: number; graceMs?: number }
): Promise<void> {
  const timeout = opts.timeoutMs ?? 5000;
  const grace = opts.graceMs ?? (earlyPatch ? 1200 : 300);
  const start = Date.now();
  let loadedAt = 0;
  for (;;) {
    const now = Date.now();
    if (document.readyState === 'complete' && !loadedAt) loadedAt = now;
    const target = rankedInputs(file)[0] || findDropZone();
    if (target) {
      if (earlyPatch && listened.has(target)) return;
      if (loadedAt && now - loadedAt >= grace) return;
    }
    if (now - start >= timeout) return;
    await sleep(50);
  }
}

function stripHandoffParams(params: URLSearchParams): void {
  params.delete('desk-file');
  params.delete('desk-name');
  const q = params.toString();
  history.replaceState(
    history.state,
    '',
    location.pathname + (q ? `?${q}` : '') + location.hash
  );
}

export async function consumeHandoff(
  opts: { timeoutMs?: number; graceMs?: number } = {}
): Promise<void> {
  const params = new URLSearchParams(location.search);
  const rawIds = params.getAll('desk-file');
  if (!rawIds.length) return;
  const rawNames = params.getAll('desk-name');
  // strip params first so a reload / history entry never re-triggers or leaks the grants
  stripHandoffParams(params);
  const desk = getDesk();
  if (!desk && !rawIds.some(isStashId)) return;

  if (rawIds.length > MAX_FILES)
    toast(`Only the first ${MAX_FILES} files were opened.`);
  const ids = rawIds.slice(0, MAX_FILES);
  const files: File[] = [];
  let total = 0;
  let invalid = false;
  for (let i = 0; i < ids.length; i++) {
    const nameOf = () =>
      sanitizeFileName(
        String(rawNames[i] ?? '').slice(0, 512) || 'document.pdf',
        'document'
      );
    if (isStashId(ids[i])) {
      // Dropped files (no desk grant): parked in IndexedDB by the home screen, deleted on read.
      try {
        const f = await takeStashed(ids[i]);
        if (!f) {
          invalid = true;
          continue;
        }
        total += f.size;
        if (f.size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
          toast(friendlyError(new Error('[too_large]'), 'open'), {
            error: true,
          });
          break;
        }
        const name = sanitizeFileName(f.name || nameOf(), 'document');
        files.push(new File([f], name, { type: f.type || mimeFromName(name) }));
      } catch (e) {
        toast(friendlyError(e, 'open'), { error: true });
      }
      continue;
    }
    if (!isValidDeskId(ids[i])) {
      invalid = true;
      continue;
    }
    if (!desk) {
      invalid = true;
      continue;
    }
    try {
      const buf = await desk.readFile(ids[i]);
      if (!buf || typeof buf.byteLength !== 'number')
        throw new Error('[internal]');
      total += buf.byteLength;
      if (buf.byteLength > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        toast(friendlyError(new Error('[too_large]'), 'open'), { error: true });
        break;
      }
      const name = nameOf();
      files.push(new File([buf], name, { type: mimeFromName(name) }));
    } catch (e) {
      toast(friendlyError(e, 'open'), { error: true });
    }
  }
  if (invalid && !files.length)
    toast('That file is no longer available. Please open it again.', {
      error: true,
    });
  if (!files.length) return;
  await waitForTarget(files[0], opts);
  if (!deliverFiles(files))
    toast('This tool could not accept the file. Please add it manually.', {
      error: true,
    });
}

function hasFiles(e: DragEvent): boolean {
  return (
    !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
  );
}

function onWindowDragOver(e: DragEvent): void {
  if (hasFiles(e)) e.preventDefault();
}

function onWindowDrop(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const zone = findDropZone();
  const target = e.target as Node | null;
  if (zone && target && zone.contains(target)) return; // page handles it
  const files = Array.from(e.dataTransfer?.files || []).slice(0, MAX_FILES);
  if (files.length && deliverFiles(files)) return;
  toast('Drop files onto the highlighted area, or use the Open button.');
}

let inited = false;

export function initDesktopIO(): void {
  if (inited) return;
  inited = true;
  earlyPatch = document.readyState !== 'complete';
  patchListenerTracking();
  patchWindow(window);
  watchFrames();
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);
  const run = (): void => void consumeHandoff();
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', run, { once: true });
  else run();
}

/** Test helper. */
export function _resetForTests(): void {
  inited = false;
  frameObserver?.disconnect();
  frameObserver = null;
  document.removeEventListener('click', onClickCapture, true);
  document.removeEventListener('webviewerloaded', onViewerLoaded, true);
  window.removeEventListener('dragover', onWindowDragOver);
  window.removeEventListener('drop', onWindowDrop);
  patchedWindows.delete(window);
}
