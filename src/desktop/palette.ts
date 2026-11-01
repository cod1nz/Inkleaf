/**
 * Command palette (Cmd/Ctrl+K): fuzzy search over tools, recent files and actions.
 * Keyboard first: arrows move, Enter runs, Esc closes, focus is trapped and restored.
 */
import { h, iconSpan, shortcut, trapFocus } from './dom';
import { fuzzyRank, Searchable, segments } from './fuzzy';
import { icon } from './icons';
import { ALL_TOOLS, HOME_HREF, NAV_GROUPS, getGroup } from './nav-model';
import { listRecent } from './recent';
import { openFromDialog, openGranted } from './open-flow';
import { toggleSidebar } from './sidebar';
import { toggleTheme } from './theme';
import { openAbout } from './about-dialog';
import { formatSize, relativeTime } from './time';

type Kind = 'action' | 'recent' | 'tool';

interface Entry extends Searchable {
  id: string;
  kind: Kind;
  icon: string;
  meta?: string;
  run: () => void;
}

const KIND_LABEL: Record<Kind, string> = {
  action: 'Action',
  recent: 'Recent',
  tool: 'Tool',
};

function actions(): Entry[] {
  const mk = (
    id: string,
    title: string,
    ico: string,
    run: () => void,
    keywords: string[],
    meta?: string
  ): Entry => ({
    id,
    kind: 'action',
    title,
    icon: ico,
    run,
    keywords,
    meta,
  });
  return [
    mk(
      'open',
      'Open PDF…',
      'folder',
      () => void openFromDialog(),
      ['open file', 'browse', 'choose'],
      shortcut('O')
    ),
    mk('theme', 'Toggle theme', 'moon', () => toggleTheme(), [
      'dark',
      'light',
      'appearance',
      'mode',
    ]),
    mk('sidebar', 'Toggle sidebar', 'sidebar', () => toggleSidebar(), [
      'collapse',
      'expand',
      'rail',
      'hide',
    ]),
    mk('home', 'Go to home', 'home', () => location.assign(HOME_HREF), [
      'start',
      'launcher',
    ]),
    mk('about', 'About Inkleaf', 'info', () => openAbout(), [
      'version',
      'license',
      'credits',
      'source',
    ]),
  ];
}

function toolEntries(): Entry[] {
  return ALL_TOOLS.map((t) => ({
    id: `tool:${t.id}`,
    kind: 'tool' as const,
    title: t.name,
    subtitle: t.subtitle,
    group: `${getGroup(t.groupId)?.label ?? ''} ${t.category}`.trim(),
    keywords: t.keywords,
    icon: getGroup(t.groupId)?.icon ?? 'file',
    run: () => location.assign(t.href),
  }));
}

let current: { close: () => void } | null = null;

export function isPaletteOpen(): boolean {
  return !!current;
}

export function openPalette(): void {
  if (current) return;
  const prevFocus = document.activeElement as HTMLElement | null;

  let recentEntries: Entry[] = [];
  const tools = toolEntries();
  const acts = actions();
  let results: { entry: Entry; ranges: [number, number][] }[] = [];
  let sel = 0;
  let query = '';

  const input = h('input', {
    class: 'dk-pal-input',
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-expanded': 'true',
      'aria-controls': 'dk-pal-list',
      'aria-autocomplete': 'list',
      'aria-label': 'Search tools, files and actions',
      placeholder: 'Search tools, files and actions',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const list = h('div', {
    class: 'dk-pal-list',
    attrs: { id: 'dk-pal-list', role: 'listbox', 'aria-label': 'Results' },
  });
  const empty = h('div', { class: 'dk-pal-empty', attrs: { hidden: true } });
  const live = h('div', { class: 'dk-sr', attrs: { 'aria-live': 'polite' } });

  const dialog = h(
    'div',
    {
      class: 'dk-palette',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Command palette',
        tabindex: -1,
      },
    },
    h(
      'div',
      { class: 'dk-pal-head' },
      iconSpan(icon('search')),
      input,
      h('kbd', { class: 'dk-kbd', text: 'Esc' })
    ),
    list,
    empty,
    h(
      'div',
      { class: 'dk-pal-foot' },
      h(
        'span',
        {},
        h('kbd', { class: 'dk-kbd', text: '↑' }),
        h('kbd', { class: 'dk-kbd', text: '↓' }),
        ' navigate'
      ),
      h('span', {}, h('kbd', { class: 'dk-kbd', text: '↵' }), ' open'),
      h('span', {}, h('kbd', { class: 'dk-kbd', text: 'Esc' }), ' close')
    ),
    live
  );
  const scrim = h('div', { class: 'dk-scrim dk-pal-scrim' }, dialog);
  const release = trapFocus(dialog);

  const close = (restore = true) => {
    if (!current) return;
    current = null;
    release();
    document.removeEventListener('keydown', onDocKey, true);
    scrim.classList.add('is-closing');
    window.setTimeout(() => scrim.remove(), 120);
    if (restore && prevFocus && prevFocus.isConnected) prevFocus.focus();
  };
  current = { close };

  const optId = (i: number) => `dk-pal-opt-${i}`;

  function compute() {
    if (!query.trim()) {
      const featured = NAV_GROUPS.map((g) => g.tools[0]).filter(Boolean);
      const featuredEntries = featured
        .map((t) => tools.find((e) => e.id === `tool:${t.id}`))
        .filter((e): e is Entry => !!e);
      results = [...acts, ...recentEntries.slice(0, 4), ...featuredEntries].map(
        (entry) => ({ entry, ranges: [] as [number, number][] })
      );
      return;
    }
    const pool: Entry[] = [...acts, ...recentEntries, ...tools];
    results = fuzzyRank(query, pool, 40).map((r) => ({
      entry: r.item,
      ranges: r.ranges,
    }));
  }

  function render() {
    compute();
    list.replaceChildren();
    sel = Math.min(sel, Math.max(results.length - 1, 0));
    let lastSection = '';
    results.forEach((r, i) => {
      if (!query.trim()) {
        const section =
          r.entry.kind === 'action'
            ? 'Actions'
            : r.entry.kind === 'recent'
              ? 'Recent files'
              : 'Tools';
        if (section !== lastSection) {
          lastSection = section;
          list.append(
            h('div', {
              class: 'dk-pal-section',
              text: section,
              attrs: { role: 'presentation' },
            })
          );
        }
      }
      const title = h('span', { class: 'dk-pal-title' });
      for (const seg of segments(r.entry.title, r.ranges)) {
        title.append(
          seg.hit
            ? h('mark', { text: seg.text })
            : document.createTextNode(seg.text)
        );
      }
      const textCol = h('span', { class: 'dk-pal-text' }, title);
      if (r.entry.subtitle)
        textCol.append(
          h('span', { class: 'dk-pal-sub', text: r.entry.subtitle })
        );
      const right =
        r.entry.meta && r.entry.kind !== 'tool'
          ? h('span', { class: 'dk-pal-meta', text: r.entry.meta })
          : h('span', { class: 'dk-pal-kind', text: KIND_LABEL[r.entry.kind] });
      const row = h(
        'div',
        {
          class: 'dk-pal-row',
          attrs: {
            id: optId(i),
            role: 'option',
            'aria-selected': String(i === sel),
          },
          on: {
            mousemove: () => {
              if (sel !== i) select(i, false);
            },
            click: () => run(i),
          },
        },
        iconSpan(icon(r.entry.icon)),
        textCol,
        right
      );
      list.append(row);
    });
    empty.hidden = results.length > 0;
    list.hidden = results.length === 0;
    if (!results.length)
      empty.textContent = `No matches for “${query.trim()}”. Try a different word.`;
    input.setAttribute(
      'aria-activedescendant',
      results.length ? optId(sel) : ''
    );
    live.textContent = results.length
      ? `${results.length} results`
      : 'No results';
    list
      .querySelector('.dk-pal-row[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }

  function select(i: number, scroll = true) {
    const rows = list.querySelectorAll<HTMLElement>('.dk-pal-row');
    rows[sel]?.setAttribute('aria-selected', 'false');
    sel = i;
    rows[sel]?.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', optId(sel));
    if (scroll) rows[sel]?.scrollIntoView({ block: 'nearest' });
  }

  function run(i: number) {
    const r = results[i];
    if (!r) return;
    close(false);
    // Let the closing frame paint, then act (dialogs opened by actions restore focus themselves).
    window.setTimeout(() => r.entry.run(), 0);
  }

  input.addEventListener('input', () => {
    query = input.value;
    sel = 0;
    render();
  });

  function onDocKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (!dialog.contains(e.target as Node)) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) select((sel + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) select((sel - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(sel);
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault();
      select(0);
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault();
      select(Math.max(results.length - 1, 0));
    }
  }
  document.addEventListener('keydown', onDocKey, true);

  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });

  document.body.append(scrim);
  render();
  input.focus();

  listRecent()
    .then((files) => {
      if (!current) return;
      recentEntries = files.map((f) => ({
        id: `recent:${f.id}`,
        kind: 'recent' as const,
        title: f.name,
        subtitle: [
          f.lastOpened ? relativeTime(f.lastOpened) : null,
          formatSize(f.size),
        ]
          .filter(Boolean)
          .join(' · '),
        keywords: ['recent', 'file', 'open'],
        icon: 'filePdf',
        run: () => openGranted([f]),
      }));
      if (recentEntries.length) render();
    })
    .catch(() => {});
}

export function closePalette(): void {
  current?.close();
}

export function togglePalette(): void {
  if (current) current.close();
  else openPalette();
}
