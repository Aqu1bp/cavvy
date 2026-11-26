// The rewind dialog (gui/src/components/RewindDialog.tsx) compiled with Solid's client reactivity, as
// gui-confirm-dialog.test.ts does: only the renderer and the server are replaced. What it asks the server for, and when.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { transformSync } from "../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../gui/node_modules/solid-js/dist/solid.js";

const source = readFileSync(new URL("../gui/src/components/RewindDialog.tsx", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");

function compile(dependencies: Record<string, unknown>) {
    const resolve = (value: any): any => (typeof value === "function" ? resolve(value()) : value);
    const renderer = {
        ...solid,
        effect: solid.createRenderEffect,
        memo: solid.createMemo,
        createElement: (tag: string) => ({ tag, props: {} }),
        createTextNode: () => ({}),
        insertNode() {},
        setProp: (node: any, key: string, value: any) => void (node.props[key] = value),
        insert: (_node: any, value: any) => solid.createRenderEffect(() => resolve(value)),
    };
    const compiled = transformSync(source, {
        filename: "RewindDialog.tsx",
        parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]],
        configFile: false,
        babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" })
        .transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;")
        .replace(/^export /gm, "");
    const scope = { renderer, ...solid, ...dependencies };
    return new Function(...Object.keys(scope), `${js}; return RewindDialog;`)(...Object.values(scope));
}

/** The dialog, the session shown (`show`), whether it's working (`work`), and what it asked the server. */
function rewind() {
    const [active, setActive] = solid.createSignal("a");
    const [open, setOpen] = solid.createSignal(false);
    const [busy, setBusy] = solid.createSignal<Record<string, boolean>>({});
    let target: number | undefined;
    const calls: { method: string; id: string; index?: number }[] = [];
    const errors: unknown[] = [];
    let title: unknown;
    const Icon = () => ({});
    const Dialog = (p: any) => solid.createMemo(() => {
        title = p.title;
        return p.open ? [p.children] : [];
    });
    const RewindDialog = compile({
        app: { get activeId() { return active(); } },
        connFor: () => "open",
        handleFor: (id?: string) => (id ? { view: { state: { get busy() { return Boolean(busy()[id]); } } } } : undefined),
        reportError: (e: unknown) => errors.push(e),
        rpc: {
            call: async (method: string, p: { id: string; index?: number }) => {
                calls.push({ method, id: p.id, ...(p.index !== undefined ? { index: p.index } : {}) });
                if (method === "session.rewindTargets") return busy()[p.id] ? [{ index: 0, text: "stale", files: 0, tracked: true }] : [{ index: 0, text: "first", files: 1, tracked: true }, { index: 1, text: "second", files: 0, tracked: true }];
                if (method === "session.rewindPlan") return { index: p.index, planId: "p", restore: [], skipped: [], tracked: true, whole: true, ...(busy()[p.id] ? { refused: "Couldn't read the files as they are now." } : {}) };
                return null;
            },
        },
        toast() {},
        rewindOpen: open,
        setRewindOpen: setOpen,
        rewindTarget: { get: () => target, set: (v: number | undefined) => void (target = v) },
        plural: (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`,
        rewindTimes: (at: unknown[]) => at.map(() => undefined),
        refreshGitChanges() {},
        promptPreview: (t: string) => t,
        takeFocus() {},
        Dialog,
        Spinner: Icon, AlertTriangle: Icon, FileMinus2: Icon, FilePen: Icon, FilePlus2: Icon, History: Icon,
    });
    let dispose!: () => void;
    solid.createRoot((d: () => void) => {
        dispose = d;
        RewindDialog();
    });
    const asked = () => calls.filter((c) => c.method === "session.rewindTargets" || c.method === "session.rewindPlan");
    return {
        open: (at?: number) => { target = at; setOpen(true); },
        close: () => setOpen(false),
        show: setActive,
        work: (id: string, on: boolean) => setBusy({ ...busy(), [id]: on }),
        asked, errors, dispose,
        get title() { return title; },
    };
}

const settle = async () => { for (let i = 0; i < 6; i++) await Bun.sleep(0); };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= (f: () => void) => setTimeout(f, 0);

test("opened for another session, it asks only for that one's prompts, never the last one's", async () => {
    const d = rewind();
    try {
        d.open(0);
        await settle();
        expect(d.asked()).toEqual([{ method: "session.rewindTargets", id: "a" }, { method: "session.rewindPlan", id: "a", index: 0 }]);
        d.close();
        // "a" deleted: another session is shown, and the dialog opened there.
        d.show("b");
        const before = d.asked().length;
        d.open();
        await settle();
        expect(d.asked().slice(before).every((c) => c.id === "b")).toBe(true);
        expect(d.asked().slice(before)).toEqual([{ method: "session.rewindTargets", id: "b" }]);
        expect(d.errors).toEqual([]);
    } finally {
        d.dispose();
    }
});

test("opened while a response runs: nothing is read until it ends, then the prompts and the plan are", async () => {
    const d = rewind();
    try {
        d.work("a", true);
        d.open(1);
        await settle();
        expect(d.asked()).toEqual([]);
        expect(d.title).toBe("Rewind");
        d.work("a", false);
        await settle();
        expect(d.asked()).toEqual([{ method: "session.rewindTargets", id: "a" }, { method: "session.rewindPlan", id: "a", index: 1 }]);
        expect(d.title).toBe("Rewind to before which prompt?");
        // Reopened on the same session, read again.
        d.close();
        d.open();
        await settle();
        expect(d.asked().filter((c) => c.method === "session.rewindTargets")).toHaveLength(2);
    } finally {
        d.dispose();
    }
});
