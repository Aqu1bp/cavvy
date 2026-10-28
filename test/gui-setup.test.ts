import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EarlyInput, terminalInputChunks, restoreTabs, TerminalClosures } from "../gui/src/lib/terminal";
import { RpcError } from "../gui/src/lib/rpc";
import { terminalFontSize } from "../gui/src/lib/text-size";
import { node } from "./gui-component-harness";
import { asksForSetup, setupNote, setupTabLabel } from "../gui/src/lib/setup";

import { setupObscured, setSettingsTab, setPaletteOpen } from "../gui/src/state/ui";

const script = { id: "install", name: "Install", command: "printf ready > ready" };
type Script = typeof script;
const setup = { ticket: "a".repeat(32), label: "Setup · feature", command: script.command };
type Setup = typeof setup;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Run both real component bodies with fake DOM/terminal adapters; no shell or socket is opened. */
async function panel() {
    const effects: (() => void)[] = [];
    const signals: (() => any)[] = [];
    const mounts: (() => void)[] = [];
    const buttons: any[] = [];
    const calls: { method: string; params: any }[] = [];
    const notices: { text: string; kind: string }[] = [];
    const app = { conn: "open" };
    const terminalActions: { loginAccount?: (provider: string, accountId: string, name: string) => void; runScript?: (cwd: string, script: Script, setup?: Setup) => void } = {};
    let opened = false;
    let onInput: ((data: string) => void) | undefined;
    let response: (method: string) => Promise<unknown> = async () => ({});
    class Terminal {
        cols = 80;
        rows = 24;
        options = {};
        loadAddon() {}
        open() {}
        attachCustomKeyEventHandler() {}
        onData(callback: (data: string) => void) { onInput = callback; return { dispose() {} }; }
        write(_text: string, done?: () => void) { done?.(); }
        focus() {}
    }
    class Observer { observe() {} disconnect() {} }
    const dependencies = {
        node: (tag: string, props: any, ...children: any[]) => {
            const result = node(tag, props, ...children);
            if (tag === "button") buttons.push(result);
            return result;
        },
        React: { Fragment: "Fragment" },
        For: "For", Show: "Show", Play: "Play", Plus: "Plus", RotateCw: "RotateCw", TerminalIcon: "TerminalIcon", X: "X", ChevronDown: "ChevronDown", Maximize2: "Maximize2", Minimize2: "Minimize2",
        terminalMax: () => false, setTerminalMax() {}, setTerminalShown() {}, shellLayout: () => ({ terminal: { most: 560 } }), panelHold: () => undefined,
        createSignal: (initial: unknown) => {
            let value = initial;
            const read = () => value;
            signals.push(read);
            return [read, (next: any) => { value = typeof next === "function" ? next(value) : next; }];
        },
        createEffect: (callback: () => void) => effects.push(callback), on: () => () => {}, onCleanup() {}, onMount: (callback: () => void) => mounts.push(callback),
        app, terminalActions, setupObscured, setSettingsTab, trustRequest: () => undefined, terminalOpen: () => opened, setTerminalOpen: (value: boolean) => { opened = value; },
        prefs: { terminalHeight: 260, fontSize: 14 }, terminalFontSize, basename: (path: string) => path.split("/").pop(), tildify: (path: string) => path,
        withShortcut: (label: string) => label, terminalKey: () => "shell", toast: (text: string, kind: string) => notices.push({ text, kind }),
        rpc: {
            call: (method: string, params: any) => { calls.push({ method, params }); return response(method); },
            onEvent: () => () => {}, onState: () => () => {},
        },
        loadTabs: () => ({ tabs: [], next: 1, open: false }), restoreTabs, saveTabs() {}, TerminalClosures,
        reportError: (error: unknown) => { throw error; },
        RpcError, Terminal, FitAddon: class { fit() {} }, EarlyInput, terminalInputChunks,
        getComputedStyle: () => ({ getPropertyValue: () => "" }), MutationObserver: Observer, ResizeObserver: Observer,
        document: { documentElement: {} }, cancelAnimationFrame() {}, requestAnimationFrame() {},
    };
    let source = readFileSync(new URL("../gui/src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node" } } }).transformSync(source);
    const components = new Function(...Object.keys(dependencies), `${compiled}\nreturn { TerminalPanel, TerminalScreen, setupTickets };`)(...Object.values(dependencies));
    components.TerminalPanel({ cwd: "/project" });
    response = async (method) => method === "terminal.list" ? [] : {};
    for (const effect of effects) effect();
    await flush();
    expect(calls.map((call) => call.method)).toEqual(["terminal.list"]);
    calls.length = 0;
    return {
        app, calls, notices, terminalActions,
        tabs: () => signals[0]!(), opened: () => opened,
        run: (withSetup = true) => terminalActions.runScript!("/project/feature", script, withSetup ? setup : undefined),
        forgetTicket: (tab: any) => components.setupTickets.delete(tab.id),
        respond: (callback: typeof response) => { response = callback; },
        screen: (tab: any) => {
            const firstSignal = signals.length;
            // Parent persistence/close handling is covered by gui-terminal-persistence;
            // this adapter isolates the screen's setup/restart command selection.
            const props = { tab, visible: true, onClose() {}, onRestart: async () => {} };
            components.TerminalScreen(props);
            mounts.pop()!();
            return {
                ended: signals[firstSignal]!,
                restart: () => buttons.find((button) => button.children.includes("Restart shell") || button.children.includes("Restart login"))!.props.onClick(),
                input: (data: string) => onInput!(data),
                hide: () => { props.visible = false; },
            };
        },
    };
}

test("manual project scripts and worktree setup insert visible tabs in their requested folders", async () => {
    const p = await panel();
    p.run(false);
    p.run();
    expect(p.tabs()).toHaveLength(2);
    expect(p.opened()).toBe(true);
    expect(p.tabs()[0]).toMatchObject({ cwd: "/project/feature", script: { id: script.id, name: script.name } });
    expect(p.tabs()[0].script.setup).toBeUndefined();
    expect(p.tabs()[1]).toMatchObject({ cwd: "/project/feature", script: { setup: { label: setup.label, command: script.command } } });
    expect(JSON.stringify(p.tabs())).not.toContain(setup.ticket);
    expect(p.calls).toEqual([]); // Inserting a tab alone does not run a hidden command.
});

test("a setup tab sends its ticket once and restarting gives a plain shell", async () => {
    const p = await panel();
    p.run();
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm"]);
    expect(p.calls[0]!.params).toMatchObject({ cwd: "/project/feature", script: script.id, setup: setup.ticket });
    expect(p.calls[0]!.params.login).toBeUndefined();
    expect(p.calls[0]!.params.env).toBeUndefined();
    const firstId = p.calls[0]!.params.id;
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm", "terminal.open"]);
    expect(p.calls[2]!.params.id).not.toBe(firstId);
    expect(p.calls[2]!.params).not.toHaveProperty("setup");
    expect(p.calls[2]!.params).not.toHaveProperty("script");
    expect(p.calls[2]!.params.login).toBeUndefined();
    expect(p.calls[2]!.params.env).toBeUndefined();
});

test("login tabs retain their account on restart without attaching it to setup tabs", async () => {
    const p = await panel();
    const login = { provider: "codex", accountId: "personal", name: "Personal" };
    p.terminalActions.loginAccount!(login.provider, login.accountId, login.name);
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls[0]).toMatchObject({ method: "terminal.open", params: { login } });
    screen.restart();
    await flush();
    expect(p.calls[1]).toMatchObject({ method: "terminal.open", params: { login } });
    p.run();
    p.screen(p.tabs()[1]);
    await flush();
    expect(p.calls[2]).toMatchObject({ method: "scripts.run", params: { setup: setup.ticket } });
    expect(p.calls[2]!.params.login).toBeUndefined();
    expect(p.tabs()[1].login).toBeUndefined();
});

test("manual script clicks still run without a setup ticket", async () => {
    const p = await panel();
    p.run(false);
    p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm"]);
    expect(p.calls[0]!.params).not.toHaveProperty("setup");
});

test("Ctrl+C typed while setup opens is delivered before the script is armed", async () => {
    const p = await panel();
    const pending = Promise.withResolvers<unknown>();
    p.respond((method) => method === "scripts.run" ? pending.promise : Promise.resolve({}));
    p.run();
    const screen = p.screen(p.tabs()[0]);
    screen.input("\x03");
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run"]);
    pending.resolve({});
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.write", "terminal.arm"]);
    expect(p.calls[1]!.params.data).toBe("\x03");
});

test("setup hidden while its shell opens is closed before arming and reports recovery", async () => {
    for (const cover of ["settings", "navigation"] as const) {
        const p = await panel();
        const pending = Promise.withResolvers<unknown>();
        p.respond((method) => method === "scripts.run" ? pending.promise : Promise.resolve({}));
        p.run();
        const screen = p.screen(p.tabs()[0]);
        if (cover === "settings") setSettingsTab("general");
        else screen.hide();
        try {
            pending.resolve({});
            await flush();
            expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.close"]);
            expect(p.notices[0]!.text).toContain("project scripts menu");
            expect(screen.ended()).toContain("no longer visible");
            screen.restart();
            await flush();
            expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.close", "terminal.open"]);
        } finally { setSettingsTab(undefined); }
    }
});

test("a failed setup start says what failed and where to run it, and cannot replay on restart", async () => {
    const p = await panel();
    p.respond((method) => method === "scripts.run" ? Promise.reject(new Error("Folder is gone")) : Promise.resolve({}));
    p.run();
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(screen.ended()).toContain("Folder is gone");
    expect(screen.ended()).toContain("didn't run");
    expect(screen.ended()).toContain("project scripts menu");
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.open"]);
});

test("a full window refuses another setup tab with a recoverable warning", async () => {
    const p = await panel();
    for (let i = 0; i < 12; i++) p.run(false);
    p.run();
    expect(p.tabs()).toHaveLength(12);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]!.kind).toBe("warn");
    expect(p.notices[0]!.text).toContain("didn't run");
    expect(p.notices[0]!.text).toContain("12 terminals");
    expect(p.notices[0]!.text).toContain("project scripts menu");
});

test("disconnect before tab creation or before shell start never runs setup", async () => {
    const p = await panel();
    p.app.conn = "closed";
    p.run();
    expect(p.tabs()).toHaveLength(0);
    expect(p.notices[0]!.kind).toBe("warn");
    expect(p.notices[0]!.text).toContain("not connected");
    p.app.conn = "open";
    p.run();
    p.app.conn = "closed";
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls).toEqual([]);
    expect(screen.ended()).toContain("didn't run");
    p.app.conn = "open";
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["terminal.open"]);
});

function worktreeDialog(options: { trusted?: boolean; unreadable?: boolean; openFails?: boolean; terminalMissing?: boolean; deferSetup?: boolean; deferCreate?: boolean } = {}) {
    const calls: { method: string; params: any }[] = [];
    const steps: string[] = [];
    const runs: any[][] = [];
    const notices: string[] = [];
    const app = { homeCwd: "/project" };
    let trusted = options.trusted ?? true;
    let event: ((event: { type: string }) => void) | undefined;
    const checkout = Promise.withResolvers<void>();
    const previews: ReturnType<typeof Promise.withResolvers<any>>[] = [];
    const dependencies = {
        createSignal: (initial: unknown) => {
            let value = initial;
            return [() => value, (next: any) => { value = typeof next === "function" ? next(value) : next; }];
        },
        onCleanup() {}, app, asksForSetup, setupNote, setupTabLabel, setupObscured, trustRequest: () => undefined,
        rpc: {
            onEvent: (callback: typeof event) => { event = callback; return () => {}; },
            call: async (method: string, params: any) => {
                calls.push({ method, params });
                if (method === "scripts.setupInfo") {
                    if (options.deferSetup) {
                        const response = Promise.withResolvers<any>();
                        previews.push(response);
                        return response.promise;
                    }
                    if (options.unreadable) throw new Error("Cannot read scripts.json");
                    return { main: "/project", trusted, script };
                }
                if (method === "projects.trust") { trusted = true; return {}; }
                if (method === "projects.createWorktree") {
                    steps.push("created");
                    if (options.deferCreate) await checkout.promise;
                    return { path: "/project/feature", branch: "feature", ...(params.setup ? { setup: { ticket: setup.ticket, script } } : {}) };
                }
                throw new Error(`Unexpected RPC ${method}`);
            },
        },
        openProject: async (path: string) => { steps.push("opened"); if (!options.openFails) app.homeCwd = path; },
        terminalActions: options.terminalMissing ? {} : { runScript: (...args: any[]) => { steps.push("setup"); runs.push(args); } },
        requestComposerFocus() {}, toast: (text: string) => notices.push(text), reportError: (error: Error) => { throw error; },
    };
    let source = readFileSync(new URL("../gui/src/components/WorktreeDialogs.tsx", import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    // As in componentCode's handler mode, omit only JSX; exercise the real request handlers.
    const end = source.indexOf("\n    return (", source.indexOf("function NewWorktreeDialog("));
    if (end < 0) throw new Error("NewWorktreeDialog return not found");
    source = `${source.slice(0, end)}\nreturn { create, setBranch, setSkipSetup, trustRepository, note };\n}`;
    const compiled = new Bun.Transpiler({ loader: "tsx" }).transformSync(source);
    const component = new Function(...Object.keys(dependencies), `${compiled}\nreturn NewWorktreeDialog;`)(...Object.values(dependencies));
    const handlers = component({ request: { cwd: "/project", main: "/project", base: "main" }, onClose() {} });
    handlers.setBranch("feature");
    return { ...handlers, calls, steps, runs, notices, previews, checkout, changed: () => event!({ type: "scripts.changed" }) };
}

test("the worktree dialog requests setup and opens the created worktree before starting its tab", async () => {
    const d = worktreeDialog();
    await flush();
    await d.create();
    expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params.setup).toBe(true);
    expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params.setupScript).toEqual({ id: script.id, command: script.command });
    expect(d.steps).toEqual(["created", "opened", "setup"]);
    expect(d.runs).toEqual([["/project/feature", script, setup]]);
    expect(d.calls.some((call) => call.method === "projects.trust")).toBe(false);
});

test("Settings or another overlay opened during checkout skips setup with recovery", async () => {
    for (const show of [() => setSettingsTab("general"), () => setPaletteOpen(true)]) {
        const d = worktreeDialog({ deferCreate: true });
        await flush();
        const creating = d.create();
        expect(d.steps).toEqual(["created"]);
        show();
        try {
            d.checkout.resolve();
            await creating;
            expect(d.steps).toEqual(["created", "opened"]);
            expect(d.runs).toEqual([]);
            expect(d.notices.some((text) => text.includes("didn't run") && text.includes("covering") && text.includes("project scripts menu"))).toBe(true);
        } finally {
            setSettingsTab(undefined);
            setPaletteOpen(false);
        }
    }
});

test("the Create request retains its accepted preview when scripts refresh during checkout", async () => {
    const d = worktreeDialog({ deferCreate: true, deferSetup: true });
    d.previews[0]!.resolve({ main: "/project", trusted: true, script });
    await flush();
    const creating = d.create();
    d.changed();
    d.previews[1]!.resolve({ main: "/project", trusted: true, script: { ...script, command: "unseen" } });
    await flush();
    expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params.setupScript).toEqual({ id: script.id, command: script.command });
    d.checkout.resolve();
    await creating;
});

test("skip, missing trust, and unreadable scripts never request setup or implicitly grant trust", async () => {
    for (const options of [{}, { trusted: false }, { unreadable: true }]) {
        const d = worktreeDialog(options);
        await flush();
        if (!("trusted" in options) && !("unreadable" in options)) d.setSkipSetup(true);
        await d.create();
        expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params).not.toHaveProperty("setup");
        expect(d.runs).toEqual([]);
        expect(d.calls.some((call) => call.method === "projects.trust")).toBe(false);
    }
});

test("explicit trust refreshes the setup preview and allows setup on create", async () => {
    const d = worktreeDialog({ trusted: false });
    await flush();
    expect(d.note().kind).toBe("untrusted");
    await d.trustRepository("/project");
    expect(d.note().kind).toBe("runs");
    expect(d.calls.find((call) => call.method === "projects.trust")!.params).toEqual({ path: "/project", trust: true });
    await d.create();
    expect(d.runs).toHaveLength(1);
});

test("a worktree that cannot be opened or lacks a terminal reports setup recovery without starting it", async () => {
    for (const options of [{ openFails: true }, { terminalMissing: true }]) {
        const d = worktreeDialog(options);
        await flush();
        await d.create();
        expect(d.steps).toEqual(["created", "opened"]);
        expect(d.runs).toEqual([]);
        expect(d.notices.some((text) => text.includes("didn't run") && text.includes("project scripts menu"))).toBe(true);
    }
});


test("submitting before the setup preview loads creates nothing; submission after loading can request setup", async () => {
    const d = worktreeDialog();
    await d.create();
    expect(d.calls.some((call) => call.method === "projects.createWorktree")).toBe(false);
    expect(d.runs).toEqual([]);
    await flush();
    await d.create();
    expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params.setup).toBe(true);
    expect(d.runs).toHaveLength(1);
});


test("a setup tab without its transient ticket refuses to fall back to a manual script run", async () => {
    const p = await panel();
    p.run();
    const tab = p.tabs()[0];
    p.forgetTicket(tab);
    const screen = p.screen(tab);
    await flush();
    expect(p.calls).toEqual([]);
    expect(screen.ended()).toContain("didn't run");
    expect(screen.ended()).toContain("project scripts menu");
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["terminal.open"]);
});


test("setup refresh blocks creation and late trusted previews cannot replace a newer refusal", async () => {
    for (const outcome of ["untrusted", "error"] as const) {
        const d = worktreeDialog({ deferSetup: true });
        d.previews[0]!.resolve({ main: "/project", trusted: true, script });
        await flush();
        expect(d.note().kind).toBe("runs");
        d.changed();
        expect(d.note().kind).toBe("loading");
        await d.create();
        expect(d.calls.some((call) => call.method === "projects.createWorktree")).toBe(false);
        d.changed();
        expect(d.previews).toHaveLength(3);
        if (outcome === "error") d.previews[2]!.reject(new Error("Cannot read scripts.json"));
        else d.previews[2]!.resolve({ main: "/project", trusted: false, script });
        await flush();
        expect(d.note().kind).toBe(outcome);
        d.previews[1]!.resolve({ main: "/project", trusted: true, script });
        await flush();
        expect(d.note().kind).toBe(outcome);
        await d.create();
        expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params).not.toHaveProperty("setup");
        expect(d.runs).toEqual([]);
    }
});
