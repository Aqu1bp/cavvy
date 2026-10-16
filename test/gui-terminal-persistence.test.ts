import { expect, test } from "bun:test";
import { TerminalClosures, parseTabs, restoreTabs, type SavedTabs } from "../gui/src/lib/terminal";
import type { Rpc } from "../gui/src/lib/rpc";
import { isTerminalReply } from "../src/server/terminal-reply";

function transport() {
    const calls: string[] = [];
    let fail: string | undefined;
    let failedMethod: string | undefined;
    const client = {
        state: "open",
        async call(method: string, { id }: { id: string }) {
            calls.push(`${method}:${id}`);
            if (fail && (!failedMethod || method === failedMethod)) throw Object.assign(new Error(fail), { code: fail });
            return { id, cwd: "/project" };
        },
    };
    return { calls, client: client as Pick<Rpc, "call" | "state">, fail(code?: string, method?: string) { fail = code; failedMethod = method; } };
}

test("closing offline survives a reload and closes the shell after reconnect", async () => {
    const t = transport();
    t.client.state = "reconnecting";
    let saved: SavedTabs = { tabs: [], next: 2, open: false };
    const closes = new TerminalClosures([], t.client, () => { saved.closed = closes.ids; });
    closes.close("shell");
    expect(t.calls).toEqual([]);
    expect(saved.closed).toEqual(["shell"]);
    const back = parseTabs(JSON.stringify(saved));
    expect(restoreTabs(back, [{ id: "shell", cwd: "/project" }]).tabs).toEqual([]);
    const reloaded = new TerminalClosures(back.closed ?? [], t.client, () => {});
    t.client.state = "open";
    await reloaded.flush();
    expect(t.calls).toEqual(["terminal.close:shell"]);
    expect(reloaded.ids).toEqual([]);
});

test("lost close replies keep close intent for retry, missing shells finish it", async () => {
    const t = transport();
    const closes = new TerminalClosures(["shell"], t.client, () => {});
    t.fail("disconnected", "terminal.close");
    await closes.flush();
    expect(closes.ids).toEqual(["shell"]);
    t.fail("terminal_not_open");
    await closes.flush();
    expect(closes.ids).toEqual([]);
    expect(t.calls.slice(-2)).toEqual(["terminal.close:shell", "terminal.attach:shell"]);
});

for (const initial of ["pending", "old socket"] as const) {
    test(`close cancels ${initial} without losing intent as a script lookup finishes`, async () => {
        let state: string = initial;
        const calls: string[] = [];
        const client = {
            state: "open",
            async call(method: string) {
                calls.push(method);
                if (method === "terminal.attach") {
                    // A lookup can finish after attach found no shell, but before the next RPC.
                    // The old attach-first sequence then drops the intent on close's not-open.
                    if (state === "pending") {
                        state = "old socket";
                        throw Object.assign(new Error("not open"), { code: "terminal_not_open" });
                    }
                    state = "new socket";
                    return {};
                }
                if (state === "old socket") throw Object.assign(new Error("not open"), { code: "terminal_not_open" });
                state = "closed";
                return null;
            },
        };
        const closes = new TerminalClosures(["shell"], client as Pick<Rpc, "call" | "state">, () => {});
        await closes.flush();
        expect(state).toBe("closed");
        expect(closes.ids).toEqual([]);
        expect(calls).toEqual(initial === "pending" ? ["terminal.close"] : ["terminal.close", "terminal.attach", "terminal.close"]);
    });
}

test("saved pending closes are validated and exclude stale tab metadata", () => {
    const saved = parseTabs(JSON.stringify({ tabs: [{ id: "tab", terminal: "shell", number: 1, cwd: "/p" }], closed: ["shell", "shell", "bad id", 3] }));
    expect(saved.closed).toEqual(["shell"]);
    expect(saved.tabs).toEqual([]);
});

test("replay response filtering recognises terminal replies without swallowing keyboard or pasted commands", () => {
    expect(isTerminalReply("\x1b[?1;2c\x1b[12;40R")).toBe(true);
    expect(isTerminalReply("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(true);
    for (const data of ["echo test\r", "\x03", "\x1b[A", "\x1b[200~ls\x1b[201~"]) expect(isTerminalReply(data)).toBe(false);
});

test("a window key stays stable when storage reads succeed but writing fails", async () => {
    const old = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    let writes = 0;
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
        getItem() { return null; },
        setItem() { writes++; throw new Error("Storage quota exceeded"); },
    } });
    try {
        const { windowKey } = await import("../gui/src/lib/platform");
        const key = windowKey();
        expect(key).toMatch(/^[0-9a-f]{32}$/);
        expect(windowKey()).toBe(key);
        expect(writes).toBe(1);
    } finally {
        if (old) Object.defineProperty(globalThis, "sessionStorage", old);
        else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
});

// Compile the real component with Solid's client runtime. The terminal and RPC
// are controllable boundaries; handlers, effects and async ordering stay real.
import { readFileSync } from "node:fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";
import { EarlyInput, terminalInputChunks } from "../gui/src/lib/terminal";
import { RpcError } from "../gui/src/lib/rpc";

function mounted(name: "TerminalPanel" | "TerminalScreen", opts: { conn?: string; saved?: SavedTabs; script?: { id: string; name: string }; fresh?: boolean } = {}) {
    const [conn, setConn] = solid.createSignal(opts.conn ?? "open");
    const [panelOpen, setPanelOpen] = solid.createSignal(false);
    const calls: { method: string; params: any; resolve: (v: any) => void; reject: (e: any) => void }[] = [];
    const events = new Set<(e: any) => void>();
    const states = new Set<(s: any) => void>();
    const nodes: any[] = [];
    const terminals: Emulator[] = [];
    const closed: string[] = [];
    const saved: SavedTabs[] = [];
    class Emulator {
        options: any = {}; cols = 80; rows = 24;
        input: (data: string) => void = () => {};
        writes: { data: string; done?: () => void }[] = [];
        constructor() { terminals.push(this); }
        loadAddon() {} open() {} focus() {} dispose() {} attachCustomKeyEventHandler() {}
        onData(fn: (data: string) => void) { this.input = fn; return { dispose() {} }; }
        write(data: string, done?: () => void) { this.writes.push({ data, done }); }
        drain() { for (const w of this.writes.splice(0)) { if (w.data.includes("QUERY")) this.input("\x1b[?1;2c"); w.done?.(); } }
    }
    const rpc = {
        get state() { return conn(); },
        call(method: string, params: any) {
            if (conn() !== "open") return Promise.reject(new RpcError("Offline", "disconnected"));
            const pending = Promise.withResolvers<any>();
            calls.push({ method, params, ...pending });
            if (!["terminal.list", "terminal.attach", "terminal.open", "scripts.run", "terminal.close"].includes(method)) pending.resolve(null);
            return pending.promise;
        },
        onEvent(fn: any) { events.add(fn); return () => events.delete(fn); },
        onState(fn: any) { states.add(fn); return () => states.delete(fn); },
    };
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : value;
    const renderer = {
        ...solid, effect: solid.createRenderEffect, memo: solid.createMemo,
        createElement(tag: string) { const node = { tag, props: {}, clientHeight: 0 }; nodes.push(node); return node; },
        createTextNode: () => ({}), insertNode() {},
        setProp(node: any, key: string, value: any) { node.props[key] = value; },
        insert(_node: any, value: any) { solid.createRenderEffect(() => resolve(value)); },
    };
    const source = readFileSync(new URL("../gui/src/components/TerminalPanel.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const compiled = transformSync(source, { filename: "TerminalPanel.tsx", parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled).replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const noop = () => ({});
    const deps = {
        renderer, ...solid, rpc, app: { get conn() { return conn(); } }, RpcError, EarlyInput, TerminalClosures, terminalInputChunks, isTerminalReply,
        loadTabs: () => opts.saved ?? { tabs: [], next: 1, open: false }, restoreTabs, saveTabs: (value: SavedTabs) => saved.push(value),
        terminalOpen: panelOpen, setTerminalOpen: setPanelOpen, terminalActions: {}, prefs: { terminalHeight: 200 }, setPrefs() {},
        basename: (v: string) => v, tildify: (v: string) => v, terminalShortcut: "Ctrl+`", toast() {}, reportError() {},
        Play: noop, Plus: noop, RotateCw: noop, SquareTerminal: noop, X: noop, Terminal: Emulator, FitAddon: class { fit() {} },
        ResizeObserver: class { observe() {} disconnect() {} }, MutationObserver: class { observe() {} disconnect() {} },
        getComputedStyle: () => ({ getPropertyValue: () => "#000" }), document: { documentElement: {} },
        requestAnimationFrame: () => 0, cancelAnimationFrame() {}, isTerminalToggle: () => false, isMod: () => false, copyText() {},
    };
    const component = new Function(...Object.keys(deps), `${js}; return ${name};`)(...Object.values(deps));
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        component(name === "TerminalPanel" ? { cwd: "/p" } : {
            tab: { id: "tab", terminal: "shell", cwd: "/p", number: 1, attach: !opts.fresh, script: opts.script }, visible: false,
            onClose: (id: string) => closed.push(id),
            onRestart: async (_next: string, previous?: string) => { if (previous) await rpc.call("terminal.close", { id: previous }); },
        });
    });
    return { calls, terminals, nodes, closed, saved, dispose, setPanelOpen,
        event(e: any) { for (const fn of events) fn(e); },
        connection(state: string) { setConn(state); for (const fn of states) fn(state); },
    };
}
const tick = () => Bun.sleep(0);

test("real panel waits for a connection and retries interrupted reconciliation", async () => {
    const m = mounted("TerminalPanel", { conn: "connecting", saved: { tabs: [], next: 1, open: false } });
    try {
        expect(m.calls).toEqual([]);
        m.connection("open"); await tick();
        expect(m.calls.map((c) => c.method)).toEqual(["terminal.list"]);
        m.connection("reconnecting"); m.calls[0]!.reject(new RpcError("lost", "disconnected")); await tick();
        m.connection("open"); await tick();
        m.calls[1]!.resolve([{ id: "server-shell", cwd: "/p", script: { id: "dev", name: "Dev" } }]); await tick();
        expect(m.calls.map((c) => c.method)).toEqual(["terminal.list", "terminal.list", "terminal.attach"]);
        expect(m.saved.at(-1)?.tabs[0]?.script?.name).toBe("Dev");
    } finally { m.dispose(); }
});

test("real screen suppresses replay replies after attach reply but keeps early user input and never rearms scripts", async () => {
    const m = mounted("TerminalScreen", { script: { id: "dev", name: "Dev" } });
    try {
        const term = m.terminals[0]!;
        term.input("typed");
        m.event({ type: "terminal.data", id: "shell", pos: 5, data: "QUERY", reset: true });
        m.calls[0]!.resolve({ id: "shell", cwd: "/p" }); await tick();
        term.drain(); await tick();
        expect(m.calls.filter((c) => c.method === "terminal.write").map((c) => c.params.data)).toEqual(["typed"]);
        expect(m.calls.some((c) => c.method === "terminal.arm" || c.method === "scripts.run")).toBe(false);
        m.event({ type: "terminal.moved", id: "shell" });
        m.connection("reconnecting"); m.connection("open"); await tick();
        expect(m.calls.filter((c) => c.method === "terminal.attach")).toHaveLength(1);
        m.dispose(); expect(m.closed).toEqual([]);
    } finally { m.dispose(); }
});

test("real screen reattaches exited shells and waits for close before restarting at capacity", async () => {
    const m = mounted("TerminalScreen");
    try {
        m.calls[0]!.resolve({ id: "shell", cwd: "/p", exitCode: 3 }); await tick();
        m.connection("reconnecting"); m.connection("open");
        expect(m.calls.filter((c) => c.method === "terminal.attach")).toHaveLength(2);
        m.calls[1]!.resolve({ id: "shell", cwd: "/p", exitCode: 3 }); await tick();
        const restart = m.nodes.find((n) => n.tag === "button" && n.props.class === "btn secondary sm");
        restart.props.onClick(); await tick();
        m.terminals[0]!.drain();
        expect(m.calls.some((c) => c.method === "terminal.open")).toBe(false);
        m.calls.find((c) => c.method === "terminal.close")!.resolve(null); await tick();
        m.terminals[0]!.drain(); await tick();
        expect(m.calls.at(-1)?.method).toBe("terminal.open");
    } finally { m.dispose(); }
});

test("real screen preserves close intent when an opening reply is lost after tab disposal", async () => {
    const m = mounted("TerminalScreen", { fresh: true, script: { id: "dev", name: "Dev" } });
    expect(m.calls[0]!.method).toBe("scripts.run");
    m.dispose();
    m.connection("reconnecting");
    m.calls[0]!.reject(new RpcError("lost", "disconnected")); await tick();
    expect(m.closed).toEqual(["shell", "shell"]);
});
