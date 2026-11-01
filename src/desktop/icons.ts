/**
 * Local outline icon set: 16px grid, 1.5px stroke, round caps/joins.
 * Hand-authored inline SVG; no icon font, no network.
 * All strings are static literals (safe for innerHTML).
 */

const P: Record<string, string> = {
  home: '<path d="M2.5 7.3 8 2.6l5.5 4.7V13a.5.5 0 0 1-.5.5H9.6V9.8H6.4v3.7H3a.5.5 0 0 1-.5-.5z"/>',
  edit: '<path d="M3 13l.7-3 7.4-7.4a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L6 12.3z"/><path d="M9.8 3.9l2.3 2.3"/>',
  sign: '<path d="M2.5 13.5h4.2M9 13.5h4.5"/><path d="M4.2 10.6 10.4 4.4a1.4 1.4 0 0 1 2 2l-6.2 6.2-2.7.7z" transform="translate(0 -1)"/>',
  organize:
    '<path d="M8 2.2 2.2 5.3 8 8.4l5.8-3.1z"/><path d="M2.2 8.2 8 11.3l5.8-3.1"/><path d="M2.2 11 8 14.1l5.8-3.1"/>',
  compress:
    '<path d="M2.5 6.2h3.7V2.5M13.5 6.2H9.8V2.5M2.5 9.8h3.7v3.7M13.5 9.8H9.8v3.7"/>',
  ocr: '<path d="M2.5 5.6V4a1.5 1.5 0 0 1 1.5-1.5h1.6M10.4 2.5H12A1.5 1.5 0 0 1 13.5 4v1.6M13.5 10.4V12a1.5 1.5 0 0 1-1.5 1.5h-1.6M5.6 13.5H4A1.5 1.5 0 0 1 2.5 12v-1.6"/><path d="M5.6 6.2h4.8M8 6.2v4.2"/>',
  convert:
    '<path d="M3 5.5h9.6M10.2 3.1l2.4 2.4-2.4 2.4"/><path d="M13 10.5H3.4M5.8 8.1l-2.4 2.4 2.4 2.4"/>',
  lock: '<rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7"/>',
  unlock:
    '<rect x="3.2" y="7" width="9.6" height="6.6" rx="1.6"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5-1"/>',
  search: '<circle cx="7.1" cy="7.1" r="4.4"/><path d="M10.4 10.4 13.6 13.6"/>',
  folder:
    '<path d="M2.5 11.8V4.6a1.1 1.1 0 0 1 1.1-1.1h2.6l1.5 1.7h4.7a1.1 1.1 0 0 1 1.1 1.1v5.5a1.1 1.1 0 0 1-1.1 1.1H3.6a1.1 1.1 0 0 1-1.1-1.1z"/>',
  file: '<path d="M4.2 2.5h4.6l3.2 3.2v7.1a.9.9 0 0 1-.9.9H4.2a.9.9 0 0 1-.9-.9V3.4a.9.9 0 0 1 .9-.9z"/><path d="M8.6 2.7v3.2H12"/>',
  filePdf:
    '<path d="M4.2 2.5h4.6l3.2 3.2v7.1a.9.9 0 0 1-.9.9H4.2a.9.9 0 0 1-.9-.9V3.4a.9.9 0 0 1 .9-.9z"/><path d="M8.6 2.7v3.2H12"/><path d="M5.5 11.2h1.1a.8.8 0 0 0 0-1.6H5.5v2.4M8.4 9.6v2.4h.6a1.1 1.1 0 0 0 0-2.4z" stroke-width="1.1"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.9V8l2.1 1.4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  chevronRight: '<path d="M6.2 3.6 10.6 8l-4.4 4.4"/>',
  chevronDown: '<path d="M3.6 6.2 8 10.6l4.4-4.4"/>',
  sidebar:
    '<rect x="2.2" y="3" width="11.6" height="10" rx="2"/><path d="M6.2 3v10"/>',
  sun: '<circle cx="8" cy="8" r="2.7"/><path d="M8 1.9v1.3M8 12.8v1.3M1.9 8h1.3M12.8 8h1.3M3.7 3.7l.9.9M11.4 11.4l.9.9M12.3 3.7l-.9.9M4.6 11.4l-.9.9"/>',
  moon: '<path d="M13.3 9.6A5.6 5.6 0 0 1 6.4 2.7a5.6 5.6 0 1 0 6.9 6.9z"/>',
  info: '<circle cx="8" cy="8" r="5.6"/><path d="M8 7.3v3.4"/><circle cx="8" cy="5.2" r=".35" fill="currentColor"/>',
  grid: '<rect x="2.5" y="2.5" width="4.4" height="4.4" rx="1.1"/><rect x="9.1" y="2.5" width="4.4" height="4.4" rx="1.1"/><rect x="2.5" y="9.1" width="4.4" height="4.4" rx="1.1"/><rect x="9.1" y="9.1" width="4.4" height="4.4" rx="1.1"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  upload:
    '<path d="M8 10.6V2.9M5 5.6l3-3 3 3"/><path d="M2.8 10.4v1.7a1.1 1.1 0 0 0 1.1 1.1h8.2a1.1 1.1 0 0 0 1.1-1.1v-1.7"/>',
  command:
    '<path d="M6 6h4v4H6z"/><path d="M6 6V4.3A1.8 1.8 0 1 0 4.3 6zM10 6h1.7A1.8 1.8 0 1 0 10 4.3zM6 10v1.7A1.8 1.8 0 1 1 4.3 10zM10 10h1.7a1.8 1.8 0 1 1-1.7 1.7z"/>',
  check: '<path d="M3.4 8.4 6.5 11.5 12.6 4.8"/>',
  trash:
    '<path d="M2.8 4.4h10.4M6.2 4.4V2.9h3.6v1.5M4.1 4.4l.5 8.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.5-8.1"/>',
  external:
    '<path d="M9 2.8h4.2V7M13.2 2.8 7.6 8.4"/><path d="M11.4 9.2v3a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h3"/>',
  merge:
    '<path d="M3 3.2c0 3 5 2.6 5 6.2v3.4M13 3.2c0 3-5 2.6-5 6.2"/><path d="M5.9 10.9 8 13l2.1-2.1"/>',
  split:
    '<path d="M8 2.8v3.4c0 3.6-5 3.2-5 6.2M8 6.2c0 3.6 5 3.2 5 6.2"/><path d="M1.2 10.2 3 12.4l2.2-1.8M10.8 10.6l2.2 1.8 1.8-2.2" transform="translate(0 0)"/>',
  settings:
    '<path d="M2.6 4.6h5.2M11.2 4.6h2.2M2.6 11.4h2.2M8.2 11.4h5.2"/><circle cx="9.5" cy="4.6" r="1.7"/><circle cx="6.5" cy="11.4" r="1.7"/>',
  arrowRight: '<path d="M3 8h9.5M8.8 4.3 12.5 8l-3.7 3.7"/>',
  corner:
    '<path d="M4 3.5v5a1.5 1.5 0 0 0 1.5 1.5H12M9.2 7.2 12 10l-2.8 2.8"/>',
  shield:
    '<path d="M8 2.2 3.2 4v4c0 3 2 4.9 4.8 5.8 2.8-.9 4.8-2.8 4.8-5.8V4z"/><path d="M5.9 8.1 7.4 9.6 10.2 6.6"/>',
  image:
    '<rect x="2.5" y="3" width="11" height="10" rx="1.6"/><circle cx="6" cy="6.6" r="1.1"/><path d="M3 12l3.4-3.2 2.4 2.1 1.8-1.6L13 11.6"/>',
  text: '<path d="M3.5 4.6V3.4h9v1.2M8 3.4v9.2M6.3 12.6h3.4"/>',
  stamp:
    '<path d="M6.2 7.6c0-1.4.8-1.4.8-3a1 1 0 0 1 2 0c0 1.6.8 1.6.8 3z"/><rect x="3.6" y="7.6" width="8.8" height="2.6" rx=".8"/><path d="M3.6 13h8.8"/>',
  crop: '<path d="M4.6 2.5v8.9h8.9M2.5 4.6h8.9v8.9"/>',
  rotate:
    '<path d="M12.9 7.2A4.9 4.9 0 1 0 12 10.8"/><path d="M13 3.6v3.6H9.4"/>',
  table:
    '<rect x="2.4" y="3" width="11.2" height="10" rx="1.6"/><path d="M2.4 6.6h11.2M2.4 9.9h11.2M6.2 6.6V13"/>',
  sparkle:
    '<path d="M8 2.4l1.3 3.3 3.3 1.3-3.3 1.3L8 11.6 6.7 8.3 3.4 7l3.3-1.3z"/>',
  leaf: '<path d="M3 13c0-5.2 3-9.2 10-9.8-.2 6.5-3.9 9.9-8.6 9.6"/><path d="M3 13c1.6-3 3.4-4.9 6-6.3"/>',
  dots: '<circle cx="3.6" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.4" cy="8" r=".6" fill="currentColor"/>',
};

export type IconName = keyof typeof P;

export function icon(name: string, size = 16): string {
  const body = P[name] ?? P.file;
  return `<svg class="dk-icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const iconNames = Object.keys(P);

/** Inkleaf brand mark: a leaf on an accent tile. */
export function logoMark(size = 24): string {
  return `<svg class="dk-logo" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect width="24" height="24" rx="6.5" fill="var(--dk-accent)"/><path d="M6.4 17.6c0-6.2 3.6-10.4 11.2-11.2-.2 7.2-4.2 11-9.4 10.6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.4 17.6c1.7-3.2 3.7-5.4 6.6-7" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}
