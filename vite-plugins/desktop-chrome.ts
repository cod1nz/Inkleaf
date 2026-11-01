import type { Plugin } from 'vite';

/**
 * Desktop (Electron) shared chrome. Active only when DESKTOP=true.
 * Runs in the 'pre' phase so Vite bundles the injected tags (hashed assets in
 * the build). Injects the shell stylesheet + shell script into every HTML page and marks
 * <html data-desktop>. No inline script: the packaged app's CSP forbids it.
 * chrome.ts applies theme/platform before the page is revealed (shell.css
 * keeps the body hidden until then, with a timed failsafe).
 */
export function desktopChrome(): Plugin {
  return {
    name: 'inkleaf-desktop-chrome',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (process.env.DESKTOP !== 'true') return html;
        const tags: {
          tag: string;
          attrs?: Record<string, string | boolean>;
          injectTo: 'head' | 'head-prepend';
        }[] = [];
        if (!/src\/css\/desktop\/shell\.css/.test(html)) {
          tags.push({
            tag: 'link',
            attrs: { rel: 'stylesheet', href: '/src/css/desktop/shell.css' },
            injectTo: 'head',
          });
        }
        if (!/src\/desktop\/chrome\.ts/.test(html)) {
          tags.push({
            tag: 'script',
            attrs: { type: 'module', src: '/src/desktop/chrome.ts' },
            injectTo: 'head',
          });
        }
        const out = /<html\b[^>]*\bdata-desktop\b/i.test(html)
          ? html
          : html.replace(/<html\b/i, '<html data-desktop');
        return { html: out, tags };
      },
    },
  };
}

export default desktopChrome;
