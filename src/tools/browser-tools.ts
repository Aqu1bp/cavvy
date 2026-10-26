// The browser tools: a headless Chrome the agent drives (src/browser), which the user can watch and take over in the
// GUI's Browser pane. Six tools, to keep their definitions short (every one goes to the model with every request):
// navigate, read (snapshot, screenshot, logs), act, evaluate. They share a session's tabs through ToolState.browser.

import { browserSettings, type Settings } from "../config/settings";
import { cachedChrome } from "../browser/chrome";
import { CdpError } from "../browser/cdp";
import { boxOf, click, hover, press, scroll, select, type as typeText, waitFor } from "../browser/interact";
import { formatLogs } from "../browser/logs";
import { BrowserError, MAX_SIDE, MIN_SIDE, type Page } from "../browser/page";
import { pageReport } from "../browser/report";
import { BrowserSession } from "../browser/session";
import { checkUrl, displayUrl } from "../browser/url-policy";
import type { ServerTool, ServerToolResult } from "../mcp/server";
import { PermissionChecker } from "../permissions/checker";
import { redact } from "../util/redact";
import type { Tool, ToolContext, ToolResult } from "./types";

const TAB = { type: "integer", description: "Tab number from the tabs list; the current tab when left out" };

/** The names these tools have when Cavvy serves them to Claude Code and Codex (mcp__cavvy__browser_navigate). */
export const BROWSER_SERVER_TOOLS = ["browser_navigate", "browser_snapshot", "browser_act", "browser_screenshot", "browser_eval", "browser_logs"];

const ACTIONS = ["click", "double_click", "hover", "type", "press", "select", "scroll", "wait", "dialog"] as const;
const NAVIGATIONS = ["goto", "back", "forward", "reload", "new_tab", "close_tab", "switch_tab", "list_tabs", "resize"] as const;
/** Actions that send the page no input: they run while the user has the tab. */
const OBSERVING = new Set<string>(["wait"]);

function browserOf(ctx: ToolContext): BrowserSession {
    if (ctx.state.browser) return ctx.state.browser;
    const checker = new PermissionChecker(() => ctx.settings, ctx.state.projectRoot);
    return (ctx.state.browser = new BrowserSession({ root: ctx.state.projectRoot, settings: () => ctx.settings, refuse: (url, approved) => checker.urlRefusal(url, approved) }));
}

/** A failed browser call as the result the agent reads. */
function failure(e: unknown, ctx: ToolContext): ToolResult {
    if (ctx.signal.aborted) return { content: "Interrupted by user", isError: true };
    const message = e instanceof BrowserError || e instanceof CdpError ? e.message : `Browser error: ${(e as Error).message ?? String(e)}`;
    return { content: redact(message), isError: true };
}

/**
 * The agent is about to act on a tab: refused if the call was cancelled or the user has the tab. Checked when the call
 * arrives, and again when it comes to the front of the tab's queue (the user may have taken the tab meanwhile).
 */
function acting(b: BrowserSession, page: Page, ctx: ToolContext) {
    if (ctx.signal.aborted) throw new BrowserError("Interrupted by user.");
    b.agentAct(page);
}

/** Runs a call on the session, turning what goes wrong into the result. */
async function guarded(ctx: ToolContext, fn: (b: BrowserSession) => Promise<ToolResult>): Promise<ToolResult> {
    const b = browserOf(ctx);
    try {
        if (ctx.signal.aborted) throw new BrowserError("Interrupted by user.");
        return await b.run(() => fn(b));
    } catch (e) {
        return failure(e, ctx);
    }
}

/** The URL to open, by the URL policy; the policy is also checked in validate, before anyone is asked. */
function addressOf(url: string, root: string): string {
    const checked = checkUrl(url, root);
    if (!checked.ok) throw new BrowserError(checked.error);
    return checked.url;
}

const short = (text: string, n = 60) => {
    const s = redact(text);
    return s.length > n ? `${s.slice(0, n)}…` : s;
};

// ---------------------------------------------------------------------------

interface NavigateInput {
    url?: string;
    action?: (typeof NAVIGATIONS)[number];
    tab?: number;
    width?: number;
    height?: number;
}

export const BrowserNavigateTool: Tool<NavigateInput> = {
    name: "BrowserNavigate",
    category: "network",
    readOnly: false,
    description: `Opens pages in a headless Chrome that the user can watch (and take over) in Cavvy's Browser pane. Returns what the page shows as a text outline with refs like [e12] that BrowserAct takes. Use it to check web UI work: start the dev server first (Bash with run_in_background, wait until it answers), then open http://localhost:PORT.

action: goto (default; needs url), back, forward, reload, new_tab (url optional), switch_tab, close_tab, list_tabs, resize (width, height in CSS pixels). Tabs belong to this session and have numbers. Only http(s) pages, about:blank and files inside the project open; logins and cookies stay in the browser's own profile for the project.`,
    parameters: {
        type: "object",
        properties: {
            url: { type: "string", description: "Address to open, like http://localhost:3000/" },
            action: { type: "string", enum: [...NAVIGATIONS], description: "What to do (default goto)" },
            tab: TAB,
            width: { type: "integer", description: "resize: viewport width" },
            height: { type: "integer", description: "resize: viewport height" },
        },
    },
    title: (i) => (i.action && i.action !== "goto" ? `BrowserNavigate(${i.action}${i.tab !== undefined ? ` ${i.tab}` : ""}${i.url ? ` ${displayUrl(i.url)}` : ""})` : `BrowserNavigate(${displayUrl(i.url ?? "")})`),
    enabled: ({ settings }) => browserAvailable(settings),
    validate(input, ctx) {
        const action = input.action ?? "goto";
        if (!NAVIGATIONS.includes(action)) return `Unknown action "${String(action)}"`;
        if ((action === "goto" || action === "new_tab") && (input.url !== undefined || action === "goto")) {
            if (typeof input.url !== "string" || !input.url.trim()) return "goto needs a url";
            const checked = checkUrl(input.url, ctx.state.projectRoot);
            if (!checked.ok) return checked.error;
        }
        if ((action === "switch_tab" || action === "close_tab") && input.tab === undefined) return `${action} needs a tab number`;
        if (action === "resize") {
            for (const side of [input.width, input.height]) if (!Number.isInteger(side) || side! < MIN_SIDE || side! > MAX_SIDE) return `resize needs width and height between ${MIN_SIDE} and ${MAX_SIDE}`;
        }
        return undefined;
    },
    async preview(input) {
        return { summary: input.url ? `Open ${displayUrl(input.url)} in the browser` : `Browser: ${input.action ?? "goto"}` };
    },
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const action = input.action ?? "goto";
            const url = input.url !== undefined ? addressOf(input.url, ctx.state.projectRoot) : undefined;
            if (action === "list_tabs") return { content: b.tabsText() };
            if (action === "switch_tab") {
                await b.switchTab(input.tab!);
                return { content: await pageReport(b, await b.page(input.tab)) };
            }
            if (action === "close_tab") {
                const page = await b.page(input.tab);
                acting(b, page, ctx);
                await b.closeTab(input.tab!);
                return { content: `Closed tab ${input.tab}.\n${b.tabsText()}` };
            }
            let page: Page;
            if (action === "new_tab") {
                page = await b.openTab("agent");
                if (!url) return { content: await pageReport(b, page) };
            } else page = await b.page(input.tab, { open: true });
            acting(b, page, ctx);
            return page.exclusive(async () => {
                acting(b, page, ctx);
                let loaded = true;
                let done: string;
                switch (action) {
                    case "back":
                    case "forward":
                        loaded = await page.go(action === "back" ? -1 : 1, ctx.signal);
                        done = action === "back" ? "Went back." : "Went forward.";
                        break;
                    case "reload":
                        loaded = await page.reload(ctx.signal);
                        done = "Reloaded.";
                        break;
                    case "resize":
                        await page.setViewport({ width: input.width!, height: input.height!, scale: page.viewport.scale });
                        done = `Resized the viewport to ${input.width}×${input.height}.`;
                        break;
                    default:
                        loaded = await page.gotoApproved(url!, ctx.signal);
                        done = `Opened ${displayUrl(url!)}.`;
                }
                const note = loaded ? "" : " The page was still loading after 30 seconds; this is what it shows so far.";
                return { content: `${done}${note}\n\n${await pageReport(b, page)}`, display: { summary: displayUrl(page.url) } };
            });
        }),
};

// ---------------------------------------------------------------------------

export const BrowserSnapshotTool: Tool<{ tab?: number; screenshot?: boolean }> = {
    name: "BrowserSnapshot",
    category: "read",
    readOnly: true,
    description: `Reads the current page as a text outline: headings, text, links (with their targets) and form controls with roles, names, values and states, and a ref like [e12] on each element BrowserAct can act on. Refs stay valid until the page navigates (or the user takes over); then take a new snapshot. Pass screenshot only when how the page looks matters: the outline is cheaper and exact.`,
    parameters: {
        type: "object",
        properties: { tab: TAB, screenshot: { type: "boolean", description: "Also return a screenshot of the viewport" } },
    },
    title: (i) => `BrowserSnapshot(${i.tab !== undefined ? `tab ${i.tab}` : "current tab"}${i.screenshot ? ", screenshot" : ""})`,
    enabled: ({ settings }) => browserAvailable(settings),
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const page = await b.page(input.tab);
            return page.exclusive(async () => {
                const content = await pageReport(b, page);
                if (!input.screenshot || page.crashed || page.dialog) return { content, display: { summary: displayUrl(page.url) } };
                const shot = await page.screenshot();
                return { content, images: [{ type: "image", mediaType: shot.mediaType, data: shot.data }], display: { summary: displayUrl(page.url) } };
            });
        }),
};

// ---------------------------------------------------------------------------

interface ActInput {
    action: (typeof ACTIONS)[number];
    tab?: number;
    ref?: string;
    x?: number;
    y?: number;
    text?: string;
    key?: string;
    modifiers?: string[];
    clear?: boolean;
    submit?: boolean;
    value?: string;
    deltaX?: number;
    deltaY?: number;
    accept?: boolean;
    selector?: string;
    timeoutMs?: number;
}

export const BrowserActTool: Tool<ActInput> = {
    name: "BrowserAct",
    category: "execute",
    // Scrolling is reading more of the page. Hovering runs the page's handlers, so it isn't (plan mode refuses it), but it goes unasked.
    readOnly: (i) => i.action === "wait" || i.action === "scroll",
    description: `Acts on the page as a person would, with real mouse and keyboard events. action:
- click, double_click, hover: at ref (from a snapshot; preferred) or at x and y in CSS pixels (from a screenshot).
- type: text into ref (or the focused field); clear replaces what's there; submit then presses Enter.
- press: key such as Enter, Tab, Escape, ArrowDown, PageDown, F5, or a combination like Control+A (more modifiers in modifiers).
- select: value is an option's value or label, in the <select> at ref.
- scroll: deltaY pixels (positive is down), the page or the element at ref/x,y.
- wait: for text, or a CSS selector, to appear (timeoutMs, default 10000); with neither, for the page to settle.
- dialog: accept (true/false) the confirm or prompt that's open; text answers a prompt.
Returns what changed on the page (or the new outline). Refused while the user has control of the tab.`,
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: [...ACTIONS] },
            tab: TAB,
            ref: { type: "string", description: "An element's ref from a snapshot, like e12" },
            x: { type: "number", description: "Horizontal position in CSS pixels" },
            y: { type: "number", description: "Vertical position in CSS pixels" },
            text: { type: "string", description: "type: what to type; wait: text to wait for; dialog: a prompt's answer" },
            key: { type: "string", description: "press: the key" },
            modifiers: { type: "array", items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta"] }, description: "press: modifier keys held" },
            clear: { type: "boolean", description: "type: replace the field's text" },
            submit: { type: "boolean", description: "type: press Enter afterwards" },
            value: { type: "string", description: "select: the option's value or label" },
            deltaX: { type: "number", description: "scroll: pixels to the right" },
            deltaY: { type: "number", description: "scroll: pixels down (negative: up)" },
            accept: { type: "boolean", description: "dialog: accept (true) or dismiss (false)" },
            selector: { type: "string", description: "wait: a CSS selector to wait for" },
            timeoutMs: { type: "integer", description: "wait: how long to wait (default 10000, at most 60000)" },
        },
        required: ["action"],
    },
    title: (i) => `BrowserAct(${i.action}${i.ref ? ` ${i.ref}` : typeof i.x === "number" && typeof i.y === "number" ? ` ${Math.round(i.x)},${Math.round(i.y)}` : ""}${i.key ? ` ${i.key}` : ""}${i.action === "wait" && (i.text ?? i.selector) ? ` ${short(i.text ?? i.selector ?? "", 30)}` : ""})`,
    enabled: ({ settings }) => browserAvailable(settings),
    validate(input) {
        if (!ACTIONS.includes(input.action)) return `Unknown action "${String(input.action)}"`;
        const at = input.ref !== undefined || (typeof input.x === "number" && typeof input.y === "number");
        switch (input.action) {
            case "click":
            case "double_click":
            case "hover":
                return at ? undefined : `${input.action} needs a ref, or both x and y`;
            case "type":
                return typeof input.text === "string" ? undefined : "type needs text";
            case "press":
                return typeof input.key === "string" && input.key ? undefined : "press needs a key";
            case "select":
                return input.ref !== undefined && typeof input.value === "string" ? undefined : "select needs a ref and a value";
            case "dialog":
                return typeof input.accept === "boolean" ? undefined : "dialog needs accept (true or false)";
            default:
                return undefined;
        }
    },
    async preview(input) {
        const where = input.ref ? ` ${input.ref}` : typeof input.x === "number" ? ` at ${Math.round(input.x)},${Math.round(input.y ?? 0)}` : "";
        const what = input.action === "type" ? ` ${JSON.stringify(short(redact(input.text ?? ""), 200))}` : input.action === "press" ? ` ${input.key}` : "";
        return { summary: `Browser: ${input.action}${where}${what}` };
    },
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const page = await b.page(input.tab);
            if (!OBSERVING.has(input.action)) acting(b, page, ctx);
            return page.exclusive(async () => {
                if (!OBSERVING.has(input.action)) acting(b, page, ctx);
                const target = { ref: input.ref, x: input.x, y: input.y };
                let done: string;
                switch (input.action) {
                    case "click":
                    case "double_click":
                        done = await click(page, target, { count: input.action === "double_click" ? 2 : 1 }, ctx.signal);
                        break;
                    case "hover":
                        done = await hover(page, target, ctx.signal);
                        break;
                    case "type":
                        done = await typeText(page, { ref: input.ref, text: input.text!, clear: input.clear, submit: input.submit }, ctx.signal);
                        break;
                    case "press":
                        done = await press(page, input.key!, input.modifiers ?? [], ctx.signal);
                        break;
                    case "select":
                        done = await select(page, input.ref!, input.value!, ctx.signal);
                        break;
                    case "scroll":
                        done = await scroll(page, target, { x: input.deltaX, y: input.deltaY }, ctx.signal);
                        break;
                    case "wait":
                        done = await waitFor(page, { text: input.text, selector: input.selector, timeoutMs: input.timeoutMs }, ctx.signal);
                        break;
                    case "dialog":
                        await page.answerDialog(input.accept!, input.text);
                        await page.settle(ctx.signal);
                        done = input.accept ? "Accepted the dialog." : "Dismissed the dialog.";
                        break;
                }
                return { content: `${done}\n\n${await pageReport(b, page, { diff: true })}`, display: { summary: done } };
            });
        }),
};

// ---------------------------------------------------------------------------

export const BrowserScreenshotTool: Tool<{ tab?: number; fullPage?: boolean; ref?: string }> = {
    name: "BrowserScreenshot",
    category: "read",
    readOnly: true,
    description: `Takes a screenshot of the page: the viewport, the whole page (fullPage), or one element (ref from a snapshot). Use it when how the page looks matters (layout, colors, rendering, an image or chart); to read what's on it or to find elements, BrowserSnapshot is cheaper.`,
    parameters: {
        type: "object",
        properties: {
            tab: TAB,
            fullPage: { type: "boolean", description: "The whole page, not only what's in view" },
            ref: { type: "string", description: "Only this element" },
        },
    },
    title: (i) => `BrowserScreenshot(${i.ref ?? (i.fullPage ? "full page" : "viewport")})`,
    enabled: ({ settings }) => browserAvailable(settings),
    validate: (input) => (input.fullPage && input.ref ? "Pass fullPage or ref, not both" : undefined),
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const page = await b.page(input.tab);
            // An element is scrolled into view first: that moves the page, which the user may be using.
            if (input.ref) acting(b, page, ctx);
            return page.exclusive(async () => {
                if (input.ref) acting(b, page, ctx);
                const clip = input.ref ? await boxOf(page, input.ref, ctx.signal) : undefined;
                const shot = await page.screenshot({ fullPage: input.fullPage, clip });
                const what = input.ref ? `element ${input.ref}` : input.fullPage ? "the full page" : "the viewport";
                return { content: `Screenshot of ${what} of tab [${b.idOf(page)}] (${shot.width}×${shot.height} CSS pixels) at ${displayUrl(page.url)}.`, images: [{ type: "image", mediaType: shot.mediaType, data: shot.data }], display: { summary: `${shot.width}×${shot.height}` } };
            });
        }),
};

// ---------------------------------------------------------------------------

export const BrowserEvalTool: Tool<{ expression: string; tab?: number }> = {
    name: "BrowserEval",
    category: "execute",
    readOnly: false,
    description: `Evaluates a JavaScript expression in the page and returns its value as JSON (a promise is awaited). For what the outline doesn't show: computed styles, storage, a count of elements, application state. To click or type, use BrowserAct. The result is capped.`,
    parameters: {
        type: "object",
        properties: {
            expression: { type: "string", description: "JavaScript to evaluate, e.g. document.querySelectorAll('li').length" },
            tab: TAB,
        },
        required: ["expression"],
    },
    title: (i) => `BrowserEval(${short(String(i.expression ?? "").replace(/\s+/g, " "), 60)})`,
    enabled: ({ settings }) => browserAvailable(settings),
    validate: (input) => (typeof input.expression === "string" && input.expression.trim() ? undefined : "expression is empty"),
    async preview(input) {
        return { summary: "Run JavaScript in the page", body: redact(input.expression).slice(0, 2000) };
    },
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const page = await b.page(input.tab);
            acting(b, page, ctx);
            return page.exclusive(async () => {
                acting(b, page, ctx);
                return { content: await page.evaluate(input.expression, ctx.signal) };
            });
        }),
};

// ---------------------------------------------------------------------------

export const BrowserLogsTool: Tool<{ tab?: number; kind?: "console" | "network" | "all"; clear?: boolean }> = {
    name: "BrowserLogs",
    category: "read",
    readOnly: true,
    description: `The page's recent console messages (with uncaught exceptions, dialogs and blocked downloads) and network requests (method, URL, status, failures; no bodies). Look here when a page misbehaves: a failed request or a script error says why. clear empties them after reading.`,
    parameters: {
        type: "object",
        properties: {
            tab: TAB,
            kind: { type: "string", enum: ["console", "network", "all"], description: "Which log (default all)" },
            clear: { type: "boolean", description: "Empty the logs after reading" },
        },
    },
    title: (i) => `BrowserLogs(${i.kind ?? "all"})`,
    enabled: ({ settings }) => browserAvailable(settings),
    run: (input, ctx) =>
        guarded(ctx, async (b) => {
            const page = await b.page(input.tab);
            const content = formatLogs(input.kind ?? "all", page.console, page.network);
            page.console.unseenErrors = 0;
            if (input.clear) {
                page.console.clear();
                page.network.clear();
            }
            return { content };
        }),
};

/** What each tool's permission prompt is headed with (the read-only ones never ask). */
export const BROWSER_TOOL_HEADINGS: Record<string, string> = {
    BrowserNavigate: "Open a page in the browser",
    BrowserAct: "Act on a page in the browser",
    BrowserEval: "Run JavaScript in a page",
};

export const BROWSER_TOOLS: Tool<any>[] = [BrowserNavigateTool, BrowserSnapshotTool, BrowserActTool, BrowserScreenshotTool, BrowserEvalTool, BrowserLogsTool];

/** Whether the tools are offered: the setting is on, and there is a browser to run (looked for at most every half minute). */
function browserAvailable(settings: Settings): boolean {
    const s = browserSettings(settings);
    return s.enabled && cachedChrome(s.executable).ok;
}

const SERVED_NAMES: Record<string, Tool<any>> = Object.fromEntries(BROWSER_TOOLS.map((t, i) => [BROWSER_SERVER_TOOLS[i]!, t]));
const SERVED_TITLES = ["Open a page", "Read the page", "Act on the page", "Screenshot the page", "Run JavaScript in the page", "Read the page's logs"];

/**
 * The browser tools for Claude Code and Codex, which have no browser of their own here. `run` takes a call through
 * Cavvy's checks (rules, mode, hooks, the user), as the same tool called by a model Cavvy runs.
 */
export function browserServerTools(run: (tool: Tool<any>, input: Record<string, unknown>, signal: AbortSignal, callId?: string) => Promise<ServerToolResult>): ServerTool[] {
    return BROWSER_SERVER_TOOLS.map((name, i) => {
        const tool = SERVED_NAMES[name]!;
        const reads = tool.readOnly === true;
        return {
            name,
            title: SERVED_TITLES[i],
            description: tool.description,
            inputSchema: tool.parameters,
            annotations: { readOnlyHint: reads, destructiveHint: false, openWorldHint: !reads },
            // Codex sends its call's id: the permission prompt goes with that call.
            call: (args, { signal, meta }) => run(tool, args, signal, typeof meta.callId === "string" ? meta.callId : undefined),
        };
    });
}

/** The name a browser tool has when served (BrowserAct -> browser_act); undefined for any other tool. */
export function servedBrowserName(tool: string): string | undefined {
    return BROWSER_SERVER_TOOLS[BROWSER_TOOLS.findIndex((t) => t.name === tool)];
}

/** A call of a served browser tool (mcp__cavvy__browser_act) as the Cavvy tool it is (BrowserAct), for the transcript. */
export function nativeBrowserCall(tool: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } | undefined {
    const native = SERVED_NAMES[tool];
    return native ? { name: native.name, input } : undefined;
}

/** Whether a call (by the name its backend gave it) is of a served browser tool, which Cavvy runs its own hooks for. */
export function servedBrowserTool(server: string | undefined, toolName: unknown): boolean {
    return Boolean(server) && typeof toolName === "string" && BROWSER_SERVER_TOOLS.some((t) => toolName === `mcp__${server}__${t}`);
}

export const BROWSER_INSTRUCTIONS = `# Browser (cavvy)

browser_navigate, browser_snapshot, browser_act, browser_screenshot, browser_eval and browser_logs drive a headless Chrome the user can watch in Cavvy's Browser pane. To check web UI work, start the dev server (in the background), open its address with browser_navigate, then read the page with browser_snapshot: its refs (e12) name elements for browser_act. Take a screenshot only when how the page looks matters. The user can take a tab over; acting on it then fails until they hand it back.`;
