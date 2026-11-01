import { defineConfig } from 'vitest/config';
import type { IncomingMessage, ServerResponse } from 'http';
import http from 'http';
import https from 'https';
import type { Connect, Plugin } from 'vite';
// import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import handlebars from 'vite-plugin-handlebars';
import { resolve } from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { desktopChrome } from './vite-plugins/desktop-chrome';

// Desktop (Electron) build: DESKTOP=true. See PLAN.md D2/D3/D4.
const DESKTOP = process.env.DESKTOP === 'true';

// Web-only/marketing pages that never ship in the desktop build.
const DESKTOP_EXCLUDED_INPUTS =
  /^(about|contact|faq|privacy|terms|licensing|kura|hyper-compress|advertise|404|blog-.*|compress-pdf-to-.*|compress-pdf-for-email|wasm-settings)$/;

// Inputs whose source file is gone (deleted marketing pages) are dropped
// instead of failing the build.
function pruneInputs(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, file] of Object.entries(input)) {
    if (DESKTOP && DESKTOP_EXCLUDED_INPUTS.test(name)) continue;
    if (!fs.existsSync(file)) {
      console.warn(`[vite] Skipping missing page input: ${name} (${file})`);
      continue;
    }
    out[name] = file;
  }
  return out;
}

function listBlogPages(): string[] {
  const dir = resolve(__dirname, 'blog');
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.html'))
    : [];
}

// Public assets that must not ship in the desktop dist.
const DESKTOP_PRUNED_PUBLIC = [
  'sw.js',
  'libreoffice-wasm', // D9: optional add-on, not bundled
  'robots.txt',
  'site.webmanifest',
  'CHANGELOG.md',
];

function desktopPrunePlugin(): Plugin {
  return {
    name: 'desktop-prune-public',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist');
      for (const rel of DESKTOP_PRUNED_PUBLIC) {
        fs.rmSync(resolve(outDir, rel), { recursive: true, force: true });
      }
      // Size trims (verified: OCR runs with only the two kept cores; cpdf loads
      // only coherentpdf.browser.min.js; browsers pick woff2 first).
      const rm = (rel: string) =>
        fs.rmSync(resolve(outDir, rel), { recursive: true, force: true });
      const walk = (dir: string, fn: (file: string) => void) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = resolve(dir, e.name);
          if (e.isDirectory()) walk(f, fn);
          else fn(f);
        }
      };
      walk(outDir, (f) => {
        if (f.endsWith('.map')) fs.rmSync(f, { force: true });
      });
      const keepCores = new Set([
        'tesseract-core-simd-lstm.wasm.js',
        'tesseract-core-relaxedsimd-lstm.wasm.js',
        'LICENSE',
      ]);
      const coreDir = resolve(outDir, 'tesseract/core');
      if (fs.existsSync(coreDir)) {
        for (const f of fs.readdirSync(coreDir))
          if (!keepCores.has(f)) rm(`tesseract/core/${f}`);
      }
      for (const f of [
        'coherentpdf.js',
        'coherentpdf.browser.js',
        'coherentpdf.min.js',
      ])
        rm(`wasm/cpdf/${f}`);
      rm('coherentpdf.browser.min.js');
      // Social-card images (og:image) are web-only marketing.
      for (const f of fs.readdirSync(resolve(outDir, 'images')))
        if (/^og-.*\.png$/.test(f)) rm(`images/${f}`);
      const assetsDir = resolve(outDir, 'assets');
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) {
          if (
            /^(KaTeX_|Phosphor-).*\.(ttf|woff)$/.test(f) ||
            /^Phosphor-.*\.svg$/.test(f)
          )
            rm(`assets/${f}`);
        }
      }
    },
  };
}

// Desktop: neutralize remote URLs baked into the vendored editor bundle
// (bentopdf-viewer): the Google Fonts @import in its shadow-DOM CSS and the
// jsDelivr defaults for pdfium/fonts. All real call sites pass local URLs.
function desktopStripRemoteUrlsPlugin(): Plugin {
  return {
    name: 'desktop-strip-remote-urls',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/node_modules[\/](bentopdf-viewer|bentopdf-pdfium)[\/]/.test(id)) {
        return null;
      }
      const out = code
        .replace(
          /@import url\(\\?['"]https:\/\/fonts\.googleapis\.com[^)]*\);?/g,
          ''
        )
        .replace(
          /https:\/\/cdn\.jsdelivr\.net\/npm\//g,
          '/__offline_disabled__/npm/'
        );
      return out === code ? null : { code: out, map: null };
    },
  };
}

function engineVersion(): string {
  try {
    const dir = resolve(__dirname, 'node_modules/bentopdf-pdfium');
    const h = createHash('sha256');
    for (const f of ['editcore.js', 'editcore.wasm']) {
      h.update(fs.readFileSync(resolve(dir, f)));
    }
    return h.digest('hex').slice(0, 12);
  } catch {
    return 'dev';
  }
}

const SUPPORTED_LANGUAGES = [
  'en',
  'ar',
  'be',
  'da',
  'ru',
  'de',
  'es',
  'fr',
  'id',
  'it',
  'nl',
  'pt',
  'pl',
  'sv',
  'tr',
  'vi',
  'zh',
  'zh-TW',
  'ko',
  'ja',
  'uk',
  'sk',
  'ca',
  'fa',
] as const;
const LANG_REGEX = new RegExp(
  `^/(${SUPPORTED_LANGUAGES.join('|')})(?:/(.*))?$`
);

function loadPages(): Set<string> {
  const pagesDir = resolve(__dirname, 'src/pages');
  const pages = new Set<string>();

  if (fs.existsSync(pagesDir)) {
    for (const file of fs.readdirSync(pagesDir)) {
      if (file.endsWith('.html')) {
        pages.add(file.replace('.html', ''));
      }
    }
  }

  const rootPages = [
    'index',
    'about',
    'contact',
    'faq',
    'privacy',
    'terms',
    'licensing',
    'kura',
    'hyper-compress',
    'advertise',
    '404',
    'pdf-converter',
    'pdf-editor',
    'pdf-security',
    'pdf-merge-split',
  ];
  rootPages.forEach((p) => pages.add(p));

  return pages;
}

const PAGES = loadPages();

function getBasePath(): string {
  return (process.env.BASE_URL || '/').replace(/\/$/, '');
}

function createLanguageMiddleware(isDev: boolean): Connect.NextHandleFunction {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): void => {
    if (!req.url) return next();

    const basePath = getBasePath();
    const [fullPathname, queryString] = req.url.split('?');

    let pathname = fullPathname;
    if (basePath && basePath !== '/' && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || '/';
    }

    if (!pathname.startsWith('/')) {
      pathname = '/' + pathname;
    }

    const match = pathname.match(LANG_REGEX);

    if (match) {
      const lang = match[1];
      const rest = match[2] ?? '';

      if (rest === '' && !pathname.endsWith('/')) {
        const redirectUrl = basePath ? `${basePath}/${lang}/` : `/${lang}/`;
        res.statusCode = 302;
        res.setHeader(
          'Location',
          redirectUrl + (queryString ? `?${queryString}` : '')
        );
        res.end();
        return;
      }

      if (rest === '' || rest === '/') {
        if (isDev) {
          req.url = '/index.html' + (queryString ? `?${queryString}` : '');
        } else {
          const langIndexPath = resolve(__dirname, 'dist', lang, 'index.html');
          if (fs.existsSync(langIndexPath)) {
            req.url =
              `/${lang}/index.html` + (queryString ? `?${queryString}` : '');
          } else {
            req.url = '/index.html' + (queryString ? `?${queryString}` : '');
          }
        }
        return next();
      }

      const cleanPath = rest.replace(/\/$/, '').replace(/\.html$/, '');
      const pageName = cleanPath.split('/')[0];

      if (pageName && PAGES.has(pageName)) {
        if (isDev) {
          const srcPath = resolve(__dirname, 'src/pages', `${pageName}.html`);
          if (fs.existsSync(srcPath)) {
            req.url =
              `/src/pages/${pageName}.html` +
              (queryString ? `?${queryString}` : '');
          } else {
            req.url =
              `/${pageName}.html` + (queryString ? `?${queryString}` : '');
          }
        } else {
          const langPagePath = resolve(
            __dirname,
            'dist',
            lang,
            `${pageName}.html`
          );
          if (fs.existsSync(langPagePath)) {
            req.url =
              `/${lang}/${pageName}.html` +
              (queryString ? `?${queryString}` : '');
          } else {
            req.url =
              `/${pageName}.html` + (queryString ? `?${queryString}` : '');
          }
        }
      } else if (!cleanPath.includes('.')) {
        if (isDev) {
          req.url =
            `/${cleanPath}.html` + (queryString ? `?${queryString}` : '');
        } else {
          const langPagePath = resolve(
            __dirname,
            'dist',
            lang,
            `${cleanPath}.html`
          );
          if (fs.existsSync(langPagePath)) {
            req.url =
              `/${lang}/${cleanPath}.html` +
              (queryString ? `?${queryString}` : '');
          } else {
            req.url =
              `/${cleanPath}.html` + (queryString ? `?${queryString}` : '');
          }
        }
      }

      return next();
    }

    if (isDev && pathname.endsWith('.html') && !pathname.startsWith('/src/')) {
      const pageName = pathname.slice(1).replace('.html', '');
      if (PAGES.has(pageName)) {
        const srcPath = resolve(__dirname, 'src/pages', `${pageName}.html`);
        if (fs.existsSync(srcPath)) {
          req.url =
            `/src/pages/${pageName}.html` +
            (queryString ? `?${queryString}` : '');
          return next();
        }
      }
    }

    if (pathname === '/blog' || pathname === '/blog/') {
      req.url = '/blog/index.html' + (queryString ? `?${queryString}` : '');
      return next();
    }

    const blogMatch = pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/);
    if (blogMatch) {
      req.url =
        `/blog/${blogMatch[1]}.html` + (queryString ? `?${queryString}` : '');
      return next();
    }

    next();
  };
}

function buildCorsProxyAllowedHosts(): Set<string> {
  const hosts = new Set<string>([
    'cdn.jsdelivr.net',
    'fonts.googleapis.com',
    'fonts.gstatic.com',
    'bentopdf-cors-proxy.bentopdf.workers.dev',
    'timestamp.digicert.com',
    'timestamp.sectigo.com',
    'ts.ssl.com',
    'freetsa.org',
    'tsa.mesign.com',
  ]);

  const envHostSources = [
    process.env.VITE_CORS_PROXY_URL,
    process.env.VITE_WASM_PYMUPDF_URL,
    process.env.VITE_WASM_GS_URL,
    process.env.VITE_WASM_CPDF_URL,
    process.env.VITE_TESSERACT_WORKER_URL,
    process.env.VITE_TESSERACT_CORE_URL,
    process.env.VITE_TESSERACT_LANG_URL,
    process.env.VITE_OCR_FONT_BASE_URL,
  ];
  for (const raw of envHostSources) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).hostname);
    } catch {
      console.warn(
        `[vite] Ignoring malformed VITE_* URL in dev CORS proxy allowlist: ${raw}`
      );
    }
  }

  const extra = process.env.VITE_DEV_CORS_PROXY_EXTRA_HOSTS;
  if (extra) {
    for (const host of extra.split(',').map((s) => s.trim())) {
      if (host) hosts.add(host);
    }
  }

  return hosts;
}

const CORS_PROXY_ALLOWED_HOSTS = buildCorsProxyAllowedHosts();

function createCorsProxyMiddleware(): Connect.NextHandleFunction {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next: Connect.NextFunction
  ): void => {
    if (!req.url?.startsWith('/cors-proxy')) return next();

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.statusCode = 204;
      res.end();
      return;
    }

    const parsed = new URL(req.url, 'http://localhost');
    const targetUrl = parsed.searchParams.get('url');
    if (!targetUrl) {
      res.statusCode = 400;
      res.end('Missing url parameter');
      return;
    }

    let targetHost: string;
    let targetProtocol: string;
    try {
      const parsedTarget = new URL(targetUrl);
      targetHost = parsedTarget.hostname;
      targetProtocol = parsedTarget.protocol;
    } catch {
      res.statusCode = 400;
      res.end('Invalid url parameter');
      return;
    }

    if (targetProtocol !== 'https:' && targetProtocol !== 'http:') {
      res.statusCode = 400;
      res.end('Unsupported protocol');
      return;
    }

    if (!CORS_PROXY_ALLOWED_HOSTS.has(targetHost)) {
      console.warn(`[CORS Proxy] Blocked disallowed host: ${targetHost}`);
      res.statusCode = 403;
      res.end(`Host not allowed: ${targetHost}`);
      return;
    }

    console.log(`[CORS Proxy] ${req.method} ${targetUrl}`);

    const bodyChunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(bodyChunks);
      const target = new URL(targetUrl);
      const transport = target.protocol === 'https:' ? https : http;

      const headers: Record<string, string> = {};
      if (req.headers['content-type']) {
        headers['Content-Type'] = req.headers['content-type'] as string;
      }
      if (body.length > 0) {
        headers['Content-Length'] = String(body.length);
      }

      const proxyReq = transport.request(
        targetUrl,
        { method: req.method || 'GET', headers },
        (proxyRes) => {
          console.log(
            `[CORS Proxy] Response: ${proxyRes.statusCode} from ${targetUrl}`
          );
          res.setHeader(
            'Access-Control-Allow-Origin',
            req.headers.origin || '*'
          );
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.statusCode = proxyRes.statusCode || 200;
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', (err) => {
        const msg = String(err.message).replace(/[\r\n]+/g, ' ');
        console.error('[CORS Proxy] Error:', msg);
        res.statusCode = 502;
        res.end(`Proxy error: ${msg}`);
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    });
  };
}

function languageRouterPlugin(): Plugin {
  return {
    name: 'language-router',
    configureServer(server) {
      if (!DESKTOP) server.middlewares.use(createCorsProxyMiddleware());
      server.middlewares.use(createLanguageMiddleware(true));
    },
    configurePreviewServer(server) {
      if (!DESKTOP) server.middlewares.use(createCorsProxyMiddleware());
      server.middlewares.use(createLanguageMiddleware(false));
    },
  };
}

function languageRedirectPlugin(): Plugin {
  const sourcePath = resolve(__dirname, 'src/js/language-redirect.js');
  let isBuild = false;
  let fileName = '';
  return {
    name: 'language-redirect',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    buildStart() {
      if (!isBuild) return;
      const hash = createHash('sha256')
        .update(fs.readFileSync(sourcePath))
        .digest('hex')
        .slice(0, 10);
      fileName = `assets/language-redirect-${hash}.js`;
    },
    generateBundle() {
      if (!isBuild) return;
      this.emitFile({
        type: 'asset',
        fileName,
        source: fs.readFileSync(sourcePath, 'utf-8'),
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        const base = `${getBasePath()}/`;
        return [
          {
            tag: 'script',
            attrs: {
              src: isBuild
                ? `${base}${fileName}`
                : `${base}src/js/language-redirect.js`,
              'data-language-redirect': '',
              'data-base': base,
              'data-languages': SUPPORTED_LANGUAGES.filter(
                (lang) => lang !== 'en'
              ).join(','),
              'data-default-language':
                process.env.VITE_DEFAULT_LANGUAGE || 'en',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

type JsonRecord = Record<string, unknown>;

function devPageTranslationsPlugin(): Plugin {
  const cache = new Map<string, { mtimeMs: number; data: JsonRecord }>();
  const loadJson = (file: string): JsonRecord => {
    if (!fs.existsSync(file)) return {};
    const { mtimeMs } = fs.statSync(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as JsonRecord;
    cache.set(file, { mtimeMs, data });
    return data;
  };

  return {
    name: 'dev-page-translations',
    apply: 'serve',
    enforce: 'post',
    async transformIndexHtml(html, ctx) {
      const basePath = getBasePath();
      let pathname = (ctx.originalUrl ?? ctx.path).split('?')[0];
      if (basePath && pathname.startsWith(basePath)) {
        pathname = pathname.slice(basePath.length) || '/';
      }
      const lang = pathname.match(LANG_REGEX)?.[1];
      if (!lang) return html;
      const rootRelative = html.replace(
        /(\s(?:src|href)=["'])(?=src\/)/g,
        `$1${basePath}/`
      );
      if (lang === 'en') return rootRelative;
      const content = loadJson(
        resolve(__dirname, 'translations', lang, 'content.json')
      );
      const resources = {
        common: loadJson(
          resolve(__dirname, 'public/locales', lang, 'common.json')
        ),
        tools: loadJson(
          resolve(__dirname, 'public/locales', lang, 'tools.json')
        ),
      };
      const pageName =
        ctx.path
          .split('/')
          .pop()
          ?.replace(/\.html$/, '') || 'index';
      const jsdomModule = 'jsdom';
      const [{ JSDOM }, { processPage }, { applyServerTranslations }] =
        (await Promise.all([
          import(jsdomModule),
          import('./scripts/content-segments.mjs'),
          import('./scripts/server-translations.mjs'),
        ])) as [
          {
            JSDOM: new (markup: string) => {
              window: { document: Document };
              serialize(): string;
            };
          },
          {
            processPage: (
              document: Document,
              pageName: string,
              options: { translate: (id: string) => string | null }
            ) => unknown;
          },
          {
            applyServerTranslations: (
              document: Document,
              resources: Record<string, JsonRecord>
            ) => void;
          },
        ];
      const dom = new JSDOM(rootRelative);
      const document = dom.window.document;
      document.documentElement.lang = lang;
      document.documentElement.dir = ['ar', 'fa'].includes(lang)
        ? 'rtl'
        : 'ltr';
      applyServerTranslations(document, resources);
      processPage(document, pageName, {
        translate: (id: string) =>
          typeof content[id] === 'string' ? (content[id] as string) : null,
      });
      return dom.serialize();
    },
  };
}

function flattenPagesPlugin(): Plugin {
  return {
    name: 'flatten-pages',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) return;

      const moves: Array<{ from: string; to: string }> = [];

      for (const fileName of Object.keys(bundle)) {
        if (fileName.startsWith('src/pages/') && fileName.endsWith('.html')) {
          moves.push({
            from: fileName,
            to: fileName.replace('src/pages/', ''),
          });
        }
      }

      if (
        (process.env.SIMPLE_MODE === 'true' || DESKTOP) &&
        bundle['simple-index.html']
      ) {
        moves.push({ from: 'simple-index.html', to: 'index.html' });
      }

      for (const { from, to } of moves) {
        const oldPath = resolve(outDir, from);
        const newPath = resolve(outDir, to);
        if (!fs.existsSync(oldPath)) continue;
        fs.mkdirSync(resolve(newPath, '..'), { recursive: true });
        if (fs.existsSync(newPath)) fs.rmSync(newPath, { force: true });
        fs.renameSync(oldPath, newPath);
      }

      const pagesDir = resolve(outDir, 'src/pages');
      if (fs.existsSync(pagesDir) && fs.readdirSync(pagesDir).length === 0) {
        fs.rmdirSync(pagesDir);
      }
      const srcDir = resolve(outDir, 'src');
      if (fs.existsSync(srcDir) && fs.readdirSync(srcDir).length === 0) {
        fs.rmdirSync(srcDir);
      }
    },
  };
}

function swPrecachePlugin(): Plugin {
  const workerAssetPattern = /^assets\/pdf\.worker(\.min)?-[\w-]+\.m?js$/;
  const placeholderPattern = /const PRECACHE_ASSETS = \[[\s\S]*?\];/;

  return {
    name: 'sw-precache',
    apply: 'build',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) return;

      const workerAssets = Object.keys(bundle)
        .filter((fileName) => workerAssetPattern.test(fileName))
        .sort();

      if (workerAssets.length === 0) {
        throw new Error(
          '[sw-precache] no PDF.js worker asset found in bundle; service worker would precache nothing'
        );
      }

      const swPath = resolve(outDir, 'sw.js');
      if (!fs.existsSync(swPath)) {
        throw new Error(`[sw-precache] ${swPath} not found in build output`);
      }

      const source = fs.readFileSync(swPath, 'utf8');
      if (!placeholderPattern.test(source)) {
        throw new Error(
          '[sw-precache] could not find "const PRECACHE_ASSETS = [...]" in sw.js'
        );
      }

      const list = workerAssets.map((asset) => `  '${asset}',`).join('\n');
      fs.writeFileSync(
        swPath,
        source.replace(
          placeholderPattern,
          `const PRECACHE_ASSETS = [\n${list}\n];`
        )
      );

      console.log(
        `[sw-precache] precaching ${workerAssets.length} asset(s): ${workerAssets.join(', ')}`
      );
    },
  };
}

function rewriteHtmlPathsPlugin(): Plugin {
  const baseUrl = process.env.BASE_URL || '/';
  const normalizedBase = baseUrl.replace(/\/?$/, '/');

  const escapedBase = normalizedBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return {
    name: 'rewrite-html-paths',
    enforce: 'post',
    writeBundle(options, bundle) {
      if (normalizedBase === '/') return;
      const outDir = options.dir;
      if (!outDir) return;

      const hrefRegex = new RegExp(
        `href="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
        'g'
      );
      const srcRegex = new RegExp(
        `src="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
        'g'
      );
      const contentRegex = new RegExp(
        `content="\\/(?!${escapedBase.slice(1)}|test\\/|http|\\/\\/)`,
        'g'
      );

      for (const fileName of Object.keys(bundle)) {
        if (!fileName.endsWith('.html')) continue;
        const diskPath = [
          resolve(outDir, fileName),
          resolve(outDir, fileName.replace(/^src\/pages\//, '')),
        ].find((candidate) => fs.existsSync(candidate));
        if (!diskPath) continue;
        const source = fs.readFileSync(diskPath, 'utf8');
        const updated = source
          .replace(hrefRegex, `href="${normalizedBase}`)
          .replaceAll(
            `href="${normalizedBase}"`,
            `href="${normalizedBase.slice(0, -1)}"`
          )
          .replace(srcRegex, `src="${normalizedBase}`)
          .replace(contentRegex, `content="${normalizedBase}`);
        if (updated !== source) {
          fs.writeFileSync(diskPath, updated);
        }
      }
    },
  };
}

export default defineConfig(({ command }) => {
  const USE_CDN = process.env.VITE_USE_CDN === 'true';
  const baseUrl = (process.env.BASE_URL || '/').replace(/\/?$/, '/');
  const docsUrl =
    !DESKTOP &&
    baseUrl === '/' &&
    (command === 'serve' || process.env.INCLUDE_DOCS === 'true')
      ? '/docs/'
      : 'https://www.bentopdf.com/docs';
  const showAds =
    !DESKTOP &&
    (command === 'serve' ||
      ['bentopdf.com', 'www.bentopdf.com'].includes(
        process.env.VERCEL_PROJECT_PRODUCTION_URL ?? ''
      ));

  if (USE_CDN) {
    console.log('[Vite] Using CDN for WASM files (with local fallback)');
  } else {
    console.log('[Vite] Using local WASM files only');
  }

  return {
    // Desktop is always served from the origin root (app://bentopdf/).
    base: DESKTOP ? '/' : (process.env.BASE_URL || '/').replace(/\/?$/, '/'),
    worker: {
      format: 'es' as const,
    },
    plugins: [
      // basicSsl(),
      handlebars({
        partialDirectory: resolve(__dirname, 'src/partials'),
        context: {
          baseUrl: (process.env.BASE_URL || '/').replace(/\/?$/, '/'),
          docsUrl,
          simpleMode: DESKTOP || process.env.SIMPLE_MODE === 'true',
          brandName: process.env.VITE_BRAND_NAME || '',
          brandLogo: process.env.VITE_BRAND_LOGO || '',
          footerText: process.env.VITE_FOOTER_TEXT || '',
          appVersion: process.env.npm_package_version || 'Unknown',
          showAds,
        },
      }),
      languageRouterPlugin(),
      devPageTranslationsPlugin(),
      ...(DESKTOP ? [] : [languageRedirectPlugin()]),
      flattenPagesPlugin(),
      ...(DESKTOP ? [] : [rewriteHtmlPathsPlugin(), swPrecachePlugin()]),
      ...(DESKTOP
        ? [
            desktopStripRemoteUrlsPlugin(),
            desktopPrunePlugin(),
            desktopChrome(),
          ]
        : []),
      tailwindcss(),
      nodePolyfills({
        include: ['buffer', 'stream', 'util', 'zlib', 'process'],
        globals: {
          Buffer: true,
          global: false,
          process: true,
        },
      }),
    ],
    define: {
      __DESKTOP__: JSON.stringify(DESKTOP),
      __SIMPLE_MODE__: JSON.stringify(
        DESKTOP || process.env.SIMPLE_MODE === 'true'
      ),
      ...(DESKTOP
        ? {
            // Desktop ships English OCR data only.
            'import.meta.env.VITE_TESSERACT_AVAILABLE_LANGUAGES':
              JSON.stringify('eng'),
          }
        : {}),
      __DISABLE_GITHUB_STARS__: JSON.stringify(
        DESKTOP || process.env.DISABLE_GITHUB_STARS === 'true'
      ),
      __BRAND_NAME__: JSON.stringify(process.env.VITE_BRAND_NAME || ''),
      __DISABLED_TOOLS__: JSON.stringify(
        (process.env.DISABLE_TOOLS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      ),
      __ENGINE_VERSION__: JSON.stringify(engineVersion()),
    },
    resolve: {
      alias: {
        '@/types': resolve(__dirname, 'src/js/types/index.ts'),
        '@': resolve(__dirname, 'src'),
        stream: 'stream-browserify',
        zlib: 'browserify-zlib',
      },
    },
    optimizeDeps: {
      include: ['pdfkit', 'blob-stream'],
      exclude: [
        'coherentpdf',
        'wasm-vips',
        'bentopdf-pdfium',
        'hyper-compress-wasm',
      ],
    },
    server: {
      host: process.env.VITE_DEV_HOST || 'localhost',
      proxy: DESKTOP
        ? undefined
        : {
            '/docs': {
              target: 'http://localhost:5174',
              ws: true,
              configure: (proxy) => {
                proxy.on('error', (_error, _req, res) => {
                  if (!('writeHead' in res) || res.headersSent) return;
                  res.writeHead(502, { 'Content-Type': 'text/plain' });
                  res.end(
                    'The docs dev server is not running. Start it with: npm run docs:dev'
                  );
                });
              },
            },
          },
      watch: {
        ignored: ['!**/node_modules/bentopdf-pdfium/**'],
      },
      // Desktop: the Electron main process sets COOP/COEP/CSP itself.
      headers: DESKTOP
        ? undefined
        : {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
    },
    preview: {
      headers: DESKTOP
        ? undefined
        : {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
    },
    build: {
      ...(DESKTOP ? { sourcemap: false } : {}),
      rollupOptions: {
        input: pruneInputs({
          main:
            DESKTOP || process.env.SIMPLE_MODE === 'true'
              ? resolve(__dirname, 'simple-index.html')
              : resolve(__dirname, 'index.html'),
          about: resolve(__dirname, 'about.html'),
          contact: resolve(__dirname, 'contact.html'),
          faq: resolve(__dirname, 'faq.html'),
          privacy: resolve(__dirname, 'privacy.html'),
          terms: resolve(__dirname, 'terms.html'),
          licensing: resolve(__dirname, 'licensing.html'),
          kura: resolve(__dirname, 'kura.html'),
          'hyper-compress': resolve(__dirname, 'hyper-compress.html'),
          ...(showAds
            ? { advertise: resolve(__dirname, 'advertise.html') }
            : {}),
          ...Object.fromEntries(
            listBlogPages().map((f) => [
              `blog-${f.replace('.html', '')}`,
              resolve(__dirname, 'blog', f),
            ])
          ),
          '404': resolve(__dirname, '404.html'),
          // Category Hub Pages
          'pdf-converter': resolve(__dirname, 'pdf-converter.html'),
          'pdf-editor': resolve(__dirname, 'pdf-editor.html'),
          'pdf-security': resolve(__dirname, 'pdf-security.html'),
          'pdf-merge-split': resolve(__dirname, 'pdf-merge-split.html'),
          // Tool Pages
          bookmark: resolve(__dirname, 'src/pages/bookmark.html'),
          'table-of-contents': resolve(
            __dirname,
            'src/pages/table-of-contents.html'
          ),
          'pdf-to-json': resolve(__dirname, 'src/pages/pdf-to-json.html'),
          'json-to-pdf': resolve(__dirname, 'src/pages/json-to-pdf.html'),
          'pdf-multi-tool': resolve(__dirname, 'src/pages/pdf-multi-tool.html'),
          'add-stamps': resolve(__dirname, 'src/pages/add-stamps.html'),
          'form-creator': resolve(__dirname, 'src/pages/form-creator.html'),
          'repair-pdf': resolve(__dirname, 'src/pages/repair-pdf.html'),
          'merge-pdf': resolve(__dirname, 'src/pages/merge-pdf.html'),
          'split-pdf': resolve(__dirname, 'src/pages/split-pdf.html'),
          'compress-pdf': resolve(__dirname, 'src/pages/compress-pdf.html'),
          'compress-pdf-to-100kb': resolve(
            __dirname,
            'src/pages/compress-pdf-to-100kb.html'
          ),
          'compress-pdf-to-200kb': resolve(
            __dirname,
            'src/pages/compress-pdf-to-200kb.html'
          ),
          'compress-pdf-to-500kb': resolve(
            __dirname,
            'src/pages/compress-pdf-to-500kb.html'
          ),
          'compress-pdf-to-1mb': resolve(
            __dirname,
            'src/pages/compress-pdf-to-1mb.html'
          ),
          'compress-pdf-to-2mb': resolve(
            __dirname,
            'src/pages/compress-pdf-to-2mb.html'
          ),
          'compress-pdf-for-email': resolve(
            __dirname,
            'src/pages/compress-pdf-for-email.html'
          ),
          'edit-pdf': resolve(__dirname, 'src/pages/edit-pdf.html'),
          'edit-pdf-text': resolve(__dirname, 'src/pages/edit-pdf-text.html'),
          'jpg-to-pdf': resolve(__dirname, 'src/pages/jpg-to-pdf.html'),
          'sign-pdf': resolve(__dirname, 'src/pages/sign-pdf.html'),
          'crop-pdf': resolve(__dirname, 'src/pages/crop-pdf.html'),
          'extract-pages': resolve(__dirname, 'src/pages/extract-pages.html'),
          'delete-pages': resolve(__dirname, 'src/pages/delete-pages.html'),
          'organize-pdf': resolve(__dirname, 'src/pages/organize-pdf.html'),
          'overlay-pdf': resolve(__dirname, 'src/pages/overlay-pdf.html'),
          'page-numbers': resolve(__dirname, 'src/pages/page-numbers.html'),
          'add-page-labels': resolve(
            __dirname,
            'src/pages/add-page-labels.html'
          ),
          'add-watermark': resolve(__dirname, 'src/pages/add-watermark.html'),
          'header-footer': resolve(__dirname, 'src/pages/header-footer.html'),
          'invert-colors': resolve(__dirname, 'src/pages/invert-colors.html'),
          'scanner-effect': resolve(__dirname, 'src/pages/scanner-effect.html'),
          'pdf-workflow': resolve(__dirname, 'src/pages/pdf-workflow.html'),
          'adjust-colors': resolve(__dirname, 'src/pages/adjust-colors.html'),
          'background-color': resolve(
            __dirname,
            'src/pages/background-color.html'
          ),
          'text-color': resolve(__dirname, 'src/pages/text-color.html'),
          'remove-annotations': resolve(
            __dirname,
            'src/pages/remove-annotations.html'
          ),
          'remove-blank-pages': resolve(
            __dirname,
            'src/pages/remove-blank-pages.html'
          ),
          'image-to-pdf': resolve(__dirname, 'src/pages/image-to-pdf.html'),
          'png-to-pdf': resolve(__dirname, 'src/pages/png-to-pdf.html'),
          'webp-to-pdf': resolve(__dirname, 'src/pages/webp-to-pdf.html'),
          'svg-to-pdf': resolve(__dirname, 'src/pages/svg-to-pdf.html'),
          'form-filler': resolve(__dirname, 'src/pages/form-filler.html'),
          'reverse-pages': resolve(__dirname, 'src/pages/reverse-pages.html'),
          'add-blank-page': resolve(__dirname, 'src/pages/add-blank-page.html'),
          'divide-pages': resolve(__dirname, 'src/pages/divide-pages.html'),
          'rotate-pdf': resolve(__dirname, 'src/pages/rotate-pdf.html'),
          'rotate-custom': resolve(__dirname, 'src/pages/rotate-custom.html'),
          'n-up-pdf': resolve(__dirname, 'src/pages/n-up-pdf.html'),
          'combine-single-page': resolve(
            __dirname,
            'src/pages/combine-single-page.html'
          ),
          'view-metadata': resolve(__dirname, 'src/pages/view-metadata.html'),
          'edit-metadata': resolve(__dirname, 'src/pages/edit-metadata.html'),
          'pdf-to-zip': resolve(__dirname, 'src/pages/pdf-to-zip.html'),
          'alternate-merge': resolve(
            __dirname,
            'src/pages/alternate-merge.html'
          ),
          'duplex-collate': resolve(__dirname, 'src/pages/duplex-collate.html'),
          'compare-pdfs': resolve(__dirname, 'src/pages/compare-pdfs.html'),
          'add-attachments': resolve(
            __dirname,
            'src/pages/add-attachments.html'
          ),
          'edit-attachments': resolve(
            __dirname,
            'src/pages/edit-attachments.html'
          ),
          'extract-attachments': resolve(
            __dirname,
            'src/pages/extract-attachments.html'
          ),
          'ocr-pdf': resolve(__dirname, 'src/pages/ocr-pdf.html'),
          'posterize-pdf': resolve(__dirname, 'src/pages/posterize-pdf.html'),
          'fix-page-size': resolve(__dirname, 'src/pages/fix-page-size.html'),
          'remove-metadata': resolve(
            __dirname,
            'src/pages/remove-metadata.html'
          ),
          'unlock-pdf': resolve(__dirname, 'src/pages/unlock-pdf.html'),
          'flatten-pdf': resolve(__dirname, 'src/pages/flatten-pdf.html'),
          'protect-pdf': resolve(__dirname, 'src/pages/protect-pdf.html'),
          'linearize-pdf': resolve(__dirname, 'src/pages/linearize-pdf.html'),
          'remove-restrictions': resolve(
            __dirname,
            'src/pages/remove-restrictions.html'
          ),
          'change-permissions': resolve(
            __dirname,
            'src/pages/change-permissions.html'
          ),
          'sanitize-pdf': resolve(__dirname, 'src/pages/sanitize-pdf.html'),
          'page-dimensions': resolve(
            __dirname,
            'src/pages/page-dimensions.html'
          ),
          'bmp-to-pdf': resolve(__dirname, 'src/pages/bmp-to-pdf.html'),
          'heic-to-pdf': resolve(__dirname, 'src/pages/heic-to-pdf.html'),
          'tiff-to-pdf': resolve(__dirname, 'src/pages/tiff-to-pdf.html'),
          'txt-to-pdf': resolve(__dirname, 'src/pages/txt-to-pdf.html'),
          'markdown-to-pdf': resolve(
            __dirname,
            'src/pages/markdown-to-pdf.html'
          ),
          'pdf-to-bmp': resolve(__dirname, 'src/pages/pdf-to-bmp.html'),
          'pdf-to-greyscale': resolve(
            __dirname,
            'src/pages/pdf-to-greyscale.html'
          ),
          'pdf-to-jpg': resolve(__dirname, 'src/pages/pdf-to-jpg.html'),
          'pdf-to-png': resolve(__dirname, 'src/pages/pdf-to-png.html'),
          'pdf-to-tiff': resolve(__dirname, 'src/pages/pdf-to-tiff.html'),
          'pdf-to-cbz': resolve(__dirname, 'src/pages/pdf-to-cbz.html'),
          'pdf-to-webp': resolve(__dirname, 'src/pages/pdf-to-webp.html'),
          'pdf-to-word': resolve(__dirname, 'src/pages/pdf-to-word.html'),
          'extract-images': resolve(__dirname, 'src/pages/extract-images.html'),
          'pdf-to-markdown': resolve(
            __dirname,
            'src/pages/pdf-to-markdown.html'
          ),
          'rasterize-pdf': resolve(__dirname, 'src/pages/rasterize-pdf.html'),
          'prepare-pdf-for-ai': resolve(
            __dirname,
            'src/pages/prepare-pdf-for-ai.html'
          ),
          'pdf-layers': resolve(__dirname, 'src/pages/pdf-layers.html'),
          'pdf-to-pdfa': resolve(__dirname, 'src/pages/pdf-to-pdfa.html'),
          'odt-to-pdf': resolve(__dirname, 'src/pages/odt-to-pdf.html'),
          'csv-to-pdf': resolve(__dirname, 'src/pages/csv-to-pdf.html'),
          'rtf-to-pdf': resolve(__dirname, 'src/pages/rtf-to-pdf.html'),
          'word-to-pdf': resolve(__dirname, 'src/pages/word-to-pdf.html'),
          'excel-to-pdf': resolve(__dirname, 'src/pages/excel-to-pdf.html'),
          'powerpoint-to-pdf': resolve(
            __dirname,
            'src/pages/powerpoint-to-pdf.html'
          ),
          'pdf-booklet': resolve(__dirname, 'src/pages/pdf-booklet.html'),
          'xps-to-pdf': resolve(__dirname, 'src/pages/xps-to-pdf.html'),
          'mobi-to-pdf': resolve(__dirname, 'src/pages/mobi-to-pdf.html'),
          'epub-to-pdf': resolve(__dirname, 'src/pages/epub-to-pdf.html'),
          'fb2-to-pdf': resolve(__dirname, 'src/pages/fb2-to-pdf.html'),
          'cbz-to-pdf': resolve(__dirname, 'src/pages/cbz-to-pdf.html'),
          'wpd-to-pdf': resolve(__dirname, 'src/pages/wpd-to-pdf.html'),
          'wps-to-pdf': resolve(__dirname, 'src/pages/wps-to-pdf.html'),
          'xml-to-pdf': resolve(__dirname, 'src/pages/xml-to-pdf.html'),
          'pages-to-pdf': resolve(__dirname, 'src/pages/pages-to-pdf.html'),
          'odg-to-pdf': resolve(__dirname, 'src/pages/odg-to-pdf.html'),
          'ods-to-pdf': resolve(__dirname, 'src/pages/ods-to-pdf.html'),
          'odp-to-pdf': resolve(__dirname, 'src/pages/odp-to-pdf.html'),
          'pub-to-pdf': resolve(__dirname, 'src/pages/pub-to-pdf.html'),
          'vsd-to-pdf': resolve(__dirname, 'src/pages/vsd-to-pdf.html'),
          'psd-to-pdf': resolve(__dirname, 'src/pages/psd-to-pdf.html'),
          'pdf-to-svg': resolve(__dirname, 'src/pages/pdf-to-svg.html'),
          'extract-tables': resolve(__dirname, 'src/pages/extract-tables.html'),
          'pdf-to-csv': resolve(__dirname, 'src/pages/pdf-to-csv.html'),
          'pdf-to-excel': resolve(__dirname, 'src/pages/pdf-to-excel.html'),
          'pdf-to-text': resolve(__dirname, 'src/pages/pdf-to-text.html'),
          'digital-sign-pdf': resolve(
            __dirname,
            'src/pages/digital-sign-pdf.html'
          ),
          'timestamp-pdf': resolve(__dirname, 'src/pages/timestamp-pdf.html'),
          'validate-signature-pdf': resolve(
            __dirname,
            'src/pages/validate-signature-pdf.html'
          ),
          'email-to-pdf': resolve(__dirname, 'src/pages/email-to-pdf.html'),
          'font-to-outline': resolve(
            __dirname,
            'src/pages/font-to-outline.html'
          ),
          'deskew-pdf': resolve(__dirname, 'src/pages/deskew-pdf.html'),
          'wasm-settings': resolve(__dirname, 'src/pages/wasm-settings.html'),
          'bates-numbering': resolve(
            __dirname,
            'src/pages/bates-numbering.html'
          ),
          // Desktop launcher (M4), present only once that module lands.
          ...(DESKTOP ? { desktop: resolve(__dirname, 'desktop.html') } : {}),
        }),
        output: {
          assetFileNames: (assetInfo) => {
            const name = assetInfo.names?.[0] ?? '';
            if (name.endsWith('.mjs')) {
              return 'assets/[name]-[hash].js';
            }
            return 'assets/[name]-[hash][extname]';
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/tests/setup.ts',
      coverage: {
        provider: 'v8' as const,
        reporter: ['text', 'json', 'html'],
        exclude: [
          'node_modules/',
          'src/tests/',
          '*.config.ts',
          '**/*.d.ts',
          'dist/',
        ],
      },
    },
  };
});
