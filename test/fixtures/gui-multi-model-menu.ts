import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createEffect, createSignal, onCleanup } from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { menuIndex, menuTypeahead, mountMenu } from "../../gui/src/lib/menu";

const cleanups: (() => void)[] = [];
function test(_name: string, run: () => void) {
    try { run(); } finally { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); }
}
const source = (name: string) => readFileSync(new URL(`../../gui/src/components/${name}.tsx`, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");

function picker(available = true) {
    const root = node("root");
    const body = node("body");
    let active: any = body;
    let listener: ((e: any) => void) | undefined;
    const frames = new Map<number, () => void>();
    let frameId = 0;
    const oldRequest = globalThis.requestAnimationFrame;
    const oldCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: () => void) => { frames.set(++frameId, cb); return frameId; }) as any;
    globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
    cleanups.push(() => { globalThis.requestAnimationFrame = oldRequest; globalThis.cancelAnimationFrame = oldCancel; });
    const doc = {
        body,
        get activeElement() { return active === body || active.isConnected ? active : body; },
        addEventListener(_name: string, fn: any) { listener = fn; },
        removeEventListener(_name: string, fn: any) { if (listener === fn) listener = undefined; },
    };
    const matches = (n: Node, selector: string): boolean => selector.split(",").some((s) => {
        s = s.trim();
        if (s === ":disabled") return !!n.props.disabled;
        if (s === "[tabindex]") return n.props.tabIndex !== undefined;
        const role = s.match(/^\[role="(.*)"\]$/)?.[1];
        if (role) return n.props.role === role;
        if (s.startsWith(".")) return s.slice(1).split(".").every((c) => (n.props.class ?? "").split(" ").includes(c));
        return n.tag === s;
    });
    const adapt = (n: Node): any => {
        if ("focus" in n) return n;
        Object.defineProperties(n, {
            isConnected: { get: () => all(root).includes(n) },
            tabIndex: { get: () => n.props.tabIndex ?? (["input", "button", "select"].includes(n.tag) ? 0 : -1) },
            parentElement: { get: () => n.parent && adapt(n.parent) },
        });
        return Object.assign(n, {
            ownerDocument: doc,
            focus() { active = n; n.props.onFocus?.(); },
            click() { if (!n.props.disabled) n.props.onClick?.(); },
            scrollIntoView() {}, getClientRects: () => [{}],
            matches: (s: string) => matches(n, s),
            getAttribute: (s: string) => n.props[s] === undefined ? null : String(n.props[s]),
            contains: (target: Node) => all(n).includes(target),
            closest: (s: string): any => matches(n, s) ? n : n.parent ? adapt(n.parent).closest(s) : null,
            querySelectorAll: (s: string) => all(n).slice(1).filter((el) => matches(el, s)).map(adapt),
            querySelector: (s: string) => all(n).slice(1).filter((el) => matches(el, s)).map(adapt)[0] ?? null,
        });
    };
    // Real Menu + controller and Solid reconciliation; only DOM/portal placement is adapted.
    const Menu = component(source("ui/Menu"), "Menu", {
        Popover(p: any) {
            const panel = node("dialog");
            renderer.insert(panel, () => p.open ? p.children : undefined);
            createEffect(() => {
                if (p.open) {
                    all(root).forEach(adapt);
                    onCleanup(mountMenu(adapt(panel), p.behavior));
                }
            });
            return panel;
        },
    });
    const [open, setOpen] = createSignal(false);
    const [comparePicks, setComparePicks] = createSignal<string[]>();
    const chosen: string[] = [];
    const warnings: string[] = [];
    const models = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) => ({ ref: `mock:${name}`, id: name, name, provider: "mock" }));
    const ModelPicker = component(source("ModelPicker"), "ModelPicker", {
        Menu, menuIndex, menuTypeahead, comparePicks, setComparePicks,
        app: { models: [{ provider: "mock", providerName: "Mock", models }], providers: [] },
        prefs: { favoriteModels: [] }, setPrefs() {}, handleFor() {}, refreshModels() {},
        setModel: (ref: string) => chosen.push(ref), toast: (msg: string) => warnings.push(msg),
        isMod: (e: any) => e.ctrlKey, mod: "Ctrl", withShortcut: (label: string, action: string) => (action === "chat:modelPicker" ? `${label} (Ctrl+/)` : label), ProviderIcon: () => node("icon"),
        ...Object.fromEntries(["Brain", "Check", "ChevronDown", "Layers", "RefreshCw", "Search", "Settings2", "Star", "Zap", "Spinner"].map((name) => [name, () => node("icon")])),
    });
    cleanups.push(renderer.render(() => ModelPicker({ get open() { return open(); }, setOpen, currentRef: models[0]!.ref, compare: { available, why: "Requires a Git project" } }), root));
    const find = (predicate: (n: Node) => boolean) => adapt(all(root).find(predicate)!);
    const trigger = find((n) => n.tag === "button" && n.props["aria-haspopup"] === "dialog");
    const key = (key: string, extra: Record<string, any> = {}) => {
        const target = doc.activeElement;
        const e = { key, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
        listener?.(e);
        // Model the browser's default button activation after the production key handler.
        if (!e.defaultPrevented && target.tag === "button" && ["Enter", " "].includes(key)) target.click();
        return e;
    };
    trigger.focus(); trigger.click();
    for (const [id, cb] of frames) { frames.delete(id); cb(); }
    return { root, doc, trigger, key, open, comparePicks, chosen, warnings, find,
        search: () => find((n) => n.props.role === "combobox"),
        toggle: () => find((n) => n.props.role === "switch"),
        options: () => all(root).filter((n) => n.props.role === "option").map(adapt),
    };
}

test("Compare keyboard toggles keep the Menu open and restore the same trigger on Escape", () => {
    const f = picker();
    expect(f.doc.activeElement).toBe(f.search());
    f.key("Tab", { shiftKey: true });
    expect(f.doc.activeElement).toBe(f.toggle());
    f.key(" ");
    expect(f.comparePicks()).toEqual(["mock:Alpha"]);
    expect(f.doc.activeElement).toBe(f.toggle());
    expect(f.open()).toBe(true);
    expect(text(f.trigger)).toContain("Pick 2–4 models");
    expect(f.options()[0].props["aria-selected"]).toBe(true);
    expect(f.find((n) => n.props.role === "listbox").props["aria-multiselectable"]).toBe(true);
    f.key("Tab");
    expect(f.doc.activeElement).toBe(f.search());
    f.key("ArrowDown"); f.key("Enter");
    expect(f.comparePicks()).toEqual(["mock:Alpha", "mock:Bravo"]);
    expect(f.doc.activeElement).toBe(f.search());
    expect(text(f.trigger)).toContain("2 models");
    const option = f.options()[1];
    option.focus(); f.key(" ");
    expect(f.comparePicks()).toEqual(["mock:Alpha"]);
    expect(f.doc.activeElement).toBe(option);
    f.key("Enter");
    expect(f.comparePicks()).toEqual(["mock:Alpha", "mock:Bravo"]);
    f.key("3", { ctrlKey: true }); f.key("4", { ctrlKey: true }); f.key("5", { ctrlKey: true });
    expect(f.comparePicks()).toHaveLength(4);
    expect(f.warnings).toEqual(["Up to 4 models at once"]);
    expect(f.chosen).toEqual([]);
    expect(f.open()).toBe(true);
    f.key("Escape");
    expect(f.open()).toBe(false);
    expect(f.doc.activeElement).toBe(f.trigger);
    expect(f.trigger.isConnected).toBe(true);
});

test("turning Compare off restores single-select behavior without replacing the trigger", () => {
    const f = picker();
    f.toggle().focus(); f.key("Enter"); f.key("Enter");
    expect(f.comparePicks()).toBeUndefined();
    expect(f.open()).toBe(true);
    expect(f.doc.activeElement).toBe(f.toggle());
    f.search().focus(); f.key("ArrowDown"); f.key("Enter");
    expect(f.chosen).toEqual(["mock:Bravo"]);
    expect(f.open()).toBe(false);
    expect(f.doc.activeElement).toBe(f.trigger);
});

test("unavailable Compare is disabled and excluded from keyboard focus", () => {
    const f = picker(false);
    expect(f.toggle().props.disabled).toBe(true);
    f.key("Tab", { shiftKey: true });
    expect(f.doc.activeElement).not.toBe(f.toggle());
    f.toggle().click();
    expect(f.comparePicks()).toBeUndefined();
    expect(text(f.root)).toContain("Requires a Git project");
});

test("the model chip's tooltip and accessible name say whose model it is", () => {
    const f = picker();
    f.key("Escape");
    // Claude Code's Opus and the Anthropic API's read the same on the chip; the provider tells them apart.
    expect(f.trigger.props.title).toBe("Alpha · Mock (Ctrl+/)");
    // The accessible name is the chip's own text plus the provider the hidden icon stands for.
    expect(f.trigger.props["aria-label"]).toBeUndefined();
    expect(text(f.trigger)).toBe("Alpha, Mock");
});
