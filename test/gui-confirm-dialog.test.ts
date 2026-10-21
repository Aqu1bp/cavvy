// Like secret-interactions.test.ts, compile the real components with Solid's
// client reactivity. Only the renderer and external services are replaced.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

function component(source: string, name: string, dependencies: Record<string, any> = {}) {
    const nodes: any[] = [];
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : value;
    const renderer = {
        ...solid,
        effect: solid.createRenderEffect,
        memo: solid.createMemo,
        createElement: (tag: string) => { const node = { tag, props: {} }; nodes.push(node); return node; },
        createTextNode: () => ({}),
        insertNode() {},
        setProp: (node: any, key: string, value: any) => { node.props[key] = value; },
        insert: (_node: any, value: any) => solid.createRenderEffect(() => resolve(value)),
    };
    const compiled = transformSync(source, {
        filename: `${name}.tsx`,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]],
        configFile: false,
        babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;")
        .replace(`export function ${name}`, `function ${name}`);
    const scope = { renderer, ...solid, ...dependencies };
    return { nodes, render: new Function(...Object.keys(scope), `${js}; return ${name};`)(...Object.values(scope)) };
}

const dialogSource = readFileSync(new URL("../gui/src/components/ui/ConfirmDialog.tsx", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../gui/src/components/Settings.tsx", import.meta.url), "utf8");

// Include module state as well as the component so remounts share real guards.
const providerSource = settingsSource.slice(settingsSource.lastIndexOf("\n}\n", settingsSource.indexOf("function ProviderRow")) + 3, settingsSource.indexOf("function Providers"));
const generalSource = settingsSource.slice(settingsSource.indexOf("async function update"), settingsSource.indexOf("function ModelSelect"))
    + settingsSource.slice(settingsSource.indexOf("const EFFORT_LABELS"), settingsSource.indexOf("\n}\n", settingsSource.indexOf("function General")) + 3);

function dialog(onConfirm: () => Promise<void>, busy: () => boolean = () => false) {
    let dialogProps: any;
    let closes = 0;
    let disposed = false;
    const [open, setOpen] = solid.createSignal(true);
    const c = component(dialogSource.slice(dialogSource.indexOf("export function")), "ConfirmDialog", {
        Dialog: (p: any) => { dialogProps = p; return p.children; },
    });
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = () => { disposed = true; d(); };
        c.render({
            get open() { return open(); }, title: "Remove?", children: "Confirm removal", confirmLabel: "Remove",
            get busy() { return busy(); },
            onClose: () => { if (disposed) throw new Error("closed after unmount"); closes++; setOpen(false); }, onConfirm,
        });
    });
    return {
        cancel: c.nodes.find((n) => n.props.class === "btn ghost"),
        confirm: c.nodes.find((n) => n.props.class === "btn danger"),
        close: () => dialogProps.onClose(), // Shared by Dialog's Escape, X and backdrop handlers.
        get open() { return dialogProps.open; },
        get closes() { return closes; },
        reopen: () => setOpen(true), dispose,
    };
}

for (const method of ["cancel", "dialog"] as const) {
    test(`pending confirmation can be dismissed via ${method} without resubmitting`, async () => {
        const gate = Promise.withResolvers<void>();
        let calls = 0;
        let results = 0;
        const d = dialog(async () => { calls++; await gate.promise; results++; });
        try {
            d.confirm.props.onClick();
            expect(d.confirm.props.disabled).toBe(true);
            expect(d.cancel.props.disabled).not.toBe(true);
            d.confirm.props.onClick(); // Even a directly invoked handler cannot resubmit.
            if (method === "cancel") d.cancel.props.onClick(); else d.close();
            expect(d.open).toBe(false);
            expect(results).toBe(0);
            d.reopen();
            d.confirm.props.onClick();
            expect(calls).toBe(1);
            gate.resolve();
            await Bun.sleep(0);
            expect(results).toBe(1);
            expect(d.closes).toBe(1); // The old request must not close a reopened dialog.
            expect(d.open).toBe(true);
            expect(d.confirm.props.disabled).toBe(false);
        } finally { d.dispose(); }
    });
}

test("a confirmation still closes normally when the user stays", async () => {
    const gate = Promise.withResolvers<void>();
    const d = dialog(() => gate.promise);
    try {
        d.confirm.props.onClick();
        gate.resolve();
        await Bun.sleep(0);
        expect(d.closes).toBe(1);
        expect(d.open).toBe(false);
    } finally { d.dispose(); }
});

test("unmounting while pending does not call the close callback on completion", async () => {
    const gate = Promise.withResolvers<void>();
    const d = dialog(() => gate.promise);
    d.confirm.props.onClick();
    d.dispose();
    gate.resolve();
    await Bun.sleep(0);
    expect(d.closes).toBe(0);
});

for (const outcome of ["success", "error", "refresh error"] as const) {
    test(`provider removal reports ${outcome} after dismissal and unmount`, async () => {
        const request = Promise.withResolvers<void>();
        const refresh = Promise.withResolvers<void>();
        const messages: string[] = [];
        const errors: unknown[] = [];
        const calls: unknown[] = [];
        let confirmProps: any;
        let mounted = true;
        const c = component(providerSource, "ProviderRow", {
            ConfirmDialog: (p: any) => { confirmProps = p; return {}; },
            ProviderIcon: () => ({}), X: () => ({}), Spinner: () => ({}), ExternalLink: () => ({}),
            rpc: { call: (...args: unknown[]) => { calls.push(args); return request.promise; } },
            refreshProviders: () => Promise.resolve(), refreshModels: () => refresh.promise,
            toast: (message: string) => messages.push(message), reportError: (e: unknown) => errors.push(e),
        });
        let dispose!: () => void;
        solid.createRoot((d: () => void) => {
            dispose = d;
            c.render({ get pr() {
                if (!mounted) throw new Error("provider props read after unmount");
                return { id: "openai", name: "OpenAI", requiresKey: true, configured: true };
            } });
        });
        let operation!: Promise<void>;
        const d = dialog(() => operation = confirmProps.onConfirm());
        d.confirm.props.onClick();
        d.cancel.props.onClick();
        d.dispose();
        dispose();
        mounted = false;
        const failure = new Error("Disconnected");
        if (outcome === "error") request.reject(failure); else request.resolve();
        // Let the successful request enter the slow models refresh.
        await Bun.sleep(0);
        expect(messages).toEqual([]);
        if (outcome === "refresh error") refresh.reject(failure); else refresh.resolve();
        await operation;
        await Bun.sleep(0);
        expect(calls).toEqual([["providers.removeKey", { provider: "openai" }]]);
        expect(messages).toEqual(outcome === "success" ? ["Removed the OpenAI key"] : []);
        expect(errors).toEqual(outcome === "success" ? [] : [failure]);
    });
}

for (const fail of [false, true]) {
    test(`bypass confirmation ${fail ? "reports errors" : "updates settings"} after unmount`, async () => {
        const request = Promise.withResolvers<any>();
        const errors: unknown[] = [];
        const updates: unknown[] = [];
        let confirmProps: any;
        const noop = () => ({});
        const c = component(generalSource, "General", {
            app: { settings: {}, conn: "closed" }, editors: () => [], mod: "Ctrl",
            Section: noop, Row: noop, Toggle: noop, ModelSelect: noop, SelectButton: noop,
            ConfirmDialog: (p: any) => { confirmProps = p; return {}; },
            rpc: { call: (method: string, params: unknown) => {
                expect(method).toBe("settings.update");
                expect(params).toEqual({ patch: { allowBypass: true } });
                return request.promise;
            } },
            setApp: (...args: unknown[]) => updates.push(args), reportError: (e: unknown) => errors.push(e),
        });
        let dispose!: () => void;
        solid.createRoot((d: () => void) => { dispose = d; c.render(); });
        const operation = confirmProps.onConfirm();
        dispose();
        const failure = new Error("Disconnected");
        if (fail) request.reject(failure); else request.resolve({ allowBypass: true });
        await operation;
        expect(updates).toEqual(fail ? [] : [["settings", { allowBypass: true }]]);
        expect(errors).toEqual(fail ? [failure] : []);
    });
}

for (const outcome of ["success", "error", "refresh error"] as const) {
    test(`provider removal stays guarded across remounts until ${outcome}`, async () => {
        const request = Promise.withResolvers<void>();
        const refresh = Promise.withResolvers<void>();
        const calls: string[] = [];
        let confirmProps: any;
        const c = component(providerSource, "ProviderRow", {
            ConfirmDialog: (p: any) => { confirmProps = p; return {}; },
            ProviderIcon: () => ({}), X: () => ({}), Spinner: () => ({}), ExternalLink: () => ({}),
            rpc: { call: (_method: string, p: { provider: string }) => { calls.push(p.provider); return request.promise; } },
            refreshProviders: () => Promise.resolve(), refreshModels: () => refresh.promise,
            toast() {}, reportError() {},
        });
        const mount = (id: string) => {
            let dispose!: () => void;
            solid.createRoot((d: () => void) => {
                dispose = d;
                c.render({ pr: { id, name: id, requiresKey: true, configured: true } });
            });
            const p = confirmProps;
            const d = dialog(() => p.onConfirm(), () => p.busy);
            return { d, confirm: () => p.onConfirm(), dispose: () => { d.dispose(); dispose(); } };
        };
        const first = mount("openai");
        first.d.confirm.props.onClick();
        first.d.close();
        first.dispose();
        const second = mount("openai");
        const other = mount("anthropic");
        try {
            void second.confirm(); // The action itself must guard even a direct call.
            second.d.confirm.props.onClick();
            expect(calls).toEqual(["openai"]);
            expect(second.d.confirm.props.disabled).toBe(true);
            expect(second.d.confirm.props["aria-busy"]).toBe(true);
            expect(other.d.confirm.props.disabled).toBe(false);
            other.d.confirm.props.onClick();
            expect(calls).toEqual(["openai", "anthropic"]);
            if (outcome === "error") request.reject(new Error("Disconnected")); else request.resolve();
            await Bun.sleep(0);
            if (outcome !== "error") expect(second.d.confirm.props.disabled).toBe(true);
            if (outcome === "refresh error") refresh.reject(new Error("Refresh failed")); else refresh.resolve();
            await Bun.sleep(0);
            expect(second.d.confirm.props.disabled).toBe(false);
            expect(second.d.confirm.props["aria-busy"]).toBe(false);
            expect(second.d.open).toBe(true);
            await second.confirm(); // Success and failure both release the guard for an explicit retry.
            expect(calls).toEqual(["openai", "anthropic", "openai"]);
        } finally {
            request.resolve();
            refresh.resolve();
            second.dispose();
            other.dispose();
        }
    });
}

for (const fail of [false, true]) {
    test(`bypass confirmation stays guarded across remounts after ${fail ? "failure" : "success"}`, async () => {
        const request = Promise.withResolvers<any>();
        let calls = 0;
        let confirmProps: any;
        const noop = () => ({});
        const c = component(generalSource, "General", {
            app: { settings: {}, conn: "closed" }, editors: () => [], mod: "Ctrl",
            Section: noop, Row: noop, Toggle: noop, ModelSelect: noop, SelectButton: noop,
            ConfirmDialog: (p: any) => { confirmProps = p; return {}; },
            rpc: { call: () => { calls++; return request.promise; } },
            setApp() {}, reportError() {},
        });
        let dispose!: () => void;
        solid.createRoot((d: () => void) => { dispose = d; c.render(); });
        const first = dialog(() => confirmProps.onConfirm(), () => confirmProps.busy);
        first.confirm.props.onClick();
        first.close();
        first.dispose();
        dispose();
        solid.createRoot((d: () => void) => { dispose = d; c.render(); });
        const second = dialog(() => confirmProps.onConfirm(), () => confirmProps.busy);
        try {
            void confirmProps.onConfirm();
            second.confirm.props.onClick();
            expect(calls).toBe(1);
            expect(second.confirm.props.disabled).toBe(true);
            if (fail) request.reject(new Error("Disconnected")); else request.resolve({ allowBypass: true });
            await Bun.sleep(0);
            expect(second.confirm.props.disabled).toBe(false);
            expect(second.open).toBe(true);
            await confirmProps.onConfirm();
            expect(calls).toBe(2);
        } finally { request.resolve({}); second.dispose(); dispose(); }
    });
}
