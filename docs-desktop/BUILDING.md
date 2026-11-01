# Building Inkleaf from source

This file covers the desktop (Electron) build: getting the sources running, producing the offline web bundle,
packaging installers, running the tests, and the signing and unsigned-build situation. The project overview is in
the top-level `README.md`; the feature list is in `docs-desktop/FEATURES.md`.

Version in `package.json`: **2.8.11**. Product name: **Inkleaf**. App id: `dev.inkleaf.desktop`
(a placeholder, see `electron-builder.yml`).

## Requirements

- **Node.js 22** (the CI workflow pins 22). Node 24 also works locally; the `electron/README.md` notes that
  Node 24 needs the test glob quoted.
- npm (ships with Node).
- Windows installer: a Windows host (CI uses `windows-latest`).
- macOS dmg: a macOS host (CI uses `macos-latest`). The mac targets use `build/entitlements.mac.plist` with
  hardened runtime.
- Enough disk space for `node_modules`, the Electron binary, the asset cache and the output folders.
  The packaged installer alone is about 210 MB.

## Step by step

All commands run from the `app/` folder.

```sh
npm ci                      # install exact versions from package-lock.json
npm run desktop:assets      # fetch and verify the offline wasm / OCR / font assets (see below)
npm run build:desktop       # assets + third-party notices + tsc + Vite desktop build -> dist/
npm run desktop:start       # run the packaged-style app: electron . (loads app://bentopdf/)
```

### What each step does

| Command                     | What it does                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                    | Clean install from the lockfile. The `prepare` script installs the husky git hooks. Three dependencies are local tarballs under `vendor/` (`bentopdf-pdfium`, `bentopdf-viewer`, `hyper-compress-wasm`), and `xlsx` is installed from the SheetJS CDN.                                                                                                        |
| `npm run desktop:assets`    | Runs `scripts/desktop-assets.mjs`. It populates `public/wasm/`, `public/tesseract/` and `public/fonts/` so the desktop build works offline at runtime. Build-time network access is used only here. Each downloaded or supplied artifact is checked against a pinned SHA-256 in `scripts/desktop-assets.lock.json` and cached in `.cache-assets/`.            |
| `npm run build:desktop`     | Chains `desktop:assets`, then `scripts/gen-notices.mjs` (writes `public/third-party-notices.html` from `package-lock.json` and installed package metadata, no network), then `tsc`, then `cross-env DESKTOP=true vite build`. `DESKTOP=true` switches `vite.config.ts` to the desktop input set and prunes web-only pages and public assets. Output: `dist/`. |
| `npm run desktop:start`     | `electron .`: starts the real shell (`electron/main.js`) against `dist/`.                                                                                                                                                                                                                                                                                     |
| `npm run desktop:dev`       | `electron . --dev`: loads `http://localhost:5173/desktop.html`. You must run `npm run dev` (Vite) in another terminal first. Dev switches are ignored in packaged builds.                                                                                                                                                                                     |
| `npm run desktop:build:web` | Alias of `npm run build:desktop`.                                                                                                                                                                                                                                                                                                                             |
| `npm run dist:dir`          | `electron-builder --dir`: unpacked app folder in `release/win-unpacked` (or the mac equivalent). Good for smoke tests without making an installer.                                                                                                                                                                                                            |
| `npm run dist:win`          | `npm run build:desktop`, then `electron-builder --win`. Produces the NSIS installer and the portable exe.                                                                                                                                                                                                                                                     |
| `npm run dist:mac`          | `electron-builder --mac` only. **It does not rebuild `dist/`**, so run `npm run build:desktop` first on macOS. Produces arm64 and x64 dmg files.                                                                                                                                                                                                              |
| `npm run size:check`        | `scripts/check-installer-size.mjs`. Fails when any `.exe`, `.dmg`, `.zip`, `.AppImage` or `.msi` in `release/` is larger than `INSTALLER_BUDGET_MB` (default 220). `RELEASE_DIR` overrides the folder.                                                                                                                                                        |

The web-only build (`npm run build`, `build:production`, and friends) is a different pipeline for the hosted site.
Do not use it for the desktop app.

## Packaging with electron-builder

Configuration lives in `electron-builder.yml`. The main points:

- **Files.** The app ships `package.json`, `electron/**` and `dist/**`. Tests, `electron/README.md` and source maps
  are excluded. `asar: true`. `main/preload/protocol` only use Node and Electron built-ins, so `node_modules` is not
  shipped. `asarUnpack` is empty; `dist/` is served straight from `app.asar`.
- **Locales.** `electronLanguages` keeps `en-US` plus 23 other Chromium locales
  and drops the rest, which keeps the installer smaller.
- **Windows.** Targets `nsis` (x64) and `portable` (x64). The NSIS installer is per-user by default
  (`perMachine: false`), lets the user change the install folder, and creates desktop and Start menu shortcuts.
  Artifact names: `Inkleaf-Setup-${version}-${arch}.exe` and `Inkleaf-Portable-${version}-${arch}.exe`.
  `signAndEditExecutable: true`.
- **macOS.** Target `dmg` for arm64 and x64, category `public.app-category.productivity`, `hardenedRuntime: true`,
  `gatekeeperAssess: false`. Artifact name: `Inkleaf-${version}-${arch}.dmg`.
- **File association.** `.pdf` (role Editor), so Inkleaf can be set as the PDF opener.
- **Updates and publishing.** `publish: null`. There is no auto-update and no upload from electron-builder. Release
  files stay in `release/` until someone uploads them.
- **Legal.** `LICENSE` is copied into the app as `LICENSE.txt`.

Expected output in `release/` after `npm run dist:win`:

- `Inkleaf-Setup-2.8.11-x64.exe` and its `.blockmap`
- `Inkleaf-Portable-2.8.11-x64.exe` (configured target; not present in the current local `release/`)
- `builder-debug.yml`

The last measured NSIS installer is about **210.2 MB** (`docs-desktop/stats.json`), inside the 220 MB budget.
The budget was raised from the original 150 MB plan because the Electron runtime plus bundled wasm, OCR and fonts
measure above 150 MB.

## Tests and checks

```sh
npx vitest run                                  # unit tests (Vitest)
node --test "electron/__tests__/*.test.js"      # Electron shell tests (plain node:test, no Electron needed)
npx eslint electron                             # lint the desktop shell
npx electron e2e/suites/tools.cjs               # Electron end-to-end suites (need a built dist/)
```

End-to-end suites live in `e2e/suites/` (`explore`, `large`, `open`, `tools`, `visual`). Each one boots the real
`electron/main.js` against `dist/` with a throwaway userData folder, and uses `INKLEAF_TEST=1` to replace native
dialogs with fixture paths. `e2e/aggregate.cjs` merges the per-suite results into `e2e/results.json`. The most
recent recorded run is in that file: 137 checks, 131 pass, 2 fail, 4 known limits. The `large` suite uses files of
several hundred MB and is heavy; run it on purpose.

## CI workflow (`.github/workflows/desktop.yml`)

Triggers: manual dispatch, pushes of tags `v*`, and pull requests that touch `electron/**`, `src/desktop/**`,
`electron-builder.yml` or the workflow itself.

| Job             | Runs on        | When                               | Steps                                                                                                                                                                                             |
| --------------- | -------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`          | ubuntu-latest  | every trigger                      | `npm ci`, `npx eslint electron`, `npx vitest run`, `node --test "electron/__tests__/*.test.js"`                                                                                                   |
| `build-windows` | windows-latest | not on pull requests; needs `test` | cache `.cache-assets` (keyed on the lock file hash), `npm run build:desktop`, `electron-builder --win`, `npm run size:check`, writes `SHA256SUMS-windows.txt`, uploads artifact `inkleaf-windows` |
| `build-macos`   | macos-latest   | not on pull requests; needs `test` | same cache and build, `electron-builder --mac`, writes `SHA256SUMS-macos.txt`, uploads artifact `inkleaf-macos`                                                                                   |
| `release`       | ubuntu-latest  | tag pushes only                    | merges both checksum files into `SHA256SUMS.txt` and creates a **draft** GitHub release with `gh release create --draft`. Nothing is published automatically.                                     |

The workflow writes a job-summary line saying whether each platform build was signed, notarized, or unsigned.

## Signing

Signing is optional. Without secrets the build is still produced, but it is unsigned.

| Platform          | Secret or variable            | Used for                                                                                 |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| Windows and macOS | `CSC_LINK`                    | Path, URL or base64 of the code-signing certificate (`.p12`). electron-builder reads it. |
| Windows and macOS | `CSC_KEY_PASSWORD`            | Password for that certificate.                                                           |
| macOS             | `APPLE_ID`                    | Apple ID used by notarization.                                                           |
| macOS             | `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization.                                                  |
| macOS             | `APPLE_TEAM_ID`               | Team id for notarization.                                                                |

Behaviour in CI:

- **Windows.** No `CSC_LINK`: the job sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and builds an unsigned installer.
- **macOS.** No `CSC_LINK`: unsigned, un-notarized dmgs (`-c.mac.identity=null`). `CSC_LINK` but no Apple secrets:
  signed, not notarized. All three Apple secrets plus `CSC_LINK`: signed and notarized (`-c.mac.notarize=true`).
  `electron-builder.yml` itself keeps `notarize: false`.

Store these as GitHub Actions secrets. Never commit certificates or passwords to the repository.

## Unsigned builds: what users will see

Builds without a code-signing certificate are not trusted by the operating system. That is expected for a
community project without paid certificates. The app itself is the same.

**Windows (SmartScreen).** Running the installer shows "Windows protected your PC" (or "Unknown publisher").
Click **More info**, then **Run anyway**.

**macOS (Gatekeeper).** An unsigned or un-notarized app is blocked the first time it opens.

- Recent macOS: try to open the app once, then go to **System Settings, Privacy and Security**, scroll to the
  message about Inkleaf, and click **Open Anyway**.
- Older macOS: right-click (or Control-click) the app in Applications and choose **Open**, then confirm.
- Advanced: remove the quarantine flag from the downloaded app with
  `xattr -dr com.apple.quarantine /Applications/Inkleaf.app`. Only do this for a build you have verified.

**Verify the download.** Every CI build publishes checksums. Compare the file's SHA-256 with `SHA256SUMS.txt` in the
release (PowerShell: `Get-FileHash <file> -Algorithm SHA256`; macOS and Linux: `shasum -a 256 <file>`).

## Notes for maintainers

- The placeholder repository URL `https://github.com/st1ne/Inkleaf` appears in `electron/app-info.js`,
  `src/desktop/app-info.ts`, the LibreOffice add-on manifest (`electron/addons/manifest.js`) and the README. Replace
  all of them together when the real repository exists.
- The `appId` in `electron-builder.yml` is also a placeholder (`dev.inkleaf.desktop`). Change it before the first
  public release, because changing it later breaks upgrades and file associations.
- The LibreOffice office-converter add-on is downloaded once, after the user confirms, from the release URL in the
  manifest. That URL is a placeholder until the add-on is published.
