// The app's names, from desktop-electron/package.json: what pack.ts builds it as, and what the installer and the
// updater look for (scripts/install-desktop.ts, scripts/update-desktop.ts). No dependencies, so they can read it
// before anything is installed.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppInfo {
    productName: string;
    identifier: string;
    version: string;
    category: string;
    minimumSystemVersion: string;
}

/** `dir`: a checkout's desktop-electron folder (the updater reads the one it builds). */
export function appInfo(dir = import.meta.dir): AppInfo {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { productName: string; version: string; cavvy: { identifier: string; category: string; minimumSystemVersion: string } };
    return { productName: pkg.productName, version: pkg.version, ...pkg.cavvy };
}
