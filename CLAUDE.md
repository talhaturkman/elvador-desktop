# Elvador Desktop - Development Rules

## Auto-Update Discipline

This app uses `electron-updater` with GitHub Releases for automatic updates. Every code change that will be deployed MUST include a version bump in `package.json`.

- Bump `version` in `package.json` before every release build (semver: patch for fixes, minor for features, major for breaking changes).
- After version bump, build with `npx electron-builder --win nsis`.
- Tag the commit with the version: `git tag vX.Y.Z`.
- Push with tags: `git push && git push --tags`.
- Upload the `.exe` and `latest.yml` from `release/` to GitHub Releases under the matching tag.
- Never ship a build without incrementing the version — the updater uses version comparison to detect new releases.

## Build & Release

- Build command: `npx electron-builder --win nsis`
- Output goes to `release/` folder
- Kill running `Elvador.exe` processes before building (file locks block the build)
- Clean `release/` and `dist/` folders if build produces stale artifacts

## Architecture

- Main process: `src/main.js` (window, tray, IPC, auto-updater)
- Notifications: `src/nativeNotifications.js` (overlay windows)
- Pending poller: `src/desktopPendingPoller.js` (polls backend API)
- Preload (panel): `src/preload.js` (DOM observer, session sync, bridge)
- Preload (overlay): `src/overlayPreload.js` (notification click IPC)
- Config: `src/config.js`

## Key Behaviors

- Notification click navigates via `history.pushState` (no page reload) when already on same origin.
- Panel visual notification fallback: MutationObserver watches `.admin-visual-alert-ribbon` in DOM.
- Desktop pending poller polls `/api/admin/desktop-notifications/pending` every 15s.
- Auto-updater checks GitHub Releases on startup and every 1 hour, downloads silently, installs on next app quit.

## Working Rules

- Do not run `npm run dev` or start the app unless user asks.
- Run `node --check` on edited JS files.
- Keep all user-facing strings in proper Turkish (ş, ı, ö, ü, ç, İ, Ğ).
- Notification overlay must stay compact: logo + title + counter + age only.
