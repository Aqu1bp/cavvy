// Codex's own computer use (src/backends/codex-computer-use.ts): what its approvals ask, from the shapes measured with
// Codex 0.167 and ChatGPT 26.1106 (and the older ones t3code handles), and the thread config that keeps it on or off.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "fs";
import { join } from "path";
import { appNameFromId, codexDesktopFallback, codexFallsBack, computerUseAsk, computerUseOff, computerUseOffConfig, computerUseOnConfig, computerUseReady, computerUseSetUp, computerUseStartFailed, computerUseTitle, fallBackToCavvyTools, fallbackToSay, mergeThreadConfig, neverOfferedApp, resetDesktopFallbacks, setComputerUseServiceApp, toolSurfaceApp } from "../src/backends/codex-computer-use";
import { tempDir } from "./helpers/isolate";
import { codexPolicy } from "../src/backends/codex";
import { approvalChoices } from "../gui/src/lib/approval";

/** An app approval as ChatGPT 26.1106's runtime sends it, passed on by Codex 0.167. */
const appAsk = (meta: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    threadId: "t",
    turnId: "u",
    serverName: "cua_repl",
    mode: "form",
    message: 'Allow Computer Use to use "Safari"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", connector_id: "computer-use", connector_name: "Computer Use", persist: ["session", "always"], riskLevel: "medium", tool_call_id: "exec-1", tool_name: "get_app_state", tool_params: { app: "com.apple.Safari" }, tool_params_display: [{ name: "app", display_name: "App", value: "Safari" }], ...meta },
    ...extra,
});

describe("computerUseAsk", () => {
    test("an app approval: its name, bundle id, what a yes can be kept for, and the call", () => {
        expect(computerUseAsk(appAsk())).toEqual({ kind: "app", name: "Safari", bundleId: "com.apple.Safari", aliases: ["Safari", "com.apple.Safari"], persist: ["session", "always"], callId: "exec-1" });
        // Persistent approvals turned off by the person's organization: once or the session only.
        expect(computerUseAsk(appAsk({ persist: ["session"] }))).toMatchObject({ persist: ["session"] });
    });

    test("older builds: the question alone names the app", () => {
        expect(computerUseAsk({ serverName: "computer-use", mode: "form", message: "Allow ChatGPT to use Safari?", _meta: null })).toEqual({ kind: "app", name: "Safari", aliases: ["Safari"], persist: [] });
    });

    test("Codex's own approval of a js call isn't one: it goes as any MCP call's", () => {
        expect(computerUseAsk({ serverName: "cua_repl", mode: "form", message: 'Allow the cua_repl MCP server to run tool "js"?', _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_name: "js", tool_params: { code: "1", title: "x", app: "com.apple.Terminal" } } })).toBeUndefined();
    });

    test("Codex's own approval of its other tools, by name or by its question, isn't one either", () => {
        expect(computerUseAsk({ serverName: "cua_repl", mode: "form", message: 'Allow the cua_repl MCP server to run tool "js_reset"?', _meta: { codex_approval_kind: "mcp_tool_call" } })).toBeUndefined();
        expect(computerUseAsk({ serverName: "cua_repl", mode: "form", message: "x", _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "turn_ended" } })).toBeUndefined();
    });

    test("anything else from computer use it can't read fails closed, with its question", () => {
        // From the computer-use connector, naming no app.
        expect(computerUseAsk(appAsk({ tool_name: "take_over", tool_params: {}, tool_params_display: [] }, { message: "Allow Computer Use to take over the screen?" }))).toEqual({ kind: "unknown", question: "Allow Computer Use to take over the screen?" });
        // Codex's approval of some other tool of its server, or a form of its own.
        expect(computerUseAsk({ serverName: "cua_repl", mode: "form", message: 'Allow the cua_repl MCP server to run tool "drive"?', _meta: { codex_approval_kind: "mcp_tool_call", tool_name: "drive" } })).toMatchObject({ kind: "unknown" });
        expect(computerUseAsk({ serverName: "node_repl", mode: "form", message: "", _meta: null })).toEqual({ kind: "unknown", question: "Codex's computer use asks for approval" });
        // The connector naming js isn't Codex's own approval.
        expect(computerUseAsk(appAsk({ tool_name: "js", tool_params: {}, tool_params_display: [] }, { message: "Something new?" }))).toMatchObject({ kind: "unknown" });
    });

    test("another server's elicitation isn't one", () => {
        expect(computerUseAsk({ serverName: "probe", mode: "form", message: "Which color?", _meta: null })).toBeUndefined();
        expect(computerUseAsk({ serverName: "probe", mode: "url", message: "Sign in", url: "https://example.com", _meta: null })).toBeUndefined();
    });

    test("a link from it, and its audio recording", () => {
        expect(computerUseAsk({ serverName: "cua_repl", mode: "url", message: "Finish setting up Computer Use", url: "https://example.com/setup", _meta: null })).toEqual({ kind: "url" });
        expect(computerUseAsk(appAsk({ tool_name: "start_audio_recording", tool_params: {}, tool_params_display: [] }, { message: "Allow Computer Use to record computer audio?" }))).toEqual({ kind: "audio" });
    });

    test("never offered: by bundle id, or by name", () => {
        expect(neverOfferedApp({ name: "Term", bundleId: "com.apple.Terminal" })).toBe("terminal");
        expect(neverOfferedApp({ name: "1Password" })).toBe("credentials");
        expect(neverOfferedApp({ name: "Safari", bundleId: "com.apple.Safari" })).toBeUndefined();
        // Named otherwise than by a bundle id, and shown by another name: what it was named by counts too.
        expect(computerUseAsk(appAsk({ tool_params: { app: "Terminal" }, tool_params_display: [{ name: "app", display_name: "App", value: "Notes" }] }))).toMatchObject({ name: "Notes", target: "Terminal" });
        expect(neverOfferedApp({ name: "Notes", target: "Terminal" })).toBe("terminal");
        expect(neverOfferedApp({ name: "Notes", target: "/System/Applications/Utilities/Terminal.app" })).toBe("terminal");
        expect(neverOfferedApp({ name: "Notes", target: "Notes" })).toBeUndefined();
        // A listed bundle id of two parts, which isn't taken for one.
        expect(computerUseAsk(appAsk({ tool_params: { app: "org.alacritty" }, tool_params_display: [{ name: "app", display_name: "App", value: "Notes" }] }))).toMatchObject({ target: "org.alacritty" });
        expect(neverOfferedApp({ name: "Notes", target: "org.alacritty" })).toBe("terminal");
        expect(neverOfferedApp({ name: "Notes", target: "org.tabby" })).toBe("terminal");
    });

    test("never offered: whichever name or id Codex gives for the app, two-part bundle ids and names alone included", () => {
        const check = (p: any) => neverOfferedApp(computerUseAsk(p) as any);
        // By a two-part bundle id, shown as another app, or not shown at all.
        expect(check(appAsk({ tool_params: { app: "org.alacritty" }, tool_params_display: [{ name: "app", display_name: "App", value: "Notes" }] }, { message: 'Allow Computer Use to use "Notes"?' }))).toBe("terminal");
        expect(check(appAsk({ tool_params: { app: "org.alacritty" }, tool_params_display: [] }, { message: 'Allow Computer Use to use "org.alacritty"?' }))).toBe("terminal");
        // By its name alone (an older question with no parameters).
        expect(check({ serverName: "computer-use", mode: "form", message: "Allow ChatGPT to use Alacritty?", _meta: null })).toBe("terminal");
        // Shown as one app, asked about as another: either is enough.
        expect(check(appAsk({ tool_params: {}, tool_params_display: [{ name: "app", display_name: "App", value: "Notes" }] }, { message: 'Allow Computer Use to use "1Password"?' }))).toBe("credentials");
        // Nothing that's never offered: not refused by this, so the person is asked.
        expect(check(appAsk({ tool_params: { app: "org.example" }, tool_params_display: [{ name: "app", display_name: "App", value: "Example" }] }, { message: 'Allow Computer Use to use "Example"?' }))).toBeUndefined();
    });
});

describe("thread config", () => {
    test("set up: the ChatGPT app's plugin on in Codex's config, and not turned off for the thread", () => {
        const plugin = "unified-computer-use@openai-bundled";
        expect(computerUseSetUp({ plugins: { [plugin]: { enabled: true } } })).toBe(true);
        expect(computerUseSetUp({ plugins: { [plugin]: { enabled: false } } })).toBe(false);
        expect(computerUseSetUp({ plugins: { "computer-use@openai-bundled": { enabled: true } } })).toBe(false);
        expect(computerUseSetUp({})).toBe(false);
        // A project's, or one whose provenance Codex didn't say: turned off, so not set up.
        expect(computerUseSetUp({ plugins: { [plugin]: { enabled: true } } }, { plugins: { [plugin]: { enabled: false } } })).toBe(false);
    });

    test("on: nothing of Cavvy's own, only the apps never offered denied", () => {
        const config = computerUseOnConfig();
        expect(Object.keys(config)).toEqual(["computer_use"]);
        expect((config.computer_use as any).macos.bundle_ids).toMatchObject({ "com.apple.Terminal": "deny", "com.apple.Passwords": "deny", "dev.cavvy.desktop": "deny" });
    });

    test("off: only what's on is turned off", () => {
        expect(computerUseOffConfig({ plugins: { "unified-computer-use@openai-bundled": { enabled: true }, "computer-use@openai-bundled": { enabled: false }, "browser@openai-bundled": { enabled: true } }, mcp_servers: { "computer-use": { command: "x" }, github: { url: "u" } } })).toEqual({
            plugins: { "unified-computer-use@openai-bundled": { enabled: false } },
            mcp_servers: { "computer-use": { enabled: false } },
        });
        expect(computerUseOffConfig({ mcp_servers: {} })).toEqual({});
        expect(computerUseOffConfig(undefined)).toEqual({});
    });

    test("merged: servers and plugins by name", () => {
        expect(mergeThreadConfig({ mcp_servers: { a: { enabled: false } }, plugins: { p: { enabled: false } } }, { mcp_servers: { b: { command: "x" } }, computer_use: { macos: {} } })).toEqual({ mcp_servers: { a: { enabled: false }, b: { command: "x" } }, plugins: { p: { enabled: false } }, computer_use: { macos: {} } });
        expect(mergeThreadConfig(undefined, {})).toBeUndefined();
        expect(mergeThreadConfig({ a: 1 }, undefined)).toEqual({ a: 1 });
    });

    test("bypass with computer use runs on-request, so its approvals reach the person; other modes as before", () => {
        expect(codexPolicy("bypassPermissions", [], false, false, true)).toMatchObject({ approvalPolicy: "on-request", sandbox: "danger-full-access" });
        expect(codexPolicy("bypassPermissions", [], false, false, false)).toMatchObject({ approvalPolicy: "never" });
        for (const m of ["default", "plan", "acceptEdits", "auto"] as const) expect(codexPolicy(m, [], false, false, true)).toEqual(codexPolicy(m, [], false, false, false));
    });
});

describe("its calls", () => {
    test("the app a call used, from its result", () => {
        expect(toolSurfaceApp({ content: [], _meta: { "codex/toolSurface": { kind: "computerUse", app: { appId: "com.apple.TextEdit", kind: "appId" } } } })).toBe("com.apple.TextEdit");
        expect(toolSurfaceApp({ content: [], _meta: { "codex/toolSurface": { kind: "computerUse", app: null } } })).toBeUndefined();
        expect(toolSurfaceApp({ content: [] })).toBeUndefined();
        expect(appNameFromId("com.apple.TextEdit")).toBe("TextEdit");
    });

    test("titles: what it does, and where", () => {
        expect(computerUseTitle("js", { code: "…", title: "Type the note" })).toBe("Mac apps: Type the note");
        expect(computerUseTitle("js", { code: "…", title: "Type the note" }, "TextEdit")).toBe("TextEdit: Type the note");
        expect(computerUseTitle("js", { code: "…" }, "TextEdit")).toBe("Use TextEdit");
        expect(computerUseTitle("js", { code: "…" })).toBe("Use an app on your Mac");
        expect(computerUseTitle("js_reset", {})).toBe("Mac apps: start over");
        // A call that only reports how the work ended reads as that report, not as using an app.
        expect(computerUseTitle("js", { completion_summary: "Couldn't reach Calculator" })).toBe("Mac apps: Couldn't reach Calculator");
        expect(computerUseTitle("js", { code: "…", completion_summary: "Done" })).toBe("Use an app on your Mac");
    });
});

describe("the approval card", () => {
    const yes = { id: "yes", label: "Allow once" } as const;
    const session = { id: "session", label: "Allow for this session" } as const;
    const always = { id: "always", label: "Always allow" } as const;
    const no = { id: "no", label: "Deny" } as const;
    test("an app's choices are each shown, numbered in the server's order (for this session first), Deny last", () => {
        const c = approvalChoices([session, yes, always, no], true);
        expect(c.keys.map((o) => o.id)).toEqual(["session", "yes", "always"]);
        expect(c.row.map((r) => `${r.o.id}:${r.key}`)).toEqual(["session:1", "yes:2", "always:3", "no:0"]);
    });
});

describe("where it can't be used, Cavvy's Mac app tools", () => {
    const PLUGIN = "unified-computer-use@openai-bundled";
    const setUp = { plugins: { [PLUGIN]: { enabled: true } } };
    const installed = () => {
        const app = join(tempDir("cu-service-"), "Codex Computer Use.app");
        mkdirSync(app);
        setComputerUseServiceApp(app);
    };
    afterEach(() => {
        setComputerUseServiceApp(undefined);
        resetDesktopFallbacks();
    });

    test("set up: its plugin on, its service installed, and the default account", () => {
        installed();
        expect(computerUseReady(setUp, undefined, undefined)).toBe(true);
        expect(computerUseReady(setUp, undefined, "default")).toBe(true);
        // Another account's Codex home, the plugin off or turned off for the thread, or no service: not set up.
        expect(computerUseReady(setUp, undefined, "work")).toBe(false);
        expect(computerUseReady({ plugins: { [PLUGIN]: { enabled: false } } }, undefined, undefined)).toBe(false);
        expect(computerUseReady(setUp, { plugins: { [PLUGIN]: { enabled: false } } }, undefined)).toBe(false);
        setComputerUseServiceApp(join(tempDir("cu-none-"), "Codex Computer Use.app"));
        expect(computerUseReady(setUp, undefined, undefined)).toBe(false);
        // Tests never look for it in the person's own HOME.
        setComputerUseServiceApp(undefined);
        expect(computerUseReady(setUp, undefined, undefined)).toBe(false);
    });

    test("before a turn: another account, or no service, falls back at once; for good, said once", () => {
        installed();
        expect(codexFallsBack("own", undefined)).toBeUndefined();
        expect(codexFallsBack("second", "work")).toBe("setup");
        expect(codexDesktopFallback("second")).toBe("setup");
        expect(codexDesktopFallback("own")).toBeUndefined();
        // A failure later: the session falls back, and stays so whatever comes after.
        fallBackToCavvyTools("own", "failed");
        expect(codexFallsBack("own", undefined)).toBe("failed");
        fallBackToCavvyTools("own", "setup");
        expect(codexDesktopFallback("own")).toBe("failed");
        expect(fallbackToSay("own")).toBe(true);
        expect(fallbackToSay("own")).toBe(false);
        expect(fallbackToSay("never")).toBe(false);
        setComputerUseServiceApp(undefined);
        expect(codexFallsBack("other", undefined)).toBe("setup");
    });

    test("a startup failure is the service that can't be reached, not an app declined or the code failing", () => {
        // As measured with Codex 0.169 and ChatGPT 26.1106, a HOME other than the person's: the call's first line.
        expect(computerUseStartFailed("Sky Computer Use native pipe startup failed\n## Computer Use\n\nControl native apps.")).toBe(true);
        expect(computerUseStartFailed("  Sky Computer Use native pipe startup failed")).toBe(true);
        expect(computerUseStartFailed("Computer Use was not approved to use Calculator")).toBe(false);
        expect(computerUseStartFailed("TypeError: cua.getApp is not a function")).toBe(false);
        // Said further down (the model's own output quoting it), it isn't the call failing to start.
        expect(computerUseStartFailed("Result:\nnative pipe startup failed")).toBe(false);
    });

    test("off: nothing to add when nothing of it is on", () => {
        expect(computerUseOff({})).toBeUndefined();
        expect(computerUseOff(setUp)).toEqual({ plugins: { [PLUGIN]: { enabled: false } } });
    });
});
