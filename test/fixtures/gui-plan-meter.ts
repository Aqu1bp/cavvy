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
        document: doc, Popover, Ring, renderer: domRenderer,
    });
    const dispose = renderer.render(() => Meter({ sessionId: options.home ? undefined : "session", provider: "cli" }), root);
    const wire = () => all(root).forEach((n: any) => {
        n.contains = (other: Node) => all(n).includes(other);
        n.focus = () => { doc.activeElement = n; n.props.onFocus?.(); };
    });
    wire();
    const trigger = () => all(root).find(n => n.props["aria-haspopup"] === "dialog")!;
    const button = (label: string) => all(root).find(n => n.tag === "button" && text(n) === label)!;
    const show = () => { setOpen(true); wire(); };
    const escape = () => listeners.get("keydown")!({ key: "Escape", stopPropagation() {} });
    const stroke = () => all(root).filter(n => n.tag === "circle")[1]!.props;
    return { root, calls, errors, notices, pending, setCatalog, setState, state, setLimits, trigger, button, show, open, setOpen, escape, stroke, wire, doc, dispose, settingsTab: () => settingsTab };
}

test("API context-only control, compaction, spend, busy state, and usage navigation", () => {
    const m = mount();
    try {
        expect(all(m.root).filter(n => n.tag === "button")).toHaveLength(1);
        expect(m.trigger().props["aria-label"]).toBe("Context: 25% used");
        // The ring has its percentage inside.
        expect(text(m.trigger())).toBe("25");
        m.show();
        expect(text(m.root)).toContain("50k of 200k tokens25%");
        expect(text(m.root)).toContain("Automatic compaction is off.");
        expect(text(m.root)).not.toContain("Plan limits");
        expect(text(m.root)).toContain("$1.25");
        m.setState({ ...m.state(), busy: true });
        expect(m.button("Compact now").props.disabled).toBe(true);
        // Busy only with an idle compaction: the user's own takes over from it.
        m.setState({ ...m.state(), busy: true, activity: { label: "Compacting while idle", since: 0, idle: true } });
        expect(m.button("Compact now").props.disabled).toBe(false);
        m.setState({ ...m.state(), busy: false, activity: undefined });
        m.button("Compact now").props.onClick();
        expect(m.calls).toEqual([["session.compact", { id: "session" }]]);
        expect(m.open()).toBe(false);
        m.show(); m.button("Usage").props.onClick();
        expect(m.settingsTab()).toBe("usage");
    } finally { m.dispose(); }
});

test("plan usage keeps its own thresholds: 85% is a warning, 90% is danger", () => {
    for (const [plan, stroke] of [[85, "var(--warn)"], [90, "var(--danger)"]] as const) {
        const m = mount({ plan });
        try { expect(m.stroke().stroke).toBe(stroke); } finally { m.dispose(); }
    }
});

test("one ring uses the higher share; card orders context, plan windows/account, spend", () => {
    const m = mount({ plan: 80 });
    try {
        expect(all(m.root).filter(n => n.tag === "button")).toHaveLength(1);
        expect(m.stroke().stroke).toBe("var(--warn)");
        expect(m.trigger().props["aria-label"]).toContain("Pro · Default usage: 5-hour 80%");
        m.show();
        expect(all(m.root).filter(n => n.tag === "h3").map(text)).toEqual(["Context window", "Plan limits", "Spend"]);
        expect(text(m.root)).toContain("Weekly15%Resets");
        expect(text(m.root).match(/Pro · Default/g)).toHaveLength(1);
        m.setState({ ...m.state(), contextTokens: 180000 });
        expect(m.stroke().stroke).toBe("var(--danger)");
        const circumference = 2 * Math.PI * (26 - 2.5) / 2;
        expect(m.stroke()["stroke-dasharray"]).toBe(`${circumference * 0.9} ${circumference}`);
    } finally { m.dispose(); }
});

for (const plan of [undefined, 100]) test(`unknown size ${plan ? "still shows the plan" : "stays neutral"} with plan=${plan}; shared /context signal opens the same card`, () => {
    const m = mount({ unknown: true, plan });
    try {
        if (plan === undefined) {
            expect(m.stroke().stroke).toBe("var(--fg-2)");
            expect(m.stroke()["stroke-dasharray"]).toStartWith("0 ");
            expect(text(m.trigger())).toBe("");
        } else {
            // Known plan usage must not disappear just because context size is unknown (e.g. on Home).
            const circumference = 2 * Math.PI * (26 - 2.5) / 2;
            expect(m.stroke().stroke).toBe("var(--danger)");
            expect(m.stroke()["stroke-dasharray"]).toBe(`${circumference} ${circumference}`);
        }
        expect(m.trigger().props["aria-label"]).toContain("size not known yet");
        m.show();
        expect(text(m.root)).toContain("Not known yet: CLI reports");
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
        expect(text(m.root)).toContain("Limit reached · using credits");
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
            m.setLimits(Object.fromEntries([ ["default", 80], ["work", 20] ].map(([id, pct]) => [planLimitKey("cli", id as string), { at: timestamp, windows: [{ label: "5-hour", usedPercent: pct }] }])));
            m.wire();
            expect(m.trigger().props["aria-label"]).toContain(home ? "Pro · Work usage: 5-hour 20%" : "Pro · Default usage: 5-hour 80%");
            m.show();
            expect(m.button("Compact now").props.disabled).toBe(home);
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


test("automatic compaction defaults on when enabled", () => {
    const m = mount({ autoCompact: true });
    try {
        m.show();
        expect(text(m.root)).toContain("Compacts on its own near the limit.");
    } finally { m.dispose(); }
});
