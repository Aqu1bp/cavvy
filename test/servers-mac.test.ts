// A Mac as a server, against a pretend one (test/helpers/fake-ssh.ts with `mac`): the real scripts run, and the
// Cavvy "installed" there is this checkout's. What isn't real: launchd (fake-launchctl.sh loads a job and runs its
// program once, and refuses what launchd refuses), sudo, and Xcode's tools. The real ones are tried on a real Mac.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import { fakeSsh } from "./helpers/fake-ssh";

setDefaultTimeout(60_000);

const iso = isolate();
const mac = fakeSsh({ mac: true });
const { setUpServer } = await import("../src/servers/install");
const { probeServer, targetFor, MAC_LABEL } = await import("../src/servers/remote");
const { MAC_BOOT_FIX, pairOverSsh, remoteCheck, remoteStatus, serviceReport, setUpService, stopRemote, xcodeTiming } = await import("../src/servers/service");
const { checkLines } = await import("../src/servers/cli");
import type { BuildSource } from "../src/servers/build";
import type { ServerEntry } from "../src/servers/store";

const entry: ServerEntry = { name: "mini", destination: "me@mini.example", addedAt: new Date().toISOString() };
mac.trust("mini.example");
const serverDir = join(mac.home, ".cavvy", "server");
const agentFile = join(mac.home, "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const daemonFile = join(mac.daemons, `${MAC_LABEL}.plist`);
const uid = process.getuid!();
const M = "0123456789abcdef0123456789abcdef";

const A = "aaaaaaaaaaaa-1";
const B = "bbbbbbbbbbbb-2";
function source(id: string, asked: string[] = []): BuildSource {
    return {
        id,
        gui: false,
        async build(target) {
            asked.push(target);
            return mac.bundle(id);
        },
        compare: (theirs) => (theirs === id ? "same" : "older"),
    };
}

/** What launchd was asked since `from`, without the looks at what's loaded. */
const asked = (from = 0) =>
    mac
        .launchd()
        .slice(from)
        .filter((l) => !l.includes(" print "));
const loaded = (domain: string) => asked().findLast((l) => l.includes(`${domain}/${MAC_LABEL}`) || l.includes(`bootstrap ${domain} `))?.includes(" bootstrap ") === true;

afterAll(async () => {
    await stopRemote(entry).catch(() => undefined);
    mac.cleanup();
    iso.cleanup();
});

describe("a Mac that asks for a password before it lets anyone be an administrator", () => {
    test("gets the build for Apple silicon, kept running by a launchd agent, and is told what would start it at boot", async () => {
        const targets: string[] = [];
        const r = await setUpServer(entry, { source: source(A, targets) });
        expect(targets).toEqual(["darwin-arm64"]);
        expect(r.facts).toMatchObject({ os: "Darwin", arch: "arm64", memMb: 16384, libc: "unknown", systemd: false });
        expect(r.status).toMatchObject({ running: true, build: A });
        // Not a service: nothing would start it after a reboot, and one command would.
        expect(r.service).toEqual({ service: false, bootFix: MAC_BOOT_FIX });
        expect(MAC_BOOT_FIX).toBe("sudo install -o root -g wheel -m 644 ~/.cavvy/server/dev.cavvy.server.plist /Library/LaunchDaemons/");
        // The agent, in the user's own part of launchd: nothing of the system's was touched.
        expect(new Set(asked())).toEqual(new Set([`user bootout user/${uid}/${MAC_LABEL}`, `user bootstrap user/${uid} ${agentFile}`]));
        expect(asked().at(-1)).toBe(`user bootstrap user/${uid} ${agentFile}`);
        expect(existsSync(daemonFile)).toBe(false);
        const agent = readFileSync(agentFile, "utf-8");
        // Without this an agent isn't loaded over SSH at all.
        expect(agent).toContain("<key>LimitLoadToSessionType</key><string>Background</string>");
        expect(agent).not.toContain("UserName");
        for (const part of [
            `<key>Label</key><string>${MAC_LABEL}</string>`,
            "<key>RunAtLoad</key><true/>",
            // Started again when it crashes; left alone when it stops by itself.
            "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
            "<key>ExitTimeOut</key><integer>30</integer>",
            "<key>ProcessType</key><string>Interactive</string>",
            "<key>CAVVY_NO_KEYCHAIN</key><string>1</string>",
            `<key>HOME</key><string>${mac.home}</string>`,
            `<string>${serverDir}</string></array>`,
        ])
            expect(agent).toContain(part);
        // The server's log is the job's output.
        expect(readFileSync(join(serverDir, "server.log"), "utf-8")).toContain("running");
    });

    test("the daemon's file is left beside Cavvy for the command to install, and once it's there the Mac is a service", async () => {
        const beside = join(serverDir, `${MAC_LABEL}.plist`);
        const daemon = readFileSync(beside, "utf-8");
        expect(daemon).toContain("<key>UserName</key><string>");
        expect(daemon).toContain(`<key>HOME</key><string>${mac.home}</string>`);
        expect(daemon).not.toContain("LimitLoadToSessionType");
        expect(serviceReport(await probeServer(entry))).toEqual({ service: false, bootFix: MAC_BOOT_FIX });
        // The user ran the command. What runs now is left as it is.
        writeFileSync(daemonFile, daemon);
        const before = await remoteStatus(entry);
        expect((await probeServer(entry)).launchDaemon).toBe("mine");
        expect(serviceReport(await probeServer(entry))).toEqual({ service: true });
        expect(await setUpService(entry)).toEqual({ service: true });
        expect((await remoteStatus(entry))?.pid).toBe(before!.pid);
    });

    test("an update there goes through the agent: only an administrator may start the daemon", async () => {
        const from = mac.launchd().length;
        const r = await setUpServer(entry, { source: source(B) });
        expect(r.status).toMatchObject({ running: true, build: B });
        expect(r.replaced).toBe(A);
        expect(r.service).toEqual({ service: true });
        expect(asked(from).filter((l) => l.startsWith("root"))).toEqual([]);
        expect(asked(from).at(-1)).toBe(`user bootstrap user/${uid} ${agentFile}`);
    });

    test("stopped on purpose, it's out of launchd, and launchd starting the job (a reboot) doesn't run it", async () => {
        await stopRemote(entry);
        expect(await remoteStatus(entry)).toBeUndefined();
        expect(loaded(`user/${uid}`)).toBe(false);
        expect(existsSync(join(serverDir, "stopped"))).toBe(true);
        // What a boot does with the daemon's file.
        const boot = Bun.spawnSync(["sh", join(import.meta.dir, "helpers", "fake-launchctl.sh"), "bootstrap", "system", daemonFile], { env: { ...process.env, FAKE_DIR: join(mac.home, ".."), FAKE_SUDO: "1", HOME: mac.home } as Record<string, string> });
        expect(boot.exitCode).toBe(0);
        await Bun.sleep(1500);
        expect(await remoteStatus(entry)).toBeUndefined();
        // Connecting again starts it: by the agent, the daemon being the system's.
        const p = await pairOverSsh(entry, { id: M, label: "laptop" });
        expect(p.build).toBe(B);
        expect(loaded(`user/${uid}`)).toBe(true);
    });
});

describe("a Mac where sudo doesn't ask", () => {
    test("gets the daemon installed by itself, and it's the daemon that's started and stopped from then on", async () => {
        mac.allowSudo(true);
        writeFileSync(daemonFile, "<plist><!-- an older Cavvy's, for this user -->" + serverDir + "</plist>\n");
        const from = mac.launchd().length;
        const r = await setUpServer(entry, { source: source(A) });
        expect(r.status).toMatchObject({ running: true, build: A });
        expect(r.service).toEqual({ service: true });
        // What was installed before is replaced by this Cavvy's.
        expect(readFileSync(daemonFile, "utf-8")).toBe(readFileSync(join(serverDir, `${MAC_LABEL}.plist`), "utf-8"));
        // The agent that ran it goes, file and all: one job keeps it running, not two.
        expect(existsSync(agentFile)).toBe(false);
        expect(loaded(`user/${uid}`)).toBe(false);
        expect(asked(from).at(-1)).toBe(`root bootstrap system ${daemonFile}`);
        expect(loaded("system")).toBe(true);

        await stopRemote(entry);
        expect(await remoteStatus(entry)).toBeUndefined();
        expect(asked().at(-1)).toBe(`root bootout system/${MAC_LABEL}`);
        expect((await pairOverSsh(entry, { id: M, label: "laptop" })).build).toBe(A);
        expect(asked().at(-1)).toBe(`root bootstrap system ${daemonFile}`);
    });

    test("another user's daemon under the same name is left alone, and there's nothing to tell this one to run", async () => {
        const theirs = "<plist><string>/Users/other/.cavvy/server</string></plist>\n";
        writeFileSync(daemonFile, theirs);
        expect(await setUpService(entry)).toEqual({ service: false, bootFix: undefined });
        expect(readFileSync(daemonFile, "utf-8")).toBe(theirs);
        expect((await probeServer(entry)).launchDaemon).toBe("other");
        expect(serviceReport(await probeServer(entry))).toEqual({ service: false });
    });
});

describe("Xcode on a Mac", () => {
    const lines = async () => checkLines("mini", await remoteCheck(entry), { service: true }).filter((l) => /Xcode|simulator/.test(l));

    test("ready, missing, not opened yet, and without an iOS simulator: each is said with what to do", async () => {
        expect((await remoteCheck(entry)).xcode).toBe("ready");
        expect(await lines()).toEqual([]);
        mac.xcode("missing");
        expect(await lines()).toEqual(["Xcode isn't installed there: iOS and Mac apps need it."]);
        // Nobody at the Mac: macOS kills it as it starts.
        mac.xcode("unopened");
        expect(await lines()).toEqual(["Xcode there hasn't been opened yet. Open it once at the Mac's screen."]);
        mac.xcode("broken");
        expect((await remoteCheck(entry)).xcode).toBe("unopened");
        mac.xcode("no-simulator");
        expect(await lines()).toEqual(["No iOS simulator there. On it: xcodebuild -downloadPlatform iOS"]);
    });

    test("one that waits on a question at the Mac's screen is given a moment, not the whole check", async () => {
        mac.xcode("hangs");
        const was = xcodeTiming.versionSeconds;
        xcodeTiming.versionSeconds = 1;
        try {
            const started = Date.now();
            expect((await remoteCheck(entry)).xcode).toBe("unopened");
            expect(Date.now() - started).toBeLessThan(15_000);
        } finally {
            xcodeTiming.versionSeconds = was;
            mac.xcode("ready");
        }
    });
});

describe("which Macs", () => {
    test("Apple silicon; an Intel Mac is refused with why", async () => {
        const facts = await probeServer(entry);
        expect(targetFor(facts, entry)).toBe("darwin-arm64");
        expect(() => targetFor({ ...facts, arch: "x86_64" }, entry)).toThrow("Cavvy can't run on mini.example: it needs a Mac with Apple silicon, and this one has an Intel processor.");
    });
});
