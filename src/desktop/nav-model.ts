/**
 * Navigation model derived from src/js/config/tools.ts (single source of truth).
 * The 7 real categories are mapped onto the 7 curated sidebar groups from
 * DESIGN.md (Home is separate). Every tool lands in exactly one group.
 */
import { categories } from '../js/config/tools';

export interface NavTool {
  id: string;
  name: string;
  subtitle: string;
  /** Root-absolute page path, e.g. /merge-pdf.html */
  href: string;
  groupId: string;
  /** Original category in tools.ts (searchable). */
  category: string;
  keywords: string[];
}

export interface NavGroup {
  id: string;
  label: string;
  icon: string;
  tools: NavTool[];
}

/** Pages that exist on the web but are not part of the desktop build. */
export const DESKTOP_EXCLUDED =
  /^(about|contact|faq|privacy|terms|licensing|kura|hyper-compress|advertise|404|blog-.*|compress-pdf-to-.*|compress-pdf-for-email|wasm-settings)$/;

export const HOME_HREF = '/desktop.html';
export const ALL_TOOLS_HREF = '/desktop.html?view=all';
export const groupHref = (id: string) => `/desktop.html?group=${id}`;

interface GroupDef {
  id: string;
  label: string;
  icon: string;
  /** Tools pinned to this group (and their order), taking priority over category defaults. */
  pin: string[];
}

const GROUP_DEFS: GroupDef[] = [
  {
    id: 'edit',
    label: 'Edit and annotate',
    icon: 'edit',
    pin: ['edit-pdf', 'edit-pdf-text', 'add-watermark', 'crop-pdf'],
  },
  {
    id: 'sign',
    label: 'Sign',
    icon: 'sign',
    pin: [
      'sign-pdf',
      'form-filler',
      'add-stamps',
      'digital-sign-pdf',
      'validate-signature-pdf',
      'timestamp-pdf',
    ],
  },
  {
    id: 'organize',
    label: 'Organize',
    icon: 'organize',
    pin: [
      'merge-pdf',
      'split-pdf',
      'organize-pdf',
      'pdf-multi-tool',
      'extract-pages',
      'delete-pages',
      'rotate-pdf',
    ],
  },
  {
    id: 'compress',
    label: 'Compress and optimize',
    icon: 'compress',
    pin: ['compress-pdf'],
  },
  {
    id: 'ocr',
    label: 'OCR',
    icon: 'ocr',
    pin: ['ocr-pdf', 'deskew-pdf', 'extract-tables', 'pdf-to-text'],
  },
  {
    id: 'convert',
    label: 'Convert',
    icon: 'convert',
    pin: [
      'image-to-pdf',
      'pdf-to-jpg',
      'pdf-to-png',
      'pdf-to-word',
      'word-to-pdf',
    ],
  },
  {
    id: 'protect',
    label: 'Protect',
    icon: 'lock',
    pin: ['protect-pdf', 'unlock-pdf', 'sanitize-pdf', 'flatten-pdf'],
  },
];

/** Category in tools.ts -> default curated group. */
const CATEGORY_DEFAULT: Record<string, string> = {
  'Edit & Annotate': 'edit',
  'Convert to PDF': 'convert',
  'Convert from PDF': 'convert',
  'Organize & Manage': 'organize',
  'Optimize & Repair': 'compress',
  'Secure PDF': 'protect',
  'Popular Tools': 'organize',
};

/** Plain-language synonyms so searches like "shrink" or "encrypt" find the right tool. */
const SYNONYMS: [RegExp, string[]][] = [
  [/merge|combine|alternate/, ['combine', 'join', 'append']],
  [/split|divide|extract-pages/, ['separate', 'cut', 'break apart']],
  [/compress/, ['shrink', 'reduce size', 'smaller', 'optimize']],
  [/ocr/, ['scan', 'recognize text', 'searchable', 'scanned']],
  [/sign/, ['signature', 'sign', 'esign']],
  [/protect|permission/, ['password', 'encrypt', 'secure', 'lock']],
  [/unlock|restrictions/, ['decrypt', 'remove password', 'open']],
  [/organize|reverse|multi-tool/, ['reorder', 'rearrange', 'move pages']],
  [/rotate/, ['turn', 'orientation']],
  [/delete-pages|remove-blank/, ['remove pages', 'discard']],
  [/watermark|stamps/, ['stamp', 'overlay text']],
  [/-to-pdf$/, ['convert', 'import', 'create pdf']],
  [/^pdf-to-/, ['convert', 'export', 'save as']],
  [/metadata/, ['properties', 'author', 'title']],
  [/sanitize|flatten/, ['clean', 'strip', 'privacy']],
  [/repair/, ['fix', 'corrupt', 'broken']],
  [/crop/, ['trim', 'margins']],
  [/form/, ['fields', 'fill']],
  [/edit-pdf$/, ['annotate', 'highlight', 'comment', 'redact', 'draw']],
];

function synonymsFor(id: string): string[] {
  const out: string[] = [];
  for (const [re, words] of SYNONYMS) if (re.test(id)) out.push(...words);
  return out;
}

function build(): { groups: NavGroup[]; all: NavTool[] } {
  const seen = new Map<string, NavTool>();
  const pinOwner = new Map<string, string>();
  for (const g of GROUP_DEFS) for (const id of g.pin) pinOwner.set(id, g.id);

  // "Popular Tools" only repeats tools from the other categories (in its own
  // order); visit it last so every tool is classified by its real category.
  const ordered = [
    ...categories.filter((c) => c.name !== 'Popular Tools'),
    ...categories.filter((c) => c.name === 'Popular Tools'),
  ];
  for (const cat of ordered) {
    for (const t of cat.tools) {
      if (DESKTOP_EXCLUDED.test(t.id)) continue;
      if (seen.has(t.id)) continue;
      const groupId =
        pinOwner.get(t.id) ?? CATEGORY_DEFAULT[cat.name] ?? 'organize';
      seen.set(t.id, {
        id: t.id,
        name: t.name,
        subtitle: t.subtitle,
        href: `/${t.id}.html`,
        groupId,
        category: cat.name,
        keywords: [t.id.replace(/-/g, ' '), ...synonymsFor(t.id)],
      });
    }
  }

  const all = [...seen.values()];
  const groups: NavGroup[] = GROUP_DEFS.map((def) => {
    const mine = all.filter((t) => t.groupId === def.id);
    const rank = (t: NavTool) => {
      const i = def.pin.indexOf(t.id);
      return i === -1 ? Infinity : i;
    };
    // Pinned first (in pin order), then the rest in tools.ts order (stable).
    const ordered = mine
      .map((t, i) => ({ t, i }))
      .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
      .map((x) => x.t);
    return { id: def.id, label: def.label, icon: def.icon, tools: ordered };
  });
  return { groups, all };
}

const built = build();

export const NAV_GROUPS: NavGroup[] = built.groups;
export const ALL_TOOLS: NavTool[] = built.all;
export const TOOL_COUNT = ALL_TOOLS.length;

const byId = new Map(ALL_TOOLS.map((t) => [t.id, t]));
export const getTool = (id: string): NavTool | undefined => byId.get(id);
export const getGroup = (id: string): NavGroup | undefined =>
  NAV_GROUPS.find((g) => g.id === id);

/** Current page slug from a pathname ('/merge-pdf.html' -> 'merge-pdf'; '/' -> ''). */
export function pageSlug(pathname: string): string {
  const last = pathname.split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\.html$/i, '');
}

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  icon: string;
  /** Tool page (or hub) opened by the tile. */
  tool: string;
  /** True when the tile can take a dropped/opened PDF directly. */
  takesFile: boolean;
  groupId: string;
}

/** The eight curated flows shown on the home screen. */
export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'edit',
    label: 'Edit and annotate',
    hint: 'Highlight, comment, redact, add shapes',
    icon: 'edit',
    tool: 'edit-pdf',
    takesFile: true,
    groupId: 'edit',
  },
  {
    id: 'sign',
    label: 'Sign',
    hint: 'Draw, type or place your signature',
    icon: 'sign',
    tool: 'sign-pdf',
    takesFile: true,
    groupId: 'sign',
  },
  {
    id: 'merge',
    label: 'Merge',
    hint: 'Combine several PDFs into one',
    icon: 'merge',
    tool: 'merge-pdf',
    takesFile: true,
    groupId: 'organize',
  },
  {
    id: 'split',
    label: 'Split and reorder',
    hint: 'Extract, delete or rearrange pages',
    icon: 'split',
    tool: 'organize-pdf',
    takesFile: true,
    groupId: 'organize',
  },
  {
    id: 'compress',
    label: 'Compress',
    hint: 'Make the file smaller',
    icon: 'compress',
    tool: 'compress-pdf',
    takesFile: true,
    groupId: 'compress',
  },
  {
    id: 'ocr',
    label: 'OCR',
    hint: 'Make scanned pages searchable',
    icon: 'ocr',
    tool: 'ocr-pdf',
    takesFile: true,
    groupId: 'ocr',
  },
  {
    id: 'convert',
    label: 'Convert',
    hint: 'To and from images, Word, Excel and more',
    icon: 'convert',
    tool: 'pdf-to-jpg',
    takesFile: true,
    groupId: 'convert',
  },
  {
    id: 'protect',
    label: 'Protect',
    hint: 'Add or remove a password',
    icon: 'lock',
    tool: 'protect-pdf',
    takesFile: true,
    groupId: 'protect',
  },
];
