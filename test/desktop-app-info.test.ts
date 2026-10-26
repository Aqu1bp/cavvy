// The desktop app's names and its minimum macOS, as the installer and the updater read them (desktop-electron/app-info.ts).
import { expect, test } from "bun:test";
import { join } from "path";
import { appInfo, olderThan } from "../desktop-electron/app-info";

test("the app's names come from its package.json", () => {
    expect(appInfo(join(import.meta.dir, "..", "desktop-electron"))).toMatchObject({ productName: "Cavvy", identifier: "dev.cavvy.desktop", minimumSystemVersion: "13.0" });
});

test("a macOS older than the app's minimum is told apart, part by part", () => {
    expect(olderThan("12.7.6", "13.0")).toBe(true);
    expect(olderThan("13", "13.0")).toBe(false);
    expect(olderThan("13.0.1", "13.0")).toBe(false);
    expect(olderThan("26.1", "13.0")).toBe(false);
    expect(olderThan("10.15", "13.0")).toBe(true);
});
