import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  DESKTOP_EXCLUDED,
  NAV_GROUPS,
  QUICK_ACTIONS,
  TOOL_COUNT,
  getTool,
  pageSlug,
} from '@/desktop/nav-model';
import { icon, iconNames } from '@/desktop/icons';

describe('nav model', () => {
  it('has the seven curated groups in design order', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      'Edit and annotate',
      'Sign',
      'Organize',
      'Compress and optimize',
      'OCR',
      'Convert',
      'Protect',
    ]);
  });

  it('lists every tool exactly once across groups', () => {
    const ids = NAV_GROUPS.flatMap((g) => g.tools.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(TOOL_COUNT);
    expect(TOOL_COUNT).toBe(ALL_TOOLS.length);
    expect(TOOL_COUNT).toBeGreaterThanOrEqual(110);
  });

  it('has no empty groups', () => {
    for (const g of NAV_GROUPS) expect(g.tools.length).toBeGreaterThan(0);
  });

  it('never links to pages absent in the desktop build', () => {
    for (const t of ALL_TOOLS) {
      expect(DESKTOP_EXCLUDED.test(t.id)).toBe(false);
      expect(t.href).toBe(`/${t.id}.html`);
    }
  });

  it('puts pinned tools in the expected groups', () => {
    expect(getTool('sign-pdf')?.groupId).toBe('sign');
    expect(getTool('ocr-pdf')?.groupId).toBe('ocr');
    expect(getTool('merge-pdf')?.groupId).toBe('organize');
    expect(getTool('compress-pdf')?.groupId).toBe('compress');
    expect(getTool('protect-pdf')?.groupId).toBe('protect');
    expect(NAV_GROUPS.find((g) => g.id === 'organize')!.tools[0].id).toBe(
      'merge-pdf'
    );
  });

  it('quick actions point at real tools', () => {
    expect(QUICK_ACTIONS).toHaveLength(8);
    for (const q of QUICK_ACTIONS) expect(getTool(q.tool)).toBeTruthy();
  });

  it('pageSlug reads the page name', () => {
    expect(pageSlug('/merge-pdf.html')).toBe('merge-pdf');
    expect(pageSlug('/')).toBe('');
    expect(pageSlug('/desktop.html')).toBe('desktop');
  });

  it('every group and quick action has an icon', () => {
    for (const g of NAV_GROUPS) expect(iconNames).toContain(g.icon);
    for (const q of QUICK_ACTIONS) expect(iconNames).toContain(q.icon);
    expect(iconNames.length).toBeGreaterThanOrEqual(30);
    expect(icon('home')).toContain('<svg');
  });
});
