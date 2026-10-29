// The Simulator tools (src/tools/simulator-tools.ts) without a Mac: what they accept, how the permission rules treat
// them, the session's states with simctl faked, the names Claude Code and Codex call them by, the pane's input as
// the server checks it, and the setting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import HELPER_SOURCE from "../src/simulator/helper.swift" with { type: "text" };

isolate();
const { SIMULATOR_TOOLS, SimulatorActTool, SimulatorControlTool, SimulatorSnapshotTool, nativeSimulatorCall, servedSimulatorName, servedSimulatorTool, simulatorAvailable, simulatorServerTools } = await import("../src/tools/simulator-tools");
const { PermissionChecker } = await import("../src/permissions/checker");
const { SimulatorSession, resetSimulators } = await import("../src/simulator/session");
const simctl = await import("../src/simulator/simctl");
const { parseSimulatorInput } = await import("../src/server/engine");
const { loadSettings, simulatorEnabled } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");

const W = realpathSync(tempDir());
const ctx = { state: { cwd: W, projectRoot: W }, settings: {}, signal: new AbortController().signal } as any;

const DEVICES = JSON.stringify({
    devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
            { udid: "AAAA", name: "iPhone 17", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
            { udid: "BBBB", name: "iPad Air", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air" },
        ],
    },
});
let ran: string[][] = [];

beforeEach(() => {
    ran = [];
    simctl.setAvailability({ ok: true, developerDir: "/Applications/Xcode.app/Contents/Developer" });
    simctl.setRunner(async (args) => {
        ran.push(args);
        if (args.join(" ") === "xcrun simctl list devices -j") return { code: 0, stdout: DEVICES, stderr: "" };
        if (args[2] === "shutdown") return { code: 1, stdout: "", stderr: "Unable to shutdown device in current state: Shutdown" };
        return { code: 0, stdout: "", stderr: "" };
    });
});
afterEach(() => {
    simctl.setAvailability(undefined);
    simctl.setRunner(undefined);
    resetSimulators();
});

describe("what the tools accept", () => {
    test("control: install needs a .app that's there, launch a bundle id, open_url a URL", () => {
        const app = join(W, "Demo.app");
        mkdirSync(app, { recursive: true });
        writeFileSync(join(W, "notes.txt"), "");
        expect(SimulatorControlTool.validate!({ action: "install" }, ctx)).toMatch(/needs app/);
        expect(SimulatorControlTool.validate!({ action: "install", app: "notes.txt" }, ctx)).toMatch(/\.app folder/);
        expect(SimulatorControlTool.validate!({ action: "install", app: "Missing.app" }, ctx)).toMatch(/no app at/);
        expect(SimulatorControlTool.validate!({ action: "install", app: "Demo.app" }, ctx)).toBeUndefined();
        expect(SimulatorControlTool.validate!({ action: "launch" }, ctx)).toMatch(/needs a bundleId/);
        expect(SimulatorControlTool.validate!({ action: "open_url", url: "not a url" }, ctx)).toMatch(/needs a url/);
        expect(SimulatorControlTool.validate!({ action: "open_url", url: "myapp://home" }, ctx)).toBeUndefined();
        expect(SimulatorControlTool.validate!({ action: "dance" } as any, ctx)).toMatch(/Unknown action/);
    });

    test("act: a tap needs a ref or a point, a swipe a direction or an end, a button one of three", () => {
        const v = (i: any) => SimulatorActTool.validate!(i, ctx);
        expect(v({ action: "tap" })).toMatch(/needs a ref, or both x and y/);
        expect(v({ action: "tap", x: 10 })).toMatch(/needs a ref/);
        expect(v({ action: "tap", ref: "e3" })).toBeUndefined();
        expect(v({ action: "long_press", x: 1, y: 2 })).toBeUndefined();
        expect(v({ action: "swipe" })).toMatch(/needs a direction/);
        expect(v({ action: "swipe", direction: "sideways" })).toMatch(/Unknown direction/);
        expect(v({ action: "swipe", toX: 5, toY: 6 })).toBeUndefined();
        expect(v({ action: "type" })).toMatch(/needs text/);
        expect(v({ action: "button", button: "volume" })).toMatch(/home or lock/);
        expect(v({ action: "wait" })).toBeUndefined();
    });
});

describe("permissions", () => {
    const checker = new PermissionChecker(() => ({}), W);
    const check = (tool: any, input: any, mode: any = "default") => checker.check(tool, input, mode, W);

    test("reading and listing never ask; acting asks and can be allowed for the tool, managing per action", () => {
        expect(check(SimulatorSnapshotTool, {}).behavior).toBe("allow");
        expect(check(SimulatorControlTool, { action: "list" }).behavior).toBe("allow");
        expect(check(SimulatorActTool, { action: "wait" }).behavior).toBe("allow");
        const boot = check(SimulatorControlTool, { action: "boot" });
        expect(boot).toMatchObject({ behavior: "ask", suggestions: ["SimulatorControl(boot)"] });
        expect(checker.withGrant(SimulatorControlTool, { action: "boot" }, boot, W).grant).toEqual({ label: "SimulatorControl(boot)", rules: ["SimulatorControl(boot)"] });
        expect(check(SimulatorActTool, { action: "tap", ref: "e1" })).toMatchObject({ behavior: "ask", suggestions: ["SimulatorAct"] });
        expect(check(SimulatorActTool, { action: "tap", ref: "e1" }, "auto")).toMatchObject({ behavior: "ask", needsClassifier: true });
        expect(check(SimulatorActTool, { action: "tap", ref: "e1" }, "bypassPermissions").behavior).toBe("allow");
    });

    test("allowing launches doesn't allow shutting the device down", () => {
        const allowing = new PermissionChecker(() => ({ permissions: { allow: ["SimulatorControl(launch)"] } }), W);
        expect(allowing.check(SimulatorControlTool, { action: "launch", bundleId: "com.example.app" }, "default", W).behavior).toBe("allow");
        expect(allowing.check(SimulatorControlTool, { action: "shutdown" }, "default", W).behavior).toBe("ask");
        expect(allowing.check(SimulatorControlTool, { action: "terminate", bundleId: "com.example.app" }, "default", W).behavior).toBe("ask");
    });

    test("plan mode reads the simulator but doesn't start or touch it", () => {
        expect(check(SimulatorSnapshotTool, {}, "plan").behavior).toBe("allow");
        expect(check(SimulatorControlTool, { action: "list" }, "plan").behavior).toBe("allow");
        const boot = check(SimulatorControlTool, { action: "boot" }, "plan");
        expect(boot.behavior).toBe("deny");
        expect(boot.reason).toMatch(/simulator can be read/);
        expect(check(SimulatorActTool, { action: "type", text: "x" }, "plan").behavior).toBe("deny");
    });
});

describe("the session's simulator", () => {
    test("off with the first iPhone offered; listed for the agent with whose it is", async () => {
        const s = new SimulatorSession({ settings: () => ({}) });
        const state = await s.refresh();
        expect(state).toMatchObject({ status: "off", device: { udid: "AAAA", name: "iPhone 17", state: "shutdown" } });
        expect(state.devices.map((d) => d.udid)).toEqual(["AAAA", "BBBB"]);
        expect(await s.devicesText()).toContain("- iPhone 17 (iOS 27.0) shutdown, this session's [AAAA]");
        s.dispose();
    });

    test("using one that isn't running says how to start it, without starting anything", async () => {
        const s = new SimulatorSession({ settings: () => ({}) });
        const r = await SimulatorSnapshotTool.run({}, { ...ctx, state: { ...ctx.state, simulator: s } });
        expect(r).toMatchObject({ isError: true });
        expect(r.content).toBe("iPhone 17 is shut down. Start it with SimulatorControl action=boot.");
        expect(ran.some((a) => a.includes("bootstatus"))).toBe(false);
        s.dispose();
    });

    test("an unknown device is named in the refusal; shutting down one that's off is done", async () => {
        const s = new SimulatorSession({ settings: () => ({}) });
        await expect(s.boot("iPhone 99")).rejects.toThrow(/no simulator named "iPhone 99"/);
        expect((await s.shutdown("iPad Air")).name).toBe("iPad Air");
        s.dispose();
    });

    test("no simulators here, or turned off: unavailable, and the tools aren't offered", async () => {
        simctl.setAvailability({ ok: false, error: "Simulators need macOS." });
        const s = new SimulatorSession({ settings: () => ({}) });
        expect(await s.refresh()).toMatchObject({ status: "unavailable", error: "Simulators need macOS." });
        expect(simulatorAvailable({})).toBe(false);
        simctl.setAvailability({ ok: true, developerDir: "/x" });
        expect(simulatorAvailable({})).toBe(true);
        expect(simulatorAvailable({ simulator: { enabled: false } })).toBe(false);
        const off = new SimulatorSession({ settings: () => ({ simulator: { enabled: false } }) });
        expect(off.state()).toMatchObject({ status: "unavailable", error: expect.stringMatching(/turned off/) });
        s.dispose();
        off.dispose();
    });
});

describe("a device another tool has taken the input of", () => {
    // A stand-in for the helper, where the built one would be: a screen, input answered, and the input taken (as
    // the device's state says) once TAKEN exists.
    const DEV = "/Applications/Xcode.app/Contents/Developer";
    const TAKEN = join(W, "taken");
    const ran2: string[][] = [];
    beforeEach(() => {
        const hash = createHash("sha256").update(HELPER_SOURCE).update("\0").update(DEV).digest("hex").slice(0, 16);
        const bin = join(paths.home(), "simulator", hash, "cavvy-sim");
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(
            bin,
            `#!${process.execPath}
const { existsSync } = require("fs");
const out = (o) => { const p = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(5); h[0] = 74; h.writeUInt32BE(p.length, 1); process.stdout.write(Buffer.concat([h, p])); };
const taken = () => existsSync(${JSON.stringify(TAKEN)});
out({ event: "ready", width: 1206, height: 2622, scale: 3 });
if (taken()) out({ event: "input", taken: true });
for await (const line of console) {
    const c = JSON.parse(line);
    if (c.op === "describe") out({ id: c.id, tree: { role: "AXApplication" }, pid: 1, process: "SpringBoard", stillMs: 1000 });
    else out({ id: c.id, ok: true, ...(["touch", "button", "keys"].includes(c.op) && taken() ? { taken: true } : {}) });
}
`,
        );
        chmodSync(bin, 0o755);
        rmSync(TAKEN, { force: true });
        ran2.length = 0;
        simctl.setRunner(async (args) => {
            ran2.push(args);
            if (args.join(" ") === "xcrun simctl list devices -j") return { code: 0, stdout: DEVICES.replace('"Shutdown"', '"Booted"'), stderr: "" };
            return { code: 0, stdout: "", stderr: "" };
        });
    });

    test("keys are an error that says to restart it; touches and buttons go, and their results say so", async () => {
        const s = new SimulatorSession({ settings: () => ({}) });
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        expect(await s.type("hi")).toBe('Typed "hi".');
        expect(s.state().inputTaken).toBeUndefined();
        writeFileSync(TAKEN, "");
        expect(await s.tap({ x: 100, y: 200 })).toMatch(/^Tapped 100,200\. Another tool has taken iPhone 17's input \(one using Xcode's device input service, such as Claude's desktop app\).*if nothing changed, restart it with SimulatorControl action=shutdown, then action=boot\.$/);
        expect(await s.button("home")).toMatch(/^Pressed the Home button\. Another tool has taken/);
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach iPhone 17: another tool has taken its input .* Restart it with SimulatorControl action=shutdown, then action=boot\.$/);
        await expect(s.press("Enter")).rejects.toThrow(/^Keys can't reach iPhone 17/);
        // The pane shows it.
        expect(s.state()).toMatchObject({ status: "ready", inputTaken: true });
        s.dispose();
    });

    test("the pane's restart shuts it down and starts it again, with a helper that has its input", async () => {
        writeFileSync(TAKEN, "");
        const s = new SimulatorSession({ settings: () => ({}) });
        await s.command("boot");
        await Bun.sleep(50);
        expect(s.state().inputTaken).toBe(true);
        rmSync(TAKEN);
        expect(await s.command("restart")).not.toHaveProperty("inputTaken");
        const steps = ran2.map((a) => a.slice(0, 3).join(" ")).filter((a) => /shutdown|bootstatus/.test(a));
        expect(steps).toEqual(["xcrun simctl shutdown", "xcrun simctl bootstatus"]);
        expect(await s.tap({ x: 10, y: 10 })).toBe("Tapped 10,10.");
        s.dispose();
    });
});

test("Claude Code and Codex call them as simulator_*, shown as the tools they are", () => {
    expect(SIMULATOR_TOOLS.map((t) => servedSimulatorName(t.name))).toEqual(["simulator_control", "simulator_snapshot", "simulator_act", "simulator_screenshot"]);
    // Control shuts devices down and ends apps; the rest don't.
    expect(simulatorServerTools(async () => ({ content: [] }) as any).map((t) => t.annotations?.destructiveHint)).toEqual([true, false, false, false]);
    expect(servedSimulatorName("BrowserAct")).toBeUndefined();
    expect(nativeSimulatorCall("simulator_act", { action: "tap" })).toEqual({ name: "SimulatorAct", input: { action: "tap" } });
    expect(servedSimulatorTool("cavvy", "mcp__cavvy__simulator_act")).toBe(true);
    expect(servedSimulatorTool("cavvy", "mcp__other__simulator_act")).toBe(false);
});

test("the pane's input is checked: touches within the screen, known buttons, bounded text", () => {
    expect(parseSimulatorInput({ kind: "touch", phase: "down", x: 0.5, y: 1 })).toEqual({ kind: "touch", phase: "down", x: 0.5, y: 1 });
    expect(parseSimulatorInput({ kind: "touch", phase: "down", x: 1.5, y: 0 })).toBeUndefined();
    expect(parseSimulatorInput({ kind: "touch", phase: "hover", x: 0, y: 0 })).toBeUndefined();
    expect(parseSimulatorInput({ kind: "key", code: "KeyA", down: true })).toEqual({ kind: "key", code: "KeyA", down: true });
    expect(parseSimulatorInput({ kind: "button", name: "power" })).toBeUndefined();
    expect(parseSimulatorInput({ kind: "text", text: "" })).toBeUndefined();
    expect(parseSimulatorInput({ kind: "text", text: "x".repeat(10_001) })).toBeUndefined();
    expect(parseSimulatorInput("tap")).toBeUndefined();
});

test("any settings file can turn the simulator off; none can turn it back on", () => {
    expect(simulatorEnabled({})).toBe(true);
    expect(simulatorEnabled({ simulator: { enabled: false } })).toBe(false);
    expect(simulatorEnabled({ simulator: "yes" } as any)).toBe(true);
    const load = (user: object, project?: object) => {
        const cwd = realpathSync(tempDir("cavvy-sim-settings-"));
        mkdirSync(dirname(paths.userSettings()), { recursive: true });
        writeFileSync(paths.userSettings(), JSON.stringify(user));
        if (project) {
            mkdirSync(dirname(paths.projectSettings(cwd)), { recursive: true });
            writeFileSync(paths.projectSettings(cwd), JSON.stringify(project));
        }
        return simulatorEnabled(loadSettings(cwd));
    };
    expect(load({})).toBe(true);
    expect(load({}, { simulator: { enabled: false } })).toBe(false);
    expect(load({ simulator: { enabled: false } }, { simulator: { enabled: true } })).toBe(false);
});
