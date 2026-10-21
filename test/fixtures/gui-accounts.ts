// Render the real settings component with Solid reactivity; only services and DOM are adapters.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import type { AccountInfo } from "../../src/server/protocol";

const source = readFileSync(new URL("../../gui/src/components/Accounts.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
const defaultAccount: AccountInfo = { id: "default", name: "Default", folder: "/fake/default", managed: false };
const personal: AccountInfo = { id: "personal", name: "Personal", folder: "/fake/personal", managed: true, signedIn: true, email: "person@example.test", plan: "Pro" };
const settle = () => Bun.sleep(0);

function fixture(initial = [defaultAccount], provider = "claude-code", extra: { info?: Record<string, any>; cli?: Record<string, any>; props?: Record<string, any> } = {}) {
    const root = node("root");
    const calls: { method: string; params: any }[] = [];
    const logins: any[] = [];
    const menus: any[] = [];
    let catalog = [...initial];
    let preferred = "default";
    let handler: ((method: string, params: any) => Promise<any>) | undefined;
    let refreshError: Error | undefined;
    let focus: Node | undefined;
    const [info, setInfo] = solid.createSignal<any>({ id: provider, name: provider === "codex" ? "Codex" : "Claude Code", configured: false, ...extra.info, agentCli: { plan: "Claude subscription", ...extra.cli, accounts: catalog, defaultAccount: preferred } });
    const refreshProviders = async () => {
        if (refreshError) throw refreshError;
        setInfo({ ...info(), agentCli: { ...info().agentCli, accounts: [...catalog], defaultAccount: preferred } });
    };
    const opened: string[] = [];
    const call = async (method: string, params: any) => {
        calls.push({ method, params });
        if (handler) return handler(method, params);
        if (method === "accounts.add") {
            const a = { id: params.id, name: params.name, folder: params.folder ?? "/fake/managed", managed: !params.folder };
            catalog = [...catalog, a]; return a;
        }
        if (method === "accounts.rename") catalog = catalog.map((a) => a.id === params.id ? { ...a, name: params.name } : a);
        if (method === "accounts.setDefault") preferred = params.id;
        if (method === "accounts.remove") { catalog = catalog.filter((a) => a.id !== params.id); if (preferred === params.id) preferred = "default"; }
        return catalog;
    };
    const Accounts = component(source, "Accounts", {
        rpc: { call }, refreshProviders, refreshModels: async () => {},
        terminalActions: { loginAccount: (...args: any[]) => logins.push(args) },
        Menu: (p: any) => { menus.push(p); return solid.createMemo(() => p.open ? p.children : null); },
        Dialog: (p: any) => solid.createMemo(() => p.open ? p.children : null),
        MoreHorizontal: () => null, Check: () => null, ExternalLink: () => null, ProviderIcon: () => null, Spinner: () => node("spinner"),
        openExternal: (url: string) => opened.push(url),
    });
    const dispose = renderer.render(() => Accounts(Object.defineProperties({ get provider() { return info(); } }, Object.getOwnPropertyDescriptors(extra.props ?? {}))), root);
    const nodes = () => {
        const nodes = all(root);
        for (const n of nodes) (n as any).focus = () => { focus = n; };
        return nodes;
    };
    const button = (label: string) => nodes().find((n) => n.tag === "button" && (n.props["aria-label"] === label || text(n).trim() === label))!;
    const input = (label: string) => nodes().find((n) => n.tag === "input" && n.props["aria-label"] === label)!;
    const form = (label: string) => nodes().find((n) => n.tag === "form" && n.props["aria-label"] === label)!;
    const enter = (label: string, value: string) => input(label).props.onInput({ currentTarget: { value } });
    const submit = (label = "Add account") => form(label).props.onSubmit({ preventDefault() {} });
    // Add account lives in the provider's ••• menu.
    const openAdd = () => { button(`${info().name} actions`).props.onClick(); button("Add account…").props.onClick(); };
    return { root, nodes, button, input, form, enter, submit, openAdd, calls, logins, menus, opened, dispose,
        get focus() { return focus; }, failRefresh: (error?: Error) => { refreshError = error; },
        handle: (fn?: typeof handler) => { handler = fn; },
    };
}

for (const provider of ["claude-code", "codex"]) test(`${provider}: one account folds into the provider's row and its menu`, () => {
    const f = fixture(undefined, provider);
    const name = provider === "codex" ? "Codex" : "Claude Code";
    try {
        for (const old of ["Default for new sessions", "Separate sign-ins", "Signed in ·", "your plan", "Status not checked"]) expect(text(f.root)).not.toContain(old);
        expect(text(f.root)).toContain("Not set up");
        expect(f.nodes().some((n) => n.props.role === "list")).toBe(false); // No sub-rows for a lone account.
        expect(f.button("Actions for Default")).toBeUndefined();
        expect(f.calls).toEqual([]); // Opening Settings does not probe a never-connected CLI.
        const trigger = f.button(`${name} actions`);
        expect(trigger.props["aria-haspopup"]).toBe("menu");
        trigger.props.onClick();
        expect(trigger.props["aria-expanded"]).toBe(true);
        expect(f.menus[0].label).toBe(`${name} actions`);
        expect(f.nodes().filter((n) => n.props.role === "menuitem").map((n) => text(n))).toEqual(["Add account…", "Sign in", "Refresh status", "Learn more…"]);
        f.button("Sign in").props.onClick();
        expect(f.logins[0].slice(0, 2)).toEqual([provider, "default"]);
        expect(trigger.props["aria-expanded"]).toBe(false);
        trigger.props.onClick(); f.button("Learn more…").props.onClick();
        expect(text(f.root)).toContain("separate sign-ins, for example personal and work");
    } finally { f.dispose(); }
});

test("a connected provider shows its plan, a status dot and its one account's email, and turns off from its menu", async () => {
    const offs: number[] = [];
    const f = fixture([{ ...defaultAccount, signedIn: true, email: "me@example.test", plan: "max" }], "claude-code", { info: { configured: true }, props: { onTurnOff: () => offs.push(1) } });
    try {
        await settle();
        expect(f.calls[0]).toEqual({ method: "accounts.list", params: { provider: "claude-code", refresh: true } });
        expect(f.nodes().find((n) => n.props.class === "tag")).toBeDefined();
        expect(text(f.nodes().find((n) => n.props.class === "tag")!)).toBe("Max");
        expect(f.nodes().find((n) => n.props.class === "cli-dot")?.props["aria-label"]).toBe("Connected");
        expect(text(f.nodes().find((n) => n.props.class?.startsWith("prov-sub"))!)).toBe("me@example.test");
        f.button("Claude Code actions").props.onClick();
        expect(f.nodes().filter((n) => n.props.role === "menuitem").map((n) => text(n))).toEqual(["Add account…", "Sign in again", "Refresh status", "Learn more…", "Turn off…"]);
        f.button("Turn off…").props.onClick();
        expect(offs).toEqual([1]);
        f.calls.length = 0;
        f.button("Claude Code actions").props.onClick(); f.button("Refresh status").props.onClick(); await settle();
        expect(f.calls).toEqual([{ method: "accounts.list", params: { provider: "claude-code", refresh: true } }]);
    } finally { f.dispose(); }
});

test("a connected provider whose one account is signed out says so instead of the dot", () => {
    const f = fixture([{ ...defaultAccount, signedIn: false }], "codex", { info: { configured: true } });
    try {
        expect(text(f.root)).toContain("Not signed in");
        expect(f.nodes().some((n) => n.props.class === "cli-dot")).toBe(false);
    } finally { f.dispose(); }
});

test("not installed offers Install and no menu; installed but off offers to use the plan", () => {
    const missing = fixture(undefined, "claude-code", { info: { keyUrl: "https://example.test/install" }, cli: { installed: false } });
    try {
        expect(text(missing.root)).toContain("Not installed");
        expect(missing.button("Claude Code actions")).toBeUndefined();
        missing.button("Install").props.onClick();
        expect(missing.opened).toEqual(["https://example.test/install"]);
    } finally { missing.dispose(); }
    let connects = 0;
    const [connecting, setConnecting] = solid.createSignal(false);
    const off = fixture(undefined, "claude-code", { cli: { installed: true }, props: { get connecting() { return connecting(); }, onConnect: () => connects++ } });
    try {
        const use = off.button("Use my Claude subscription");
        use.props.onClick();
        expect(connects).toBe(1);
        setConnecting(true);
        expect(use.props.disabled).toBe(true);
        expect(off.nodes().some((n) => n.tag === "spinner")).toBe(true);
    } finally { off.dispose(); }
});

test("add card validates inline, submits from its form, guards pending work and opens the new account terminal", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<AccountInfo>();
    try {
        f.openAdd();
        expect(f.input("Account name").props.autofocus).toBe(true);
        const advanced = f.nodes().find((n) => n.props.class === "account-advanced")!;
        expect(advanced.props.open).toBe(false);
        f.submit();
        expect(f.calls).toEqual([]);
        expect(f.input("Account name").props["aria-invalid"]).toBe(true);
        const errorId = f.input("Account name").props["aria-describedby"];
        expect(f.nodes().find((n) => n.props.id === errorId)?.props.role).toBe("alert");
        f.enter("Account name", "Personal");
        f.handle(() => pending.promise);
        f.submit(); f.submit();
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]!.params).toMatchObject({ provider: "claude-code", name: "Personal" });
        expect(f.calls[0]!.params.folder).toBeUndefined();
        expect(f.button("Creating…").props.disabled).toBe(true);
        expect(f.form("Add account").props["aria-busy"]).toBe(true);
        pending.reject(new Error("Add accounts once running responses finish"));
        await settle();
        expect(f.nodes().some((n) => n.props.role === "alert" && text(n).includes("running responses"))).toBe(true);
        expect(f.button("Create and sign in").props.disabled).toBe(false);
        f.handle();
        f.submit();
        await settle();
        expect(f.form("Add account")).toBeUndefined();
        expect(f.button("Actions for Personal")).toBeDefined();
        expect(f.logins).toHaveLength(1);
        expect(f.logins[0][1]).toBe(f.calls.at(-1)!.params.id);
    } finally { f.dispose(); }
});

test("existing folder client and server errors stay attached to the disclosed field", async () => {
    const f = fixture();
    try {
        f.openAdd();
        f.enter("Account name", "Work"); f.enter("Account folder", "relative"); f.submit();
        expect(f.calls).toHaveLength(0);
        expect(f.input("Account folder").props["aria-invalid"]).toBe(true);
        expect(f.nodes().find((n) => n.props.class === "account-advanced")!.props.open).toBe(true);
        f.enter("Account folder", "/repo/account");
        f.handle(async () => { throw new Error("Account folders must be outside projects"); });
        f.submit(); await settle();
        expect(f.input("Account folder").props["aria-invalid"]).toBe(true);
        expect(f.nodes().some((n) => n.props.role === "alert" && text(n) === "Account folders must be outside projects")).toBe(true);
        expect(f.calls[0]!.params.folder).toBe("/repo/account");
        expect(f.input("Account name").props.value).toBe("Work");
        f.handle(); f.submit(); await settle();
        expect(f.button("Actions for Work")).toBeDefined();
        expect(f.logins).toHaveLength(1);
    } finally { f.dispose(); }
});

test("Cancel and Escape clear the card and return focus to the provider's menu button", () => {
    const f = fixture();
    try {
        const trigger = f.button("Claude Code actions");
        for (const escape of [false, true]) {
            f.openAdd(); f.enter("Account name", "Discard");
            if (escape) {
                let stopped = false;
                let prevented = false;
                f.form("Add account").props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
                expect(stopped && prevented).toBe(true);
            } else f.button("Cancel").props.onClick();
            expect(f.form("Add account")).toBeUndefined();
            expect(f.focus).toBe(trigger);
            f.openAdd(); expect(f.input("Account name").props.value).toBe(""); f.button("Cancel").props.onClick();
        }
        expect(f.calls).toEqual([]);
    } finally { f.dispose(); }
});

test("two accounts list as rows: identity, sign in again, make default, rename and confirmed removal", async () => {
    const f = fixture([defaultAccount, personal]);
    try {
        await settle(); f.calls.length = 0;
        const rows = () => f.nodes().filter((n) => n.props.role === "listitem");
        expect(rows()).toHaveLength(2);
        const row = (label: string) => rows().find((n) => text(n).includes(label))!;
        // The email first, then the account's name and plan; the default has a check.
        expect(text(row("person@example.test"))).toBe("person@example.testPersonal · Pro");
        const isDefault = (r: Node) => all(r).some((n) => n.props["aria-label"] === "Default");
        expect(isDefault(row("Default"))).toBe(true);
        expect(isDefault(row("person@example.test"))).toBe(false);
        expect(text(f.root)).not.toContain("Signed in ·");
        const open = () => f.button("Actions for Personal").props.onClick();
        open(); expect(f.nodes().filter((n) => n.props.role === "menuitem").map((n) => text(n))).toEqual(["Sign in again", "Make default", "Rename…", "Remove…"]);
        f.button("Sign in again").props.onClick(); expect(f.logins[0][1]).toBe("personal");
        open(); f.button("Make default").props.onClick(); await settle();
        expect(f.calls).toContainEqual({ method: "accounts.setDefault", params: { provider: "claude-code", id: "personal" } });
        expect(isDefault(row("person@example.test"))).toBe(true);
        expect(isDefault(row("Default"))).toBe(false);
        // The provider's plan is the default account's.
        expect(text(f.nodes().find((n) => n.props.class === "tag")!)).toBe("Pro");
        open(); f.button("Rename…").props.onClick(); f.enter("New account name", "Bad..name"); f.submit("Rename Personal");
        expect(f.input("New account name").props["aria-invalid"]).toBe(true);
        f.enter("New account name", "Work"); f.submit("Rename Personal"); await settle();
        f.button("Actions for Work").props.onClick(); f.button("Remove…").props.onClick();
        expect(text(f.root)).toContain("Delete the Harness-created folder");
        expect(f.calls.some((c) => c.method === "accounts.remove")).toBe(false);
        f.handle(async () => { throw new Error("Stop the account's running turn before removing it"); });
        f.button("Confirm removal").props.onClick(); await settle();
        expect(f.nodes().some((n) => n.props.role === "alert" && text(n).includes("running turn"))).toBe(true);
        f.handle(); f.button("Confirm removal").props.onClick(); await settle();
        expect(f.button("Actions for Work")).toBeUndefined();
        expect(f.calls.at(-1)).toEqual({ method: "accounts.remove", params: { provider: "claude-code", id: "personal", confirmedFolder: "/fake/personal" } });
    } finally { f.dispose(); }
});

test("a refresh failure after successful creation still opens sign-in and does not leave a duplicate-create form", async () => {
    const f = fixture();
    try {
        f.openAdd(); f.enter("Account name", "Personal");
        f.failRefresh(new Error("Disconnected while refreshing"));
        f.submit(); await settle();
        expect(f.logins).toHaveLength(1);
        expect(f.form("Add account")).toBeUndefined();
        expect(f.nodes().some((n) => n.props.role === "alert" && text(n).includes("Disconnected"))).toBe(true);
    } finally { f.dispose(); }
});

for (const action of ["rename", "remove"]) test(`${action}: a refresh error after saving is visible outside the closed editor`, async () => {
    const f = fixture([defaultAccount, personal]);
    try {
        await settle();
        f.button("Actions for Personal").props.onClick();
        f.button(action === "rename" ? "Rename…" : "Remove…").props.onClick();
        f.failRefresh(new Error("Disconnected while refreshing"));
        if (action === "rename") {
            f.enter("New account name", "Work"); f.submit("Rename Personal");
        } else f.button("Confirm removal").props.onClick();
        await settle();
        expect(f.form("Rename Personal")).toBeUndefined();
        expect(f.button("Confirm removal")).toBeUndefined();
        expect(f.nodes().some((n) => n.props.role === "alert" && text(n).includes("Disconnected"))).toBe(true);
    } finally { f.dispose(); }
});

test("external account removal describes keeping its folder and sends the exact confirmation", async () => {
    const external = { ...personal, managed: false };
    const f = fixture([defaultAccount, external]);
    try {
        await settle();
        f.button("Actions for Personal").props.onClick(); f.button("Remove…").props.onClick();
        expect(text(f.root)).toContain("leave its folder untouched");
        f.button("Cancel").props.onClick();
        expect(f.calls.some((c) => c.method === "accounts.remove")).toBe(false);
    } finally { f.dispose(); }
});

test("invalid accounts remain visible as unavailable and removal promises to leave the folder untouched", async () => {
    const f = fixture([defaultAccount, { ...personal, invalid: true, description: "Invalid account folder" }]);
    try {
        expect(text(f.root)).toContain("Unavailable");
        f.button("Actions for Personal").props.onClick();
        f.button("Remove…").props.onClick();
        expect(text(f.root)).toContain("Forget this account and leave its folder untouched");
        expect(text(f.root)).not.toContain("Delete the Harness-created folder");
        f.button("Confirm removal").props.onClick();
        await settle();
        expect(f.calls).toContainEqual({ method: "accounts.remove", params: { provider: "claude-code", id: "personal", confirmedFolder: "/fake/personal" } });
    } finally { f.dispose(); }
});
