// A test copy of the desktop app, to try a change that needs macOS's grants (Mac app control) without touching the
// ones given to the Cavvy you use. It's Cavvy Test (dev.cavvy.desktop.test), and its Mac app helper Cavvy Desktop
// Control (Test) (dev.cavvy.desktop.control.test), so System Settings lists them apart. The copy is always at ~/Applications/Cavvy
// Test.app (your account's, whatever HOME says), and signed with your Apple Development certificate from your login
// keychain, named outright: macOS keeps a grant for that id and certificate, so a rebuild there keeps it. macOS only.
//
//   bun scripts/test-copy.ts build     build it and put it in place, signed ad hoc for now
//   bun scripts/test-copy.ts sign      sign the copy in place (macOS may ask to let codesign use your key)
//   bun scripts/test-copy.ts show      what the copy and its helper are signed as
//   bun scripts/test-copy.ts remove    take the copy out, and out of LaunchServices
//
// CAVVY_SIGNING_IDENTITY picks the certificate by name or SHA-1, as for desktop:install.
//
// Launch it directly with homes of its own:
//   CAVVY_HOME=<test home> CAVVY_ELECTRON_USER_DATA=<test dir> CAVVY_NO_KEYCHAIN=1 ~/Applications/Cavvy\ Test.app/Contents/MacOS/cavvy-desktop
// The helper is the copy's own (in the app), so the homes may be anywhere, /tmp included.

import { existsSync } from "fs";
import { userInfo } from "os";
import { join, resolve } from "path";
import { replaceBundle } from "../src/config/desktop-install";
import { TEST_COPY_APP } from "../desktop-electron/app-info";
import { accountHome, appleIssued, loginKeychain, validIdentities } from "./signing";

if (process.platform !== "darwin") {
    console.error("A test copy of the desktop app is for macOS.");
    process.exit(1);
}

const root = resolve(import.meta.dir, "..");
const { identifier } = TEST_COPY_APP;
const TEST_COPY = join(accountHome(), "Applications", "Cavvy Test.app");
const step = process.argv[2];

/** Its output, or its error and exit if it fails. */
function output(cmd: string[]): string {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
        console.error(r.stderr.toString().trim() || `${cmd[0]} failed`);
        process.exit(r.exitCode ?? 1);
    }
    return r.stdout.toString() + r.stderr.toString();
}

/** Nothing is replaced, signed or removed under a copy that's running. */
function refuseWhileRunning() {
    const r = Bun.spawnSync(["pgrep", "-U", String(userInfo().uid), "-f", "/Cavvy Test.app/Contents/"], { stdout: "pipe" });
    if (r.stdout.toString().trim()) {
        console.error(`${TEST_COPY} is running: quit it first.`);
        process.exit(1);
    }
}

const { TEST_HELPER_IDENTITY } = await import("../src/desktop/helper");
const helper = join(TEST_COPY, "Contents", "Helpers", `${TEST_HELPER_IDENTITY.name}.app`);

switch (step) {
    case "build": {
        refuseWhileRunning();
        for (const dir of [root, join(root, "gui"), join(root, "desktop-electron")]) if (!existsSync(join(dir, "node_modules"))) output(["bun", "install", "--cwd", dir]);
        const { pack } = await import("../desktop-electron/pack.ts");
        const built = await pack({ testCopy: true });
        if (!existsSync(join(built, "Contents", "Helpers", `${TEST_HELPER_IDENTITY.name}.app`))) {
            console.error(`The build has no ${TEST_HELPER_IDENTITY.name}.app (is swiftc there? xcode-select --install).`);
            process.exit(1);
        }
        replaceBundle(built, TEST_COPY, (from, to) => void output(["ditto", from, to]));
        console.log(`Placed ${TEST_COPY}, signed ad hoc. Next: bun scripts/test-copy.ts sign`);
        break;
    }
    case "sign": {
        refuseWhileRunning();
        if (!existsSync(helper)) {
            console.error(`${TEST_COPY} isn't there, or has no ${TEST_HELPER_IDENTITY.name}.app: bun scripts/test-copy.ts build`);
            process.exit(1);
        }
        // The login keychain named outright, whatever HOME is: with HOME elsewhere, codesign wouldn't find the key.
        const keychain = loginKeychain();
        const valid = validIdentities(output(["security", "find-identity", "-v", "-p", "codesigning", keychain]));
        const want = process.env.CAVVY_SIGNING_IDENTITY?.trim();
        const id = want ? valid.find((i) => i.hash === want.toUpperCase() || i.name === want) : valid.find(appleIssued);
        if (!id) {
            console.error(want ? `No valid signing certificate "${want}" in ${keychain}.` : `No Apple Development certificate in ${keychain}: a test copy is signed with one (Xcode → Settings → Accounts makes one).`);
            process.exit(1);
        }
        const sign = (args: string[]) => output(["codesign", "--force", "--sign", id.hash, "--keychain", keychain, "--timestamp=none", ...args]);
        // As desktop:install signs: Electron's parts (--deep), the server under its own identifier, the helper under
        // its bundle id (what macOS keeps its grants by, with the certificate), then the app around them again.
        sign(["--deep", TEST_COPY]);
        sign(["--identifier", `${identifier}.server`, join(TEST_COPY, "Contents", "MacOS", "cavvy")]);
        sign(["--identifier", TEST_HELPER_IDENTITY.bundleId, helper]);
        sign([TEST_COPY]);
        output(["codesign", "--verify", "--deep", "--strict", TEST_COPY]);
        console.log(`Signed ${TEST_COPY} with ${id.name}.`);
        show();
        break;
    }
    case "show":
        show();
        break;
    case "remove": {
        refuseWhileRunning();
        const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
        for (const app of [helper, TEST_COPY]) if (existsSync(app)) Bun.spawnSync([lsregister, "-u", app]);
        Bun.spawnSync(["rm", "-rf", TEST_COPY]);
        console.log(`Removed ${TEST_COPY}. Its entries in System Settings (${TEST_HELPER_IDENTITY.name}) stay until you take them out with −.`);
        break;
    }
    default:
        console.error("bun scripts/test-copy.ts build | sign | show | remove");
        process.exit(1);
}

/** What the copy and its helper are signed as: identifier, authority, designated requirement, cdhash. */
function show() {
    for (const [what, path] of [[`${TEST_HELPER_IDENTITY.name}.app`, helper], ["Cavvy Test.app", TEST_COPY]] as const) {
        if (!existsSync(path)) continue;
        const info = output(["codesign", "-dvvv", path]);
        const field = (k: string) => info.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1] ?? "(none)";
        const requirement = output(["codesign", "-dr", "-", path]).split("\n").find((l) => l.startsWith("designated"))?.trim() ?? "(none)";
        console.log(`${what}\n  Identifier: ${field("Identifier")}\n  Authority:  ${field("Authority")}\n  CDHash:     ${field("CDHash")}\n  ${requirement}`);
    }
}
