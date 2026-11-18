// Whether a desktop-app Browser page has drawn at the size its <webview> was given (BrowserHostLayer). The page draws
// at a new size a moment after it's given it (on this machine's software rendering, seconds), and until then the
// window shows its old picture stretched or cut to the new box: what's waited on before it's shown again, or before
// the pane gives it the space a bar took.

import { electron } from "./platform";
import { hostedTargets } from "../state/browser-host";

/** The longest it's waited for (the app gives up a little sooner: desktop-electron/src/browser-host.ts). */
const PAINT_HOLD_MS = 2500;

/** Resolves once the tab's page has drawn at `size` (its webview's), or after PAINT_HOLD_MS. */
export function painted(key: string, size: { width: number; height: number }): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise((r) => (timer = setTimeout(r, PAINT_HOLD_MS)));
    return Promise.race([electron?.browserPainted?.(key, size) ?? Promise.resolve(), late]).finally(() => clearTimeout(timer));
}

/** Resolves once the page of `targetId` has drawn at the size its webview has now. */
export function pagePainted(targetId: string): Promise<unknown> {
    const key = Object.entries(hostedTargets()).find(([, t]) => t === targetId)?.[0];
    const view = key ? document.querySelector<HTMLElement>(`webview[data-key="${key}"]`) : null;
    const size = view && { width: parseFloat(view.style.width), height: parseFloat(view.style.height) };
    return key && size && size.width > 0 && size.height > 0 ? painted(key, size) : Promise.resolve();
}
