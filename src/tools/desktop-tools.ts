// The desktop tools: the person's Mac apps, each only once they've said the agent may use it (src/desktop). Four
// tools, to keep their definitions short (each goes to the model with every request): control (which apps), read
// (snapshot, screenshot), act. They share a session's grants through ToolState.desktop. Cavvy's own models get them
// built in, and Claude Code from Cavvy's MCP server (it has no computer use of its own); Codex uses its own.

/** The names these tools have when Cavvy serves them to Claude Code (mcp__cavvy__desktop_act). */
export const DESKTOP_SERVER_TOOLS = ["desktop_control", "desktop_snapshot", "desktop_act", "desktop_screenshot"];

import { desktopEnabled, type Settings } from "../config/settings";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import { DesktopError, DesktopSession } from "../desktop/session";
import { redact } from "../util/redact";
import { imageMarkdown, saveScreenshot } from "./browser-tools";
import type { Tool, ToolContext, ToolResult } from "./types";

const CONTROLS = ["list", "request_access", "open"] as const;
const ACTIONS = ["click", "double_click", "right_click", "drag", "scroll", "type", "press", "wait"] as const;
const DIRECTIONS = ["up", "down", "left", "right"] as const;

export function desktopOf(ctx: Pick<ToolContext, "state">): DesktopSession {
    return (ctx.state.desktop ??= new DesktopSession());
}

/** Runs a call on the session's desktop, turning what goes wrong into the result. */
async function guarded(ctx: ToolContext, fn: (s: DesktopSession) => Promise<ToolResult>): Promise<ToolResult> {
    try {
        if (ctx.signal.aborted) throw new DesktopError("Interrupted by user.");
        const s = desktopOf(ctx);
        // A grant macOS hasn't given is asked for with a card in the person's window, where there is one.
        const card = ctx.ui?.accessCard?.bind(ctx.ui);
        s.asking({ card, signal: ctx.signal });
        return await fn(s);
    } catch (e) {
        if (ctx.signal.aborted) return { content: "Interrupted by user", isError: true };
        const message = e instanceof DesktopError ? e.message : `Desktop error: ${(e as Error).message ?? String(e)}`;
        return { content: redact(message), isError: true };
    }
}

const short = (text: string, n = 60) => {
    const s = redact(text);
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** The first line of a result: what was done, for the transcript's row. */
const done = (content: string): ToolResult => ({ content, display: { summary: content.split("\n")[0] } });

/** Whether the tools are offered: turned on in the user's own settings, on a Mac. */
export function desktopAvailable(settings: Settings): boolean {
    return process.platform === "darwin" && desktopEnabled(settings);
}

// ---------------------------------------------------------------------------

interface ControlInput {
    action: (typeof CONTROLS)[number];
    app?: string;
}

export const DesktopControlTool: Tool<ControlInput> = {
    name: "DesktopControl",
    category: "execute",
    readOnly: (i) => i.action === "list",
    description: `The user's Mac apps, which you can use only once the user says so, each for this session. action:
- list: the apps running, and which you may use.
- request_access: ask the user for an app by name (app). Terminals, password managers and Cavvy are never offered.
- open: start an app you may use, or bring it to the front (keys go only to an app you may use that's in front).`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: [...CONTROLS] },
            app: { type: "string", description: "request_access, open: the app's name, like Notes" },
        },
        required: ["action"],
    },
    title: (i) => `DesktopControl(${i.action}${i.app ? ` ${short(i.app, 40)}` : ""})`,
    enabled: ({ settings }) => desktopAvailable(settings),
    async validate(input, ctx) {
        if (!CONTROLS.includes(input.action)) return `Unknown action "${String(input.action)}"`;
        if (input.action === "list") return undefined;
        if (typeof input.app !== "string" || !input.app.trim()) return `${input.action} needs app, the app's name`;
        // Found (or not) before the user is asked about it; one to open, given already.
        const s = desktopOf(ctx);
        const { app, error } = await s.find(input.app).catch((e: Error) => ({ app: undefined, error: e.message }));
        if (error || !app) return error;
        if (input.action === "open" && !s.isApproved(app.bundleId)) return `${app.name} isn't an app you may use: ask with DesktopControl action=request_access app=${app.name}.`;
        return undefined;
    },
    async preview(input, ctx) {
        const found = input.app ? await desktopOf(ctx).find(input.app).catch(() => undefined) : undefined;
        const name = found?.app?.name ?? input.app ?? "an app";
        if (input.action === "request_access") return { summary: `Use ${name}` };
        if (input.action === "open") return { summary: `Open ${name}` };
        return { summary: "List the apps" };
    },
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            switch (input.action) {
                case "list":
                    return { content: await s.list() };
                case "request_access":
                    return done(await s.grant(input.app!));
                case "open":
                    return done(await s.open(input.app!, ctx.signal));
            }
        }),
};

// ---------------------------------------------------------------------------

export const DesktopSnapshotTool: Tool<{ app?: string; screenshot?: boolean }> = {
    name: "DesktopSnapshot",
    category: "read",
    readOnly: true,
    description: `Reads an app you may use as a text outline of its windows and menus: buttons, text, fields, rows with their labels and values, and a ref like [e12] on each that DesktopAct can click. The app in front, or app by name. Refs last until your next action, which returns a new outline. If the app has changed since, or the user has used the Mac, a ref is refused and you get the new outline. Coordinates are screen points. Pass screenshot only when how it looks matters.`,
    parameters: {
        type: "object",
        properties: {
            app: { type: "string", description: "Which app you may use to read (default: the one in front)" },
            screenshot: { type: "boolean", description: "Also return a screenshot" },
        },
    },
    title: (i) => `DesktopSnapshot(${i.app ? short(i.app, 40) : "front"}${i.screenshot ? ", screenshot" : ""})`,
    enabled: ({ settings }) => desktopAvailable(settings),
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            const content = await s.snapshot(input.app);
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
    amount?: number;
    text?: string;
    submit?: boolean;
    clear?: boolean;
    key?: string;
    modifiers?: string[];
    timeoutMs?: number;
}

export const DesktopActTool: Tool<ActInput> = {
    name: "DesktopAct",
    category: "execute",
    readOnly: (i) => i.action === "wait",
    description: `Acts in an app you may use, as a mouse and keyboard would. Clicks reach only an app you may use; keys only while one is in front. action:
- click, double_click, right_click: at ref (from a snapshot; preferred) or at x and y in screen points.
- drag: from ref or x,y to toX,toY.
- scroll: direction (up, down, left, right) by amount lines (default 5), at ref or x,y (default: the window's middle).
- type: text into the focused field (ref clicks a field first); clear replaces what's in it; submit then presses Enter.
- press: a key such as Enter, Tab, Escape, ArrowDown, or a combination like Meta+S.
- wait: for text to show (timeoutMs, default 10000); with no text, for the app to be still.
Returns the app once it's still, as a new outline. If the user moves the mouse or types during an action, it stops and says so.`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: [...ACTIONS] },
            ref: { type: "string", description: "An element's ref from a snapshot, like e12" },
            x: { type: "number", description: "Horizontal screen position in points" },
            y: { type: "number", description: "Vertical screen position in points" },
            toX: { type: "number", description: "drag: where it ends" },
            toY: { type: "number", description: "drag: where it ends" },
            direction: { type: "string", enum: [...DIRECTIONS], description: "scroll: which way" },
            amount: { type: "integer", description: "scroll: how many lines" },
            text: { type: "string", description: "type: what to type; wait: text to wait for" },
            submit: { type: "boolean", description: "type: press Enter afterwards" },
            clear: { type: "boolean", description: "type: replace what's in the field" },
            key: { type: "string", description: "press: the key" },
            modifiers: { type: "array", items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta"] }, description: "press: modifier keys held" },
            timeoutMs: { type: "integer", description: "wait: how long to wait (at most 60000)" },
        },
        required: ["action"],
    },
    title: (i) =>
        `DesktopAct(${i.action}${i.ref ? ` ${i.ref}` : typeof i.x === "number" && typeof i.y === "number" ? ` ${Math.round(i.x)},${Math.round(i.y)}` : ""}${i.direction ? ` ${i.direction}` : ""}${i.key ? ` ${i.key}` : ""}${i.action === "wait" && i.text ? ` ${short(i.text, 30)}` : ""})`,
    enabled: ({ settings }) => desktopAvailable(settings),
    validate(input) {
        if (!ACTIONS.includes(input.action)) return `Unknown action "${String(input.action)}"`;
        const at = input.ref !== undefined || (typeof input.x === "number" && typeof input.y === "number");
        switch (input.action) {
            case "click":
            case "double_click":
            case "right_click":
                return at ? undefined : `${input.action} needs a ref, or both x and y`;
            case "drag":
                if (!at) return "drag needs a ref, or both x and y, to start from";
                return typeof input.toX === "number" && typeof input.toY === "number" ? undefined : "drag needs toX and toY";
            case "scroll":
                return DIRECTIONS.includes(input.direction!) ? undefined : "scroll needs a direction: up, down, left or right";
            case "type":
                return (typeof input.text === "string" && input.text) || input.clear ? undefined : "type needs text, or clear";
            case "press":
                return typeof input.key === "string" && input.key ? undefined : "press needs a key";
            default:
                return undefined;
        }
    },
    async preview(input, ctx) {
        // What it does to what, as one would say it ('Click button "Bold" (e12) in TextEdit'): it heads the prompt.
        const s = desktopOf(ctx);
        const apps = s.approved().map((a) => a.name);
        const where = apps.length === 1 ? ` in ${apps[0]}` : "";
        const named = (ref: string) => {
            const what = s.refName(ref);
            return what ? `${what} (${ref})` : ref;
        };
        const at = input.ref ? ` ${named(input.ref)}` : typeof input.x === "number" ? ` at ${Math.round(input.x)},${Math.round(input.y ?? 0)}` : "";
        switch (input.action) {
            case "type":
                if (!input.text && input.clear) return { summary: `Clear ${input.ref ? named(input.ref) : "the field"}${where}` };
                return { summary: `Type ${JSON.stringify(short(input.text ?? "", 120))}${input.ref ? ` into ${named(input.ref)}` : ""}${where}` };
            case "press":
                return { summary: `Press ${[...(input.modifiers ?? []), input.key].join("+")}${where}` };
            case "scroll":
                return { summary: `Scroll ${input.direction}${at}${where}` };
            case "drag":
                return { summary: `Drag from${at} to ${Math.round(input.toX ?? 0)},${Math.round(input.toY ?? 0)}${where}` };
            case "wait":
                return { summary: `Wait${where}` };
            default:
                return { summary: `${input.action === "double_click" ? "Double-click" : input.action === "right_click" ? "Right-click" : "Click"}${at}${where}` };
        }
    },
    run: (input, ctx) =>
        guarded(ctx, async (s) => {
            const target = { ref: input.ref, x: input.x, y: input.y };
            switch (input.action) {
                case "click":
                    return done(await s.click(target, {}, ctx.signal));
                case "double_click":
                    return done(await s.click(target, { count: 2 }, ctx.signal));
                case "right_click":
                    return done(await s.click(target, { button: "right" }, ctx.signal));
                case "drag":
                    return done(await s.drag(target, { x: input.toX!, y: input.toY! }, undefined, ctx.signal));
                case "scroll":
                    return done(await s.scroll(target, input.direction!, input.amount, ctx.signal));
                case "type":
                    return done(await s.type(input.text ?? "", { ref: input.ref, submit: input.submit, clear: input.clear }, ctx.signal));
                case "press":
                    return done(await s.press(input.key!, input.modifiers ?? [], ctx.signal));
                case "wait":
                    return done(await s.waitFor(input.text, input.timeoutMs, ctx.signal));
            }
        }),
};

// ---------------------------------------------------------------------------

export const DesktopScreenshotTool: Tool<Record<string, never>> = {
    name: "DesktopScreenshot",
    category: "read",
    readOnly: true,
    description: `Takes a picture of the windows of the apps you may use, and nothing else on the screen. Use it when how an app looks matters; to read it or find what to click, DesktopSnapshot is cheaper.`,
    parameters: { type: "object", properties: {} },
    title: () => "DesktopScreenshot()",
    enabled: ({ settings }) => desktopAvailable(settings),
    run: (_input, ctx) =>
        guarded(ctx, async (s) => {
            const shot = await s.screenshot();
            const image = { type: "image" as const, mediaType: "image/png", data: Buffer.from(shot.png).toString("base64") };
            const file = await saveScreenshot({ ...image, width: shot.width });
            const show = file ? ` Saved as ${file}: to show it to the user, put ${imageMarkdown(file)} in your last message.` : "";
            return {
                content: `Screenshot of ${shot.apps}, ${shot.width}×${shot.height}, a pixel a point: its top left is ${Math.round(shot.x)},${Math.round(shot.y)} on the screen, so a place x,y in it is ${Math.round(shot.x)}+x,${Math.round(shot.y)}+y for DesktopAct.${show}`,
                images: [image],
                display: { summary: `${shot.width}×${shot.height}` },
            };
        }),
};

/** What each tool's permission prompt is headed with (the read-only ones never ask). */
export const DESKTOP_TOOL_HEADINGS: Record<string, string> = {
    DesktopControl: "Use an app",
    DesktopAct: "Act in an app",
};

export const DESKTOP_TOOLS: Tool<any>[] = [DesktopControlTool, DesktopSnapshotTool, DesktopActTool, DesktopScreenshotTool];

const SERVED_NAMES: Record<string, Tool<any>> = Object.fromEntries(DESKTOP_TOOLS.map((t, i) => [DESKTOP_SERVER_TOOLS[i]!, t]));
const SERVED_TITLES = ["Use the Mac's apps", "Read an app", "Act in an app", "Screenshot the apps"];

/**
 * The desktop tools for Claude Code. `run` takes a call through Cavvy's checks (rules, mode, hooks, the user), as the
 * same tool called by a model Cavvy runs.
 */
export function desktopServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return DESKTOP_SERVER_TOOLS.map((name, i) => {
        const tool = SERVED_NAMES[name]!;
        return {
            name,
            title: SERVED_TITLES[i],
            description: tool.description,
            inputSchema: tool.parameters,
            annotations: { readOnlyHint: tool.readOnly === true, destructiveHint: name === "desktop_act", openWorldHint: false },
            call: (args, { signal, meta }) => run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined),
        };
    });
}

/** The name a desktop tool has when served (DesktopAct -> desktop_act); undefined for any other tool. */
export function servedDesktopName(tool: string): string | undefined {
    return DESKTOP_SERVER_TOOLS[DESKTOP_TOOLS.findIndex((t) => t.name === tool)];
}

/** A call of a served desktop tool (mcp__cavvy__desktop_act) as the Cavvy tool it is (DesktopAct), for the transcript. */
export function nativeDesktopCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    const native = SERVED_NAMES[tool];
    return native ? { name: native.name, input } : undefined;
}

/** Whether a call (by the name its backend gave it) is of a served desktop tool, which Cavvy runs its own hooks for. */
export function servedDesktopTool(server: string | undefined, toolName: unknown): boolean {
    return Boolean(server) && typeof toolName === "string" && DESKTOP_SERVER_TOOLS.some((t) => toolName === `mcp__${server}__${t}`);
}

export const DESKTOP_INSTRUCTIONS = `# Mac apps (cavvy)

This is computer use on this Mac. When the user asks for computer use, or for something done in an app, use these tools, not another computer-use skill or app. desktop_control, desktop_snapshot, desktop_act and desktop_screenshot use apps on the user's Mac, each only once the user says so: ask with desktop_control action=request_access app=<name>, then bring it to the front with action=open and read it with desktop_snapshot: its refs (e12) name elements for desktop_act. Take a screenshot only when how it looks matters. The user can take over at any time: when they use the mouse or keyboard, an action stops and the next result says so.`;
