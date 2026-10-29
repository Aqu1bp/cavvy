// The Simulator tools (src/tools/simulator-tools.ts) without a Mac: what they accept, how the permission rules treat
// them, the session's states with simctl faked, the names Claude Code and Codex call them by, the pane's input as
// the server checks it, and the setting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

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
