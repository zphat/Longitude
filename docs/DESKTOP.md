# Longitude for Windows (the desktop app)

The desktop app is the same `web/` folder the browser version serves, inside a
[Tauri 2](https://v2.tauri.app/) window that uses Microsoft Edge WebView2, the
web engine Windows 10 and 11 already have. The installer is built by GitHub
Actions only (`.github/workflows/build.yml`). Working on the app itself still
needs nothing but Python and a browser.

```
src-tauri/
  tauri.conf.json        window, security headers and CSP, installer settings
  Cargo.toml, Cargo.lock the Rust side (CI commits the resolved Cargo.lock back)
  build.rs               makes sure src-tauri/vendor/ exists, warns about web/vendor/
  src/lib.rs             the native layer (below); src/main.rs only calls it
  capabilities/          what the page may call (core APIs, the window title)
  icons/                 app and file icons; installer/  installer art and license
  make_art.py            draws icons/, installer/ and web/icons/ (Pillow, numpy)
  stage_vendor.py        moves the checked background remover into src-tauri/vendor/
  vendor/                (git-ignored) what the installer bundles
package.json             only the Tauri CLI, for CI: npm run tauri build
web/js/app/desktop.js    the page side; does nothing in a normal browser
```

## What changes in the app

`web/js/app/desktop.js` runs only when `window.__TAURI__` exists
(`withGlobalTauri`). It:

- sets `<html data-desktop="tauri">` for styles and `ctx.desktop`, which the
  views ask to word things for an app: the export button says Save, storage
  is "in Longitude" or "on this computer" rather than "in this browser", and
  Settings leaves out "Ask the browser to keep data";
- skips the service worker: every file is inside the program, there is no
  offline cache to keep (main.js);
- saves exports and project files through the Windows Save dialog
  (`showSaveFilePicker`; designs start in Documents, images in Pictures, each
  remembers its last folder). If the dialog cannot open, for example after a
  long export used up the click, the file downloads to Downloads as in a
  browser (`download()` in `features/compress.js`). `download()` resolves
  false when the dialog is canceled, and the export sheet, Save a copy and
  quick tools wait for it: a canceled dialog leaves the sheet open, with no
  "Saved" message;
- opens files handed to the program: a double-clicked `.longitude`, "Open
  with Longitude" on an image or a font, or files passed to a second launch.
  The second launch only hands them over and exits; the running window comes
  to the front (single-instance plugin). Designs open like File, Open; images
  go onto the canvas; fonts are added to the font picker;
- opens links to other sites in the default browser;
- turns off the browser's own context menu outside text fields, and the
  browser shortcuts that make no sense in an app: print, find, view source,
  downloads, caret browsing, back and forward. Reload stays: autosave makes it
  safe;
- keeps the window title in step with the design name;
- on close, asks the page to finish its last autosave first (up to 4 s, a
  second click closes at once). WebView2 sends no `pagehide` when a window is
  destroyed, so without this the last second of work could be lost;
- checks for updates once a day (below).

Window size, position and maximized state are remembered (window-state
plugin). The smallest window is 760 x 520: Windows keeps a window at its
minimum size even when it is maximized, so a larger minimum would run under
the taskbar on a 1366 x 768 screen at 125% scaling. The page has layouts for
those sizes. The window starts on the Signal workspace color with a dark title
bar, so it never flashes white. `dragDropEnabled` is `false` in
`tauri.conf.json`: otherwise Tauri takes file drops for itself and the page's
drag and drop stops working on Windows.

## Background removal is included

The installer carries onnxruntime-web (both builds, WebGPU and WebAssembly)
and the Fast model (IS-Net int8), about 82 MB, so removing a background works
right after install with no network. Best (BiRefNet lite) stays an optional
download inside the app, cached in the WebView2 profile like in a browser.

How it gets there:

1. CI runs `python tools/fetch_model.py --models fast`, which downloads the
   files listed in the config block of `web/js/features/bgremove/config.js`
   and checks each one's size and SHA-256, then `--check` verifies them again.
2. `python src-tauri/stage_vendor.py --move` checks the files against the
   same config block, copies exactly the runtime and the Fast model into
   `src-tauri/vendor/` with a manifest of those files, and deletes
   `web/vendor/`.
3. `bundle.resources` in `tauri.conf.json` installs `src-tauri/vendor/` as
   `<install folder>\vendor\`.
4. `src/lib.rs` serves that folder on its own origin, the `vendor` protocol:
   `http://vendor.localhost/<path>` on Windows (`vendor://localhost/` on
   macOS and Linux). `vendorUrl()` in `config.js` points there when the page
   runs on `tauri.localhost`, in the page and in the background-removal
   worker. Everything else in the app is unchanged: it reads
   `manifest.json`, sees the model listed, and shows "Included with the app".

A build without the files (a local build that skipped step 1) still works:
`build.rs` writes an empty manifest, and that copy downloads the model on
first use like the browser version.

### Why resources and a protocol, not frontend assets

The simpler option was to leave the files in `web/vendor/` and let Tauri embed
them with the rest of `web/`. Tauri compiles every file of `frontendDist` into
the executable at build time (`generate_context!`, brotli-compressed), and
serves each request by decompressing the whole file from the program's
memory. For a 44 MB model and 38 MB of runtime that means a slow,
memory-hungry compile on every CI build, a program of about 100 MB, and a full
decompression each time the model loads. ONNX weights barely compress, so nothing is gained in return.

Resources stay ordinary files in the install folder. The protocol handler
reads one when it is asked for, on its own thread (asynchronous protocol), so
a 44 MB read never blocks the window, and the program stays small. The handler
only answers plain relative paths of letters, digits, `.`, `-` and `_` under
`vendor\` (no `..`, no hidden files, no drive letters), only GET, HEAD and
OPTIONS, and adds `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin` to every response, which a
cross-origin isolated page (below) needs before it may import a module or
fetch a file from another origin. When onnxruntime-web runs with threads, it
loads its thread script from that origin as a `blob:` copy, which the CSP
allows.

`build.rs` warns if `web/vendor/` exists at build time, because it would be
compiled into the program as a second copy.

## Security headers

`app.security.headers` (Tauri 2.1 and later) adds to every app file:

- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`, so the page is cross-origin
  isolated and onnxruntime-web can use several threads (`SharedArrayBuffer`).
  Everything the app loads is its own, a `blob:` or `data:` URL, the vendor
  protocol (CORS and CORP headers), or a CORS fetch (Hugging Face, jsDelivr,
  GitHub's API), all of which pass `require-corp`. If WebView2 ever did not
  isolate the page, `threadCount()` in `bgremove/engine.js` falls back to one
  thread; nothing breaks.

`app.security.csp` allows only the app itself, `data:` and `blob:` for
images, fonts and media, `'wasm-unsafe-eval'` for WebAssembly, the vendor
protocol, Tauri's IPC, and for `connect-src` the hosts the app talks to:
Hugging Face (`huggingface.co` and its download hosts `*.huggingface.co`,
`*.hf.co`) for Best, jsDelivr for a runtime build that is not bundled, and
`api.github.com` for the update check. No frames, no plugins, no remote
images. `style-src` keeps `'unsafe-inline'` (style attributes, mod styles),
so Tauri is told not to add style nonces there
(`dangerousDisableAssetCspModification: ["style-src"]`); scripts get Tauri's
hashes and no `'unsafe-inline'` or `'unsafe-eval'`.
`tests/desktop-shell.test.js` fails if code fetches a host the CSP does not
list.

The page can call five commands of its own (`src/lib.rs`): take and read the
files handed to the program (only those, by number, never a path from the
page), open an `http(s)` link in the default browser (nothing else, so a page
can never start a program), and the two halves of the close handshake.

## Where data lives

| What | Where |
| --- | --- |
| The program | `%LOCALAPPDATA%\Longitude\` (the installer offers to change it) |
| Background remover (bundled) | `%LOCALAPPDATA%\Longitude\vendor\` |
| Designs, images, fonts you added, settings, the Best model | `%LOCALAPPDATA%\app.longitude.desktop\EBWebView\` (the WebView2 profile: IndexedDB, local storage, Cache Storage) |
| Window size and position | `%APPDATA%\app.longitude.desktop\` |

The installer is per user: no admin rights, nothing in Program Files. It adds
a Start menu entry, offers a desktop shortcut on its last page, and registers
`.longitude` files ("Longitude design", with the app icon). The uninstaller
removes the program; its "Delete the application data" box (off by default)
also removes both `app.longitude.desktop` folders, which deletes every design
not saved as a `.longitude` file.

Two settings must never change after the first release, or installed copies
lose sight of their designs (the data stays on disk, the app looks elsewhere):
the `identifier` (`app.longitude.desktop`, the profile folder's name) and the
page's origin (`http://tauri.localhost`; leave `useHttpsScheme` unset).

The browser version and the desktop app keep separate designs. Move one across
with Save a copy (a `.longitude` file) and open it in the other.

## Update check

There is no self-installing updater yet (that needs a signing key and its
infrastructure). Instead, at most once a day, a few seconds after start, the
app asks `https://api.github.com/repos/zphat/Longitude/releases/latest` for the
newest release. The request carries no cookies and nothing about you or your
designs; GitHub sees an IP address and a browser user agent, as with any page.
If the release's tag (`v0.2.0`) is newer than the running version, a toast
offers Download, which opens the release page in the default browser, and
Skip this version. Drafts and pre-releases never count. The comparison is
semver-like: `0.10.0` is newer than `0.9.0`, `1.0.0-beta.2` older than
`1.0.0`.

- On by default. Settings > General > Updates has the switch and Check now
  (the group shows only when `app.check-updates` is registered). Command
  palette: "Automatic update checks on or off", and "Check for updates" to
  look now. Both commands live in `desktop.js` and exist only in the desktop
  app.
- Prefs: `updateCheck` (`false` turns it off), `updateCheckedAt` (time of the
  last successful check), `updateSkipped` (a version the toast stays quiet
  about). Turning the switch back on checks at once if a day has passed
  (`desktop.js` listens for the pref).
- A failed check (offline) is silent and tried again within the hour.

## Building

Only GitHub Actions builds the installer; there is no Rust or Node on the
development machines. `.github/workflows/build.yml`:

1. **check** (Ubuntu): `deno run --allow-read tools/check.mjs`,
   `deno test --allow-read tests/`, the Python scripts compile, and on a tag,
   that the tag is `v` plus the version in `tauri.conf.json`.
2. **windows**: Rust stable, Node 20, `npm install` (the Tauri CLI), Python;
   fetch, check and stage the background remover (the download is cached
   under the hash of `config.js`); `npm run tauri build` with compiler errors
   turned into annotations; a look inside the installer with 7-Zip for the
   model and the runtime; the installer as the run's artifact
   `Longitude-windows-installer`; on `main`, the resolved `Cargo.lock`
   committed back with `[skip ci]` (the only commit the workflow makes).
3. On a tag `vX.Y.Z`: tauri-action publishes a regular release (not a draft,
   not a pre-release, since `/releases/latest` skips those) named
   "Longitude vX.Y.Z", whose text is the tag's message plus install notes, and
   the installer is attached a second time as `Longitude-Setup.exe`, so
   `https://github.com/zphat/Longitude/releases/latest/download/Longitude-Setup.exe`
   always serves the newest build.

Third-party actions are pinned to commit SHAs, and `permissions: contents:
write` is set at the top of the workflow (a job-level grant alone was not
enough for Sundial's releases).

A local build is possible on a machine with Node, Rust and the MSVC build
tools:

```bash
npm install
python tools/fetch_model.py --models fast
python src-tauri/stage_vendor.py --move
npm run tauri build
```

The installer lands in `src-tauri/target/release/bundle/nsis/`.

## Releasing

1. Bump the version in all four places (`tests/desktop-shell.test.js` fails
   if they differ): `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `package.json`, and `VERSION` in `web/js/app/context.js`. Bump `VERSION` in
   `web/sw.js` too, so browser installs pick up the new files.
2. Commit and push to `main`; wait for a green build (it also commits
   `Cargo.lock`, so pull afterwards).
3. Tag with a message, which becomes the release text:

   ```bash
   git tag -a v0.2.0 -m "What changed, in a few lines"
   git push origin v0.2.0
   ```

The release appears when the windows job finishes. Installed copies see it
within a day.

The installer is not code-signed. Windows SmartScreen warns about unknown
programs: "More info", then "Run anyway". The release text says so.

## Icons and installer art

`python src-tauri/make_art.py` redraws `icons/` (icon.ico with 16 to 256 px
frames, and the PNGs Tauri wants), `installer/header.bmp` (150 x 57) and
`installer/sidebar.bmp` (164 x 314), the sizes NSIS's Modern UI expects, and
the web app's icons in `web/icons/`, all from the Longitude logo: the black
sphere with five lime lines of longitude. Sizes from 40 px up come from
`brand/longitude-logo-1024.png`; 32 px and below come from
`brand/longitude-logo-small.svg`, with the 16, 20 and 24 px frames fitted to
the pixel grid so each stripe is one sharp pixel wide. The browser tab icon,
`web/icons/favicon.svg`, is a copy of that small SVG. The wordmark uses Syne
from `tools/fonts/cache`. The outputs are committed. `installer/license.txt` is `LICENSE` with Windows line endings for
the installer's license page (the test suite keeps the two equal).
