/** desktop.html: the launcher. Empty-state drop zone, quick actions, recent files, tool directory. */
import { h, iconSpan, shortcut } from './dom';
import { getDesk } from './desk';
import { fuzzyRank } from './fuzzy';
import { icon } from './icons';
import {
  ALL_TOOLS,
  NAV_GROUPS,
  QUICK_ACTIONS,
  TOOL_COUNT,
  getGroup,
  groupHref,
  NavGroup,
  NavTool,
} from './nav-model';
import { openDropped, openFromDialog, openGranted } from './open-flow';
import { RecentEntry, clearRecent, dismissRecent, listRecent } from './recent';
import { formatSize, relativeTime } from './time';

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function refreshSidebarRecent(): void {
  window.inkleaf?.refreshRecent();
}

// ---------------------------------------------------------------------------
// Home view
// ---------------------------------------------------------------------------

function renderHome(root: HTMLElement): void {
  const canOpen = !!getDesk();

  // Drop zone
  const openBtn = h('button', {
    class: 'dk-btn dk-btn-primary dk-btn-lg',
    attrs: { type: 'button' },
    on: {
      click: (e) => {
        e.stopPropagation();
        void openFromDialog();
      },
    },
  });
  openBtn.append(iconSpan(icon('folder')), h('span', { text: 'Open PDF' }));

  const zone = h(
    'section',
    { class: 'dk-drop', attrs: { 'aria-labelledby': 'dk-drop-h' } },
    h('div', { class: 'dk-drop-ico' }, iconSpan(icon('upload', 22))),
    h('h2', {
      class: 'dk-drop-title',
      text: 'Drop a PDF here',
      attrs: { id: 'dk-drop-h' },
    }),
    h('p', {
      class: 'dk-drop-sub',
      text: canOpen
        ? 'Or choose a file from your computer. Everything stays on this device.'
        : 'Or choose a file. Everything stays on this device.',
    }),
    h(
      'div',
      { class: 'dk-drop-actions' },
      openBtn,
      h(
        'span',
        { class: 'dk-drop-hint' },
        h('kbd', { class: 'dk-kbd', text: shortcut('O') }),
        ' to open'
      )
    )
  );
  zone.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    void openFromDialog();
  });

  // Window-wide drag feedback; drop anywhere on home opens the file.
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    zone.classList.add('is-drag');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-drag');
  });
  window.addEventListener('drop', (e) => {
    depth = 0;
    zone.classList.remove('is-drag');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    const tile = (e.target as HTMLElement).closest?.<HTMLElement>(
      '[data-tool]'
    );
    void openDropped(files, tile?.dataset.tool);
  });

  // Quick actions
  const tiles = h('div', { class: 'dk-tiles', attrs: { role: 'list' } });
  for (const q of QUICK_ACTIONS) {
    const href = q.id === 'convert' ? groupHref('convert') : `/${q.tool}.html`;
    const a = h('a', {
      class: 'dk-tile',
      attrs: { href, role: 'listitem', 'data-tool': q.tool },
    });
    a.append(
      h('span', { class: 'dk-tile-ico' }, iconSpan(icon(q.icon, 18))),
      h(
        'span',
        { class: 'dk-tile-text' },
        h('span', { class: 'dk-tile-title', text: q.label }),
        h('span', { class: 'dk-tile-hint', text: q.hint })
      )
    );
    tiles.append(a);
  }

  // Recent
  const recentHead = h(
    'div',
    { class: 'dk-sec-head' },
    h('h2', {
      class: 'dk-sec-title',
      text: 'Recent files',
      attrs: { id: 'dk-rec-h' },
    })
  );
  const clearBtn = h('button', {
    class: 'dk-btn dk-btn-quiet',
    text: 'Clear list',
    attrs: { type: 'button' },
    on: {
      click: async () => {
        await clearRecent();
        paintRecent([]);
        refreshSidebarRecent();
      },
    },
  });
  recentHead.append(clearBtn);
  const recentBody = h('div', { class: 'dk-recent-wrap' });

  const paintRecent = (items: RecentEntry[]) => {
    recentBody.replaceChildren();
    clearBtn.hidden = !items.length;
    if (!items.length) {
      recentBody.append(
        h(
          'div',
          { class: 'dk-empty' },
          h('div', { class: 'dk-empty-ico' }, iconSpan(icon('clock', 18))),
          h('p', { class: 'dk-empty-title', text: 'No recent files yet' }),
          h('p', {
            class: 'dk-empty-sub',
            text: 'PDFs you open will show up here so you can pick up where you left off.',
          })
        )
      );
      return;
    }
    const ul = h('ul', {
      class: 'dk-rec-list',
      attrs: { 'aria-labelledby': 'dk-rec-h' },
    });
    for (const f of items.slice(0, 8)) {
      const meta = [
        f.lastOpened ? relativeTime(f.lastOpened) : null,
        formatSize(f.size),
      ]
        .filter(Boolean)
        .join(' · ');
      const open = h('button', {
        class: 'dk-rec-open',
        attrs: { type: 'button', title: f.name },
        on: { click: () => openGranted([f]) },
      });
      open.append(
        h('span', { class: 'dk-rec-ico' }, iconSpan(icon('filePdf', 18))),
        h(
          'span',
          { class: 'dk-rec-text' },
          h('span', { class: 'dk-rec-name', text: f.name }),
          h('span', { class: 'dk-rec-meta', text: meta })
        )
      );
      const rm = h('button', {
        class: 'dk-btn-icon dk-rec-rm',
        attrs: {
          type: 'button',
          'aria-label': `Remove ${f.name} from recent files`,
          title: 'Remove from list',
        },
        on: {
          click: () => {
            li.classList.add('is-leaving');
            void dismissRecent(f).then(() => {
              window.setTimeout(() => {
                void listRecent().then(paintRecent);
                refreshSidebarRecent();
              }, 160);
            });
          },
        },
      });
      rm.append(iconSpan(icon('x')));
      const li = h('li', { class: 'dk-rec-row' }, open, rm);
      ul.append(li);
    }
    recentBody.append(ul);
  };
  paintRecent([]);
  void listRecent()
    .then(paintRecent)
    .catch(() => {});

  root.replaceChildren(
    h(
      'div',
      { class: 'dk-home' },
      zone,
      h(
        'section',
        { class: 'dk-sec', attrs: { 'aria-labelledby': 'dk-qa-h' } },
        h(
          'div',
          { class: 'dk-sec-head' },
          h('h2', {
            class: 'dk-sec-title',
            text: 'Quick actions',
            attrs: { id: 'dk-qa-h' },
          })
        ),
        tiles
      ),
      h(
        'section',
        { class: 'dk-sec', attrs: { 'aria-labelledby': 'dk-rec-h' } },
        recentHead,
        recentBody
      ),
      h(
        'p',
        { class: 'dk-home-foot' },
        iconSpan(icon('lock', 12)),
        ' Files are processed on your computer and never uploaded.'
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Directory view: all tools (searchable) or one group
// ---------------------------------------------------------------------------

function toolRow(t: NavTool): HTMLElement {
  const g = getGroup(t.groupId);
  const a = h('a', { class: 'dk-dir-row', attrs: { href: t.href } });
  a.append(
    h('span', { class: 'dk-dir-ico' }, iconSpan(icon(g?.icon ?? 'file'))),
    h(
      'span',
      { class: 'dk-dir-text' },
      h('span', { class: 'dk-dir-name', text: t.name }),
      h('span', { class: 'dk-dir-sub', text: t.subtitle })
    )
  );
  return a;
}

function renderDirectory(
  root: HTMLElement,
  opts: { group?: NavGroup; all?: boolean }
): void {
  const wrap = h('div', { class: 'dk-home dk-dir' });
  const title = opts.group ? opts.group.label : 'All tools';
  const count = opts.group ? opts.group.tools.length : TOOL_COUNT;
  wrap.append(
    h(
      'div',
      { class: 'dk-home-head' },
      h('h1', { class: 'dk-home-title', text: title }),
      h('p', {
        class: 'dk-home-sub',
        text: `${count} tool${count === 1 ? '' : 's'}`,
      })
    )
  );

  const input = h('input', {
    class: 'dk-field',
    attrs: {
      type: 'search',
      placeholder: opts.group
        ? `Filter ${title.toLowerCase()}`
        : `Search ${TOOL_COUNT} tools`,
      'aria-label': 'Filter tools',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const field = h(
    'label',
    { class: 'dk-field-wrap' },
    iconSpan(icon('search')),
    input
  );
  const results = h('div', { class: 'dk-dir-results' });
  wrap.append(field, results);

  const pool = opts.group ? opts.group.tools : ALL_TOOLS;
  const paint = (q: string) => {
    results.replaceChildren();
    if (q.trim()) {
      const ranked = fuzzyRank(
        q,
        pool.map((t) => ({
          t,
          title: t.name,
          subtitle: t.subtitle,
          group: t.category,
          keywords: t.keywords,
        }))
      );
      if (!ranked.length) {
        results.append(
          h('p', {
            class: 'dk-dir-none',
            text: `No tools match “${q.trim()}”.`,
          })
        );
        return;
      }
      const list = h('div', { class: 'dk-dir-grid' });
      for (const r of ranked) list.append(toolRow(r.item.t));
      results.append(list);
      return;
    }
    const groups = opts.group ? [opts.group] : NAV_GROUPS;
    for (const g of groups) {
      const sec = h('section', { class: 'dk-dir-sec' });
      if (!opts.group)
        sec.append(h('h2', { class: 'dk-sec-title', text: g.label }));
      const list = h('div', { class: 'dk-dir-grid' });
      for (const t of g.tools) list.append(toolRow(t));
      sec.append(list);
      results.append(sec);
    }
  };
  input.addEventListener('input', () => paint(input.value));
  paint('');
  root.replaceChildren(wrap);
  if (opts.all) input.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------

function boot(): void {
  const root = document.getElementById('dk-home-root');
  if (!root) return;
  const q = new URLSearchParams(location.search);
  const group = getGroup(q.get('group') ?? '');
  if (q.get('view') === 'all') renderDirectory(root, { all: true });
  else if (group) renderDirectory(root, { group });
  else renderHome(root);
}

boot();
