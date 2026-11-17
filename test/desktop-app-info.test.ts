// The desktop app's names and its minimum macOS, as the installer and the updater read them (desktop-electron/app-info.ts).
import { expect, test } from "bun:test";
import { join } from "path";
import { appInfo, olderThan, TEST_COPY_APP } from "../desktop-electron/app-info";
import { neverOffered } from "../src/desktop/apps";

test("the app's names come from its package.json", () => {
    expect(appInfo(join(import.meta.dir, "..", "desktop-electron"))).toMatchObject({ productName: "Cavvy", identifier: "dev.cavvy.desktop", minimumSystemVersion: "13.0" });
});

test("a test copy is an app of its own to macOS, and still Cavvy to the Mac app tools", () => {
    expect(TEST_COPY_APP).toEqual({ productName: "Cavvy Test", identifier: "dev.cavvy.desktop.test" });
    expect(TEST_COPY_APP.identifier).not.toBe(appInfo(join(import.meta.dir, "..", "desktop-electron")).identifier);
    expect(neverOffered({ name: TEST_COPY_APP.productName, bundleId: TEST_COPY_APP.identifier })).toBe("cavvy");
});

test("a macOS older than the app's minimum is told apart, part by part", () => {
    expect(olderThan("12.7.6", "13.0")).toBe(true);
    expect(olderThan("13", "13.0")).toBe(false);
    expect(olderThan("13.0.1", "13.0")).toBe(false);
    expect(olderThan("26.1", "13.0")).toBe(false);
    expect(olderThan("10.15", "13.0")).toBe(true);
});
