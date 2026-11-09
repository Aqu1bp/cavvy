# Cavvy's desktop app

The GUI (`gui/dist`) and the server (`src/`, compiled to one executable) in an Electron window. The Browser pane is a
real Chromium page in the window, which you use directly and the agent drives too.

    bun run desktop:dev        # the GUI from Vite (hot reload), the server from source
    bun run desktop:build      # macOS: out/Cavvy-darwin-<arch>/Cavvy.app (pack.ts)
    bun run desktop:install    # macOS: build it and install it in /Applications (scripts/install-desktop.ts)
    bun run desktop:typecheck

## The app

- `src/main.ts`: the window (its page reloaded if it dies, asking first if that keeps happening), the server (started with `serve --handshake --login-env`, restarted if it stops, but not
  more than five times a minute, and asked to quit with the app), the GUI served from `cavvy://app` with the same
  Content-Security-Policy the Tauri shell had, the menu bar, and where the window was (`window-state.ts`).
- `src/preload.ts`: the page's only way to the app (`window.cavvyDesktop`, `gui/src/lib/platform.ts`). Each call is
  checked to come from the app's own page.
- Packaged, the bundle is laid out as the Tauri app's was: the app at `Contents/MacOS/cavvy-desktop`, the server beside
  it at `Contents/MacOS/cavvy`. The installer, the updater (`scripts/update-desktop.ts`) and the Update button
  (`src/server/app-update.ts`) find both as they did. The installer signs the server under its own identifier, so the
  keychain's trust carries over from build to build.
- Window material: Liquid Glass through `electron-liquid-glass` (Apple's NSGlassEffectView) on macOS 26, else the
  sidebar vibrancy. `CAVVY_ELECTRON_GLASS=0` turns the glass off.

## The browser

- Each tab is a `<webview>` in the UI page (`gui/src/components/BrowserHostLayer.tsx`). The pane lays the current tab
  over its page box; tabs no pane shows stay inside the window, clipped behind the UI, so they keep rendering for the
  agent (Electron stops rendering a page that's outside the window).
- The server's browser pool talks to the app over `/browser-host` (`src/browser/host.ts`), with the server's token,
  instead of starting a headless Chrome. The app (`src/browser-host.ts`) answers the few browser-wide DevTools
  commands the pool uses and passes each tab's commands to its `webContents.debugger`. No DevTools port is opened.
- A click, key or scroll in a tab tells the server the person used it (`Cavvy.humanInput`), as a click in the
  streamed pane does: the agent isn't kept out, and is told the next time it reads the page. The page's size is the webview's (`Cavvy.viewSize`), never emulated.
- A tab nobody sees and nobody has used for 30 seconds sleeps: it isn't drawn, then it's frozen and asked to give
  back memory. A command for it, or a pane showing it, wakes it first.
- A popup the person opens (within 5 seconds of using the page) is a window of its own with `window.opener`, so
  sign-in windows can report back. It goes only to http(s) pages and `about:blank`, and closes with its tab. One the
  agent opens is a tab.
- The web GUI (`cavvy gui`) still streams a headless Chrome; with the app connected, the server's browser is the app's.

## Measuring it

`bench.ts` (memory and CPU while idle, browsing, with the pane open, under three sessions at once, and with busy
pages in unseen tabs), `bench-startup.ts` (launch to a usable composer) and `bench-ux.ts` (a person's clicks and keys
to the frame that shows the result) run the app against the demo, in a data folder of their own. Each takes
`--app <packaged executable>` to measure a build. Results go to `bench-results/` (not kept in the repo); `PERF.md` has
the numbers from the move to Electron.
