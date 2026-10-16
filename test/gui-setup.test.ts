import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EarlyInput, terminalInputChunks } from "../gui/src/lib/terminal";
import { node } from "./gui-component-harness";
import { asksForSetup, setupNote, setupTabLabel } from "../gui/src/lib/setup";

const script = { id: "install", name: "Install", command: "printf ready > ready" };
type Script = typeof script;
const setup = { ticket: "a".repeat(32), label: "Setup · feature", command: script.command };
type Setup = typeof setup;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** Run both real component bodies with fake DOM/terminal adapters; no shell or socket is opened. */
function panel() {
    const signals: (() => any)[] = [];
    const mounts: (() => void)[] = [];
    const buttons: any[] = [];
    const calls: { method: string; params: any }[] = [];
    const notices: { text: string; kind: string }[] = [];
    const app = { conn: "open" };
    const terminalActions: { runScript?: (cwd: string, script: Script, setup?: Setup) => void } = {};
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
        For: "For", Show: "Show", Play: "Play", Plus: "Plus", RotateCw: "RotateCw", SquareTerminal: "SquareTerminal", X: "X",
        createSignal: (initial: unknown) => {
            let value = initial;
            const read = () => value;
            signals.push(read);
            return [read, (next: any) => { value = typeof next === "function" ? next(value) : next; }];
        },
        createEffect() {}, on() {}, onCleanup() {}, onMount: (callback: () => void) => mounts.push(callback),
        app, terminalActions, terminalOpen: () => opened, setTerminalOpen: (value: boolean) => { opened = value; },
        prefs: { terminalHeight: 260 }, basename: (path: string) => path.split("/").pop(), tildify: (path: string) => path,
        terminalShortcut: "Ctrl+`", toast: (text: string, kind: string) => notices.push({ text, kind }),
        rpc: {
            call: (method: string, params: any) => { calls.push({ method, params }); return response(method); },
            onEvent: () => () => {}, onState: () => () => {},
        },
        Terminal, FitAddon: class { fit() {} }, EarlyInput, terminalInputChunks,
        getComputedStyle: () => ({ getPropertyValue: () => "" }), MutationObserver: Observer, ResizeObserver: Observer,
        document: { documentElement: {} }, cancelAnimationFrame() {}, requestAnimationFrame() {},
    };
    let source = readFileSync(new URL("../gui/src/components/TerminalPanel.tsx", import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node" } } }).transformSync(source);
    const components = new Function(...Object.keys(dependencies), `${compiled}\nreturn { TerminalPanel, TerminalScreen, setupTickets };`)(...Object.values(dependencies));
    components.TerminalPanel({ cwd: "/project" });
    return {
        app, calls, notices, terminalActions,
        tabs: () => signals[0]!(), opened: () => opened,
        run: (withSetup = true) => terminalActions.runScript!("/project/feature", script, withSetup ? setup : undefined),
        forgetTicket: (tab: any) => components.setupTickets.delete(tab.id),
        respond: (callback: typeof response) => { response = callback; },
        screen: (tab: any) => {
            const firstSignal = signals.length;
            components.TerminalScreen({ tab, visible: true });
            mounts.pop()!();
            return {
                ended: signals[firstSignal]!,
                restart: () => buttons.find((button) => button.children.includes(" Restart shell"))!.props.onClick(),
                input: (data: string) => onInput!(data),
            };
        },
    };
}

test("manual project scripts and worktree setup insert visible tabs in their requested folders", () => {
    const p = panel();
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
    const p = panel();
    p.run();
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm"]);
    expect(p.calls[0]!.params).toMatchObject({ cwd: "/project/feature", script: script.id, setup: setup.ticket });
    const firstId = p.calls[0]!.params.id;
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm", "terminal.open"]);
    expect(p.calls[2]!.params.id).not.toBe(firstId);
    expect(p.calls[2]!.params).not.toHaveProperty("setup");
    expect(p.calls[2]!.params).not.toHaveProperty("script");
});

test("manual script clicks still run without a setup ticket", async () => {
    const p = panel();
    p.run(false);
    p.screen(p.tabs()[0]);
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.arm"]);
    expect(p.calls[0]!.params).not.toHaveProperty("setup");
});

test("Ctrl+C typed while setup opens is delivered before the script is armed", async () => {
    const p = panel();
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

test("a failed setup start explains that the worktree remains and cannot replay on restart", async () => {
    const p = panel();
    p.respond((method) => method === "scripts.run" ? Promise.reject(new Error("Folder is gone")) : Promise.resolve({}));
    p.run();
    const screen = p.screen(p.tabs()[0]);
    await flush();
    expect(screen.ended()).toContain("Folder is gone");
    expect(screen.ended()).toContain("The worktree was created");
    expect(screen.ended()).toContain("project scripts menu");
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["scripts.run", "terminal.open"]);
});

test("a full window refuses another setup tab with a recoverable warning", () => {
    const p = panel();
    for (let i = 0; i < 12; i++) p.run(false);
    p.run();
    expect(p.tabs()).toHaveLength(12);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0]!.kind).toBe("warn");
    expect(p.notices[0]!.text).toContain("worktree was created");
    expect(p.notices[0]!.text).toContain("12 terminals");
    expect(p.notices[0]!.text).toContain("project scripts menu");
});

test("disconnect before tab creation or before shell start never runs setup", async () => {
    const p = panel();
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
    expect(screen.ended()).toContain("The worktree was created");
    p.app.conn = "open";
    screen.restart();
    await flush();
    expect(p.calls.map((call) => call.method)).toEqual(["terminal.open"]);
});

function worktreeDialog(options: { trusted?: boolean; unreadable?: boolean; openFails?: boolean; terminalMissing?: boolean; deferSetup?: boolean } = {}) {
    const calls: { method: string; params: any }[] = [];
    const steps: string[] = [];
    const runs: any[][] = [];
    const notices: string[] = [];
    const app = { homeCwd: "/project" };
    let trusted = options.trusted ?? true;
    let event: ((event: { type: string }) => void) | undefined;
    const previews: ReturnType<typeof Promise.withResolvers<any>>[] = [];
    const dependencies = {
        createSignal: (initial: unknown) => {
            let value = initial;
            return [() => value, (next: any) => { value = typeof next === "function" ? next(value) : next; }];
        },
        onCleanup() {}, app, asksForSetup, setupNote, setupTabLabel,
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
    return { ...handlers, calls, steps, runs, notices, previews, changed: () => event!({ type: "scripts.changed" }) };
}

test("the worktree dialog requests setup and opens the created worktree before starting its tab", async () => {
    const d = worktreeDialog();
    await flush();
    await d.create();
    expect(d.calls.find((call) => call.method === "projects.createWorktree")!.params.setup).toBe(true);
    expect(d.steps).toEqual(["created", "opened", "setup"]);
    expect(d.runs).toEqual([["/project/feature", script, setup]]);
    expect(d.calls.some((call) => call.method === "projects.trust")).toBe(false);
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
        expect(d.notices.some((text) => text.includes("worktree was created") && text.includes("project scripts menu"))).toBe(true);
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
    const p = panel();
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
