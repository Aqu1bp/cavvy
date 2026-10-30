// The Simulator tools (src/tools/simulator-tools.ts) without a Mac: what they accept, how the permission rules treat
// them, the session's states with simctl faked, the names Claude Code and Codex call them by, the pane's input as
// the server checks it, and the setting.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
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
        expect(allowing.check(SimulatorControlTool, { action: "take_control" }, "default", W)).toMatchObject({ behavior: "ask", suggestions: ["SimulatorControl(take_control)"] });
    });

    test("plan mode reads the simulator but doesn't start or touch it", () => {
        expect(check(SimulatorSnapshotTool, {}, "plan").behavior).toBe("allow");
        expect(check(SimulatorControlTool, { action: "list" }, "plan").behavior).toBe("allow");
        const boot = check(SimulatorControlTool, { action: "boot" }, "plan");
        expect(boot.behavior).toBe("deny");
        expect(boot.reason).toMatch(/simulator can be read/);
        expect(check(SimulatorActTool, { action: "type", text: "x" }, "plan").behavior).toBe("deny");
        expect(check(SimulatorControlTool, { action: "take_control" }, "plan").behavior).toBe("deny");
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

describe("a device another tool has taken input from", () => {
    // A stand-in for the helper, where the built one would be: a screen, input answered, and Xcode's device input
    // service holding the input while HELD exists (said as it changes, as the helper's timer does). What it's sent goes
    // to OPS, and it ends when DIE exists. The device's input process is a stand-in that runs (`inputPid`), and the
    // log has CUT's lines for the first and LATER's for the next. Taking the input back clears HELD and starts the next,
    // unless it fails. While GONE exists, the screen reads as an app that's gone, until the device's bridge restarts.
    const DEV = "/Applications/Xcode.app/Contents/Developer";
    const HELD = join(W, "held");
    const OPS = join(W, "ops");
    const DIE = join(W, "die");
    const GONE = join(W, "gone");
    const SAFARI = join(W, "safari");
    const SLOW = join(W, "slow");
    // Settings opens a field to type in half a second after it's tapped (while OPENS exists), as Safari's address does.
    const OPENS = join(W, "opens");
    const EDITING = join(W, "editing");
    const disconnected = (service: string) => `2026-10-29 19:30:55.511 Df backboardd[123:d96735] (SimulatorHID) Disconnecting service: <SimHIDVirtualService: 0x1: identifier: 0x2 com.apple.SimulatorHID.${service}, state: disconnected>`;
    const ALL = ["ExternalKeyboardService", "MainScreenButtonsService", "ScreenTouchService.00000000-0000-4000-8000-000000000001"].map(disconnected).join("\n");
    let cut = "";
    let later = "";
    let logFails = false;
    let lookupFails = false;
    let psFails = false;
    /** The next ps call takes this long. */
    let psSlowOnce = 0;
    let lookupMs = 300;
    /** How long a lookup that works takes. */
    let lookupOkMs = 0;
    let logMs = 0;
    let inputPid = 0;
    let inputs: ReturnType<typeof Bun.spawn>[] = [];
    /** When each process started, as ps says (a minute and a half before its stand-in did). */
    const started = new Map<number, number>();
    /** The device's input process restarts (the one before is gone, as launchd sees to, unless `reusing` its pid). */
    const nextInputProcess = async (reusing = false) => {
        if (!reusing) {
            inputs.at(-1)?.kill();
            await inputs.at(-1)?.exited;
        } else started.set(inputPid, Date.now());
        inputs.push(Bun.spawn(["sleep", "600"]));
        inputPid = inputs.at(-1)!.pid;
        started.set(inputPid, Date.now() - 90_000);
    };
    afterEach(() => {
        for (const p of inputs) p.kill();
    });
    let restart: "ok" | "fails" | "taken again" | "slow" = "ok";
    let restartedAt = 0;
    const ran2: string[][] = [];
    beforeEach(async () => {
        const hash = createHash("sha256").update(HELPER_SOURCE).update("\0").update(DEV).digest("hex").slice(0, 16);
        const bin = join(paths.home(), "simulator", hash, "cavvy-sim");
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(
            bin,
            `#!${process.execPath}
const { existsSync, appendFileSync, rmSync, writeFileSync } = require("fs");
const out = (o) => { const p = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(5); h[0] = 74; h.writeUInt32BE(p.length, 1); process.stdout.write(Buffer.concat([h, p])); };
const held = () => existsSync(${JSON.stringify(HELD)});
let said = held();
const tell = () => { if (held() !== said) { said = held(); out({ event: "input", held: said }); } };
setInterval(tell, 50);
out({ event: "ready", width: 1206, height: 2622, scale: 3, held: said });
for await (const line of console) {
    const c = JSON.parse(line);
    if (existsSync(${JSON.stringify(DIE)})) { rmSync(${JSON.stringify(DIE)}); process.exit(0); }
    appendFileSync(${JSON.stringify(OPS)}, (c.op === "claim" ? JSON.stringify({ claim: c.touch ? (c.keys ? "all" : "not keys") : "not touch" }) : \`\${c.op} \${Date.now()}\`) + "\\n");
    if (["touch", "keys", "button"].includes(c.op) && existsSync(${JSON.stringify(SLOW)})) await Bun.sleep(400);
    if (c.op === "touch" && c.phase === "up" && existsSync(${JSON.stringify(OPENS)})) setTimeout(() => writeFileSync(${JSON.stringify(EDITING)}, ""), 500);
    tell();
    if (c.op === "describe" && existsSync(${JSON.stringify(GONE)})) out({ id: c.id, tree: { role: "AXApplication" }, pid: 99999, gone: true, stillMs: 1000 });
    else if (c.op === "describe") out({ id: c.id, tree: { role: "AXApplication", children: [{ role: existsSync(${JSON.stringify(EDITING)}) ? "AXTextField" : "AXButton", label: "Settings", frame: [20, 100, 60, 60] }] }, pid: 1, process: existsSync(${JSON.stringify(SAFARI)}) ? "MobileSafari" : "SpringBoard", stillMs: 1000 });
    else out({ id: c.id, ok: true });
}
`,
        );
        chmodSync(bin, 0o755);
        rmSync(HELD, { force: true });
        rmSync(OPS, { force: true });
        rmSync(DIE, { force: true });
        rmSync(GONE, { force: true });
        rmSync(SAFARI, { force: true });
        rmSync(SLOW, { force: true });
        rmSync(OPENS, { force: true });
        rmSync(EDITING, { force: true });
        cut = "";
        later = "";
        logFails = false;
        lookupFails = false;
        psFails = false;
        psSlowOnce = 0;
        lookupMs = 300;
        lookupOkMs = 0;
        logMs = 0;
        inputs = [];
        await nextInputProcess();
        restart = "ok";
        ran2.length = 0;
        simctl.setRunner(async (args) => {
            ran2.push(args);
            const line = args.join(" ");
            if (line === "xcrun simctl list devices -j") return { code: 0, stdout: DEVICES.replace('"Shutdown"', '"Booted"'), stderr: "" };
            if (line === "xcrun simctl spawn AAAA launchctl list" && lookupFails) {
                await Bun.sleep(lookupMs);
                return { code: 1, stdout: "", stderr: "launchctl list failed" };
            }
            if (line === "xcrun simctl spawn AAAA launchctl list") await Bun.sleep(lookupOkMs);
            if (line === "xcrun simctl spawn AAAA launchctl list") return { code: 0, stdout: `PID\tStatus\tLabel\n120\t0\tcom.apple.SpringBoard\n${inputPid}\t0\tcom.apple.backboardd\n`, stderr: "" };
            const ps = /^ps -o etime= -p (\d+)$/.exec(line);
            if (ps) {
                if (psSlowOnce) await Bun.sleep(psSlowOnce + (psSlowOnce = 0));
                if (psFails) return { code: 1, stdout: "", stderr: "" };
                const since = started.get(Number(ps[1]));
                if (since === undefined || !inputs.some((p) => p.pid === Number(ps[1]) && p.exitCode === null)) return { code: 1, stdout: "", stderr: "" };
                const t = Math.floor((Date.now() - since) / 1000);
                return { code: 0, stdout: ` ${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}\n`, stderr: "" };
            }
            if (line.startsWith("xcrun simctl spawn AAAA log show")) {
                await Bun.sleep(logMs);
                if (logFails) return { code: 1, stdout: "", stderr: "log: Could not open the log store" };
                const of = inputs.findIndex((p) => line.includes(`processIdentifier == ${p.pid} `));
                return { code: 0, stdout: `Timestamp               Ty Process[PID:TID]\n${of === 0 ? cut : of === 1 ? later : ""}\n`, stderr: "" };
            }
            if (line.includes("notifyutil -s com.apple.coredevice.dtuhidd.active 1")) writeFileSync(HELD, "");
            if (line.includes("notifyutil -s com.apple.coredevice.dtuhidd.active 0")) {
                rmSync(HELD, { force: true });
                await Bun.sleep(restart === "taken again" ? 150 : 0);
            }
            if (line.includes("kickstart -k user/foreground/com.apple.CoreSimulator.bridge")) rmSync(GONE, { force: true });
            else if (line.includes("launchctl kickstart")) {
                if (restart === "fails") return { code: 1, stdout: "", stderr: "Could not kickstart service" };
                restartedAt = Date.now();
                if (restart === "slow") await Bun.sleep(3000);
                // The tool takes over again as the input process restarts, and says so before it's back.
                if (restart === "taken again") {
                    writeFileSync(HELD, "");
                    await Bun.sleep(300);
                }
                await nextInputProcess();
            }
            return { code: 0, stdout: "", stderr: "" };
        });
    });
    const session = () => new SimulatorSession({ settings: () => ({}) });

    test("the inputs it took are errors that say how to take them back, and snapshots and the pane say what's taken", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        // Touches weren't taken (they were in use when the service started): they go, and nothing is said.
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        await expect(s.type("hi")).rejects.toThrow("Keys can't reach iPhone 17: another tool (one using Xcode's device input service, such as Claude's desktop app) has taken its keyboard. SimulatorControl action=take_control takes the input back (it restarts the home screen, closing the apps).");
        await expect(s.press("Enter")).rejects.toThrow(/^Keys can't reach iPhone 17/);
        expect(s.state()).toMatchObject({ status: "ready", inputCut: ["keyboard"] });
        expect(await s.snapshot()).toContain("\nAnother tool (one using Xcode's device input service, such as Claude's desktop app) has taken this device's keyboard: SimulatorControl action=take_control takes the input back");
        // The log is read for the device's input process now, back as far as it has run.
        const read = ran2.find((a) => a.includes("log"))!;
        expect(read).toContain("--last");
        expect(read[read.indexOf("--last") + 1]).toBe("100s");
        expect(read.at(-1)).toBe(`processIdentifier == ${inputPid} AND eventMessage CONTAINS "Disconnecting service"`);
        s.dispose();
    });

    test("the first snapshot, as what was taken is still being read: it says so", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        logMs = 800;
        const s = session();
        expect(await s.snapshot()).toContain("has taken this device's touch screen, keyboard and buttons");
        s.dispose();
    });

    test("the service holding the input, with nothing taken (each was in use): nothing is said, and there's nothing to take back", async () => {
        writeFileSync(HELD, "");
        const s = session();
        expect(await s.type("hi")).toBe('Typed "hi".');
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        expect(s.state().inputCut).toBeUndefined();
        expect(await s.snapshot()).not.toContain("Another tool");
        const r = await SimulatorControlTool.run({ action: "take_control" }, { ...ctx, state: { ...ctx.state, simulator: s } });
        expect(r).toMatchObject({ isError: true, content: "Nothing has taken iPhone 17's input: there's nothing to take back." });
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test("take_control takes it all back, and claims each input so the tool coming back doesn't take it", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach iPhone 17: .* has taken its touch screen\./);
        await expect(s.button("home")).rejects.toThrow(/^Buttons can't reach iPhone 17: .* has taken its buttons\./);
        expect(await s.snapshot()).toContain("has taken this device's touch screen, keyboard and buttons: SimulatorControl action=take_control");
        expect(s.state().inputCut).toEqual(["touch", "keyboard", "buttons"]);
        cut = "";
        const r = await SimulatorControlTool.run({ action: "take_control" }, { ...ctx, state: { ...ctx.state, simulator: s } });
        expect(r.isError).toBeFalsy();
        expect(String(r.content)).toStartWith("Took iPhone 17's input back: its home screen restarted, and its apps closed.\n\niPhone 17");
        // The service is told it no longer has it, then the input process restarts.
        const steps = ran2.filter((a) => a.includes("notifyutil") || a.includes("kickstart")).map((a) => a.slice(4).join(" "));
        expect(steps).toEqual(["notifyutil -s com.apple.coredevice.dtuhidd.active 0 -p com.apple.coredevice.dtuhidd.active", "launchctl kickstart -k user/foreground/com.apple.backboardd"]);
        expect(readFileSync(OPS, "utf8").split("\n").filter((o) => o.includes("claim"))).toEqual(['{"claim":"all"}', '{"claim":"all"}']);
        expect(s.state().inputCut).toBeUndefined();
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        s.dispose();
    });

    test("the pane's Take control does the same, without claiming what the person is using; asked again, it does nothing", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await s.command("boot");
        await Bun.sleep(100);
        expect(s.state().inputCut).toHaveLength(3);
        cut = "";
        // Their finger is down: letting go of a touch would lift it.
        await s.input({ kind: "touch", phase: "down", x: 0.5, y: 0.5 });
        expect(await s.command("take_control")).not.toHaveProperty("inputCut");
        expect(ran2.filter((a) => a.includes("kickstart"))).toHaveLength(1);
        expect(readFileSync(OPS, "utf8")).toContain('{"claim":"not touch"}');
        await s.input({ kind: "touch", phase: "up", x: 0.5, y: 0.5 });
        // Another window still showing it taken: nothing's taken now, so the apps aren't closed again.
        await s.command("take_control");
        expect(ran2.filter((a) => a.includes("kickstart"))).toHaveLength(1);
        s.dispose();
    });

    test("the service taking over as input is sent: what went nowhere is an error", async () => {
        const s = session();
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        writeFileSync(HELD, "");
        cut = ALL;
        await expect(s.press("a")).rejects.toThrow(/^Keys can't reach iPhone 17/);
        s.dispose();
    });

    test("what was taken lasts while the input process it was taken from does, whatever helpers come and go", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        // The service no longer says it has it (told so by hand, say), but the keyboard is still cut off: a new helper
        // keeps knowing.
        rmSync(HELD);
        cut = "";
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        // A new input process (the device restarted): it's not.
        await nextInputProcess();
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        expect(await s.type("hi")).toBe('Typed "hi".');
        s.dispose();
    });

    test("taken back by another Cavvy (a new input process): the service letting go is noticed, and there's nothing to take back", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        await nextInputProcess();
        rmSync(HELD);
        await Bun.sleep(200);
        expect(s.state().inputCut).toBeUndefined();
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        s.dispose();
    });

    test("taken back by another Cavvy, with no word of it (the service took over again at once): the input process is looked up before an input is refused", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        // The service took the new process's keyboard too: that's read, not taken for working.
        later = disconnected("ExternalKeyboardService");
        await nextInputProcess();
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        expect(s.state().inputCut).toEqual(["keyboard"]);
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        s.dispose();
    });

    test("restarted elsewhere, and the service took what wasn't taken before: an input checks its process first", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        later = disconnected("ScreenTouchService.00000000-0000-4000-8000-000000000001");
        await nextInputProcess();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        expect(s.state().inputCut).toEqual(["touch"]);
        s.dispose();
    });

    test("restarted elsewhere, and the device can't be asked about the new process: what the old one lost is dropped, and input carries the note", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        later = disconnected("ScreenTouchService.00000000-0000-4000-8000-000000000001");
        lookupFails = true;
        await nextInputProcess();
        expect(await s.tap({ x: 100, y: 200 })).toMatch(/^Tapped 100,200\. .*whether this reached it can't be told/);
        expect(s.state()).toMatchObject({ inputUncertain: true });
        expect(s.state().inputCut).toBeUndefined();
        s.dispose();
    });

    test("taken back elsewhere as take_control reads again what couldn't be read: what it read is of the process before, and nothing's restarted", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        lookupFails = true;
        const s = session();
        await s.command("boot");
        await Bun.sleep(800);
        expect(s.state()).toMatchObject({ inputUncertain: true });
        lookupFails = false;
        logMs = 400;
        const taking = s.takeControl();
        // As it reads the log, another Cavvy takes the input back.
        await Bun.sleep(150);
        rmSync(HELD);
        await nextInputProcess();
        await expect(taking).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test("the log no longer saying what the input process let go of (pruned as it ran on): it's still known", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        // A new helper reads it again, and the log has nothing now.
        cut = "";
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        expect(s.state().inputCut).toEqual(["touch", "keyboard", "buttons"]);
        s.dispose();
    });

    test("taking the input back waits for touches being sent from another session to end, so they aren't cut short", async () => {
        writeFileSync(HELD, "");
        cut = [disconnected("ExternalKeyboardService"), disconnected("MainScreenButtonsService")].join("\n");
        const agent = session();
        const pane = session();
        await agent.tap({ x: 100, y: 200 });
        await pane.command("boot");
        const t0 = Date.now();
        const swiping = agent.swipe({ direction: "up", durationMs: 2000 });
        await Bun.sleep(100);
        await pane.command("take_control");
        expect(await swiping).toStartWith("Swiped from");
        expect(restartedAt).toBeGreaterThanOrEqual(t0 + 1950);
        agent.dispose();
        pane.dispose();
    });

    test("taking the input back waits for typing from another session to end, its Enter included", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("MainScreenButtonsService");
        const agent = session();
        const pane = session();
        await agent.tap({ x: 100, y: 200 });
        await agent.press("a");
        await pane.command("boot");
        const typing = agent.type("hello", { submit: true });
        // During the pause before Enter.
        await Bun.sleep(400);
        await pane.command("take_control");
        expect(await typing).toBe('Typed "hello" and pressed Enter.');
        const lastKeys = Math.max(...readFileSync(OPS, "utf8").split("\n").filter((o) => o.startsWith("keys ")).map((o) => Number(o.split(" ")[1])));
        expect(Number.isFinite(lastKeys)).toBe(true);
        expect(restartedAt).toBeGreaterThanOrEqual(lastKeys);
        agent.dispose();
        pane.dispose();
    });

    test.each([
        ["the agent's", (s: SimulatorSession) => s.button("lock")],
        ["the pane's", (s: SimulatorSession) => s.input({ kind: "button", name: "lock" })],
    ])("taking the input back waits for a button press from another session, %s", async (_, press) => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        await expect(agent.press("a")).rejects.toThrow(/^Keys can't reach/);
        writeFileSync(SLOW, "");
        const pressing = press(agent);
        await Bun.sleep(100);
        await other.takeControl();
        await pressing;
        const pressed = Number(readFileSync(OPS, "utf8").split("\n").find((o) => o.startsWith("button "))?.split(" ")[1]);
        expect(Number.isFinite(pressed)).toBe(true);
        expect(restartedAt).toBeGreaterThanOrEqual(pressed + 400);
        rmSync(SLOW);
        agent.dispose();
        other.dispose();
    });

    test("what couldn't be read, of a process whose pid another has since: take_control doesn't read the new one for it", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        const s = session();
        await s.tap({ x: 100, y: 200 });
        expect(s.state()).toMatchObject({ inputUncertain: true });
        // Taken back elsewhere, and the old pid another process's; the log still can't be read.
        rmSync(HELD);
        await nextInputProcess(true);
        await Bun.sleep(200);
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test.each([
        ["another", false],
        ["its pid reused", true],
    ])("the input process restarting as a tap is sent, by another Cavvy (%s): it's an error", async (_, reusing) => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await s.tap({ x: 100, y: 200 });
        await expect(s.press("a")).rejects.toThrow(/^Keys can't reach/);
        writeFileSync(SLOW, "");
        const tapping = s.tap({ x: 100, y: 200 }).catch((e) => e as Error);
        await Bun.sleep(200);
        rmSync(HELD);
        await nextInputProcess(reusing);
        expect(String(await tapping)).toContain("The input was taken back from another tool as this was sent");
        rmSync(SLOW);
        s.dispose();
    });

    test.each([
        ["", false],
        [", as it's first looked up", true],
    ])("the input process restarting as a tap is sent, nothing known to be taken%s: it's an error", async (_, first) => {
        const s = session();
        // The input process looked up, or being looked up (the tap starts the helper).
        if (first) lookupOkMs = 800;
        else {
            await s.command("boot");
            await Bun.sleep(500);
        }
        writeFileSync(SLOW, "");
        const tapping = s.tap({ x: 100, y: 200 }).catch((e) => e as Error);
        // As the touch is sent.
        while (!existsSync(OPS) || !readFileSync(OPS, "utf8").includes("touch ")) await Bun.sleep(20);
        await Bun.sleep(100);
        await nextInputProcess();
        expect(String(await tapping)).toContain("The input was taken back from another tool as this was sent");
        rmSync(SLOW);
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        s.dispose();
    });

    test("taking the input back, as a tap waits for the Mac to say its input process is the one: it waits for the tap", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        await expect(agent.press("a")).rejects.toThrow(/^Keys can't reach/);
        psSlowOnce = 1500;
        const tapping = agent.tap({ x: 100, y: 200 });
        await Bun.sleep(50);
        await other.takeControl();
        expect(await tapping).toBe("Tapped 100,200.");
        const lastTouch = Math.max(...readFileSync(OPS, "utf8").split("\n").filter((o) => o.startsWith("touch ")).map((o) => Number(o.split(" ")[1])));
        expect(restartedAt).toBeGreaterThanOrEqual(lastTouch);
        agent.dispose();
        other.dispose();
    });

    test("a read again that fails, the Mac not saying when the process started: when an earlier read said it did is kept", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        const s = session();
        await s.tap({ x: 100, y: 200 });
        expect(s.state()).toMatchObject({ inputUncertain: true });
        // A new helper reads again, as ps fails.
        psFails = true;
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        await s.tap({ x: 100, y: 200 });
        psFails = false;
        // Taken back elsewhere, its pid reused; the log still can't be read.
        rmSync(HELD);
        await nextInputProcess(true);
        await Bun.sleep(200);
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test("take_control stopped as it waits for typing: the typing isn't said to be cut short", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("MainScreenButtonsService");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        await agent.press("a");
        writeFileSync(SLOW, "");
        const typing = agent.type("x".repeat(400), { submit: true }).catch((e) => e as Error);
        await Bun.sleep(100);
        const stop = new AbortController();
        const taking = SimulatorControlTool.run({ action: "take_control" }, { ...ctx, signal: stop.signal, state: { ...ctx.state, simulator: other } });
        await Bun.sleep(3000);
        stop.abort();
        expect(await taking).toMatchObject({ isError: true, content: expect.stringContaining("Interrupted by user") });
        expect(String(await typing)).toContain("and pressed Enter.");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        rmSync(SLOW);
        agent.dispose();
        other.dispose();
    }, 30_000);

    test("a read that fails as another Cavvy takes the input back, its pid reused: it's of the process before", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        logMs = 400;
        const s = session();
        await s.command("boot");
        await Bun.sleep(100);
        rmSync(HELD);
        await nextInputProcess(true);
        await Bun.sleep(600);
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test("taken back elsewhere while take_control waits for input being sent: it doesn't restart it again", async () => {
        writeFileSync(HELD, "");
        cut = [disconnected("ExternalKeyboardService"), disconnected("MainScreenButtonsService")].join("\n");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        const swiping = agent.swipe({ direction: "up", durationMs: 2000 }).catch((e) => e as Error);
        await Bun.sleep(100);
        const taking = other.takeControl();
        await Bun.sleep(300);
        rmSync(HELD);
        await nextInputProcess();
        await expect(taking).rejects.toThrow("Nothing has taken iPhone 17's input any more");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        // Restarted under it, elsewhere.
        expect(String(await swiping)).toContain("The input was taken back from another tool as this was sent");
        agent.dispose();
        other.dispose();
    });

    test("input that outlasts take_control's wait for it, and ends as the input process restarts: it's an error, not done", async () => {
        writeFileSync(HELD, "");
        cut = [disconnected("ExternalKeyboardService"), disconnected("MainScreenButtonsService")].join("\n");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        writeFileSync(SLOW, "");
        restart = "slow";
        const swiping = agent.swipe({ direction: "up", durationMs: 300 });
        await Bun.sleep(100);
        const taking = other.takeControl();
        await expect(swiping).rejects.toThrow("The input was taken back from another tool as this was sent");
        rmSync(SLOW);
        await taking;
        agent.dispose();
        other.dispose();
    }, 30_000);

    test("typing into a ref that opens a field to type in (Safari's address on a page): the keys wait for the field", async () => {
        writeFileSync(OPENS, "");
        const s = session();
        expect(await s.snapshot()).toContain('button "Settings" [e1]');
        expect(await s.type("hi", { ref: "e1" })).toBe('Typed "hi".');
        const firstKeys = Math.min(...readFileSync(OPS, "utf8").split("\n").filter((o) => o.startsWith("keys ")).map((o) => Number(o.split(" ")[1])));
        expect(firstKeys).toBeGreaterThanOrEqual(statSync(EDITING).mtimeMs);
        s.dispose();
    });

    test("two of a session's actions at once, outlasting take_control's wait: each is its own, and the one cut short is an error", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("MainScreenButtonsService");
        const agent = session();
        const other = session();
        await agent.tap({ x: 100, y: 200 });
        await agent.press("a");
        writeFileSync(SLOW, "");
        restart = "slow";
        // A swipe of about 9 seconds, and typing of about 7 that starts as it goes.
        const swiping = agent.swipe({ direction: "up", durationMs: 300 }).catch((e) => e as Error);
        await Bun.sleep(50);
        const typing = agent.type("x".repeat(400), { submit: true }).catch((e) => e as Error);
        await Bun.sleep(100);
        const taking = other.takeControl();
        expect(String(await typing)).toContain("The input was taken back from another tool as this was sent");
        expect(String(await swiping)).toContain("The input was taken back from another tool as this was sent");
        rmSync(SLOW);
        await taking;
        agent.dispose();
        other.dispose();
    }, 40_000);

    test("take_control reads again what couldn't be read of the process that runs: it's readable now, and nothing's taken", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        const s = session();
        await s.tap({ x: 100, y: 200 });
        expect(s.state()).toMatchObject({ inputUncertain: true });
        logFails = false;
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        s.dispose();
    });

    test("a read the Mac can't say the start of, of the same process: when it started stays known (its pid used again later is told)", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        psFails = true;
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        psFails = false;
        later = disconnected("ScreenTouchService.00000000-0000-4000-8000-000000000001");
        await nextInputProcess(true);
        await Bun.sleep(2100);
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        s.dispose();
    });

    test("a slow read of the log, which no longer says what was let go of: it's still known", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        cut = "";
        logMs = 6500;
        writeFileSync(DIE, "");
        await s.snapshot().catch(() => undefined);
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        expect(s.state().inputCut).toHaveLength(3);
        s.dispose();
    }, 20_000);

    test("the Mac not saying when the input process started: what's known of it stays while it runs", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        psFails = true;
        rmSync(HELD);
        await Bun.sleep(2100);
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        s.dispose();
    });

    test("the old input process's pid used again, as the new one loses what wasn't known as taken: an input checks which process it is", async () => {
        writeFileSync(HELD, "");
        cut = disconnected("ExternalKeyboardService");
        const s = session();
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach/);
        later = disconnected("ScreenTouchService.00000000-0000-4000-8000-000000000001");
        await nextInputProcess(true);
        await Bun.sleep(2100);
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        expect(s.state().inputCut).toEqual(["touch"]);
        s.dispose();
    });

    test("the input process's pid running another process (the device restarted, and the pid used again): what was known of it is dropped", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        await nextInputProcess(true);
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        expect(s.state().inputCut).toBeUndefined();
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        s.dispose();
    });

    test("once the screen reads after taking it back, whatever app is in front (one the person opened), the bridge is left alone", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        writeFileSync(SAFARI, "");
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        const t0 = Date.now();
        await s.takeControl();
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(ran2.some((a) => a.join(" ").includes("com.apple.CoreSimulator.bridge"))).toBe(false);
        s.dispose();
    });

    test("a read that fails as another Cavvy takes the input back is of the process before: there's nothing to take back", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        logMs = 400;
        const s = session();
        await s.command("boot");
        await Bun.sleep(100);
        // Taken back elsewhere as the log is read.
        rmSync(HELD);
        await nextInputProcess();
        await Bun.sleep(600);
        await expect(s.takeControl()).rejects.toThrow("Nothing has taken iPhone 17's input");
        expect(ran2.some((a) => a.includes("kickstart"))).toBe(false);
        expect(s.state()).not.toHaveProperty("inputUncertain");
        s.dispose();
    });

    test("a read whose input process couldn't be looked up, taken back elsewhere meanwhile: the next input reads again", async () => {
        writeFileSync(HELD, "");
        lookupFails = true;
        const s = session();
        await s.command("boot");
        // The service lets go and the process restarts while the lookups fail; then the device answers again.
        rmSync(HELD);
        await Bun.sleep(150);
        await nextInputProcess();
        await Bun.sleep(700);
        lookupFails = false;
        expect(s.state()).toMatchObject({ inputUncertain: true });
        // It's read again as the tap goes (which isn't held up by it).
        await s.tap({ x: 100, y: 200 });
        await Bun.sleep(200);
        expect(s.state()).not.toHaveProperty("inputUncertain");
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        s.dispose();
    });

    test("lookups that fail slowly, with the pane open: input goes on with the note, held up by a read at most", async () => {
        writeFileSync(HELD, "");
        lookupFails = true;
        lookupMs = 6000;
        const s = session();
        await s.watch({}, () => undefined);
        // The first read fails at six seconds.
        await Bun.sleep(6500);
        expect(s.state()).toMatchObject({ inputUncertain: true });
        const lookups = () => ran2.filter((a) => a.join(" ") === "xcrun simctl spawn AAAA launchctl list").length;
        expect(lookups()).toBe(1);
        // A tap reads again, without waiting for it.
        let t0 = Date.now();
        expect(await s.tap({ x: 100, y: 200 })).toContain("can't be told");
        expect(Date.now() - t0).toBeLessThan(1000);
        // The pane's poll, and another tap, come during that read: they don't queue another behind it.
        await Bun.sleep(4000);
        t0 = Date.now();
        expect(await s.tap({ x: 100, y: 200 })).toContain("can't be told");
        expect(Date.now() - t0).toBeLessThan(1000);
        await Bun.sleep(2500);
        expect(lookups()).toBe(2);
        s.dispose();
    }, 30_000);

    test("taken back elsewhere just after the service let go: the pane stops saying it's taken", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await s.watch({}, () => undefined);
        await s.tap({ x: 100, y: 200 }).catch(() => undefined);
        expect(s.state().inputCut).toHaveLength(3);
        // The other Cavvy tells the service first (this one looks: the input process still runs), then restarts it.
        rmSync(HELD);
        await Bun.sleep(200);
        await nextInputProcess();
        expect(s.state().inputCut).toHaveLength(3);
        await Bun.sleep(5500);
        expect(s.state().inputCut).toBeUndefined();
        s.dispose();
    }, 15_000);

    test("the device's bridge answering for an app that's gone (its home screen restarted): it's restarted, and the screen reads", async () => {
        const s = session();
        await s.tap({ x: 100, y: 200 });
        writeFileSync(GONE, "");
        expect(await s.snapshot()).toContain('"Settings"');
        expect(ran2.filter((a) => a.join(" ").includes("com.apple.CoreSimulator.bridge"))).toHaveLength(1);
        s.dispose();
    });

    test("taking it back failing: what was taken stays known (the service no longer says it has it), and it can be asked for again", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        logFails = true;
        const s = session();
        await s.tap({ x: 100, y: 200 });
        restart = "fails";
        const r = await SimulatorControlTool.run({ action: "take_control" }, { ...ctx, state: { ...ctx.state, simulator: s } });
        expect(r).toMatchObject({ isError: true, content: expect.stringContaining("Could not kickstart service") });
        await Bun.sleep(200);
        expect(s.state()).toMatchObject({ inputUncertain: true });
        expect(await s.tap({ x: 100, y: 200 })).toContain("whether this reached it can't be told");
        restart = "ok";
        logFails = false;
        await s.takeControl();
        expect(ran2.filter((a) => a.includes("kickstart"))).toHaveLength(2);
        expect(s.state()).not.toHaveProperty("inputUncertain");
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        s.dispose();
    });

    test("taking it back failing, and every window gone: whoever looks next finds what was taken", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await expect(s.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        restart = "fails";
        await expect(s.takeControl()).rejects.toThrow("Could not kickstart service");
        s.dispose();
        const next = session();
        await expect(next.tap({ x: 100, y: 200 })).rejects.toThrow(/^Touches can't reach/);
        next.dispose();
    });

    test("a read of the process before that ends after the input's claimed: it's read again", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await s.command("boot");
        await Bun.sleep(100);
        // The tool takes over again as it's taken back, and the new input process loses its keyboard.
        restart = "taken again";
        logMs = 2500;
        later = disconnected("ExternalKeyboardService");
        await s.command("take_control");
        await expect(s.type("hi")).rejects.toThrow(/^Keys can't reach iPhone 17/);
        expect(s.state().inputCut).toEqual(["keyboard"]);
        s.dispose();
    }, 15_000);

    test("what's read of the input process before it was taken back is dropped", async () => {
        writeFileSync(HELD, "");
        cut = ALL;
        const s = session();
        await s.command("boot");
        await Bun.sleep(100);
        expect(s.state().inputCut).toHaveLength(3);
        // The tool takes over again as it's taken back: the read that starts is of the process before, and ends after.
        restart = "taken again";
        logMs = 400;
        expect(await s.command("take_control")).not.toHaveProperty("inputCut");
        await Bun.sleep(600);
        expect(s.state().inputCut).toBeUndefined();
        expect(await s.tap({ x: 100, y: 200 })).toBe("Tapped 100,200.");
        s.dispose();
    });

    test("a claim doesn't come between touches being sent from another session, even one that's moved to another device", async () => {
        writeFileSync(HELD, "");
        cut = [disconnected("ExternalKeyboardService"), disconnected("MainScreenButtonsService")].join("\n");
        const agent = session();
        const pane = session();
        await agent.tap({ x: 100, y: 200 });
        await pane.command("boot");
        // The pane takes the input back; the agent starts a swipe after the restart, before the input's claimed, and its
        // session moves to the iPad meanwhile.
        const taking = pane.command("take_control");
        await Bun.sleep(300);
        const swiping = agent.swipe({ direction: "up", durationMs: 3000 });
        await Bun.sleep(100);
        await agent.command("select", "BBBB");
        await taking;
        expect(readFileSync(OPS, "utf8")).toContain('{"claim":"not touch"}');
        expect(await swiping).toStartWith("Swiped from");
        agent.dispose();
        pane.dispose();
    });

    test("what was taken can't be read: input goes, and the results say it may not have", async () => {
        writeFileSync(HELD, "");
        logFails = true;
        const s = session();
        expect(await s.tap({ x: 100, y: 200 })).toMatch(/^Tapped 100,200\. Another tool \(.*\) has taken over iPhone 17's input, and whether this reached it can't be told: if nothing changed, SimulatorControl action=take_control takes the input back \(.*\)\.$/);
        expect(await s.snapshot()).toContain("and what it took can't be read");
        // The pane says it may have been taken, and offers to take it back.
        expect(s.state()).toMatchObject({ inputUncertain: true });
        expect(s.state().inputCut).toBeUndefined();
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
