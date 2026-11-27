// Core Windows support: shell wrapping, PowerShell encoding, Registry PATH
// merging, process-tree cleanup, server-role path checks, and live host daemon
// lifecycle (runs on Linux/macOS and natively on Windows CI).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { encodePowerShell, isPowerShell, pickShell, runShell, shellArgv, stopGroup, wrapCommand } = await import("../src/tools/bash");
const { loginShellPath, mergePath, parseRegPath } = await import("../src/server/login-env");
const { inServerInstall } = await import("../src/servers/role");
const { processStart } = await import("../src/servers/host");
const { DETACHED, treeAlive } = await import("../src/util/process-tree");

const scratch = tempDir("cavvy-win-core-");

afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    iso.cleanup();
});

describe("Windows shell helpers", () => {
    test("recognizes PowerShell executables across platforms and cases", () => {
        expect(isPowerShell("pwsh")).toBe(true);
        expect(isPowerShell("pwsh.exe")).toBe(true);
        expect(isPowerShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(true);
        expect(isPowerShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(true);
        expect(isPowerShell("POWERSHELL.EXE")).toBe(true);
        expect(isPowerShell("/bin/bash")).toBe(false);
        expect(isPowerShell("C:\\Program Files\\Git\\bin\\bash.exe")).toBe(false);
    });

    test("encodes PowerShell commands as UTF-16LE base64 and uses -EncodedCommand", () => {
        const script = `Write-Output "hello 'world' $env:OS"\nexit 0`;
        const argv = shellArgv(script, undefined, "powershell.exe");
        expect(argv.slice(0, 5)).toEqual(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
        expect(Buffer.from(argv[5]!, "base64").toString("utf16le")).toBe(script);
        expect(argv[5]).toBe(encodePowerShell(script));
    });

    test("falls back to -Command when an encoded PowerShell script would exceed Windows command-line budget", () => {
        const huge = "a".repeat(12_000);
        const argv = shellArgv(huge, undefined, "pwsh.exe");
        expect(argv).toEqual(["pwsh.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", huge]);
    });

    test("wraps PowerShell commands to capture UTF-8 output, exit code, and cwd", () => {
        const wrapped = wrapCommand("cd sub", "C:\\tmp\\o'clock\\cwd.txt", "pwsh.exe", "win32");
        expect(wrapped).toContain("UTF8Encoding");
        expect(wrapped).toContain("cd sub");
        expect(wrapped).toContain("C:\\tmp\\o''clock\\cwd.txt");
        expect(wrapped).toContain("(Get-Location).ProviderPath");
        expect(wrapped).toContain("exit $__cavvy_ec");
    });

    test("wraps POSIX shells on Windows with pwd -W fallback so cwd stays a Windows path", () => {
        const wrapped = wrapCommand("cd sub", "C:\\tmp\\cwd", "C:\\Program Files\\Git\\bin\\bash.exe", "win32");
        expect(wrapped).toContain("pwd -W 2>/dev/null || pwd -P");
        expect(wrapped).toContain("exit $__cavvy_ec");
    });

    test("pickShell falls back to SystemRoot PowerShell on win32 when PATH has no shells", () => {
        const picked = pickShell("win32", { PATH: "", SystemRoot: "D:\\Win" });
        expect(picked).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    });
});

describe("Windows Registry PATH helpers", () => {
    test("parses REG_SZ and REG_EXPAND_SZ Path values from reg query output", () => {
        const out = [
            "",
            "HKEY_CURRENT_USER\\Environment",
            "    Path    REG_EXPAND_SZ    %USERPROFILE%\\.bun\\bin;C:\\Tools",
            "",
        ].join("\r\n");
        expect(parseRegPath(out)).toBe("%USERPROFILE%\\.bun\\bin;C:\\Tools");
    });

    test("merges Windows PATH entries with ; delimiter and case-insensitive dedupe", () => {
        const merged = mergePath("c:\\tools;C:\\Windows\\System32", "C:\\Bun\\bin;C:\\Tools", ";", true);
        expect(merged).toBe("C:\\Bun\\bin;C:\\Tools;C:\\Windows\\System32");
    });

    if (process.platform === "win32") {
        test("loginShellPath reads Windows Registry PATH entries", async () => {
            const regPath = await loginShellPath();
            expect(regPath).toBeTruthy();
            expect(regPath!.toLowerCase()).toContain("system32");
        });
    }
});

describe("Server role and process helpers", () => {
    test("inServerInstall recognizes builds inside home/.cavvy/server/builds", () => {
        const fakeHome = join(scratch, "home");
        const binDir = join(fakeHome, ".cavvy", "server", "builds", "abc123def456");
        mkdirSync(binDir, { recursive: true });
        const bin = join(binDir, process.platform === "win32" ? "cavvy.exe" : "cavvy");
        writeFileSync(bin, "");
        expect(inServerInstall(bin, fakeHome)).toBe(true);
        expect(inServerInstall(join(scratch, "other"), fakeHome)).toBe(false);
    });

    test("processStart returns a stable identifier for the current process", () => {
        const a = processStart(process.pid);
        const b = processStart(process.pid);
        expect(a).toBeTruthy();
        expect(a).toBe(b);
    });

    test("treeAlive and stopGroup stop a spawned process cleanly", async () => {
        const proc = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: DETACHED,
        });
        expect(treeAlive(proc.pid)).toBe(true);
        const how = await stopGroup(proc.pid, 500);
        expect(["stopped", "killed"]).toContain(how);
        await proc.exited;
        expect(treeAlive(proc.pid)).toBe(false);
    });
});

describe("Live shell execution", () => {
    test("runShell captures stdout, exit code, and tracks cd across calls", async () => {
        const sub = join(scratch, "sub-dir");
        mkdirSync(sub, { recursive: true });
        const cmd = process.platform === "win32"
            ? `Set-Location '${sub.replace(/'/g, "''")}'; Write-Output "hello-win"`
            : `cd '${sub}' && printf 'hello-posix\\n'`;
        const res = await runShell({
            command: cmd,
            cwd: scratch,
            timeoutMs: 15_000,
            signal: new AbortController().signal,
            env: { ...process.env } as Record<string, string>,
            paced: false,
        });
        expect(res.exitCode).toBe(0);
        expect(res.output).toContain(process.platform === "win32" ? "hello-win" : "hello-posix");
        expect(res.newCwd).toBeDefined();
        const canonical = (p: string) => (realpathSync.native ? realpathSync.native(p) : realpathSync(p)).toLowerCase();
        expect(canonical(res.newCwd!)).toBe(canonical(sub));
    });

    test("runShell preserves non-zero exit codes", async () => {
        const cmd = process.platform === "win32"
            ? `& '${process.execPath.replace(/'/g, "''")}' -e 'process.exit(7)'`
            : `'${process.execPath}' -e 'process.exit(7)'`;
        const res = await runShell({
            command: cmd,
            cwd: scratch,
            timeoutMs: 15_000,
            signal: new AbortController().signal,
            env: { ...process.env } as Record<string, string>,
            paced: false,
        });
        expect(res.exitCode).toBe(7);
    });

    test("runShell terminates on timeout", async () => {
        const cmd = process.platform === "win32"
            ? `& '${process.execPath.replace(/'/g, "''")}' -e 'setInterval(() => {}, 1000)'`
            : `'${process.execPath}' -e 'setInterval(() => {}, 1000)'`;
        const res = await runShell({
            command: cmd,
            cwd: scratch,
            timeoutMs: 400,
            signal: new AbortController().signal,
            env: { ...process.env } as Record<string, string>,
            paced: false,
        });
        expect(res.timedOut).toBe(true);
    });
});

describe("Live host daemon lifecycle", () => {
    test("cavvy host run, status, pair, revoke, and stop work end-to-end", async () => {
        const hostHome = join(scratch, "host-home");
        mkdirSync(hostHome, { recursive: true });
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            CAVVY_HOME: hostHome,
            CAVVY_NO_KEYCHAIN: "1",
        };
        const entry = join(import.meta.dir, "..", "src", "index.ts");
        const cli = async (...args: string[]) => {
            const p = Bun.spawn([process.execPath, "--no-env-file", entry, "host", ...args], {
                env,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            });
            const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
            return { exitCode, stdout, stderr };
        };

        const daemon = Bun.spawn([process.execPath, "--no-env-file", entry, "host", "run", "--port", "0"], {
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        try {
            let status: { running?: boolean; port?: number; pid?: number } | undefined;
            for (let i = 0; i < 60; i++) {
                const r = await cli("status");
                if (r.exitCode === 0) {
                    status = JSON.parse(r.stdout);
                    if (status?.running) break;
                }
                await Bun.sleep(150);
            }
            expect(status?.running).toBe(true);
            expect(status?.pid).toBe(daemon.pid);
            expect(typeof status?.port).toBe("number");
            expect(status!.port! > 0).toBe(true);
            if (process.platform === "win32") {
                expect(existsSync(join(hostHome, "server", "control.json"))).toBe(true);
            }

            const machineId = "0123456789abcdef0123456789abcdef";
            const paired = await cli("pair", "--machine", machineId, "--label", "win-test");
            expect(paired.exitCode).toBe(0);
            const pairData = JSON.parse(paired.stdout) as { code?: string; port?: number };
            expect(typeof pairData.code).toBe("string");
            expect(pairData.port).toBe(status!.port);

            const revoked = await cli("revoke", "--machine", machineId);
            expect(revoked.exitCode).toBe(0);

            const stopped = await cli("stop");
            expect(stopped.exitCode).toBe(0);
            const exitCode = await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => -1)]);
            expect(exitCode).toBe(0);
        } finally {
            if (daemon.exitCode === null) daemon.kill("SIGKILL");
        }
    }, 30_000);
});
