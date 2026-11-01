/**
 * Left sidebar: Home, curated groups (disclosure tree), All tools, Recent files.
 * 232px, collapsible to a 56px icon rail (state remembered).
 */
import { h, iconSpan, svg } from './dom';
import { getDesk, store } from './desk';
import { icon, logoMark } from './icons';
import {
  ALL_TOOLS_HREF,
  HOME_HREF,
  NAV_GROUPS,
  TOOL_COUNT,
  groupHref,
  pageSlug,
} from './nav-model';
import { listRecent, RecentEntry } from './recent';
import { openGranted } from './open-flow';
import { formatSize } from './time';
import { effectiveTheme, onThemeChange, toggleTheme } from './theme';
import { openAbout } from './about-dialog';

const RAIL_KEY = 'inkleaf.sidebar';
const OPEN_KEY = 'inkleaf.nav.open';
const MAX_RECENT = 4;

export function isRail(): boolean {
  return document.documentElement.dataset.sidebar === 'rail';
}

export function setRail(rail: boolean): void {
  const root = document.documentElement;
  if (rail) root.setAttribute('data-sidebar', 'rail');
  else root.removeAttribute('data-sidebar');
  store.set(RAIL_KEY, rail ? 'rail' : 'full');
  syncRailAria();
}

export function toggleSidebar(): void {
  setRail(!isRail());
}

export function restoreSidebar(): void {
  if (store.get(RAIL_KEY) === 'rail') {
    document.documentElement.setAttribute('data-sidebar', 'rail');
  }
}

let railBtn: HTMLButtonElement | null = null;
function syncRailAria(): void {
  if (!railBtn) return;
  const rail = isRail();
  railBtn.setAttribute('aria-expanded', String(!rail));
  railBtn.setAttribute(
    'aria-label',
    rail ? 'Expand sidebar' : 'Collapse sidebar'
  );
  railBtn.title = rail ? 'Expand sidebar' : 'Collapse sidebar';
}

export function sidebarToggleButton(): HTMLButtonElement {
  railBtn = h('button', {
    class: 'dk-btn-icon dk-nodrag',
    attrs: { type: 'button', 'aria-controls': 'dk-sidebar' },
    on: { click: () => toggleSidebar() },
  });
  railBtn.append(iconSpan(icon('sidebar')));
  syncRailAria();
  return railBtn;
}

interface Active {
  home: boolean;
  all: boolean;
  group: string | null;
  tool: string | null;
}

function activeFromLocation(): Active {
  const slug = pageSlug(location.pathname);
  const q = new URLSearchParams(location.search);
  if (slug === 'desktop' || slug === '' || slug === 'index') {
    if (q.get('view') === 'all')
      return { home: false, all: true, group: null, tool: null };
    const g = q.get('group');
    if (g) return { home: false, all: false, group: g, tool: null };
    return { home: true, all: false, group: null, tool: null };
  }
  return { home: false, all: false, group: null, tool: slug };
}

export function buildSidebar(): { el: HTMLElement; refreshRecent: () => void } {
  const active = activeFromLocation();
  const open = new Set<string>(store.getJson<string[]>(OPEN_KEY, []));
  const activeGroupOfTool = active.tool
    ? NAV_GROUPS.find((g) => g.tools.some((t) => t.id === active.tool))?.id
    : undefined;
  const forced = activeGroupOfTool ?? active.group;
  if (forced) {
    open.clear();
    open.add(forced);
  } else if (open.size > 1) {
    const first = [...open][0];
    open.clear();
    open.add(first);
  }

  const persistOpen = () => store.setJson(OPEN_KEY, [...open]);

  // ---- tree ----
  const tree = h('ul', {
    class: 'dk-tree',
    attrs: { role: 'tree', 'aria-label': 'Tools' },
  });

  const link = (
    href: string,
    label: string,
    ico: string | null,
    level: number,
    current: boolean,
    extraClass = ''
  ): HTMLAnchorElement => {
    const a = h('a', {
      class: `dk-item ${extraClass}`.trim(),
      attrs: {
        href,
        role: 'treeitem',
        'aria-level': level,
        'aria-current': current ? 'page' : undefined,
        title: label,
        tabindex: -1,
      },
    });
    if (ico) a.append(iconSpan(icon(ico)));
    a.append(h('span', { class: 'dk-label', text: label }));
    if (current) a.classList.add('is-active');
    return a;
  };

  tree.append(
    h(
      'li',
      { attrs: { role: 'none' } },
      link(HOME_HREF, 'Home', 'home', 1, active.home)
    )
  );

  for (const g of NAV_GROUPS) {
    const isOpen = open.has(g.id);
    const containsActive = g.id === activeGroupOfTool || g.id === active.group;
    const subId = `dk-sub-${g.id}`;
    const row = h('button', {
      class: `dk-item dk-item-group${containsActive ? ' has-active' : ''}`,
      attrs: {
        type: 'button',
        role: 'treeitem',
        'aria-level': 1,
        'aria-expanded': String(isOpen),
        'aria-controls': subId,
        title: g.label,
        tabindex: -1,
        'data-group': g.id,
      },
    });
    row.append(iconSpan(icon(g.icon)));
    row.append(h('span', { class: 'dk-label', text: g.label }));
    row.append(iconSpan(icon('chevronRight', 12), 'dk-chev'));

    const list = h('ul', {
      attrs: { role: 'group', 'aria-label': g.label, id: subId },
    });
    for (const t of g.tools) {
      list.append(
        h(
          'li',
          { attrs: { role: 'none' } },
          link(t.href, t.name, null, 2, t.id === active.tool, 'dk-item-tool')
        )
      );
    }
    const wrap = h(
      'div',
      { class: 'dk-sub' },
      h('div', { class: 'dk-sub-inner' }, list)
    );
    const li = h(
      'li',
      { class: `dk-group${isOpen ? ' is-open' : ''}`, attrs: { role: 'none' } },
      row,
      wrap
    );
    if (!isOpen) wrap.setAttribute('inert', '');

    row.addEventListener('click', () => {
      if (isRail()) {
        location.assign(groupHref(g.id));
        return;
      }
      const nowOpen = !li.classList.contains('is-open');
      // Accordion: one group open at a time keeps the sidebar short.
      if (nowOpen) {
        tree
          .querySelectorAll<HTMLElement>('li.dk-group.is-open')
          .forEach((other) => {
            other.classList.remove('is-open');
            other
              .querySelector('.dk-item-group')
              ?.setAttribute('aria-expanded', 'false');
            other.querySelector('.dk-sub')?.setAttribute('inert', '');
          });
        open.clear();
      }
      li.classList.toggle('is-open', nowOpen);
      row.setAttribute('aria-expanded', String(nowOpen));
      if (nowOpen) wrap.removeAttribute('inert');
      else wrap.setAttribute('inert', '');
      if (nowOpen) open.add(g.id);
      else open.delete(g.id);
      persistOpen();
    });
    tree.append(li);
  }

  tree.append(
    h(
      'li',
      { class: 'dk-sep-before', attrs: { role: 'none' } },
      link(ALL_TOOLS_HREF, `All tools (${TOOL_COUNT})`, 'grid', 1, active.all)
    )
  );

  // ---- roving tabindex + arrow keys ----
  const visibleItems = (): HTMLElement[] =>
    Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
      (el) => !el.closest('[inert]') && el.offsetParent !== null
    );
  const focusItem = (el: HTMLElement | undefined) => {
    if (!el) return;
    tree
      .querySelectorAll<HTMLElement>('[role="treeitem"]')
      .forEach((i) => (i.tabIndex = -1));
    el.tabIndex = 0;
    el.focus();
  };
  const initial =
    tree.querySelector<HTMLElement>('[aria-current="page"]') ??
    tree.querySelector<HTMLElement>('.dk-item.is-active') ??
    tree.querySelector<HTMLElement>('[role="treeitem"]');
  if (initial) initial.tabIndex = 0;

  tree.addEventListener('focusin', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]'
    );
    if (!t) return;
    tree
      .querySelectorAll<HTMLElement>('[role="treeitem"]')
      .forEach((i) => (i.tabIndex = -1));
    t.tabIndex = 0;
  });

  tree.addEventListener('keydown', (e) => {
    const cur = (e.target as HTMLElement).closest<HTMLElement>(
      '[role="treeitem"]'
    );
    if (!cur) return;
    const items = visibleItems();
    const i = items.indexOf(cur);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusItem(items[Math.min(i + 1, items.length - 1)]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusItem(items[Math.max(i - 1, 0)]);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(items[0]);
        break;
      case 'End':
        e.preventDefault();
        focusItem(items[items.length - 1]);
        break;
      case 'ArrowRight':
        if (cur.getAttribute('aria-expanded') === 'false') {
          e.preventDefault();
          cur.click();
        } else if (cur.getAttribute('aria-expanded') === 'true') {
          e.preventDefault();
          focusItem(items[i + 1]);
        }
        break;
      case 'ArrowLeft':
        if (cur.getAttribute('aria-expanded') === 'true') {
          e.preventDefault();
          cur.click();
        } else if (cur.getAttribute('aria-level') === '2') {
          e.preventDefault();
          const gid = cur
            .closest('li.dk-group')
            ?.querySelector<HTMLElement>(':scope > .dk-item-group');
          focusItem(gid ?? undefined);
        }
        break;
      case ' ':
        if (cur.tagName === 'A') {
          e.preventDefault();
          cur.click();
        }
        break;
    }
  });

  // ---- recent ----
  const recentList = h('ul', {
    class: 'dk-recent-list',
    attrs: { 'aria-label': 'Recent files' },
  });
  const recent = h(
    'section',
    { class: 'dk-recent', attrs: { 'aria-labelledby': 'dk-recent-h' } },
    h('h2', {
      class: 'dk-section-label',
      text: 'Recent',
      attrs: { id: 'dk-recent-h' },
    }),
    recentList
  );

  const renderRecent = (items: RecentEntry[]) => {
    recentList.replaceChildren();
    if (!items.length) {
      recent.classList.add('is-empty');
      recentList.append(
        h('li', {
          class: 'dk-recent-empty',
          text: 'Files you open will appear here.',
        })
      );
      return;
    }
    recent.classList.remove('is-empty');
    for (const f of items.slice(0, MAX_RECENT)) {
      const b = h('button', {
        class: 'dk-item dk-item-recent',
        attrs: { type: 'button', title: `${f.name} (${formatSize(f.size)})` },
        on: { click: () => openGranted([f]) },
      });
      b.append(
        iconSpan(icon('filePdf')),
        h('span', { class: 'dk-label', text: f.name })
      );
      recentList.append(h('li', {}, b));
    }
  };
  const refreshRecent = () => {
    if (!getDesk()) return renderRecent([]);
    listRecent()
      .then(renderRecent)
      .catch(() => renderRecent([]));
  };
  renderRecent([]);
  refreshRecent();

  // ---- footer ----
  const themeBtn = h('button', {
    class: 'dk-btn-icon',
    attrs: { type: 'button' },
    on: { click: () => toggleTheme() },
  });
  const syncThemeBtn = () => {
    const dark = effectiveTheme() === 'dark';
    themeBtn.replaceChildren(iconSpan(icon(dark ? 'sun' : 'moon')));
    themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  };
  syncThemeBtn();
  onThemeChange(syncThemeBtn);

  const aboutBtn = h('button', {
    class: 'dk-btn-icon',
    attrs: {
      type: 'button',
      title: 'About Inkleaf',
      'aria-label': 'About Inkleaf',
    },
    on: { click: () => openAbout() },
  });
  aboutBtn.append(iconSpan(icon('info')));

  const foot = h('div', { class: 'dk-sb-foot' }, themeBtn, aboutBtn);

  // ---- assemble ----
  const top = h(
    'div',
    { class: 'dk-sb-top' },
    h(
      'a',
      {
        class: 'dk-brand dk-nodrag',
        attrs: {
          href: HOME_HREF,
          'aria-label': 'Inkleaf home',
          title: 'Inkleaf home',
        },
      },
      svg(logoMark(22)),
      h('span', { class: 'dk-brand-name', text: 'Inkleaf' })
    )
  );

  const el = h(
    'aside',
    {
      class: 'dk-sidebar',
      attrs: { id: 'dk-sidebar', 'aria-label': 'Sidebar' },
    },
    top,
    h(
      'nav',
      { class: 'dk-nav', attrs: { 'aria-label': 'Main' } },
      tree,
      recent
    ),
    foot
  );

  return { el, refreshRecent };
}
