import { describe, expect, it } from 'vitest';
import { formatSize, relativeTime } from '@/desktop/time';

describe('relative time', () => {
  const now = new Date(2026, 5, 15, 14, 0, 0).getTime();

  it('formats recent times', () => {
    expect(relativeTime(now - 10_000, now)).toBe('Just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 hours ago');
  });

  it('says yesterday and days', () => {
    expect(relativeTime(new Date(2026, 5, 14, 9, 0).getTime(), now)).toBe(
      'Yesterday'
    );
    expect(relativeTime(new Date(2026, 5, 11, 9, 0).getTime(), now)).toBe(
      '4 days ago'
    );
  });

  it('formats sizes', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatSize(-1)).toBe('');
  });
});
