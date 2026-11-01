import { describe, expect, it, vi } from 'vitest';
import {
  buildToolUrl,
  openWithTool,
  readHandoffIds,
  toolSlug,
} from '@/desktop/handoff';

describe('handoff contract', () => {
  it('normalizes tool paths', () => {
    expect(toolSlug('merge-pdf')).toBe('merge-pdf');
    expect(toolSlug('/merge-pdf.html')).toBe('merge-pdf');
    expect(toolSlug('app://x/en/merge-pdf.html?a=1')).toBe('merge-pdf');
  });

  it('builds /<tool>.html?desk-file=<id>&desk-file=<id>', () => {
    expect(buildToolUrl('edit-pdf', ['a1', 'b2'])).toBe(
      '/edit-pdf.html?desk-file=a1&desk-file=b2'
    );
    expect(buildToolUrl('/merge-pdf.html', [])).toBe('/merge-pdf.html');
  });

  it('adds index-aligned desk-name params when names are given', () => {
    expect(buildToolUrl('merge-pdf', ['a', 'b'], ['A one.pdf', 'b.pdf'])).toBe(
      '/merge-pdf.html?desk-file=a&desk-name=A%20one.pdf&desk-file=b&desk-name=b.pdf'
    );
  });

  it('encodes ids and round-trips through readHandoffIds', () => {
    const url = buildToolUrl('edit-pdf', ['stash:1/2', 'x y']);
    expect(readHandoffIds(url.slice(url.indexOf('?')))).toEqual([
      'stash:1/2',
      'x y',
    ]);
  });

  it('keeps only the last path segment and rejects unsafe names', () => {
    expect(buildToolUrl('../../etc/passwd', ['a'])).toBe(
      '/passwd.html?desk-file=a'
    );
    expect(() => buildToolUrl('bad name!', ['a'])).toThrow();
    expect(() => buildToolUrl('', ['a'])).toThrow();
  });

  it('openWithTool navigates via the injected function', () => {
    const nav = vi.fn();
    const url = openWithTool('split-pdf', ['id1'], nav);
    expect(nav).toHaveBeenCalledWith('/split-pdf.html?desk-file=id1');
    expect(url).toBe('/split-pdf.html?desk-file=id1');
  });
});
