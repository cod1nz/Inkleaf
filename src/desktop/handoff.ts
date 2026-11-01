/**
 * Contract between the UI shell (M4) and tool flows (M5):
 * a tool page opened with `?desk-file=<id>&desk-file=<id>` should load those
 * granted files (via window.desk.readFile) instead of asking for them.
 */

export const HANDOFF_PARAM = 'desk-file';
export const DEFAULT_TOOL = 'edit-pdf';

/** 'merge-pdf' | 'merge-pdf.html' | '/merge-pdf.html' | '/x/merge-pdf' -> 'merge-pdf' */
export function toolSlug(toolPath: string): string {
  const clean = String(toolPath).split(/[?#]/)[0];
  const last = clean.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.html$/i, '');
}

/** `/<tool>.html?desk-file=<id>&desk-file=<id>` */
export function buildToolUrl(
  toolPath: string,
  fileIds: readonly string[] = [],
  names: readonly string[] = []
): string {
  const slug = toolSlug(toolPath);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    throw new Error(`Invalid tool path: ${toolPath}`);
  }
  // ids and names stay index-aligned (desktop-io pairs them by position)
  const q = fileIds
    .flatMap((id, i) => {
      if (typeof id !== 'string' || !id) return [];
      const n = names[i];
      return [
        `${HANDOFF_PARAM}=${encodeURIComponent(id)}`,
        ...(typeof n === 'string' && n
          ? [`desk-name=${encodeURIComponent(n)}`]
          : []),
      ];
    })
    .join('&');
  return `/${slug}.html${q ? `?${q}` : ''}`;
}

/** Read file ids from a location search string (used by M5). */
export function readHandoffIds(search: string): string[] {
  return new URLSearchParams(search).getAll(HANDOFF_PARAM);
}

/** Navigate to a tool page carrying the granted file ids. */
export function openWithTool(
  toolPath: string,
  fileIds: readonly string[],
  nav: (url: string) => void = (u) => window.location.assign(u),
  names: readonly string[] = []
): string {
  const url = buildToolUrl(toolPath, fileIds, names);
  nav(url);
  return url;
}
