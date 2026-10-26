// Run by test/preload.test.ts in a child `bun test` with CAVVY_HOME and
// CAVVY_NO_KEYCHAIN removed from its environment: only the preload can set them.
import { expect, test } from "bun:test";
import { homedir } from "os";
import { resolve, sep } from "path";

test("the preload set an isolated home and turned the keychain off", () => {
    const home = resolve(process.env.CAVVY_HOME ?? "");
    const user = resolve(homedir());
    expect(process.env.CAVVY_HOME).toBeTruthy();
    expect(home === user || home.startsWith(user + sep)).toBe(false);
    expect(process.env.CAVVY_NO_KEYCHAIN).toBe("1");
});
