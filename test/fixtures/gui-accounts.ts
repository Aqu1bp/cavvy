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

function fixture(initial = [defaultAccount], provider = "claude-code") {
    const root = node("root");
    const calls: { method: string; params: any }[] = [];
    const logins: any[] = [];
    const menus: any[] = [];
    let catalog = [...initial];
    let preferred = "default";
    let handler: ((method: string, params: any) => Promise<any>) | undefined;
    let refreshError: Error | undefined;
    let focus: Node | undefined;
    const [info, setInfo] = solid.createSignal({ id: provider, name: provider === "codex" ? "Codex" : "Claude Code", configured: false, agentCli: { accounts: catalog, defaultAccount: preferred } });
    const refreshProviders = async () => {
        if (refreshError) throw refreshError;
        setInfo({ ...info(), agentCli: { accounts: [...catalog], defaultAccount: preferred } });
    };
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
        Plus: () => null, MoreHorizontal: () => null, Spinner: () => null,
    });
    const dispose = renderer.render(() => Accounts({ get provider() { return info(); } }), root);
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
    return { root, nodes, button, input, form, enter, submit, calls, logins, menus, dispose,
        get focus() { return focus; }, failRefresh: (error?: Error) => { refreshError = error; },
        handle: (fn?: typeof handler) => { handler = fn; },
    };
}

for (const provider of ["claude-code", "codex"]) test(`${provider}: default-only settings show a row and accessible sign-in menu`, () => {
    const f = fixture(undefined, provider);
    try {
        expect(text(f.root)).toContain("Default for new sessions");
        expect(text(f.root)).toContain("Status not checked");
        expect(f.calls).toEqual([]); // Opening Settings does not probe a never-connected CLI.
        const trigger = f.button("Actions for Default");
        expect(trigger.props["aria-haspopup"]).toBe("menu");
        trigger.props.onClick();
        expect(trigger.props["aria-expanded"]).toBe(true);
        expect(f.menus[0].label).toBe("Default account actions");
        expect(f.button("Rename")).toBeUndefined();
        expect(f.button("Remove")).toBeUndefined();
        f.button("Sign in").props.onClick();
        expect(f.logins[0].slice(0, 2)).toEqual([provider, "default"]);
        expect(trigger.props["aria-expanded"]).toBe(false);
        expect(f.nodes().some((n) => n.tag === "summary" && text(n) === "Learn more")).toBe(true);
    } finally { f.dispose(); }
});

test("add card validates inline, submits from its form, guards pending work and opens the new account terminal", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<AccountInfo>();
    try {
        f.button("Add account").props.onClick();
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
        f.button("Add account").props.onClick();
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

test("Cancel and Escape clear the card and return focus to Add account", () => {
    const f = fixture();
    try {
        const trigger = f.button("Add account");
        for (const escape of [false, true]) {
            trigger.props.onClick(); f.enter("Account name", "Discard");
            if (escape) {
                let stopped = false;
                let prevented = false;
                f.form("Add account").props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
                expect(stopped && prevented).toBe(true);
            } else f.button("Cancel").props.onClick();
            expect(f.form("Add account")).toBeUndefined();
            expect(f.focus).toBe(trigger);
            trigger.props.onClick(); expect(f.input("Account name").props.value).toBe(""); f.button("Cancel").props.onClick();
        }
        expect(f.calls).toEqual([]);
    } finally { f.dispose(); }
});

test("signed-in row exposes identity, re-sign-in, default, rename and confirmed removal", async () => {
    const f = fixture([defaultAccount, personal]);
    try {
        await settle(); f.calls.length = 0;
        expect(text(f.root)).toContain("Signed in · person@example.test · Pro");
        const open = () => f.button("Actions for Personal").props.onClick();
        open(); f.button("Re-sign in").props.onClick(); expect(f.logins[0][1]).toBe("personal");
        open(); f.button("Use for new sessions").props.onClick(); await settle();
        expect(f.calls).toContainEqual({ method: "accounts.setDefault", params: { provider: "claude-code", id: "personal" } });
        const row = f.nodes().find((n) => n.props.class === "account-row" && text(n).includes("Personal"))!;
        expect(text(row)).toContain("Default for new sessions");
        open(); f.button("Rename").props.onClick(); f.enter("New account name", "Bad..name"); f.submit("Rename Personal");
        expect(f.input("New account name").props["aria-invalid"]).toBe(true);
        f.enter("New account name", "Work"); f.submit("Rename Personal"); await settle();
        f.button("Actions for Work").props.onClick(); f.button("Remove").props.onClick();
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
        f.button("Add account").props.onClick(); f.enter("Account name", "Personal");
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
        f.button(action === "rename" ? "Rename" : "Remove").props.onClick();
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
        f.button("Actions for Personal").props.onClick(); f.button("Remove").props.onClick();
        expect(text(f.root)).toContain("leave its folder untouched");
        f.button("Cancel").props.onClick();
        expect(f.calls.some((c) => c.method === "accounts.remove")).toBe(false);
    } finally { f.dispose(); }
});
