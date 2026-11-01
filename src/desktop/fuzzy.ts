/**
 * Pure fuzzy ranker for the command palette. No DOM, no imports.
 *
 * Every whitespace-separated query token must match (AND). A token matches a
 * field as a word-prefix, a substring, or (for tokens of 2+ chars) an in-order
 * subsequence. Title matches outweigh keywords, keywords outweigh group names,
 * group names outweigh subtitles. Ties keep input order (stable).
 */

export interface Searchable {
  title: string;
  subtitle?: string;
  group?: string;
  keywords?: readonly string[];
}

export type Range = [start: number, end: number];

export interface Ranked<T> {
  item: T;
  score: number;
  /** Matched character ranges in `title` (for highlighting). */
  ranges: Range[];
}

const FIELD_WEIGHT = { title: 1, keywords: 0.62, group: 0.45, subtitle: 0.3 };

export function normalize(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  return !/[a-z0-9]/.test(text[i - 1]);
}

interface Match {
  score: number;
  ranges: Range[];
}

/** Score one normalized token against one normalized field. */
export function matchToken(token: string, text: string): Match | null {
  if (!token || !text) return null;
  const idx = text.indexOf(token);
  if (idx !== -1) {
    // Prefer an occurrence at a word start.
    let best = idx;
    if (!isBoundary(text, idx)) {
      let j = idx;
      while ((j = text.indexOf(token, j + 1)) !== -1) {
        if (isBoundary(text, j)) {
          best = j;
          break;
        }
      }
    }
    let score = 100;
    if (best === 0) score += 60;
    else if (isBoundary(text, best)) score += 40;
    score -= Math.min(best, 30) * 0.4;
    score -= Math.min(text.length - token.length, 40) * 0.2;
    if (text === token) score += 40;
    return { score, ranges: [[best, best + token.length]] };
  }
  if (token.length < 2) return null;

  // In-order subsequence with bonuses for word starts and adjacency.
  const ranges: Range[] = [];
  let score = 0;
  let pos = 0;
  let prev = -2;
  for (let c = 0; c < token.length; c++) {
    let found = -1;
    // Prefer a word-boundary or adjacent hit nearby, else the first hit.
    for (let j = pos; j < text.length; j++) {
      if (text[j] !== token[c]) continue;
      if (found === -1) found = j;
      if (isBoundary(text, j) || j === prev + 1) {
        found = j;
        break;
      }
      if (j - pos > 6) break;
    }
    if (found === -1) return null;
    let s = 8;
    if (found === prev + 1) s += 9;
    if (isBoundary(text, found)) s += 10;
    s -= Math.min(found - pos, 10) * 0.7;
    score += s;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === found) last[1] = found + 1;
    else ranges.push([found, found + 1]);
    prev = found;
    pos = found + 1;
  }
  const span = ranges[ranges.length - 1][1] - ranges[0][0];
  if (span > token.length * 3 + 4) return null; // too scattered to mean anything
  return { score: Math.min(score, 70), ranges };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Score a whole item against the query; null when any token has no match. */
export function scoreItem(
  query: string,
  s: Searchable
): { score: number; ranges: Range[] } | null {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, ranges: [] };
  const title = normalize(s.title);
  const sub = s.subtitle ? normalize(s.subtitle) : '';
  const group = s.group ? normalize(s.group) : '';
  const kws = (s.keywords ?? []).map(normalize);

  let total = 0;
  const titleRanges: Range[] = [];
  for (const t of tokens) {
    let best = 0;
    const m = matchToken(t, title);
    if (m) {
      best = m.score * FIELD_WEIGHT.title;
      titleRanges.push(...m.ranges);
    }
    for (const k of kws) {
      const km = matchToken(t, k);
      if (km && km.score * FIELD_WEIGHT.keywords > best)
        best = km.score * FIELD_WEIGHT.keywords;
    }
    if (group) {
      const gm = matchToken(t, group);
      if (gm && gm.score * FIELD_WEIGHT.group > best)
        best = gm.score * FIELD_WEIGHT.group;
    }
    if (sub) {
      const sm = matchToken(t, sub);
      if (sm && sm.score * FIELD_WEIGHT.subtitle > best)
        best = sm.score * FIELD_WEIGHT.subtitle;
    }
    if (best <= 0) return null;
    total += best;
  }
  // Whole-query bonuses on the title.
  const q = tokens.join(' ');
  if (title === q) total += 80;
  else if (title.startsWith(q)) total += 40;
  return { score: total, ranges: mergeRanges(titleRanges) };
}

export function fuzzyRank<T extends Searchable>(
  query: string,
  items: readonly T[],
  limit = Infinity
): Ranked<T>[] {
  if (!query.trim()) {
    return items
      .slice(0, limit)
      .map((item): Ranked<T> => ({ item, score: 0, ranges: [] }));
  }
  const out: (Ranked<T> & { i: number })[] = [];
  items.forEach((item, i) => {
    const r = scoreItem(query, item);
    if (r) out.push({ item, score: r.score, ranges: r.ranges, i });
  });
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.title.length - b.item.title.length ||
      a.i - b.i
  );
  return out
    .slice(0, limit)
    .map(({ item, score, ranges }) => ({ item, score, ranges }));
}

/** Split text into highlighted/plain segments for rendering. */
export function segments(
  text: string,
  ranges: Range[]
): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    if (e > s) out.push({ text: text.slice(s, e), hit: true });
    at = Math.max(at, e);
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
