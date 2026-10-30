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
    // What the screen reads as, when this exists: the helper's answer.
    const TREE = join(W, "tree");
    // What the picture reads as, when this exists.
    const LINES = join(W, "lines");
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
    /** How long listing the devices takes. */
    let listMs = 0;
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
    const pasted: string[] = [];
    let onCopy = () => {};
    let onOpen = () => {};
    beforeEach(async () => {
        const hash = createHash("sha256").update(HELPER_SOURCE).update("\0").update(DEV).digest("hex").slice(0, 16);
        const bin = join(paths.home(), "simulator", hash, "cavvy-sim");
        mkdirSync(dirname(bin), { recursive: true });
        writeFileSync(
            bin,
            `#!${process.execPath}
const { existsSync, appendFileSync, readFileSync, rmSync, writeFileSync } = require("fs");
const out = (o) => { const p = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(5); h[0] = 74; h.writeUInt32BE(p.length, 1); process.stdout.write(Buffer.concat([h, p])); };
const held = () => existsSync(${JSON.stringify(HELD)});
let said = held();
const tell = () => { if (held() !== said) { said = held(); out({ event: "input", held: said }); } };
setInterval(tell, 50);
out({ event: "ready", width: 1206, height: 2622, scale: 3, held: said });
for await (const line of console) {
    const c = JSON.parse(line);
    if (existsSync(${JSON.stringify(DIE)})) { rmSync(${JSON.stringify(DIE)}); process.exit(0); }
    appendFileSync(${JSON.stringify(OPS)}, (c.op === "claim" ? JSON.stringify({ claim: c.touch ? (c.keys ? "all" : "not keys") : "not touch" }) : \`\${c.op} \${Date.now()} \${JSON.stringify(c.keys ?? c.phase ?? "")}\`) + "\\n");
    if (["touch", "keys", "button"].includes(c.op) && existsSync(${JSON.stringify(SLOW)})) await Bun.sleep(400);
    if (c.op === "touch" && c.phase === "up" && existsSync(${JSON.stringify(OPENS)})) setTimeout(() => writeFileSync(${JSON.stringify(EDITING)}, ""), 500);
    tell();
    if (c.op === "describe" && existsSync(${JSON.stringify(GONE)})) out({ id: c.id, tree: { role: "AXApplication" }, pid: 99999, gone: true, stillMs: 1000 });
    else if (c.op === "text" && existsSync(${JSON.stringify(LINES)})) out({ id: c.id, lines: JSON.parse(readFileSync(${JSON.stringify(LINES)}, "utf8")) });
    else if (c.op === "describe" && existsSync(${JSON.stringify(TREE)})) out({ id: c.id, stillMs: 1000, ...JSON.parse(readFileSync(${JSON.stringify(TREE)}, "utf8")) });
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
        rmSync(TREE, { force: true });
        rmSync(LINES, { force: true });
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
        listMs = 0;
        logMs = 0;
        inputs = [];
        await nextInputProcess();
        restart = "ok";
        ran2.length = 0;
        pasted.length = 0;
        simctl.setRunner(async (args, o) => {
            ran2.push(args);
            if (args.includes("openurl")) {
                onOpen();
                onOpen = () => {};
            }
            if (args.includes("pbcopy")) {
                pasted.push(String(o?.input));
                onCopy();
                onCopy = () => {};
            }
            const line = args.join(" ");
            if (line === "xcrun simctl list devices -j") {
                await Bun.sleep(listMs);
                return { code: 0, stdout: DEVICES.replace('"Shutdown"', '"Booted"'), stderr: "" };
            }
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

    test("the pane's touches don't wait on simctl: a fast swipe isn't held back and sent at once", async () => {
        const s = session();
        await s.command("boot");
        // What's known of the devices has gone stale, and asking again is slow.
        await Bun.sleep(1100);
        listMs = 600;
        const started = Date.now();
        await s.input({ kind: "touch", phase: "down", x: 0.8, y: 0.5 });
        await s.input({ kind: "touch", phase: "move", x: 0.5, y: 0.5 });
        await s.input({ kind: "touch", phase: "up", x: 0.2, y: 0.5 });
        expect(Date.now() - started).toBeLessThan(400);
        s.dispose();
    });

    /** What was sent, by kind: each `keys` batch's strokes, each touch's phase. */
    const sent = (op: string) =>
        readFileSync(OPS, "utf8")
            .split("\n")
            .filter((o) => o.startsWith(`${op} `))
            .map((o) => JSON.parse(o.split(" ").slice(2).join(" ")));
    const FORM = (fields: Record<string, unknown>[]) => JSON.stringify({ pid: 5, process: "Final", tree: { role: "AXApplication", children: fields } });
    const FIELD = { role: "AXTextField", value: "hello", frame: [20, 100, 200, 40] };
    const PASSWORD = { role: "AXTextField", subrole: "AXSecureTextField", value: "Password", frame: [20, 200, 200, 40] };
    const [META, A, BACKSPACE, ENTER, ARROW_DOWN] = [0xe3, 0x04, 0x2a, 0x28, 0x51];
    /** The last ref in an outline. */
    const lastRef = (outline: string) => [...outline.matchAll(/\[(e\d+)\]/g)].at(-1)![1]!;
    const pressed = (usage: number) => sent("keys").some((batch) => batch.some((k: [number, boolean]) => k[0] === usage && k[1]));

    test("the person having used the screen, a ref is refused with the screen as it is, and nothing is sent", async () => {
        const s = session();
        await s.snapshot();
        await s.input({ kind: "touch", phase: "down", x: 0.5, y: 0.5 });
        await s.input({ kind: "touch", phase: "up", x: 0.5, y: 0.5 });
        const touches = sent("touch").length;
        const refused = (await s.tap({ ref: "e1" }).catch((e) => e)) as Error;
        expect(refused.message).toContain("Not done: e1 may not be what it was.");
        expect(refused.message).toContain('- button "Settings" [e2]');
        expect(sent("touch")).toHaveLength(touches);
        // It has read the screen now, and the refs are new.
        await expect(s.tap({ ref: "e1" })).rejects.toThrow("There's no ref e1");
        const again = lastRef(await s.snapshot());
        expect(await s.tap({ ref: again })).toContain("Tapped");
        const typing = lastRef(await s.snapshot());
        await s.input({ kind: "touch", phase: "down", x: 0.5, y: 0.5 });
        await s.input({ kind: "touch", phase: "up", x: 0.5, y: 0.5 });
        await expect(s.type("secret", { ref: typing })).rejects.toThrow("Not done");
        expect(sent("keys")).toHaveLength(0);
        // A point is what the agent says it is.
        await s.input({ kind: "touch", phase: "down", x: 0.5, y: 0.5 });
        await s.input({ kind: "touch", phase: "up", x: 0.5, y: 0.5 });
        expect(await s.tap({ x: 10, y: 10 })).toContain("Tapped");
        s.dispose();
    });

    test("a ref used by one action isn't good for another alongside it", async () => {
        const s = session();
        const first = lastRef(await s.snapshot());
        const results = await Promise.allSettled([s.tap({ ref: first }), s.tap({ ref: first })]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain(`There's no ref ${first}`);
        // Nor for what comes with a button press, whichever goes first.
        const second = lastRef(await s.snapshot());
        const typed = sent("keys").length;
        const [pressed2, typing] = await Promise.allSettled([s.button("home"), s.type("secret", { ref: second })]);
        expect(pressed2.status).toBe("fulfilled");
        expect(String((typing as PromiseRejectedResult).reason)).toContain(`There's no ref ${second}`);
        expect(sent("keys")).toHaveLength(typed);
        s.dispose();
    });

    test("a ref from before an action, sent after its outline (a batch, one call after another), is refused, never another element", async () => {
        const s = session();
        const old = lastRef(await s.snapshot());
        // The first call of the batch: it acts and reads the new screen, as every action's result does.
        await s.tap({ ref: old });
        const now = await s.snapshot();
        expect(now).not.toContain(`[${old}]`);
        const touches = sent("touch").length;
        await expect(s.tap({ ref: old })).rejects.toThrow(`There's no ref ${old}`);
        expect(sent("touch")).toHaveLength(touches);
        s.dispose();
    });

    test("another session moved the screen: a ref is refused with the screen as it is, and nothing is sent", async () => {
        const a = session();
        const b = session();
        const screen = (label: string, pid: number, y = 100) => JSON.stringify({ pid, process: "Final", tree: { role: "AXApplication", children: [{ role: "AXButton", label, frame: [20, y, 200, 40] }] } });
        for (const [what, after] of [
            ["another app in front", screen("Tap me", 7)],
            ["another element there", screen("Row 0", 5)],
            ["moved", screen("Tap me", 5, 300)],
        ] as const) {
            writeFileSync(TREE, screen("Tap me", 5));
            const ref = lastRef(await a.snapshot());
            await b.snapshot();
            writeFileSync(TREE, after);
            const touches = existsSync(OPS) ? sent("touch").length : 0;
            const refused = (await a.tap({ ref }).catch((e) => e)) as Error;
            expect(`${what}: ${refused.message}`).toContain(`Not done: ${ref} isn't there any more`);
            expect(refused.message).toContain("Screen");
            expect(existsSync(OPS) ? sent("touch").length : 0).toBe(touches);
        }
        // Nothing changed: it goes.
        writeFileSync(TREE, screen("Tap me", 5));
        expect(await a.tap({ ref: lastRef(await a.snapshot()) })).toContain("Tapped");
        a.dispose();
        b.dispose();
    });

    test("a line read from the picture is looked for in the picture again", async () => {
        const s = session();
        writeFileSync(TREE, FORM([]));
        writeFileSync(LINES, JSON.stringify([{ text: "Learn more", confidence: 1, frame: [20, 300, 100, 20] }]));
        const ref = /seen "Learn more" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        writeFileSync(LINES, JSON.stringify([{ text: "Something else", confidence: 1, frame: [20, 300, 100, 20] }]));
        await expect(s.tap({ ref })).rejects.toThrow(`Not done: ${ref} isn't there any more`);
        const again = /seen "Something else" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        expect(await s.tap({ ref: again })).toContain("Tapped");
        s.dispose();
    });

    test("a button whose label counts is tapped by ref, and said as it reads now; a list that moved isn't", async () => {
        const s = session();
        const screen = (...labels: string[]) => FORM(labels.map((label, i) => ({ role: "AXButton", label, frame: [20, 100 + i * 50, 200, 40] })));
        writeFileSync(TREE, screen("Resend in 997", "Steady"));
        const ref = /"Resend in 997" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        writeFileSync(TREE, screen("Resend in 990", "Steady"));
        expect(await s.tap({ ref })).toBe(`Tapped "Resend in 990" [${ref}].`);

        const rows = (n: number) => screen(`Item ${n}`, `Item ${n + 1}`, `Item ${n + 2}`);
        writeFileSync(TREE, rows(5));
        const row = /"Item 5" \[(e\d+)\]/.exec(await s.snapshot())![1]!;
        writeFileSync(TREE, rows(6));
        const touches = sent("touch").length;
        const refused = (await s.tap({ ref: row }).catch((e) => e)) as Error;
        expect(refused.message).toContain(`Not done: ${row} isn't there any more`);
        expect(refused.message).toContain("tap it by x,y");
        expect(sent("touch").length).toBe(touches);
        s.dispose();
    });

    test("text waits for the caret's move to a web field's end, or the page loses some of it", async () => {
        const s = session();
        writeFileSync(TREE, FORM([]));
        writeFileSync(LINES, JSON.stringify([{ text: "prefilled text", confidence: 1, frame: [20, 300, 100, 20] }]));
        await s.type("x", { ref: lastRef(await s.snapshot()) });
        const batches = readFileSync(OPS, "utf8").split("\n").filter((o) => o.startsWith("keys "));
        const at = (o: string) => Number(o.split(" ")[1]);
        expect(batches).toHaveLength(2);
        expect(batches[0]).toContain(`[${ARROW_DOWN},true]`);
        expect(at(batches[1]!) - at(batches[0]!)).toBeGreaterThanOrEqual(140);
        s.dispose();
    });

    test("paste puts text in through the pasteboard, as written", async () => {
        const s = session();
        writeFileSync(TREE, FORM([FIELD]));
        expect(await s.type("user.name@example.com", { paste: true })).toBe('Pasted "user.name@example.com".');
        const down = sent("keys")[0].filter((k: [number, boolean]) => k[1]).map((k: [number, boolean]) => k[0]);
        expect(down).toEqual([META, 0x19]);
        s.dispose();
    });

    test("what's pasted doesn't stay on the device's pasteboard, stopped or not", async () => {
        const s = session();
        writeFileSync(TREE, FORM([FIELD]));
        const copies = () => pasted.slice();
        await s.type("hunter2", { paste: true });
        expect(copies()).toEqual(["hunter2", ""]);
        // Stopped once it's there, before it's pasted.
        const stop = new AbortController();
        pasted.length = 0;
        onCopy = () => stop.abort();
        const keys = sent("keys").length;
        await expect(s.type("hunter2", { paste: true }, stop.signal)).rejects.toThrow();
        expect(sent("keys").length).toBe(keys);
        expect(copies()).toEqual(["hunter2", ""]);
        s.dispose();
    });

    test("the result says when iOS changed what was typed; not when it's there as typed, or wasn't typed", async () => {
        const s = session();
        const run = async (field: string, input: Record<string, unknown>) => {
            writeFileSync(TREE, FORM([{ ...FIELD, selection: [0, 5], value: field }]));
            return String(((await SimulatorActTool.run({ action: "type", ...input } as any, { ...ctx, state: { ...ctx.state, simulator: s } })) as { content: unknown }).content).split("\n")[0]!;
        };
        await s.snapshot();
        expect(await run("User.name@example.com", { text: "user.name@example.com" })).toContain("iOS seems to have changed it");
        expect(await run("The quick brown fox", { text: "teh quick brwon fox" })).toContain("iOS seems to have changed it");
        expect(await run("user.name@example.com", { text: "user.name@example.com" })).not.toContain("changed it");
        expect(await run("nothing like it", { text: "user.name@example.com" })).not.toContain("changed it");
        expect(await run("User.name@example.com", { text: "user.name@example.com", paste: true })).not.toContain("changed it");
        // A line break shows as a space; a narrow field shows the end; an unrelated line with a word of it isn't the field.
        expect(await run("first line here second line here", { text: "first line here\nsecond line here" })).not.toContain("changed it");
        expect(await run("over the lazy dog", { text: "the quick brown fox over the lazy dog" })).not.toContain("changed it");
        expect(await run("Welcome john", { text: "john smith" })).not.toContain("changed it");
        // Pressing Enter went on: what's on the screen now says nothing of the field.
        expect(await run("john smith WELCOME", { text: "JOHN SMITH", submit: true })).not.toContain("changed it");
        // Wrapped onto two of the picture's lines, it's as typed.
        writeFileSync(LINES, JSON.stringify([{ text: "the first half of a long line", confidence: 1, frame: [20, 300, 300, 20] }, { text: "and its second half", confidence: 1, frame: [20, 330, 300, 20] }]));
        expect(await run("hello", { text: "the first half of a long line and its second half" })).not.toContain("changed it");
        s.dispose();
    });

    test("an app a tap started is waited for; the app already read, with nothing to read, isn't", async () => {
        const s = session();
        const app = (pid: number, children: unknown[]) => JSON.stringify({ pid, process: "App", tree: { role: "AXApplication", children } });
        writeFileSync(TREE, app(5, [{ role: "AXButton", label: "Icon", frame: [20, 100, 200, 40] }]));
        await s.snapshot();
        writeFileSync(TREE, app(9, []));
        setTimeout(() => writeFileSync(TREE, app(9, [{ role: "AXButton", label: "Ready", frame: [20, 100, 200, 40] }])), 900);
        const started = (await SimulatorActTool.run({ action: "tap", x: 50, y: 50 } as any, { ...ctx, state: { ...ctx.state, simulator: s } })) as { content: string };
        expect(started.content).toContain('"Ready"');

        writeFileSync(TREE, app(9, []));
        await s.snapshot();
        const at = Date.now();
        const still = (await SimulatorActTool.run({ action: "tap", x: 50, y: 50 } as any, { ...ctx, state: { ...ctx.state, simulator: s } })) as { content: string };
        expect(still.content).toContain("nothing on the screen can be read");
        expect(Date.now() - at).toBeLessThan(2500);
        s.dispose();
    }, 15_000);

    test("open_url waits for Safari's page to show text; another app has its own to read", async () => {
        const s = session();
        const open = () => SimulatorControlTool.run({ action: "open_url", url: "http://example.com/" } as any, { ...ctx, state: { ...ctx.state, simulator: s } }) as Promise<{ content: string }>;
        const front = (process: string, changes = 0) => JSON.stringify({ pid: 5, process, changes, tree: { role: "AXApplication", children: [{ role: "AXButton", label: "Back", frame: [34, 780, 48, 48] }] } });
        writeFileSync(TREE, front("MobileSafari"));
        writeFileSync(LINES, "[]");
        // It moves to the page at once, and the page's text comes well after the screen is still.
        onOpen = () => {
            writeFileSync(TREE, front("MobileSafari", 1));
            setTimeout(() => writeFileSync(LINES, JSON.stringify([{ text: "Example Domain", confidence: 1, frame: [20, 300, 200, 20] }])), 2500);
        };
        expect((await open()).content).toContain('seen "Example Domain"');

        writeFileSync(TREE, front("App"));
        writeFileSync(LINES, "[]");
        const at = Date.now();
        await s.untilPage(8000);
        expect(Date.now() - at).toBeLessThan(1000);
        s.dispose();
    }, 20_000);

    test("clear with no text empties the field", async () => {
        const s = session();
        expect(await s.type("", { clear: true })).toBe("Cleared the field.");
        expect(sent("keys")).toHaveLength(1);
        expect(SimulatorActTool.validate!({ action: "type", clear: true }, ctx)).toBeUndefined();
        expect(SimulatorActTool.validate!({ action: "type" }, ctx)).toBe("type needs text, or clear");
        s.dispose();
    });

    test("Stop lifts a finger held down or moving, and what's left isn't sent", async () => {
        const s = session();
        const stop = new AbortController();
        const holding = s.tap({ x: 10, y: 10 }, { holdMs: 5000 }, stop.signal);
        await Bun.sleep(150);
        let started = Date.now();
        stop.abort();
        await expect(holding).rejects.toThrow("Interrupted by user.");
        expect(Date.now() - started).toBeLessThan(1000);
        expect(sent("touch")).toEqual(["down", "up"]);

        const stop2 = new AbortController();
        const swiping = s.swipe({ direction: "up", durationMs: 5000 }, stop2.signal);
        await Bun.sleep(150);
        started = Date.now();
        stop2.abort();
        await expect(swiping).rejects.toThrow("Interrupted by user.");
        expect(Date.now() - started).toBeLessThan(1000);
        expect(sent("touch").at(-1)).toBe("up");
        s.dispose();
    });

    test("Stop before Enter: type doesn't press it, and press sends nothing", async () => {
        const s = session();
        const stop = new AbortController();
        const typing = s.type("hi", { submit: true }, stop.signal);
        await Bun.sleep(500);
        stop.abort();
        await expect(typing).rejects.toThrow("Interrupted by user.");
        expect(pressed(ENTER)).toBe(false);
        const before = sent("keys").length;
        await expect(s.press("Enter", [], stop.signal)).rejects.toThrow("Interrupted by user.");
        expect(sent("keys")).toHaveLength(before);
        s.dispose();
    });

    test("in the pane, a key follows text sent before it", async () => {
        const s = session();
        await s.snapshot();
        await Promise.all([s.input({ kind: "text", text: "hi" }), s.input({ kind: "key", code: "Enter", down: true }), s.input({ kind: "key", code: "Enter", down: false })]);
        const usages = sent("keys").flat().map((k: [number, boolean]) => k[0]);
        expect(usages.indexOf(ENTER)).toBeGreaterThan(usages.findIndex((u: number) => u !== ENTER));
        s.dispose();
    });

    test("what's typed in a password field isn't said back; elsewhere it is", async () => {
        const s = session();
        writeFileSync(TREE, FORM([FIELD, PASSWORD]));
        const outline = await s.snapshot();
        expect(outline).toContain('- securefield value="Password" [e2]');
        const by = await s.type("hunter2", { ref: "e2" });
        expect(by).toBe("Typed 7 characters, not shown as a password field is involved.");
        // Without a ref it may be the one the keys go to.
        expect(await s.type("hunter2")).not.toContain("hunter2");
        writeFileSync(TREE, FORM([FIELD]));
        expect(await s.type("hello", { ref: lastRef(await s.snapshot()) })).toBe('Typed "hello".');
        expect(await s.type("hello")).toBe('Typed "hello".');
        s.dispose();
    });

    test("type by ref goes at the field's end, unless the tap selected what's there; clear replaces it", async () => {
        const s = session();
        writeFileSync(TREE, FORM([{ ...FIELD, selection: [2, 0] }]));
        await s.type("x", { ref: lastRef(await s.snapshot()) });
        expect(pressed(ARROW_DOWN)).toBe(true);

        rmSync(OPS);
        writeFileSync(TREE, FORM([{ ...FIELD, selection: [0, 5] }]));
        await s.type("x", { ref: lastRef(await s.snapshot()) });
        expect(pressed(ARROW_DOWN)).toBe(false);

        rmSync(OPS);
        writeFileSync(TREE, FORM([{ ...FIELD, selection: [2, 0] }]));
        await s.type("x", { ref: lastRef(await s.snapshot()), clear: true });
        expect(pressed(ARROW_DOWN)).toBe(false);
        expect(sent("keys")[0].filter((k: [number, boolean]) => k[1]).map((k: [number, boolean]) => k[0])).toEqual([META, A, BACKSPACE]);
        s.dispose();
    });

    test("lock waits for the lock screen, from an app and from the home screen", async () => {
        const s = session();
        for (const [before, after] of [
            [{ pid: 5, process: "Final", tree: { role: "AXApplication", label: "Final" } }, { pid: 1, process: "SpringBoard", tree: { role: "AXApplication" } }],
            [{ pid: 1, process: "SpringBoard", tree: { role: "AXApplication", label: "Home" } }, { pid: 1, process: "SpringBoard", tree: { role: "AXApplication" } }],
        ]) {
            writeFileSync(TREE, JSON.stringify(before));
            await s.snapshot();
            const started = Date.now();
            let done = 0;
            const locking = s.button("lock").then(() => (done = Date.now()));
            await Bun.sleep(700);
            writeFileSync(TREE, JSON.stringify(after));
            await locking;
            expect(done - started).toBeGreaterThanOrEqual(700);
        }
        s.dispose();
    });

    test("wait finds text the picture read with a space the page hasn't got", async () => {
        const s = session();
        writeFileSync(TREE, FORM([{ role: "AXStaticText", label: "example. com", frame: [20, 100, 200, 40] }]));
        expect(await s.waitFor("example.com", 2000)).toContain("is on the screen");
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
        const swiping = agent.swipe({ direction: "up", durationMs: 1000 }).catch((e) => e as Error);
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
    }, 15_000);

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
