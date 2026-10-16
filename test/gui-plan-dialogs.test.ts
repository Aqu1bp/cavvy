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
