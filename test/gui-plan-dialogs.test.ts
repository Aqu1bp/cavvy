// Render the actual Solid components with client reactivity, without a browser or sockets.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

function component(source: string, name: string, dependencies: Record<string, any>) {
    const nodes: any[] = [];
    const resolve = (value: any): any => typeof value === "function" ? resolve(value()) : value;
    const renderer = {
        ...solid,
        effect: solid.createRenderEffect,
        memo: solid.createMemo,
        createElement: (tag: string) => { const node = { tag, props: {} }; nodes.push(node); return node; },
        createTextNode: (text: string) => ({ text }),
        insertNode() {},
        setProp: (node: any, key: string, value: any) => { node.props[key] = value; },
        insert: (node: any, value: any) => solid.createRenderEffect(() => { node.children = resolve(value); }),
    };
    const compiled = transformSync(source, {
        filename: `${name}.tsx`,
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]],
        configFile: false,
        babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;");
    const scope = { renderer, ...solid, ...dependencies };
    return { nodes, render: new Function(...Object.keys(scope), `${js}; return ${name};`)(...Object.values(scope)) };
}

const planSource = readFileSync(new URL("../gui/src/components/PlanDialogs.tsx", import.meta.url), "utf8");
const archiveSource = readFileSync(new URL("../gui/src/components/ArchiveDialog.tsx", import.meta.url), "utf8");

test("a worktree dialog request without Git safely shows the plan instead of dereferencing git", () => {
    let viewed = false;
    let implemented = false;
    const info = { plan: "# A plan", notGit: "This folder is not a Git repository." };
    const c = component(planSource.slice(planSource.indexOf("function PlanDialog("), planSource.indexOf("function ViewPlan(")), "PlanDialog", {
        createResource: () => [() => info],
        ViewPlan: (p: any) => { viewed = p.info === info; },
        ImplementPlan: () => { implemented = true; throw new Error("No Git repository"); },
        SavePlan() {}, Dialog: (p: any) => p.children, Spinner() {}, AlertTriangle() {}, setPlanDialog() {},
    });
    solid.createRoot((dispose: () => void) => {
        c.render({ sessionId: "session", kind: "worktree" });
        expect(viewed).toBe(true);
        expect(implemented).toBe(false);
        dispose();
    });
});

function archiveDialog(removable: boolean, call: (method: string, params: any) => Promise<any>) {
    const results: any[] = [];
    let closes = 0;
    let dispose!: () => void;
    const c = component(archiveSource.slice(archiveSource.indexOf("function ArchiveWorktree(")), "ArchiveWorktree", {
        app: {}, tildify: (path: string) => path,
        rpc: { call },
        setArchiveRequest: () => { closes++; },
        archivedWithWorktree: (id: string, result: any) => results.push({ id, ...result }),
        errorOf: (e: Error) => ({ field: "general", message: e.message }),
        Dialog: (p: any) => p.children,
        AlertTriangle() {}, Info() {}, Spinner() {}, IgnoredFiles() {},
    });
    solid.createRoot((d: () => void) => {
        dispose = d;
        c.render({ id: "session", title: "Planning", offer: { removable, reason: removable ? undefined : "Unpushed commits.", worktree: { path: "/repo/.claude/worktrees/plan", branch: "plan", main: "/repo" } } });
    });
    return { nodes: c.nodes, results, dispose, get closes() { return closes; } };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("a rejected planInfo resource renders its inline error without throwing to an error boundary", async () => {
    const pending = Promise.withResolvers<any>();
    const errors: unknown[] = [];
    const c = component(planSource.slice(planSource.indexOf("function PlanDialog("), planSource.indexOf("function ViewPlan(")), "PlanDialog", {
        rpc: { call: () => pending.promise },
        ViewPlan() {}, ImplementPlan() {}, SavePlan() {},
        Dialog: (p: any) => p.children, Spinner() {}, AlertTriangle() {}, setPlanDialog() {},
    });
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        solid.createComponent(solid.ErrorBoundary, {
            fallback: (error: unknown) => { errors.push(error); return undefined; },
            get children() { return c.render({ sessionId: "session", kind: "worktree" }); },
        });
    });
    try {
        pending.reject(new Error("The plan could not be loaded"));
        await settle();
        expect(errors).toEqual([]);
        expect(c.nodes.some((n) => n.tag === "span" && n.children === "The plan could not be loaded")).toBe(true);
    } finally { dispose(); }
});

test("Trust and continue preserves the selected base when resuming the created worktree", async () => {
    const calls: any[] = [];
    const path = "/repo/.claude/worktrees/implementation";
    const c = component(planSource.slice(planSource.indexOf("function ImplementPlan(")), "ImplementPlan", {
        rpc: { call: async (method: string, params: any) => {
            calls.push({ method, params });
            if (method === "projects.trust") return null;
            return calls.length === 1
                ? { path, branch: "implementation", failed: { code: "needs_trust", folder: path, message: "Trust this folder" } }
                : { path, branch: "implementation", sessionId: "destination" };
        } },
        IMPLEMENT_MODES: ["default"], MODE_CHOICES: { default: { label: "Ask for edits", hint: "Ask" } },
        home: (path: string) => path, errorOf: (error: Error) => ({ field: "general", message: error.message }),
        Dialog: (p: any) => p.children, Spinner() {}, AlertTriangle() {}, toast() {}, activate() {},
    });
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        const [busy, setBusy] = solid.createSignal(false);
        c.render({ sessionId: "source", info: { id: "plan", git: { main: "/repo", branch: "implementation", base: "main" }, mode: "default" }, get busy() { return busy(); }, setBusy, onClose() {} });
    });
    try {
        const base = c.nodes.find((n) => n.tag === "input" && n.props.placeholder === "HEAD");
        base.props.onInput({ currentTarget: { value: "release-v2" } });
        const form = c.nodes.find((n) => n.tag === "form");
        form.props.onSubmit({ preventDefault() {} });
        await settle();
        expect(base.props.disabled).toBe(true);
        form.props.onSubmit({ preventDefault() {} });
        await settle();
        expect(calls).toEqual([
            { method: "session.implementPlan", params: { id: "source", toolId: "plan", branch: "implementation", base: "release-v2", mode: "default", resume: undefined } },
            { method: "projects.trust", params: { path, trust: true } },
            { method: "session.implementPlan", params: { id: "source", toolId: "plan", branch: "implementation", base: "release-v2", mode: "default", resume: path } },
        ]);
    } finally { dispose(); }
});

test("Archive only is focused by default, and an ineligible worktree has no removal button", async () => {
    const calls: any[] = [];
    const d = archiveDialog(false, async (method, params) => { calls.push({ method, params }); return null; });
    try {
        expect(d.nodes.filter((n) => n.props.class === "btn danger")).toHaveLength(0);
        const safe = d.nodes.find((n) => n.props.class === "btn primary");
        expect(safe.props.autofocus).toBe(true);
        safe.props.onClick();
        await settle();
        expect(calls).toEqual([{ method: "session.archive", params: { id: "session", archived: true } }]);
        expect(d.results).toEqual([{ id: "session", archived: true, removed: false, kept: "Unpushed commits." }]);
    } finally { d.dispose(); }
});

test("Archive only prevents double submission and keeps the dialog on failure", async () => {
    const pending = Promise.withResolvers<any>();
    let calls = 0;
    const d = archiveDialog(true, () => { calls++; return pending.promise; });
    try {
        const safe = d.nodes.find((n) => n.props.class === "btn primary");
        safe.props.onClick();
        safe.props.onClick();
        expect(calls).toBe(1);
        expect(safe.props.disabled).toBe(true);
        pending.reject(new Error("Disconnected"));
        await settle();
        expect(d.closes).toBe(0);
        expect(d.results).toHaveLength(0);
        expect(safe.props.disabled).toBe(false);
    } finally { d.dispose(); }
});

test("archive removal forwards an ignored-files token only after the second explicit click", async () => {
    const calls: any[] = [];
    const d = archiveDialog(true, async (_method, params) => {
        calls.push(params);
        return calls.length === 1
            ? { archived: false, ignored: ["cache"], total: 1, confirm: "shown-files" }
            : { archived: true, removed: true, closed: true };
    });
    try {
        d.nodes.find((n) => n.props.class === "btn danger").props.onClick();
        await settle();
        expect(d.results).toHaveLength(0);
        expect(d.closes).toBe(0);
        expect(calls).toEqual([{ id: "session", archived: true, removeWorktree: true, deleteIgnored: undefined }]);
        d.nodes.filter((n) => n.props.class === "btn danger").at(-1).props.onClick();
        await settle();
        expect(calls[1].deleteIgnored).toBe("shown-files");
        expect(d.results).toEqual([{ id: "session", archived: true, removed: true, closed: true }]);
    } finally { d.dispose(); }
});

for (const git of [undefined, { main: "/repo", branch: "plan", base: "main" }]) {
    test(`answered plan side panel ${git ? "offers" : "disables"} worktree creation according to repository availability`, () => {
        const source = readFileSync(new URL("../gui/src/components/RightPanel.tsx", import.meta.url), "utf8");
        const requests: any[] = [];
        const c = component(source.slice(source.indexOf("function ProposedPlan("), source.indexOf("function Plan(")), "ProposedPlan", {
            createResource: () => [() => ({ git, notGit: git ? undefined : "This folder is not a Git repository." })],
            app: { sessions: [], archived: [] },
            setPlanDialog: (request: any) => requests.push(request),
            Popover: (p: any) => p.children,
            ClipboardList() {}, FolderGit2() {}, Save() {}, Copy() {}, ArrowUpLeft() {}, GitBranchPlus() {},
        });
        solid.createRoot((dispose: () => void) => {
            c.render({ handle: { id: "session", view: { state: { plan: { id: "plan", title: "Saved plan" }, interactions: [] } } } });
            const button = c.nodes.find((n) => n.props.class === "menu-item compact" && "disabled" in n.props);
            expect(button.props.disabled).toBe(!git);
            if (git) {
                button.props.onClick();
                expect(requests).toEqual([{ kind: "worktree", sessionId: "session", planId: "plan" }]);
            } else {
                expect(button.props.title).toBe("This folder is not a Git repository.");
            }
            dispose();
        });
    });
}
