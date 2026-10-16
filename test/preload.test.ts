import { expect, test } from "bun:test";
import { homedir } from "os";
import { resolve, sep } from "path";
import { harnessHome } from "../src/config/paths";

// Capture at module load so another file's setup cannot make the preload test pass.
const { HARNESS_HOME, HARNESS_NO_KEYCHAIN } = process.env;
const configuredHome = harnessHome();
const userHome = resolve(homedir());

test("the preload isolates state and disables the keychain before application imports", () => {
    expect(HARNESS_HOME).toBeTruthy();
    expect(configuredHome).toBe(resolve(HARNESS_HOME!));
    expect(configuredHome === userHome || configuredHome.startsWith(userHome + sep)).toBe(false);
    expect(HARNESS_NO_KEYCHAIN).toBe("1");
});
