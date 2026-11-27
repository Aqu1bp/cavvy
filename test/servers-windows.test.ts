// Windows remote servers: PowerShell transport encoding, Windows probe fallback,
// target selection, build naming, store persistence, and service reporting.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { psQuote, remotePs } = await import("../src/servers/ssh");
const { isWindowsServer, parseFacts, probeServer, targetFor } = await import("../src/servers/remote");
const { binaryName, targetName } = await import("../src/servers/build");
const { applyBuild, pairOverSsh, remoteCheck, remoteStatus, serviceReport, setUpService, stopRemote } = await import("../src/servers/service");
const { sendBuild } = await import("../src/servers/install");
const { sendCopy } = await import("../src/servers/copy");
const { draftServer, getServer, saveServer } = await import("../src/servers/store");
const { parseServerSpec } = await import("../src/servers/cli");
import type { ServerEntry } from "../src/servers/store";

const scratch = tempDir("cavvy-win-servers-");
const savedSsh = process.env.CAVVY_SSH;

afterAll(() => {
    if (savedSsh === undefined) delete process.env.CAVVY_SSH;
    else process.env.CAVVY_SSH = savedSsh;
    rmSync(scratch, { recursive: true, force: true });
    iso.cleanup();
});

const winEntry: ServerEntry = { name: "winbox", destination: "dev@winbox.example", platform: "windows", addedAt: "2026-01-01T00:00:00.000Z" };

describe("PowerShell SSH transport", () => {
    test("psQuote doubles single quotes safely", () => {
        expect(psQuote("hello")).toBe("'hello'");
        expect(psQuote("it's $HOME")).toBe("'it''s $HOME'");
    });

    test("remotePs emits shell-neutral -EncodedCommand with UTF-8 preamble and bound arguments", () => {
        const cmd = remotePs(`Write-Output $cavvyArgs[0]`, ["a'b", "C:\\Program Files\\Cavvy"]);
        expect(cmd).toMatch(/^powershell\.exe -NoLogo -NoProfile -NonInteractive -InputFormat Text -OutputFormat Text -EncodedCommand [A-Za-z0-9+/=]+$/);
        const b64 = cmd.split(" ").at(-1)!;
        const decoded = Buffer.from(b64, "base64").toString("utf16le");
        expect(decoded).toContain("UTF8Encoding");
        expect(decoded).toContain(`$cavvyArgs = @('a''b', 'C:\\Program Files\\Cavvy')`);
        expect(decoded).toContain("Write-Output $cavvyArgs[0]");
    });

    test("remotePs automatically gzip-compresses long scripts so cmd.exe's 8191-char limit is never exceeded", () => {
        const longScript = Array.from({ length: 120 }, (_, i) => `Write-Output "line ${i}: the quick brown fox jumps over the lazy dog"`).join("\n");
        const cmd = remotePs(longScript, ["arg1"]);
        expect(cmd.length).toBeLessThan(8000);
        const decoded = Buffer.from(cmd.split(" ").at(-1)!, "base64").toString("utf16le");
        expect(decoded).toContain("GZipStream");
    });
});

describe("Windows server facts, target, store, and build helpers", () => {
    test("parses Windows probe output including wintask and builds", () => {
        const facts = parseFacts(
            [
                "os=Windows",
                "arch=AMD64",
                "home=C:\\Users\\me",
                "user=me",
                "shell=powershell",
                "mem=16384",
                "disk=45000",
                "wintask=1",
                "build=0123456789ab",
                "gui=0123456789ab",
                "current=0123456789ab",
            ].join("\r\n"),
        );
        expect(facts.os).toBe("Windows");
        expect(facts.arch).toBe("AMD64");
        expect(facts.home).toBe("C:\\Users\\me");
        expect(facts.windowsTask).toBe(true);
        expect(facts.builds).toEqual(["0123456789ab"]);
        expect(facts.guiBuilds).toEqual(["0123456789ab"]);
        expect(facts.current).toBe("0123456789ab");
        expect(targetFor(facts, winEntry)).toBe("windows-x64");
        expect(serviceReport(facts)).toEqual({ service: true });
    });

    test("serviceReport gives a bootFix when Windows Scheduled Task is not registered for startup", () => {
        const facts = parseFacts("os=Windows\narch=AMD64\nhome=C:\\Users\\me\nuser=me");
        const rep = serviceReport(facts);
        expect(rep.service).toBe(false);
        expect(rep.bootFix).toContain("Register-ScheduledTask");
        expect(rep.bootFix).toContain("CavvyServer");
    });

    test("binaryName and targetName handle windows-x64", () => {
        expect(binaryName("windows-x64")).toBe("cavvy.exe");
        expect(binaryName("linux-x64")).toBe("cavvy");
        expect(binaryName("darwin-arm64")).toBe("cavvy");
        expect(targetName("windows-x64")).toBe("Windows x64");
    });

    test("store persists platform=windows across save/load", () => {
        const e = draftServer({ name: "win-dev", destination: "dev@win.example", platform: "windows" });
        expect(isWindowsServer(e)).toBe(true);
        saveServer(e);
        const loaded = getServer("win-dev");
        expect(loaded?.platform).toBe("windows");
    });

    test("parseServerSpec preserves Windows drive letters after the server name", () => {
        expect(parseServerSpec("winbox:C:\\code\\app")).toEqual({ name: "winbox", folder: "C:\\code\\app" });
    });
});

if (process.platform !== "win32") {
    describe("Windows SSH probe fallback and service setup (mocked SSH)", () => {
        test("probeServer falls back to PowerShell when POSIX sh fails on a Windows OpenSSH server", async () => {
            const fakeSshBin = join(scratch, "fake-win-ssh");
            mkdirSync(scratch, { recursive: true });
            // Simulates Windows OpenSSH: rejects `sh -c ...`, accepts `powershell.exe ... -EncodedCommand ...`.
            writeFileSync(
                fakeSshBin,
                `#!/bin/sh
cmd=""
for arg in "$@"; do cmd="$arg"; done
case "$cmd" in
    sh\\ -c*)
        echo "'sh' is not recognized as an internal or external command." >&2
        exit 1
        ;;
    powershell.exe*-EncodedCommand*)
        printf 'os=Windows\\r\\narch=AMD64\\r\\nhome=C:\\\\Users\\\\me\\r\\nuser=me\\r\\nshell=powershell\\r\\ndisk=2048\\r\\n'
        exit 0
        ;;
    *)
        exit 2
        ;;
esac
`,
            );
            chmodSync(fakeSshBin, 0o755);
            process.env.CAVVY_SSH = fakeSshBin;

            // First probe without platform set yet (like `cavvy servers add`).
            const unknownPlatform: ServerEntry = { name: "winbox", destination: "dev@winbox.example", addedAt: "2026-01-01T00:00:00.000Z" };
            const facts = await probeServer(unknownPlatform);
            expect(facts.os).toBe("Windows");
            expect(facts.arch).toBe("AMD64");
            expect(facts.home).toBe("C:\\Users\\me");
            expect(targetFor(facts, unknownPlatform)).toBe("windows-x64");
        });

        test("setUpService dispatches to PowerShell and parses windows=1 / wintask=0", async () => {
            const fakeSshBin = join(scratch, "fake-win-setup-ssh");
            writeFileSync(
                fakeSshBin,
                `#!/bin/sh
cmd=""
for arg in "$@"; do cmd="$arg"; done
case "$cmd" in
    powershell.exe*-EncodedCommand*)
        printf 'windows=1\\r\\nwintask=0\\r\\nuser=me\\r\\n'
        exit 0
        ;;
    *)
        echo "unexpected non-powershell command: $cmd" >&2
        exit 1
        ;;
esac
`,
            );
            chmodSync(fakeSshBin, 0o755);
            process.env.CAVVY_SSH = fakeSshBin;

            const rep = await setUpService(winEntry);
            expect(rep.service).toBe(false);
            expect(rep.bootFix).toContain("Register-ScheduledTask");
        });
    });
}

if (process.platform === "win32") {
    describe("Real Windows PowerShell remote scripts end-to-end", () => {
        test("probe, sendCopy, sendBuild, applyBuild, pairOverSsh, remoteCheck, and stopRemote execute on real PowerShell", async () => {
            // Isolated fake remote USERPROFILE so we don't touch the runner's real home.
            const remoteHome = join(scratch, "win-remote-home");
            mkdirSync(remoteHome, { recursive: true });

            // Compile a real .exe SSH shim (Bun blocks metacharacters to .cmd/.bat files, whereas real ssh.exe is a .exe)
            // that runs the remote command through cmd.exe /d /c (matching Windows OpenSSH's default shell) with USERPROFILE
            // pointed at our isolated remoteHome.
            const shimScript = join(scratch, "local-win-ssh.ts");
            writeFileSync(
                shimScript,
                `
const args = process.argv.slice(2);
const sep = args.indexOf("--");
const cmd = sep >= 0 ? args[sep + 2] : args[args.length - 1];
if (!cmd) process.exit(2);
const env = { ...process.env, USERPROFILE: ${JSON.stringify(remoteHome)}, CAVVY_HOME: ${JSON.stringify(join(remoteHome, ".cavvy"))}, CAVVY_NO_KEYCHAIN: "1" };
// Execute through cmd.exe /d /c exactly as default Windows OpenSSH does.
const proc = Bun.spawn(["cmd.exe", "/d", "/c", cmd], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
});
process.exit(await proc.exited);
`,
            );
            const shimExe = join(scratch, "local-win-ssh.exe");
            const compiled = Bun.spawnSync([process.execPath, "build", "--compile", "--outfile", shimExe, shimScript]);
            expect(compiled.exitCode).toBe(0);
            process.env.CAVVY_SSH = shimExe;

            // 1. Auto-detect Windows via probeServer (sh -c fails under cmd.exe -> falls back to remotePs PROBE_PS).
            const unknown: ServerEntry = { name: "winlocal", destination: "dev@127.0.0.1", addedAt: "2026-01-01T00:00:00.000Z" };
            const facts = await probeServer(unknown);
            expect(facts.os).toBe("Windows");
            expect(facts.home.toLowerCase()).toBe(remoteHome.toLowerCase());
            expect(targetFor(facts, unknown)).toBe("windows-x64");

            const localWin: ServerEntry = { ...unknown, platform: "windows" };

            // 2. sendCopy streams a real .tar.gz into PowerShell RECEIVE_PS and unpacks with tar.exe.
            const copyStage = join(scratch, "copy-stage");
            mkdirSync(join(copyStage, ".cavvy"), { recursive: true });
            writeFileSync(join(copyStage, ".cavvy", "CAVVY.md"), "# win-copy-ok\n");
            const copied = await sendCopy(localWin, {
                stage: copyStage,
                counts: { settings: false, memory: 1, skills: 0, commands: 0 },
                left: { servers: [], rules: 0 },
                files: 1,
                cleanup: () => {},
            });
            expect(copied).toEqual([".cavvy/CAVVY.md"]);
            expect(readFileSync(join(remoteHome, ".cavvy", "CAVVY.md"), "utf-8")).toContain("win-copy-ok");

            // 3. If a compiled cavvy.exe was provided by CI, test the full sendBuild -> applyBuild -> pair -> check -> stop flow!
            const exePath = process.env.CAVVY_WIN_TEST_EXE;
            if (exePath && existsSync(exePath)) {
                const buildId = "0123456789ab";
                const stageDir = join(scratch, "build-stage");
                mkdirSync(stageDir, { recursive: true });
                copyFileSync(exePath, join(stageDir, "cavvy.exe"));
                const bundlePath = join(scratch, "bundle.tar.gz");
                const tar = Bun.spawnSync(["tar.exe", "-czf", bundlePath, "-C", stageDir, "cavvy.exe"]);
                expect(tar.exitCode).toBe(0);
                const sha256 = createHash("sha256").update(readFileSync(exePath)).digest("hex");

                await sendBuild(
                    localWin,
                    { id: buildId, target: "windows-x64", bundle: bundlePath, bundleBytes: statSync(bundlePath).size, sha256, gui: false },
                    facts,
                );
                expect(existsSync(join(remoteHome, ".cavvy", "server", "builds", buildId, "cavvy.exe"))).toBe(true);

                // Re-probe should see the installed build!
                const afterSend = await probeServer(localWin);
                expect(afterSend.builds).toContain(buildId);

                try {
                    const status = await applyBuild(localWin, buildId);
                    expect(status.running).toBe(true);
                    expect(status.build).toBe(buildId);
                    expect(status.port).toBeGreaterThan(0);

                    const liveStatus = await remoteStatus(localWin);
                    expect(liveStatus?.running).toBe(true);
                    expect(liveStatus?.pid).toBe(status.pid);

                    const paired = await pairOverSsh(localWin, { id: "0123456789abcdef0123456789abcdef", label: "ci-win" });
                    expect(paired.port).toBe(status.port);
                    expect(paired.build).toBe(buildId);
                    expect(paired.code.length).toBeGreaterThanOrEqual(16);

                    const check = await remoteCheck(localWin);
                    expect(check.memMb).toBeGreaterThan(0);

                    await stopRemote(localWin);
                    expect(await remoteStatus(localWin)).toBeUndefined();
                    expect(existsSync(join(remoteHome, ".cavvy", "server", "stopped"))).toBe(true);
                } catch (err) {
                    const sdir = join(remoteHome, ".cavvy", "server");
                    const diag = ["current.txt", "run.ps1", "state.json", "control.json", "server.log", "server.out.log"].map((f) => {
                        const p = join(sdir, f);
                        return existsSync(p) ? `${f}=${readFileSync(p, "utf-8").slice(0, 400)}` : `${f}=MISSING`;
                    });
                    // Probe running the compiled exe directly for 4s to see exact startup output/error.
                    const probe = Bun.spawn([join(sdir, "builds", buildId, "cavvy.exe"), "host", "run", "--login-env", "--port", "0"], {
                        env: { ...process.env, CAVVY_HOME: join(remoteHome, ".cavvy-probe"), CAVVY_NO_KEYCHAIN: "1", CAVVY_HOST_DEBUG: "1" },
                        stdin: "ignore",
                        stdout: "pipe",
                        stderr: "pipe",
                    });
                    await Bun.sleep(4000);
                    const probeRunning = probe.exitCode === null;
                    if (probeRunning) probe.kill();
                    const [pOut, pErr, pCode] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
                    throw new Error(`${(err as Error).message}\n[diag] ${diag.join("\n[diag] ")}\n[probe] running=${probeRunning} code=${pCode} out=${pOut.slice(0, 400)} err=${pErr.slice(0, 600)}`);
                } finally {
                    await stopRemote(localWin).catch(() => undefined);
                }
            }
        }, 90_000);
    });
}
