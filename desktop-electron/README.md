# Harness on Electron (spike)

The desktop app on Electron instead of Tauri, to compare side by side. Same UI (`gui/dist`), same server (run from this
repo with `bun`, as `tauri dev` does). The difference: the Browser pane is a real Chromium page in the window, which
you use directly and the agent drives too.

    cd gui && bun run build && cd ../desktop-electron && bun install && bun run start

## How the browser works

- Each tab is a `<webview>` in the UI page (`gui/src/components/BrowserHostLayer.tsx`). The pane lays the current tab
  over its page box; tabs no pane shows stay inside the window, clipped behind the UI, so they keep rendering for
  the agent (Electron stops rendering a page that's outside the window).
- The server's browser pool talks to the app over `/browser-host` (`src/browser/host.ts`), with the server's token,
  instead of starting a headless Chrome. The app (`src/browser-host.ts`) answers the few browser-wide DevTools
  commands the pool uses and passes each tab's commands to its `webContents.debugger`. No DevTools port is opened.
- A click, key or scroll in a tab tells the server the person took it (`Harness.humanInput`), as a click in the
  streamed pane does. The page's size is the webview's (`Harness.viewSize`), never emulated.
- Window material: Liquid Glass through `electron-liquid-glass` (Apple's NSGlassEffectView) on macOS 26, else the
  sidebar vibrancy. `HARNESS_ELECTRON_GLASS=0` turns the glass off.

## Not done (spike)

- Development only: no packaging, signing, updates or a bundled server.
- A page's popup opens as a new tab without `window.opener`, so sign-in popups that report back to their opener
  won't complete.
- The web GUI (`harness gui`) still streams pictures; with the app connected, its browser is the app's.
- Window dragging uses CSS drag regions, so a strip element with only a script click handler drags instead.
