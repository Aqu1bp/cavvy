// The simulator tools: Xcode's iOS simulators, which the agent drives (src/simulator) and the user can watch and use
// too in the GUI's Simulator pane. Four tools, to keep their definitions short (every one goes to the model with
// every request): control (devices and apps), read (snapshot, screenshot), act. They share a session's device
// through ToolState.simulator.

import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import { simulatorEnabled, type Settings } from "../config/settings";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import { simulatorsLikely } from "../simulator/simctl";
import { sentence, SimulatorError, SimulatorSession } from "../simulator/session";
import { redact } from "../util/redact";
import { imageMarkdown, saveScreenshot } from "./browser-tools";
import type { Tool, ToolContext, ToolResult } from "./types";

/** The names these tools have when Cavvy serves them to Claude Code and Codex (mcp__cavvy__simulator_act). */
export const SIMULATOR_SERVER_TOOLS = ["simulator_control", "simulator_snapshot", "simulator_act", "simulator_screenshot"];

const CONTROLS = ["list", "boot", "shutdown", "install", "launch", "terminate", "open_url", "take_control"] as const;
const ACTIONS = ["tap", "double_tap", "long_press", "swipe", "type", "press", "button", "wait"] as const;
const BUTTONS = ["home", "lock"] as const;
const DIRECTIONS = ["up", "down", "left", "right"] as const;

function simulatorOf(ctx: ToolContext): SimulatorSession {
    return (ctx.state.simulator ??= new SimulatorSession({ settings: () => ctx.settings }));
}

/** Runs a call on the session's simulator, turning what goes wrong into the result. */
async function guarded(ctx: ToolContext, fn: (s: SimulatorSession) => Promise<ToolResult>): Promise<ToolResult> {
    try {
        if (ctx.signal.aborted) throw new SimulatorError("Interrupted by user.");
        return await fn(simulatorOf(ctx));
    } catch (e) {
        if (ctx.signal.aborted) return { content: "Interrupted by user", isError: true };
        const message = e instanceof SimulatorError ? e.message : `Simulator error: ${(e as Error).message ?? String(e)}`;
        return { content: redact(message), isError: true };
    }
}

/** How long `open_url` waits for a web page to show text, once the screen is still. */
const PAGE_WAIT_MS = 8000;

/**
 * What the screen shows once it's still (at most a few seconds after an action, and not before 0.6: what an action
 * does can take half a second to start showing), as the result's tail.
 */
async function after(s: SimulatorSession, done: string, ctx: ToolContext, waitMs = 2500, typed?: string): Promise<ToolResult> {
    await s.settle(waitMs, ctx.signal, 600).catch(() => undefined);
    await s.untilStarted(4000, ctx.signal).catch(() => undefined);
    // What was done is done: a screen that can't be read now says so, and the action still stands.
    const screen = await s.snapshot().catch((e) => `The screen couldn't be read: ${sentence((e as Error).message)} Try SimulatorSnapshot again.`);
    const changed = typed && done.startsWith("Typed \"") && reworded(typed, screen) ? " iOS seems to have changed it (capitals, corrections): the outline has what's there, and paste puts text in without them." : "";
    return { content: `${done}${changed}\n\n${screen}`, display: { summary: done } };
}

/**
 * Whether the screen has a line with most of the words typed, but not as typed. The outline shows a line break as a
 * space, text wrapping onto the picture's next line as two lines, and a narrow field only the end of its text.
 */
function reworded(typed: string, screen: string): boolean {
    const text = typed.replace(/\s+/g, " ").trim();
    const escaped = JSON.stringify(text).slice(1, -1);
    const shown = screen.replace(/" \[e\d+\]\n\s*- seen "/g, " ");
    if (shown.includes(escaped)) return false;
    if ([...shown.matchAll(/"((?:[^"\\]|\\.)*)"/g)].some((m) => m[1]!.length >= 4 && escaped.endsWith(m[1]!))) return false;
    const words = text.toLowerCase().split(" ");
    return screen.split("\n").some((l) => {
        const line = new Set(l.toLowerCase().split(/[\s"]+/));
        const has = words.filter((w) => line.has(w)).length;
        return has >= Math.min(2, words.length) && has / words.length >= 0.5;
    });
}

const short = (text: string, n = 60) => {
    const s = redact(text);
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** A path the agent gave, from the session's folder. */
function pathOf(p: string, ctx: ToolContext): string {
    return isAbsolute(p) ? p : resolve(ctx.state.cwd, p);
}

// ---------------------------------------------------------------------------

interface ControlInput {
    action: (typeof CONTROLS)[number];
    device?: string;
    app?: string;
    bundleId?: string;
    args?: string[];
    url?: string;
}

export const SimulatorControlTool: Tool<ControlInput> = {
    name: "SimulatorControl",
    category: "execute",
    readOnly: (i) => i.action === "list",
    description: `Manages Xcode's iOS simulators, which the user can watch (and use too) in Cavvy's Simulator pane. action:
- list: the devices and which is booted.
- boot: start a device (by name like "iPhone 17", or UDID; the session's when left out) and use it; returns its screen.
- shutdown: stop it.
- install: a built .app (path to the .app folder, e.g. from xcodebuild's build/Build/Products/Debug-iphonesimulator); returns its bundle id.
- launch: start an app by bundle id, or bring it to the front as it is if it's running; with args (launch arguments) it starts afresh. Returns its screen.
- terminate: end an app. open_url: open a URL or deep link.
- take_control: take the device's input back when another tool has taken it (a snapshot says so). It restarts the home screen, closing the apps.
To build an app for it: xcodebuild -scheme <scheme> -destination 'platform=iOS Simulator,id=<UDID>' -derivedDataPath build build.`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: [...CONTROLS] },
            device: { type: "string", description: "boot, shutdown: a device's name or UDID" },
            app: { type: "string", description: "install: path to the .app" },
            bundleId: { type: "string", description: "launch, terminate: the app's bundle id" },
            args: { type: "array", items: { type: "string" }, description: "launch: arguments for the app" },
            url: { type: "string", description: "open_url: the URL" },
        },
        required: ["action"],
    },
    title: (i) => `SimulatorControl(${i.action}${i.device ? ` ${i.device}` : ""}${i.bundleId ? ` ${i.bundleId}` : ""}${i.app ? ` ${short(i.app.split("/").pop() ?? i.app, 40)}` : ""}${i.url ? ` ${short(i.url, 40)}` : ""})`,
    enabled: ({ settings }) => simulatorAvailable(settings),
    validate(input, ctx) {
        if (!CONTROLS.includes(input.action)) return `Unknown action "${String(input.action)}"`;
        if (input.action === "install") {
            if (typeof input.app !== "string" || !input.app.trim()) return "install needs app, the path to a .app";
            const p = pathOf(input.app, ctx);
            if (!/\.app\/?$/.test(p)) return "app must be a .app folder";
            if (!existsSync(p) || !statSync(p).isDirectory()) return `There's no app at ${p}`;
        }
        if ((input.action === "launch" || input.action === "terminate") && (typeof input.bundleId !== "string" || !input.bundleId.trim())) return `${input.action} needs a bundleId`;
        if (input.action === "open_url" && (typeof input.url !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(input.url))) return "open_url needs a url";
        return undefined;
    },
    async preview(input) {
        const what: Record<string, string> = {
            boot: `Start ${input.device ?? "the simulator"}`,
            shutdown: `Shut down ${input.device ?? "the simulator"}`,
            install: `Install ${input.app?.split("/").pop() ?? "an app"} on the simulator`,
            launch: `Launch ${input.bundleId} on the simulator`,
            terminate: `End ${input.bundleId} on the simulator`,
            open_url: `Open ${short(input.url ?? "", 80)} on the simulator`,
            take_control: "Take the simulator's input back (closes its apps)",
        };
        return { summary: what[input.action] ?? `Simulator: ${input.action}` };
    },
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            switch (input.action) {
                case "list":
                    return { content: await s.devicesText() };
                case "boot": {
                    const { device: d, started } = await s.boot(input.device, ctx.signal);
                    const done = `${d.name} (${d.runtime}) is running.`;
                    if (!started) return after(s, done, ctx);
                    const screen = await s.steadySnapshot(15_000, ctx.signal).catch((e) => `The screen couldn't be read: ${sentence((e as Error).message)} Try SimulatorSnapshot again.`);
                    return { content: `${done}\n\n${screen}`, display: { summary: done } };
                }
                case "shutdown": {
                    const d = await s.shutdown(input.device, ctx.signal);
                    return { content: `Shut down ${d.name}.`, display: { summary: `Shut down ${d.name}` } };
                }
                case "install": {
                    const app = pathOf(input.app!, ctx);
                    const id = await s.install(app, ctx.signal);
                    const done = `Installed ${app.replace(/\/$/, "").split("/").pop()}${id ? ` (bundle id ${id})` : ""}.`;
                    return { content: done, display: { summary: done } };
                }
                case "launch": {
                    const args = input.args ?? [];
                    const { pid, running, front } = await s.launch(input.bundleId!, args, ctx.signal);
                    const p = pid ? ` (process ${pid})` : "";
                    const done = running
                        ? `${input.bundleId} was running: brought it to the front as it was${p}. To start it afresh, terminate it first.`
                        : args.length
                          ? `Started ${input.bundleId} afresh with the arguments${p}.`
                          : `Launched ${input.bundleId}${p}.`;
                    return after(s, `${done}${pid && !front ? " It isn't in front yet." : ""}`, ctx, 5000);
                }
                case "terminate":
                    await s.terminate(input.bundleId!, ctx.signal);
                    return after(s, `Ended ${input.bundleId}.`, ctx);
                case "open_url":
                    await s.openUrl(input.url!, ctx.signal);
                    await s.settle(4000, ctx.signal, 600).catch(() => undefined);
                    await s.untilPage(PAGE_WAIT_MS, ctx.signal).catch(() => undefined);
                    return after(s, `Opened ${short(input.url!, 120)}.`, ctx, 1000);
                case "take_control": {
                    const d = await s.takeControl(ctx.signal);
                    return after(s, `Took ${d.name}'s input back: its home screen restarted, and its apps closed.`, ctx);
                }
            }
        }),
};

// ---------------------------------------------------------------------------

export const SimulatorSnapshotTool: Tool<{ screenshot?: boolean }> = {
    name: "SimulatorSnapshot",
    category: "read",
    readOnly: true,
    description: `Reads the simulator's screen as a text outline from its accessibility tree: buttons, text, fields, cells and switches with their labels and values, and a ref like [e12] on each that SimulatorAct can tap. Text the tree lacks (a web page's) is read from the picture and listed after it as seen "…" lines, with refs too. Refs last until your next action, which returns a new outline with new refs. If the screen has changed since, or the user has used it, a ref is refused and you get the new outline. Coordinates are in points. Pass screenshot only when how it looks matters: the outline is cheaper and exact.`,
    parameters: {
        type: "object",
        properties: { screenshot: { type: "boolean", description: "Also return a screenshot" } },
    },
    title: (i) => `SimulatorSnapshot(${i.screenshot ? "screenshot" : "screen"})`,
    enabled: ({ settings }) => simulatorAvailable(settings),
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            const content = await s.snapshot();
            if (!input.screenshot) return { content };
            const shot = await s.screenshot();
            return { content, images: [{ type: "image", mediaType: "image/png", data: Buffer.from(shot.png).toString("base64") }] };
        }),
};

// ---------------------------------------------------------------------------

interface ActInput {
    action: (typeof ACTIONS)[number];
    ref?: string;
    x?: number;
    y?: number;
    toX?: number;
    toY?: number;
    direction?: (typeof DIRECTIONS)[number];
    durationMs?: number;
    text?: string;
    submit?: boolean;
    clear?: boolean;
    paste?: boolean;
    key?: string;
    modifiers?: string[];
    button?: (typeof BUTTONS)[number];
    timeoutMs?: number;
}

export const SimulatorActTool: Tool<ActInput> = {
    name: "SimulatorAct",
    category: "execute",
    readOnly: (i) => i.action === "wait",
    description: `Acts on the simulator as a finger and a hardware keyboard would. action:
- tap, double_tap, long_press: at ref (from a snapshot; preferred) or at x and y in points.
- swipe: from ref or x,y (default: the middle) to toX,toY, or by direction (up, down, left, right: the way the finger moves, so up scrolls further down a list); durationMs (default 300).
- type: text into the focused field (ref taps a field first, and adds to its end); clear replaces what's in it, or with no text empties it; submit then presses Enter. iOS capitalizes and corrects what's typed in a field that lets it, as it does for anyone: paste puts text in without that, through the device's pasteboard (added to what's in a field, iOS may adjust the spaces around it).
- press: a key such as Enter, Backspace, Tab, Escape, ArrowDown, or a combination like Meta+A (more modifiers in modifiers).
- button: home or lock.
- wait: for text to show (timeoutMs, default 10000); with no text, for the screen to be still.
Returns the screen once it's still, as a new outline; it says when the user used the simulator since you last looked.`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: [...ACTIONS] },
            ref: { type: "string", description: "An element's ref from a snapshot, like e12" },
            x: { type: "number", description: "Horizontal position in points" },
            y: { type: "number", description: "Vertical position in points" },
            toX: { type: "number", description: "swipe: where it ends" },
            toY: { type: "number", description: "swipe: where it ends" },
            direction: { type: "string", enum: [...DIRECTIONS], description: "swipe: the way the finger moves" },
            durationMs: { type: "integer", description: "swipe: how long it takes" },
            text: { type: "string", description: "type: what to type; wait: text to wait for" },
            submit: { type: "boolean", description: "type: press Enter afterwards" },
            clear: { type: "boolean", description: "type: replace what's in the field" },
            paste: { type: "boolean", description: "type: paste the text rather than type it: no capitals or corrections from iOS" },
            key: { type: "string", description: "press: the key" },
            modifiers: { type: "array", items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta"] }, description: "press: modifier keys held" },
            button: { type: "string", enum: [...BUTTONS], description: "button: which" },
            timeoutMs: { type: "integer", description: "wait: how long to wait (at most 60000)" },
        },
        required: ["action"],
    },
    title: (i) =>
        `SimulatorAct(${i.action}${i.ref ? ` ${i.ref}` : typeof i.x === "number" && typeof i.y === "number" ? ` ${Math.round(i.x)},${Math.round(i.y)}` : ""}${i.direction ? ` ${i.direction}` : ""}${i.key ? ` ${i.key}` : ""}${i.button ? ` ${i.button}` : ""}${i.action === "wait" && i.text ? ` ${short(i.text, 30)}` : ""})`,
    enabled: ({ settings }) => simulatorAvailable(settings),
    validate(input) {
        if (!ACTIONS.includes(input.action)) return `Unknown action "${String(input.action)}"`;
        const at = input.ref !== undefined || (typeof input.x === "number" && typeof input.y === "number");
        switch (input.action) {
            case "tap":
            case "double_tap":
            case "long_press":
                return at ? undefined : `${input.action} needs a ref, or both x and y`;
            case "swipe":
                if (input.direction === undefined && !(typeof input.toX === "number" && typeof input.toY === "number")) return "swipe needs a direction, or toX and toY";
                if (input.direction !== undefined && !DIRECTIONS.includes(input.direction)) return `Unknown direction "${String(input.direction)}"`;
                return undefined;
            case "type":
                return (typeof input.text === "string" && input.text) || input.clear ? undefined : "type needs text, or clear";
            case "press":
                return typeof input.key === "string" && input.key ? undefined : "press needs a key";
            case "button":
                return BUTTONS.includes(input.button!) ? undefined : "button needs home or lock";
            default:
                return undefined;
        }
    },
    async preview(input) {
        const where = input.ref ? ` ${input.ref}` : typeof input.x === "number" ? ` at ${Math.round(input.x)},${Math.round(input.y ?? 0)}` : "";
        const what = input.action === "type" ? ` ${JSON.stringify(short(input.text ?? "", 200))}` : input.action === "press" ? ` ${input.key}` : input.action === "button" ? ` ${input.button}` : input.direction ? ` ${input.direction}` : "";
        return { summary: `Simulator: ${input.action.replace("_", " ")}${where}${what}` };
    },
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            const target = { ref: input.ref, x: input.x, y: input.y };
            const hasTarget = input.ref !== undefined || typeof input.x === "number";
            switch (input.action) {
                case "tap":
                    return after(s, await s.tap(target, {}, ctx.signal), ctx);
                case "double_tap":
                    return after(s, await s.tap(target, { count: 2 }, ctx.signal), ctx);
                case "long_press":
                    return after(s, await s.tap(target, { holdMs: 800 }, ctx.signal), ctx);
                case "swipe": {
                    const to = typeof input.toX === "number" && typeof input.toY === "number" ? { x: input.toX, y: input.toY } : undefined;
                    return after(s, await s.swipe({ from: hasTarget ? target : undefined, to, direction: input.direction, durationMs: input.durationMs }, ctx.signal), ctx);
                }
                case "type":
                    return after(s, await s.type(input.text ?? "", { ref: input.ref, submit: input.submit, clear: input.clear, paste: input.paste }, ctx.signal), ctx, undefined, input.submit ? undefined : input.text);
                case "press":
                    return after(s, await s.press(input.key!, input.modifiers ?? [], ctx.signal), ctx);
                case "button":
                    return after(s, await s.button(input.button!, ctx.signal), ctx);
                case "wait": {
                    const done = await s.waitFor(input.text, input.timeoutMs, ctx.signal);
                    return { content: `${done}\n\n${await s.snapshot()}`, display: { summary: done } };
                }
            }
        }),
};

// ---------------------------------------------------------------------------

export const SimulatorScreenshotTool: Tool<Record<string, never>> = {
    name: "SimulatorScreenshot",
    category: "read",
    readOnly: true,
    description: `Takes a screenshot of the simulator's screen. Use it when how the app looks matters (layout, colors, images); to read what's on it or find what to tap, SimulatorSnapshot is cheaper.`,
    parameters: { type: "object", properties: {} },
    title: () => "SimulatorScreenshot()",
    enabled: ({ settings }) => simulatorAvailable(settings),
    run: (_input, ctx) =>
        guarded(ctx, async (s) => {
            const shot = await s.screenshot();
            const image = { type: "image" as const, mediaType: "image/png", data: Buffer.from(shot.png).toString("base64") };
            // At the screen's size in points: drawn as it is.
            const file = await saveScreenshot({ ...image, width: shot.width });
            const show = file ? ` Saved as ${file}: to show it to the user, put ${imageMarkdown(file)} in your last message.` : "";
            return {
                content: `Screenshot of the simulator, ${shot.width}×${shot.height}: a pixel in it is a point, as SimulatorAct's x and y are.${show}`,
                images: [image],
                display: { summary: `${shot.points.width}×${shot.points.height}` },
            };
        }),
};

/** What each tool's permission prompt is headed with (the read-only ones never ask). */
export const SIMULATOR_TOOL_HEADINGS: Record<string, string> = {
    SimulatorControl: "Use the simulator",
    SimulatorAct: "Act on the simulator",
};

export const SIMULATOR_TOOLS: Tool<any>[] = [SimulatorControlTool, SimulatorSnapshotTool, SimulatorActTool, SimulatorScreenshotTool];

/** Whether the tools are offered: the setting is on, and this Mac has Xcode's simulators. */
export function simulatorAvailable(settings: Settings): boolean {
    return simulatorEnabled(settings) && simulatorsLikely();
}

const SERVED_NAMES: Record<string, Tool<any>> = Object.fromEntries(SIMULATOR_TOOLS.map((t, i) => [SIMULATOR_SERVER_TOOLS[i]!, t]));
const SERVED_TITLES = ["Manage the simulator", "Read the simulator's screen", "Act on the simulator", "Screenshot the simulator"];

/**
 * The simulator tools for Claude Code and Codex. `run` takes a call through Cavvy's checks (rules, mode, hooks, the
 * user), as the same tool called by a model Cavvy runs.
 */
export function simulatorServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return SIMULATOR_SERVER_TOOLS.map((name, i) => {
        const tool = SERVED_NAMES[name]!;
        const reads = tool.readOnly === true;
        return {
            name,
            title: SERVED_TITLES[i],
            description: tool.description,
            inputSchema: tool.parameters,
            // Control shuts devices down and ends apps.
            annotations: { readOnlyHint: reads, destructiveHint: name === "simulator_control", openWorldHint: false },
            call: (args, { signal, meta }) => run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined),
        };
    });
}

/** The name a simulator tool has when served (SimulatorAct -> simulator_act); undefined for any other tool. */
export function servedSimulatorName(tool: string): string | undefined {
    return SIMULATOR_SERVER_TOOLS[SIMULATOR_TOOLS.findIndex((t) => t.name === tool)];
}

/** A call of a served simulator tool (mcp__cavvy__simulator_act) as the Cavvy tool it is (SimulatorAct), for the transcript. */
export function nativeSimulatorCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    const native = SERVED_NAMES[tool];
    return native ? { name: native.name, input } : undefined;
}

/** Whether a call (by the name its backend gave it) is of a served simulator tool, which Cavvy runs its own hooks for. */
export function servedSimulatorTool(server: string | undefined, toolName: unknown): boolean {
    return Boolean(server) && typeof toolName === "string" && SIMULATOR_SERVER_TOOLS.some((t) => toolName === `mcp__${server}__${t}`);
}

export const SIMULATOR_INSTRUCTIONS = `# Simulator (cavvy)

simulator_control, simulator_snapshot, simulator_act and simulator_screenshot drive Xcode's iOS simulators, which the user can watch in Cavvy's Simulator pane. To check an iOS app: build it for the simulator with xcodebuild, start a device (simulator_control action=boot), install the .app and launch it by bundle id, then read the screen with simulator_snapshot: its refs (e12) name elements for simulator_act. Take a screenshot only when how it looks matters. The user can use the simulator too: when they have, the next result says so. To show the user a screenshot, put ![what it shows](path) with the path the result gives in your last message.`;
