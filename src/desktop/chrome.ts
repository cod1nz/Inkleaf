/**
 * Inkleaf desktop shell. Injected into every page by vite-plugins/desktop-chrome.ts.
 * Wraps the page's own content in: titlebar + sidebar + main area, without
 * editing the page. Web chrome (site header, footer, marketing) is hidden in
 * shell.css. Safe to load in a plain browser (no window.desk).
 */
import { h, iconSpan, shortcut } from './dom';
import { getDesk, platform } from './desk';
import { icon } from './icons';
import {
  buildSidebar,
  restoreSidebar,
  sidebarToggleButton,
  toggleSidebar,
} from './sidebar';
import { initTheme, toggleTheme } from './theme';
import { getGroup, getTool, pageSlug } from './nav-model';
import { openPalette, togglePalette } from './palette';
import { openAbout } from './about-dialog';
import { openFromDialog, openGranted } from './open-flow';
import { toast } from './toast';
import { bootstrapFlows } from './flows/bootstrap';

bootstrapFlows();

declare global {
  interface Window {
    __inkleafChrome?: boolean;
    inkleaf?: InkleafShell;
  }
}

/** Small public surface for tool flows (M5). */
export interface InkleafShell {
  toast: typeof toast;
  openPalette: () => void;
  /** Show the open file's name in the titlebar and window title. */
  setTitle: (fileName: string | null) => void;
  /** Set true when the current page handles File > Open / open-with itself. */
  handlesOpen: boolean;
  refreshRecent: () => void;
}

const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'LINK',
  'TEMPLATE',
  'NOSCRIPT',
  'META',
]);

function init(): void {
  if (window.__inkleafChrome) return;
  window.__inkleafChrome = true;

  const root = document.documentElement;
  root.setAttribute('data-desktop', '');
  root.setAttribute('data-platform', platform());

  restoreSidebar();
  initTheme();

  const mount = () => {
    if (document.querySelector('.dk-app')) return;
    const body = document.body;
    const slug = pageSlug(location.pathname);
    const isHome = slug === 'desktop' || slug === '' || slug === 'index';
    const tool = getTool(slug);
    const toolName = isHome
      ? homeTitle()
      : (tool?.name ?? cleanTitle(document.title));

    // ---- build shell ----
    const sb = buildSidebar();

    const titleTool = h('span', { class: 'dk-tb-tool', text: toolName });
    const titleSep = h('span', {
      class: 'dk-tb-sep',
      text: '/',
      attrs: { 'aria-hidden': 'true', hidden: true },
    });
    const titleFile = h('span', {
      class: 'dk-tb-file',
      attrs: { hidden: true },
    });
    const title = h(
      'div',
      { class: 'dk-tb-title', attrs: { 'aria-live': 'polite' } },
      titleTool,
      titleSep,
      titleFile
    );

    const searchBtn = h(
      'button',
      {
        class: 'dk-search-btn dk-nodrag',
        attrs: {
          type: 'button',
          'aria-label': 'Search tools and files',
          title: `Search (${shortcut('K')})`,
        },
        on: { click: () => openPalette() },
      },
      iconSpan(icon('search')),
      h('span', { class: 'dk-search-label', text: 'Search' }),
      h('kbd', { class: 'dk-kbd', text: shortcut('K') })
    );

    const titlebar = h(
      'header',
      { class: 'dk-titlebar' },
      h('div', { class: 'dk-tb-left' }, sidebarToggleButton()),
      title,
      h('div', { class: 'dk-tb-right' }, searchBtn)
    );

    const main = h('main', {
      class: 'dk-main',
      attrs: { id: 'dk-main', tabindex: -1 },
    });
    const col = h('div', { class: 'dk-col' }, titlebar, main);
    const app = h('div', { class: 'dk-app' }, sb.el, col);

    // ---- move the page's own content into <main> (node identity preserved) ----
    const nodes = Array.from(body.childNodes).filter(
      (n) => !(n.nodeType === 1 && SKIP_TAGS.has((n as Element).tagName))
    );
    // Pages that make <body> a full-height flex column (workflow builder) need
    // <main> to play that role instead.
    const bodyClasses = body.classList;
    if (bodyClasses.contains('flex')) main.dataset.bodyFlex = '';
    if (bodyClasses.contains('overflow-hidden')) main.dataset.bodyClip = '';
    body.prepend(app);
    for (const n of nodes) main.append(n);

    root.setAttribute('data-page', isHome ? 'home' : 'tool');
    if (slug) root.setAttribute('data-tool', slug);

    // ---- window/document title ----
    const applyDocTitle = (file: string | null) => {
      document.title = file ? `${file} — Inkleaf` : `${toolName} — Inkleaf`;
    };
    applyDocTitle(null);

    const shell: InkleafShell = {
      toast,
      openPalette,
      handlesOpen: false,
      refreshRecent: sb.refreshRecent,
      setTitle: (file) => {
        const f = file && file.trim() ? file.trim() : null;
        titleFile.textContent = f ?? '';
        titleFile.hidden = !f;
        titleSep.hidden = !f;
        applyDocTitle(f);
      },
    };
    window.inkleaf = shell;

    // Reveal (CSS keeps body hidden until now; there is also a timed failsafe).
    requestAnimationFrame(() => root.classList.add('dk-ready'));

    // ---- keyboard ----
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          e.stopPropagation();
          togglePalette();
        }
      },
      true
    );

    // ---- desk events ----
    const desk = getDesk();
    if (desk?.onMenu) {
      try {
        desk.onMenu((id) => {
          switch (id) {
            case 'file:open':
              if (!shell.handlesOpen) void openFromDialog();
              break;
            case 'view:toggleSidebar':
              toggleSidebar();
              break;
            case 'view:toggleDark':
              toggleTheme();
              break;
            case 'menu:about':
              openAbout();
              break;
            default:
              break;
          }
        });
      } catch {
        /* ignore */
      }
    }
    if (desk) {
      // Open-with at the shell level, unless the page declares it handles it.
      try {
        desk.onOpenWith?.((files) => {
          if (shell.handlesOpen || !Array.isArray(files) || !files.length)
            return;
          openGranted(files);
        });
      } catch {
        /* ignore */
      }
    }

    // Never let a stray drop navigate the window to the dropped file.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

function homeTitle(): string {
  const q = new URLSearchParams(location.search);
  if (q.get('view') === 'all') return 'All tools';
  const g = getGroup(q.get('group') ?? '');
  return g ? g.label : 'Home';
}

function cleanTitle(t: string): string {
  return t.split(/\s[|—-]\s/)[0].trim() || 'Inkleaf';
}

init();
