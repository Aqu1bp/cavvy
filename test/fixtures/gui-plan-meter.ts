import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { planLimitKey, type AccountInfo } from "../../src/server/protocol";
import { limitAlternatives, meterOf, windowLine } from "../../gui/src/lib/limits";
import { contextView } from "../../gui/src/lib/context";
import { cost, tokens } from "../../gui/src/lib/format";

const source = (path: string) => readFileSync(new URL(`../../gui/src/${path}`, import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const accounts: AccountInfo[] = ["default", "work"].map((id) => ({ id, name: id === "default" ? "Default" : "Work", folder: `/fake/${id}`, managed: id !== "default", signedIn: true }));
const timestamp = Date.now();
function mount(options: { plan?: number; reached?: boolean; unknown?: boolean; home?: boolean; current?: string; singleAccount?: boolean; autoCompact?: boolean; credits?: boolean } = {}) {
    const root = node("root");
    const calls: any[] = [];
    const errors: unknown[] = [];
    const notices: string[] = [];
    const pending = Promise.withResolvers<AccountInfo[]>();
    const [open, setOpen] = solid.createSignal(false);
    const [catalog, setCatalog] = solid.createSignal(options.singleAccount ? accounts.filter(a => a.id === options.current) : accounts);
    const [state, setState] = solid.createSignal<any>({ model: { provider: "cli", providerName: "CLI", contextWindow: options.unknown ? undefined : 200_000 }, contextTokens: 50_000, tokensIn: 1000, tokensOut: 200, cost: 1.25, busy: false, accounts: { cli: options.current ?? "default" } });
    const [limits, setLimits] = solid.createSignal<any>(options.plan === undefined && !options.reached ? {} : {
        [planLimitKey("cli", options.current ?? "default")]: { provider: "cli", accountId: options.current ?? "default", at: timestamp, reached: options.reached, credits: options.credits, windows: options.plan === undefined ? [] : [{ label: "5-hour", usedPercent: options.plan, resetsAt: timestamp + 3600000 }, { label: "Weekly", usedPercent: 15, resetsAt: timestamp + 86400000 }] },
    });
    const listeners = new Map<string, Function>();
    const doc: any = { activeElement: undefined, addEventListener: (key: string, fn: Function) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) };
    const domRenderer = { ...solid, ...renderer, Portal: (p: any) => p.children, createElement: (tag: string) => {
        const n: any = node(tag);
        n.contains = (other: Node) => all(n).includes(other);
        n.focus = () => { doc.activeElement = n; n.props.onFocus?.(); };
        return n;
    } };
    const Popover = component(source("components/ui/Popover.tsx"), "Popover", { settingsTab: () => undefined, sp: (n: number) => n, document: doc, window: { addEventListener() {}, removeEventListener() {} }, requestAnimationFrame() {}, renderer: domRenderer });
    const Ring = component(source("components/ui/bits.tsx"), "Ring", {});
    let settingsTab: string | undefined;
    const Meter = component(source("components/ComposerMeter.tsx"), "ComposerMeter", {
        app: { settings: { autoCompact: options.autoCompact ?? false }, providers: [{ id: "cli", name: "CLI", agentCli: { plan: "Pro", defaultAccount: "work", get accounts() { return catalog(); } } }], get limits() { return limits(); } },
        handleFor: () => ({ view: { get state() { return state(); } } }), contextCardOpen: open, setContextCardOpen: setOpen,
        rpc: { call: (...args: any[]) => { calls.push(args); return args[0] === "accounts.list" ? pending.promise : Promise.resolve(); } },
        now: () => timestamp, planLimitKey, limitAlternatives, meterOf, windowLine, contextView, cost, tokens,
        reportError: (error: unknown) => errors.push(error), toast: (message: string) => notices.push(message), setSettingsTab: (tab: string) => { settingsTab = tab; },
        document: doc, Popover, Ring, Gauge: () => null, renderer: domRenderer, sp: (n: number) => n,
    });
    const dispose = renderer.render(() => Meter({ sessionId: options.home ? undefined : "session", provider: "cli" }), root);
    const wire = () => all(root).forEach((n: any) => {
        n.contains = (other: Node) => all(n).includes(other);
        n.focus = () => { doc.activeElement = n; n.props.onFocus?.(); };
    });
    wire();
    const trigger = () => all(root).find(n => n.props["aria-haspopup"] === "dialog")!;
    // A row of the card by its word (Usage has the session's figures after it).
    const button = (label: string) => all(root).find(n => n.tag === "button" && text(n).startsWith(label))!;
    const show = () => { setOpen(true); wire(); };
    const escape = () => listeners.get("keydown")!({ key: "Escape", stopPropagation() {} });
    /** How the words under the composer are toned: normal, warning or danger. */
    const tone = () => /\btone-(\w+)/.exec(trigger().props.class)?.[1];
    /** How far the card's bar is filled. */
    const filled = () => all(root).find(n => n.tag === "i" && n.parent?.props.class?.startsWith("cx-bar"))?.props.style.width;
    return { root, calls, errors, notices, pending, setCatalog, setState, state, setLimits, trigger, button, show, open, setOpen, escape, tone, filled, wire, doc, dispose, settingsTab: () => settingsTab };
}

test("API context-only control, compaction, spend, busy state, and usage navigation", () => {
    const m = mount();
    try {
        expect(all(m.root).filter(n => n.tag === "button")).toHaveLength(1);
        expect(m.trigger().props["aria-label"]).toBe("Context: 25% used");
        // In words, under the composer.
        expect(text(m.trigger())).toBe("25% context");
        m.show();
        // The card grows out of the words: what to do on top, then what the context holds beside the words themselves.
        expect(text(m.root)).toContain("Compact now50k of 200k25% context");
        expect(text(m.root)).not.toContain("Limit reached");
        // The card is the context alone: what the session has used is Settings → Usage's.
        expect(text(m.root)).not.toContain(" in, ");
        expect(all(m.root).filter(n => n.tag === "button" && text(n).startsWith("Usage"))).toHaveLength(0);
        // Unavailable, not disabled, while a reply runs: its tooltip still says why, and a click does nothing.
        m.setState({ ...m.state(), busy: true });
        expect(m.button("Compact now").props["aria-disabled"]).toBe(true);
        expect(m.button("Compact now").props.title).toBe("Available when the reply finishes");
        m.button("Compact now").props.onClick();
        expect(m.calls).toEqual([]);
        // Busy only with an idle compaction: the user's own takes over from it.
        m.setState({ ...m.state(), busy: true, activity: { label: "Compacting while idle", since: 0, idle: true } });
        expect(m.button("Compact now").props["aria-disabled"]).toBeUndefined();
        m.setState({ ...m.state(), busy: false, activity: undefined });
        m.button("Compact now").props.onClick();
        expect(m.calls).toEqual([["session.compact", { id: "session" }]]);
        expect(m.open()).toBe(false);
    } finally { m.dispose(); }
});

test("plan usage short of a limit leaves the words to the context (the rail's footer shows it)", () => {
    for (const plan of [85, 95]) {
        const m = mount({ plan });
        try {
            expect(m.tone()).toBe("normal");
            expect(m.trigger().props["aria-label"]).toBe("Context: 25% used");
            m.show();
            expect(text(m.root)).not.toContain("5-hour");
        } finally { m.dispose(); }
    }
});

test("the words are the context; their tone follows the context alone", () => {
    const m = mount({ plan: 80 });
    try {
        expect(all(m.root).filter(n => n.tag === "button")).toHaveLength(1);
        expect(m.tone()).toBe("normal");
        m.show();
        expect(all(m.root).filter(n => n.tag === "h3").map(text)).toEqual(["Context"]);
        m.setState({ ...m.state(), contextTokens: 150000 });
        expect(m.tone()).toBe("warning");
        m.setState({ ...m.state(), contextTokens: 180000 });
        expect(m.tone()).toBe("danger");
        expect(text(m.trigger())).toBe("90% context");
        expect(m.filled()).toBe("90%");
    } finally { m.dispose(); }
});

for (const reached of [false, true]) test(`unknown size stays empty${reached ? ", red once a limit is reached" : " and neutral"}; shared /context signal opens the same card`, () => {
    const m = mount({ unknown: true, reached, plan: reached ? 100 : undefined });
    try {
        expect(m.tone()).toBe(reached ? "danger" : "normal");
        // No share to say yet: the word alone.
        expect(text(m.trigger())).toBe("Context");
        expect(m.trigger().props["aria-label"]).toContain("size not known yet");
        if (reached) expect(m.trigger().props["aria-label"]).toContain("Pro · Default usage:");
        m.show();
        expect(text(m.root)).toContain("Known after CLI's first reply");
        expect(all(m.root).filter(n => n.props.role === "dialog")).toHaveLength(1);
        expect(m.trigger().props["aria-controls"]).toBe(all(m.root).find(n => n.props.role === "dialog")!.props.id);
    } finally { m.dispose(); }
});

for (const current of ["default", "work"]) test(`${current}: refresh only alternatives, and switch from inside the card`, async () => {
    const m = mount({ current, reached: true, singleAccount: true });
    try {
        expect(m.calls).toEqual([]);
        expect(all(m.root).filter(n => n.tag === "button")).toHaveLength(1);
        m.show();
        expect(text(m.root)).toContain("Limit reached");
        m.setCatalog(accounts);
        expect(m.calls).toEqual([["accounts.list", { provider: "cli", refresh: true }]]);
        expect(text(m.root)).toContain("Checking accounts…");
        m.pending.resolve(accounts);
        await Bun.sleep(0);
        const alternative = current === "default" ? "Work" : "Default";
        m.setState({ ...m.state(), busy: true });
        expect(m.button(`Switch to ${alternative}`).props.disabled).toBe(true);
        m.setState({ ...m.state(), busy: false });
        m.button(`Switch to ${alternative}`).props.onClick();
        await Bun.sleep(0);
        expect(m.calls.at(-1)).toEqual(["session.setAccount", { id: "session", provider: "cli", accountId: alternative.toLowerCase() }]);
        expect(m.open()).toBe(false);
        expect(m.notices).toHaveLength(1);
        m.show(); m.setCatalog(accounts.filter(a => a.id === current));
        expect(text(m.root)).not.toContain("Switch to");
    } finally { m.dispose(); }
});

test("reached on credits (#434): says so, and switching away doesn't claim the turn stopped", async () => {
    const m = mount({ reached: true, credits: true });
    try {
        expect(m.trigger().props["aria-label"]).toContain("Pro · Default usage: limit reached · using credits");
        m.show();
        expect(text(m.root)).toContain("Limit reached, using credits");
        m.pending.resolve(accounts);
        await Bun.sleep(0);
        // Another account is still offered: it stops the spending.
        m.button("Switch to Work").props.onClick();
        await Bun.sleep(0);
        expect(m.notices).toEqual(["Account switched. Your next message uses it."]);
    } finally { m.dispose(); }
    const hard = mount({ reached: true, credits: false });
    try {
        hard.show();
        expect(text(hard.root)).toContain("Limit reached");
        expect(text(hard.root)).not.toContain("using credits");
    } finally { hard.dispose(); }
});

test("Home uses default account; session uses its own account", () => {
    for (const home of [true, false]) {
        const m = mount({ home });
        try {
            m.setLimits(Object.fromEntries([ ["default", 100], ["work", 100] ].map(([id, pct]) => [planLimitKey("cli", id as string), { at: timestamp, reached: true, windows: [{ label: id === "work" ? "Weekly" : "5-hour", usedPercent: pct }] }])));
            m.wire();
            expect(m.trigger().props["aria-label"]).toContain(home ? "Pro · Work usage: Weekly 100%" : "Pro · Default usage: 5-hour 100%");
            m.show();
            expect(text(m.root)).toContain(home ? "Pro · Work, weekly limit." : "Pro · Default, 5-hour limit.");
            expect(m.button("Compact now").props["aria-disabled"]).toBe(home ? true : undefined);
        } finally { m.dispose(); }
    }
});

test("focus/click/ArrowDown open; Escape closes and restores focus; delayed hover/blur close", async () => {
    const m = mount();
    try {
        m.trigger().props.onFocus(); m.wire();
        expect(m.open()).toBe(true);
        m.trigger().props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
        expect(m.doc.activeElement.props.role).toBe("dialog");
        m.escape();
        expect(m.open()).toBe(false);
        expect(m.doc.activeElement).toBe(m.trigger());
        m.trigger().props.onClick(); m.wire();
        expect(m.open()).toBe(true);
        m.escape(); m.doc.activeElement = undefined;
        m.trigger().props.onMouseEnter(); m.wire();
        m.trigger().props.onMouseLeave();
        expect(m.open()).toBe(true);
        const panel = all(m.root).find(n => n.props.role === "dialog")!;
        panel.props.onMouseEnter();
        await Bun.sleep(180);
        expect(m.open()).toBe(true);
        panel.props.onMouseLeave();
        await Bun.sleep(180);
        expect(m.open()).toBe(false);
        m.trigger().props.onFocus(); m.wire();
        m.trigger().props.onBlur();
        m.doc.activeElement = m.button("Compact now");
        await Bun.sleep(180);
        expect(m.open()).toBe(true);
        m.doc.activeElement = undefined;
        all(m.root).find(n => n.props.role === "dialog")!.props.onFocusOut();
        await Bun.sleep(180);
        expect(m.open()).toBe(false);
    } finally { m.dispose(); }
});


test("aggregate limit resets survive windows without resets, without duplicating window resets", () => {
    const m = mount();
    try {
        const report = { at: timestamp, reached: true, resetsAt: timestamp + 3600000, windows: [{ label: "5-hour", usedPercent: 70 }] };
        m.setLimits({ [planLimitKey("cli", "default")]: report });
        m.show();
        expect(text(m.root)).toContain(`Resets ${meterOf(report, timestamp)!.resets}`);
        m.setLimits({ [planLimitKey("cli", "default")]: { ...report, windows: [{ ...report.windows[0], usedPercent: 100, resetsAt: report.resetsAt }] } });
        expect(text(m.root).match(/Resets /g)).toHaveLength(1);
    } finally { m.dispose(); }
});


test("context is measured to where it compacts, and the numbers say where that comes from", () => {
    const m = mount({ autoCompact: true });
    try {
        m.show();
        const numbers = () => all(m.root).find(n => n.tag === "span" && n.props.title !== undefined && text(n).includes(" of "))!;
        expect(numbers().props.title).toBe("CLI decides when to compact. The model holds up to 200k.");
        m.setState({ ...m.state(), compactAt: 100_000 });
        expect(text(m.root)).toContain("50k of 100k50% context");
        expect(m.trigger().props["aria-label"]).toBe("Context: 50% used");
        expect(numbers().props.title).toBe("CLI compacts at 100k, your auto-compact setting. The model holds up to 200k.");
        // A setting past the model's window: the window wins.
        m.setState({ ...m.state(), compactAt: 500_000 });
        expect(text(m.root)).toContain("50k of 200k");
    } finally { m.dispose(); }
});
