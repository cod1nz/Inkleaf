import { describe, expect, it } from 'vitest';
import {
  fuzzyRank,
  matchToken,
  normalize,
  scoreItem,
  segments,
} from '@/desktop/fuzzy';

const items = [
  {
    title: 'Merge PDF',
    subtitle: 'Combine multiple PDFs into one file.',
    keywords: ['combine', 'join'],
  },
  {
    title: 'Split PDF',
    subtitle: 'Extract a range of pages into a new PDF.',
    keywords: ['separate'],
  },
  {
    title: 'Compress PDF',
    subtitle: 'Reduce the file size of your PDF.',
    keywords: ['shrink'],
  },
  {
    title: 'OCR PDF',
    subtitle: 'Make scanned pages searchable.',
    keywords: ['scan'],
  },
  { title: 'Sign PDF', subtitle: 'Draw, type, or upload your signature.' },
  {
    title: 'Protect PDF',
    subtitle: 'Password protect a PDF.',
    group: 'Protect',
  },
  { title: 'PDF to JPG', subtitle: 'Convert pages to images.' },
  { title: 'Résumé Maker', subtitle: 'Accents are folded.' },
];

describe('fuzzy ranker', () => {
  it('returns items in order for an empty query', () => {
    const r = fuzzyRank('  ', items);
    expect(r.map((x) => x.item.title)).toEqual(items.map((i) => i.title));
  });

  it('ranks exact title above partial', () => {
    expect(fuzzyRank('merge pdf', items)[0].item.title).toBe('Merge PDF');
  });

  it('prefers a title word-prefix to a subtitle hit', () => {
    expect(fuzzyRank('split', items)[0].item.title).toBe('Split PDF');
  });

  it('finds tools through keywords', () => {
    expect(fuzzyRank('shrink', items)[0].item.title).toBe('Compress PDF');
    expect(fuzzyRank('combine', items)[0].item.title).toBe('Merge PDF');
  });

  it('requires every token to match (AND)', () => {
    expect(fuzzyRank('pdf jpg', items).map((x) => x.item.title)).toEqual([
      'PDF to JPG',
    ]);
    expect(fuzzyRank('merge jpg', items)).toHaveLength(0);
  });

  it('supports in-order subsequence matches', () => {
    expect(fuzzyRank('cmprs', items)[0]?.item.title).toBe('Compress PDF');
  });

  it('rejects scattered, meaningless subsequences', () => {
    const far = 'm ' + 'xx '.repeat(12) + 'p ' + 'yy '.repeat(12) + 'f';
    expect(matchToken('mpf', far)).toBeNull();
  });

  it('is case and accent insensitive', () => {
    expect(fuzzyRank('RESUME', items)[0].item.title).toBe('Résumé Maker');
    expect(normalize('Ünïcode')).toBe('unicode');
  });

  it('matches the group label', () => {
    expect(fuzzyRank('protect', items)[0].item.title).toBe('Protect PDF');
  });

  it('is stable for equal scores', () => {
    const same = [
      { title: 'Alpha one' },
      { title: 'Alpha two' },
      { title: 'Alpha tri' },
    ];
    expect(fuzzyRank('alpha', same).map((x) => x.item.title)).toEqual([
      'Alpha one',
      'Alpha two',
      'Alpha tri',
    ]);
  });

  it('honours the limit', () => {
    expect(fuzzyRank('pdf', items, 2)).toHaveLength(2);
  });

  it('reports title ranges for highlighting', () => {
    const r = scoreItem('merge', items[0])!;
    expect(r.ranges).toEqual([[0, 5]]);
    expect(segments('Merge PDF', r.ranges)).toEqual([
      { text: 'Merge', hit: true },
      { text: ' PDF', hit: false },
    ]);
  });

  it('segments handles no ranges', () => {
    expect(segments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});
