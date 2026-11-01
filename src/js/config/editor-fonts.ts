// Replaced at build time by vite `define`; guarded so unit tests (which
// use vitest.config.ts) still run in web mode.
const IS_DESKTOP = typeof __DESKTOP__ !== 'undefined' && __DESKTOP__;
// Desktop build: fonts are bundled (scripts/desktop-assets.mjs ->
// public/fonts/editor/) and served same-origin; no remote base exists.
const FONT_CDN = IS_DESKTOP
  ? typeof location !== 'undefined' && location.href
    ? new URL('/fonts/editor', location.href).href
    : '/fonts/editor'
  : import.meta.env.VITE_EMBEDPDF_FONTS_URL ||
    'https://cdn.jsdelivr.net/npm/@embedpdf';

// Desktop layout drops the "@1.0.0" suffix: fonts/editor/fonts-jp/fonts/*.otf
const V = IS_DESKTOP ? '' : '@1.0.0';

const CHARSET = {
  ANSI: 0,
  DEFAULT: 1,
  SHIFTJIS: 128,
  HANGEUL: 129,
  GB2312: 134,
  CHINESEBIG5: 136,
  GREEK: 161,
  TURKISH: 162,
  VIETNAMESE: 163,
  HEBREW: 177,
  ARABIC: 178,
  BALTIC: 186,
  RUSSIAN: 204,
  THAI: 222,
  EASTEUROPE: 238,
} as const;

const PACK = {
  jp: `fonts-jp${V}/fonts/NotoSansJP-Regular.otf`,
  kr: `fonts-kr${V}/fonts/NotoSansKR-Regular.otf`,
  sc: `fonts-sc${V}/fonts/NotoSansHans-Regular.otf`,
  tc: `fonts-tc${V}/fonts/NotoSansHant-Regular.otf`,
  arabic: `fonts-arabic${V}/fonts/NotoNaskhArabic-Regular.ttf`,
  hebrew: `fonts-hebrew${V}/fonts/NotoSansHebrew-Regular.ttf`,
  latin: `fonts-latin${V}/fonts/NotoSans-Regular.ttf`,
} as const;

export const editorFontFallback = {
  baseUrl: FONT_CDN,
  fonts: {
    [CHARSET.SHIFTJIS]: PACK.jp,
    [CHARSET.HANGEUL]: PACK.kr,
    [CHARSET.GB2312]: PACK.sc,
    [CHARSET.CHINESEBIG5]: PACK.tc,
    [CHARSET.ARABIC]: PACK.arabic,
    [CHARSET.HEBREW]: PACK.hebrew,
    [CHARSET.GREEK]: PACK.latin,
    [CHARSET.TURKISH]: PACK.latin,
    [CHARSET.VIETNAMESE]: PACK.latin,
    [CHARSET.BALTIC]: PACK.latin,
    [CHARSET.RUSSIAN]: PACK.latin,
    [CHARSET.EASTEUROPE]: PACK.latin,
    [CHARSET.THAI]: PACK.latin,
    [CHARSET.ANSI]: PACK.latin,
    [CHARSET.DEFAULT]: PACK.latin,
  },
  defaultFont: PACK.latin,
};
