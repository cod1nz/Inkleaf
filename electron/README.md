# Inkleaf desktop shell (Electron)

Plain CommonJS, no build step. `package.json` here pins `commonjs` because the root package is ESM.

- `main.js` window, hardening (deny popups/permissions/webviews, navigation locked to `app://bentopdf`), single instance, open-with.
- `protocol.js` serves `dist/` over the privileged `app://bentopdf/` scheme with COOP/COEP/CSP headers, site-style routing
  (`/x` -> `x.html`, locale prefix fallback), plus read-only `/addons/<name>/...` from `userData/addons`.
- `ipc.js` + `preload.js` expose only `window.desk`. Main keeps id -> path grants; the renderer never sees paths.
  Writes only go to ids from `saveAs`, atomically (temp file + rename). Every handler checks the sender frame.
- `menu.js` native menu; items send ids on the `menu` channel. `lib/` holds pure helpers, tested without Electron.

## Run

    npm run desktop:build:web   # vite build -> dist/
    npm run desktop:start       # electron . (loads app://bentopdf/)
    npm run desktop:dev         # electron . --dev (Vite dev server on http://localhost:5173)

Unit tests: `node --test "electron/__tests__/*.test.js"` (Node 24 needs the glob)

## Recent files API

`desk.recent.list()` -> `[{ id, name, size, lastOpened }]` (`lastOpened` = ms since epoch, 0 for legacy entries; ids are input grants usable with `readFile`).
`desk.recent.add(id)`, `desk.recent.remove(id)` (removes one entry; id must be a granted input id, else `[not_granted]`/`[bad_args]`), `desk.recent.clear()`.
The list is persisted as `{ path, name, lastOpened }` in `userData/recent.json` (10 entries max).

## Test hook

Only when unpackaged and `INKLEAF_TEST=1`: `INKLEAF_TEST_SAVE_DIR` makes `saveAs` skip the dialog and save into that dir;
`INKLEAF_TEST_OPEN` (paths separated by `|`) makes `openFiles` skip the dialog. Inert in packaged builds.

## App identity

`app-info.js` (mirrored by `src/desktop/app-info.ts`) holds `APP_NAME`, `SOURCE_URL`, `UPSTREAM_URL`.
`REPLACE_ME` in `SOURCE_URL` must be replaced with the real repository path when the repo is public (update both files).
