// Render the real error cards, title-bar toasts and provider rows with Solid reactivity; the store and services are adapters.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createStore } from "../../gui/node_modules/solid-js/store/dist/store.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import * as errorText from "../../gui/src/lib/error-text";

const read = (file: string) => readFileSync(new URL(`../../gui/src/components/${file}.tsx`, import.meta.url), "utf8");
const strip = (source: string) => source.replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const has = (n: Node, cls: string) => !!n.props.class?.split(" ").includes(cls) || !!n.props.classList?.[cls];
const byClass = (root: Node, cls: string) => all(root).filter((n) => has(n, cls));
const buttons = (root: Node) => all(root).filter((n) => n.tag === "button");
const button = (root: Node, label: string) => buttons(root).find((n) => n.props["aria-label"] === label || text(n).trim() === label);
const icon = () => null;
const settle = () => Bun.sleep(0);

/** A stand-in for state/app's toast store: just what the components read and call. */
function store() {
    const [toasts, setToasts] = createStore<any[]>([]);
    let id = 0;
    const calls = { dismissed: [] as number[], ran: [] as [number, number][], toasts: [] as [string, string][], copied: [] as string[] };
    return {
        toasts, calls,
        add: (message: string, level = "error", extra: Record<string, any> = {}) => { setToasts((t) => [...t, { id: ++id, level, message, count: 1, ...extra }]); return id; },
        bump: (at: number) => setToasts((t) => t.id === at, "count", (c: number) => c + 1),
        deps: {
            toasts,
            dismissToast: (at: number) => { calls.dismissed.push(at); setToasts((t) => t.filter((x) => x.id !== at)); },
            runToastChoice: async (at: number, index: number) => { calls.ran.push([at, index]); },
            pauseToast: () => {},
            toast: (message: string, level = "info") => { calls.toasts.push([message, level]); },
            copyText: async (value: string) => { calls.copied.push(value); return true; },
        },
    };
}

/** ErrorCards.tsx loaded once: its places share which of them shows. */
function cardsModule(s: ReturnType<typeof store>, settings: () => string | undefined = () => undefined, terminalMax: () => boolean = () => false) {
    const shellLayout = () => ({ terminal: { maximized: terminalMax() } });
    const ErrorCards = component(strip(read("ErrorCards")), "ErrorCards", { ...s.deps, ...errorText, settingsTab: settings, shellLayout, CircleAlert: icon, Copy: icon, X: icon });
    return (place: string) => mountWith(ErrorCards, place);
}

function mount(place: string, s: ReturnType<typeof store>) {
    return cardsModule(s)(place);
}

function mountWith(ErrorCards: (p: { place: string }) => any, place: string) {
    const root = node("root");
    const dispose = renderer.render(() => ErrorCards({ place }), root);
    return { root, dispose, cards: () => byClass(root, "error-card"), region: () => byClass(root, "error-cards")[0]! };
}

test("errors show as cards with the whole message, and never in the title bar's row", () => {
    const s = store();
    s.add("Session settled", "success");
    s.add("Codex isn't signed in. Run `codex login` in a terminal (OpenAI's own sign-in), then try again.");
    const cards = mount("composer", s);
    const Toasts = component(strip(read("Toasts")), "Toasts", { ...s.deps, titleBarBox: () => undefined, CircleCheck: icon, Info: icon, TriangleAlert: icon, X: icon });
    const bar = node("bar");
    const disposeBar = renderer.render(() => Toasts(), bar);
    try {
        // The title bar: only the confirmation, in a polite region; no alert region there any more.
        expect(text(bar)).toContain("Session settled");
        expect(text(bar)).not.toContain("signed in");
        expect(all(bar).some((n) => n.props.role === "alert")).toBe(false);
        // The card: an assertive alert region, the title and its fix, the command as code.
        expect(cards.region().props).toMatchObject({ role: "alert", "aria-live": "assertive" });
        expect(cards.cards()).toHaveLength(1);
        expect(text(byClass(cards.root, "error-card-title")[0]!)).toBe("Codex isn't signed in");
        expect(text(byClass(cards.root, "error-card-detail")[0]!)).toBe("Run codex login in a terminal (OpenAI's own sign-in), then try again.");
        expect(all(cards.root).filter((n) => n.tag === "code").map(text)).toEqual(["codex login"]);
        expect(text(cards.root)).not.toContain("Session settled");
    } finally {
        cards.dispose();
        disposeBar();
    }
});

test("two cards at most, newest first, then how many more", () => {
    const s = store();
    const ids = ["First failure", "Second failure", "Third failure", "Fourth failure"].map((m) => s.add(m));
    const cards = mount("composer", s);
    try {
        expect(cards.cards().map(text).map((t) => t.split("Copy error")[0])).toEqual(["Fourth failure", "Third failure"]);
        expect(text(byClass(cards.root, "error-more")[0]!)).toBe("2 more");
        s.deps.dismissToast(ids[3]!);
        expect(cards.cards().map((c) => text(byClass(c, "error-card-title")[0]!))).toEqual(["Third failure", "Second failure"]);
        expect(text(byClass(cards.root, "error-more")[0]!)).toBe("1 more");
        s.deps.dismissToast(ids[2]!);
        expect(byClass(cards.root, "error-more")).toHaveLength(0);
        s.deps.dismissToast(ids[1]!);
        s.deps.dismissToast(ids[0]!);
        expect(cards.cards()).toHaveLength(0);
        expect(cards.region().props.classList).toEqual({ empty: true });
    } finally {
        cards.dispose();
    }
});

test("a repeat bumps the count and nudges the card again each time, instead of stacking", () => {
    const s = store();
    const id = s.add("Couldn't reach Anthropic");
    const cards = mount("composer", s);
    try {
        const card = cards.cards()[0]!;
        expect(card.props["data-nudge"]).toBeUndefined();
        expect(byClass(cards.root, "error-count")).toHaveLength(0);
        s.bump(id);
        expect(cards.cards()).toHaveLength(1);
        expect(cards.cards()[0]).toBe(card);
        expect(text(byClass(cards.root, "error-count")[0]!)).toBe("2×");
        const first = card.props["data-nudge"];
        expect(first).toBeDefined();
        s.bump(id);
        expect(text(byClass(cards.root, "error-count")[0]!)).toBe("3×");
        expect(card.props["data-nudge"]).not.toBe(first);
    } finally {
        cards.dispose();
    }
});

test("the toast's actions are the card's buttons, the first primary, then Copy error and dismiss", async () => {
    const s = store();
    const id = s.add("Session deleted: Not connected", "error", { action: { label: "Undo", run() {} }, additionalActions: [{ label: "Details", run() {} }] });
    const cards = mount("composer", s);
    try {
        const labels = buttons(cards.root).map((b) => b.props["aria-label"] ?? text(b).trim());
        expect(labels).toEqual(["Undo", "Details", "Copy error", "Dismiss"]);
        expect(has(button(cards.root, "Undo")!, "primary")).toBe(true);
        expect(has(button(cards.root, "Details")!, "ghost")).toBe(true);
        button(cards.root, "Details")!.props.onClick();
        expect(s.calls.ran).toEqual([[id, 1]]);
        await button(cards.root, "Copy error")!.props.onClick();
        expect(s.calls.copied).toEqual(["Session deleted: Not connected"]);
        expect(s.calls.toasts).toEqual([["Copied error", "success"]]);
        button(cards.root, "Dismiss")!.props.onClick();
        expect(s.calls.dismissed).toEqual([id]);
        expect(cards.cards()).toHaveLength(0);
    } finally {
        cards.dispose();
    }
});

test("one place shows the errors: Settings while it's open, else the composer, else the window", () => {
    const s = store();
    s.add("Archive failed");
    const [settings, setSettings] = solid.createSignal<string | undefined>();
    const place = cardsModule(s, settings);
    const windowCards = place("window");
    try {
        expect(windowCards.cards()).toHaveLength(1);
        const composer = place("composer");
        expect(windowCards.cards()).toHaveLength(0);
        expect(composer.cards()).toHaveLength(1);
        // Settings covers the composer (still mounted under it); with no Settings host, the window's.
        setSettings("providers");
        expect(composer.cards()).toHaveLength(0);
        expect(windowCards.cards()).toHaveLength(1);
        const page = place("settings");
        expect(page.cards()).toHaveLength(1);
        expect(windowCards.cards()).toHaveLength(0);
        setSettings(undefined);
        expect(composer.cards()).toHaveLength(1);
        expect(page.cards()).toHaveLength(0);
        page.dispose();
        composer.dispose();
        expect(windowCards.cards()).toHaveLength(1);
    } finally {
        windowCards.dispose();
    }
});

test("the terminal maximized over the composer: the window's shows the errors, and the composer again once it's restored", () => {
    const s = store();
    s.add("Not connected");
    const [max, setMax] = solid.createSignal(false);
    const place = cardsModule(s, () => undefined, max);
    const windowCards = place("window");
    const composer = place("composer");
    try {
        expect(composer.cards()).toHaveLength(1);
        expect(windowCards.cards()).toHaveLength(0);
        setMax(true);
        expect(composer.cards()).toHaveLength(0);
        expect(windowCards.cards()).toHaveLength(1);
        setMax(false);
        expect(composer.cards()).toHaveLength(1);
        expect(windowCards.cards()).toHaveLength(0);
    } finally {
        composer.dispose();
        windowCards.dispose();
    }
});

// ---- A provider's row: its own failure shows on it, not as a card ----

function providerRow(info: Record<string, any>, handler: (method: string, params: any) => Promise<any>) {
    const source = strip(read("Settings"));
    const calls: string[] = [];
    const reported: unknown[] = [];
    const toasts: [string, string][] = [];
    const copied: string[] = [];
    // Every imported name gets a stand-in; the ones the row uses are real or recorded.
    const imported = [...read("Settings").matchAll(/^import (?:type )?\{([^}]*)\}/gm)].flatMap((m) => m[1]!.split(",").map((n) => n.trim().replace(/^type /, "").split(" as ").pop()!).filter(Boolean));
    const stubs = Object.fromEntries(imported.filter((n) => !(n in solid)).map((n) => [n, icon]));
    const s = store();
    const MessageText = component(strip(read("ErrorCards")), "MessageText", { ...s.deps, ...errorText, settingsTab: () => undefined, CircleAlert: icon, Copy: icon, X: icon });
    const ProviderRow = component(source, "ProviderRow", {
        ...stubs, ...errorText, MessageText,
        app: { providers: [], models: [] }, prefs: {}, settingsTab: () => undefined, mod: "⌘",
        rpc: { call: (method: string, params: any) => { calls.push(method); return handler(method, params); } },
        reportError: (e: unknown) => reported.push(e),
        toast: (m: string, level = "info") => toasts.push([m, level]),
        copyText: async (v: string) => { copied.push(v); return true; },
        refreshProviders: async () => {}, refreshModels: async () => {}, refreshSettings: async () => {},
        // As state/actions.ts has it: the RPC's failure goes to the caller's `failed`, a success to a toast.
        connectCli: async (pr: any, failed: (e: unknown) => void = (e) => reported.push(e)) => {
            let r: any;
            try {
                calls.push("providers.connectCli");
                r = await handler("providers.connectCli", { provider: pr.id });
            } catch (e) {
                failed(e);
                return false;
            }
            toasts.push([`Using your ${pr.agentCli?.plan ?? pr.name} through ${pr.name} (${r.description})`, "success"]);
            if (r.warning) toasts.push([r.warning, "warn"]);
            return true;
        },
        Accounts: (p: any) => { const n = node("accounts"); n.props.onConnect = p.onConnect; return n; },
        ConfirmDialog: () => null, Spinner: () => node("spinner"),
    });
    const root = node("root");
    const [pr, setPr] = solid.createSignal<any>({ id: "codex", name: "Codex", configured: false, agentCli: { plan: "ChatGPT plan", accounts: [] }, ...info });
    const dispose = renderer.render(() => ProviderRow({ get pr() { return pr(); } }), root);
    return { root, dispose, calls, reported, toasts, copied, setPr, row: () => byClass(root, "prov")[0]! };
}

class RpcError extends Error {
    constructor(message: string, readonly code?: string) { super(message); }
}

test("a CLI row that can't connect says why on the row, copies the command, and checks again", async () => {
    let signedIn = false;
    const r = providerRow({}, async (method) => {
        if (method !== "providers.connectCli") throw new Error(`Unexpected ${method}`);
        if (!signedIn) throw new RpcError("Codex isn't signed in. Run `codex login` in a terminal (OpenAI's own sign-in), then try again.", "not_signed_in");
        return { description: "Signed in with ChatGPT" };
    });
    try {
        expect(has(r.row(), "err")).toBe(false);
        await all(r.root).find((n) => n.tag === "accounts")!.props.onConnect();
        await settle();
        // On the row, not as a card.
        expect(r.reported).toEqual([]);
        expect(has(r.row(), "err")).toBe(true);
        expect(r.row().props["data-flash"]).toBe("a");
        expect(text(byClass(r.root, "tag")[0]!)).toBe("Not signed in");
        const message = all(r.root).find((n) => has(n, "prov-err-msg"))!;
        expect(message.props.role).toBe("alert");
        expect(all(message).filter((n) => n.tag === "code").map(text)).toEqual(["codex login"]);
        await button(r.root, "Copy command")!.props.onClick();
        expect(r.copied).toEqual(["codex login"]);
        expect(r.toasts).toEqual([["Copied codex login", "success"]]);
        // Checking again, still not signed in: the row flashes again.
        button(r.root, "Check again")!.props.onClick();
        const check = buttons(r.root).find((b) => b.props.class === "btn primary sm")!;
        expect(all(check).some((n) => n.tag === "spinner")).toBe(true);
        expect(text(check)).toBe("Checking");
        expect(check.props.disabled).toBe(true);
        await settle();
        expect(r.row().props["data-flash"]).toBe("b");
        expect(r.calls).toEqual(["providers.connectCli", "providers.connectCli"]);
        // Signed in now: the row's back to normal.
        signedIn = true;
        button(r.root, "Check again")!.props.onClick();
        await settle();
        await settle();
        expect(has(r.row(), "err")).toBe(false);
        expect(byClass(r.root, "prov-err-line")).toHaveLength(0);
        expect(r.toasts.at(-1)).toEqual(["Using your ChatGPT plan through Codex (Signed in with ChatGPT)", "success"]);
        expect(r.reported).toEqual([]);
    } finally {
        r.dispose();
    }
});

test("a key that isn't saved says so on its row; the row clears once the provider is set up", async () => {
    const r = providerRow({ id: "openai", name: "OpenAI", requiresKey: true, agentCli: undefined }, async () => {
        throw new RpcError("OpenAI rejected the key (401 invalid). Nothing was saved.");
    });
    try {
        button(r.root, "Add key")!.props.onClick();
        all(r.root).find((n) => n.tag === "input")!.props.onInput({ currentTarget: { value: "sk-bad" } });
        await button(r.root, "Save")!.props.onClick();
        await settle();
        expect(r.reported).toEqual([]);
        expect(has(r.row(), "err")).toBe(true);
        expect(text(all(r.root).find((n) => has(n, "prov-name"))!)).toContain("Key not saved");
        expect(text(all(r.root).find((n) => has(n, "prov-sub"))!)).toBe("OpenAI rejected the key (401 invalid). Nothing was saved.");
        // No command in it: nothing to copy.
        expect(button(r.root, "Copy command")).toBeUndefined();
        r.setPr({ id: "openai", name: "OpenAI", requiresKey: true, configured: true, masked: "sk-…a91f" });
        expect(has(r.row(), "err")).toBe(false);
    } finally {
        r.dispose();
    }
});
