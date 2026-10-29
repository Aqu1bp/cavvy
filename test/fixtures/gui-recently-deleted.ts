// Render the real Recently deleted dialog with Solid reactivity; the server, the dialog frame and navigation are adapters.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";

const source = readFileSync(new URL("../../gui/src/components/RecentlyDeleted.tsx", import.meta.url), "utf8")
    .replace(/^import [\s\S]*?;\n/gm, "")
    .replace(/^export /gm, "");
const has = (n: Node, cls: string) => !!n.props.class?.split(" ").includes(cls);
const byClass = (root: Node, cls: string) => all(root).filter((n) => has(n, cls));
const button = (root: Node, label: string) => all(root).find((n) => n.tag === "button" && text(n).trim() === label);
const settle = () => Bun.sleep(0);
// The dialog frame: its body only while open.
const Dialog = component(`function Dialog(p) { return <Show when={p.open}><div class="dialog">{p.children}</div></Show>; }`, "Dialog", {});

const TRASH = [
    { id: "b", title: "Add a dark theme", projectName: "acme", deletedAt: 2 },
    { id: "a", title: "Why does the login test fail", deletedAt: 1 },
];

function mount(answer: (method: string, params: any) => Promise<any>) {
    const [open, setOpen] = solid.createSignal(false);
    const calls = { rpc: [] as [string, any][], opened: [] as string[], errors: [] as unknown[] };
    const RecentlyDeleted = component(source, "RecentlyDeleted", {
        Dialog,
        Spinner: () => null,
        ArchiveRestore: () => null,
        deletedOpen: open,
        setDeletedOpen: setOpen,
        ago: (ms: number) => (ms === 1 ? "now" : "5m"),
        activate: async (id: string) => void calls.opened.push(id),
        reportError: (e: unknown) => void calls.errors.push(e),
        rpc: { call: (method: string, params: any) => (calls.rpc.push([method, params]), answer(method, params)) },
    });
    const root = node("root");
    const dispose = renderer.render(() => RecentlyDeleted(), root);
    return { root, dispose, open, setOpen, calls, rows: () => byClass(root, "deleted-row") };
}

test("opening it lists the trash, newest first, with where and when; nothing deleted says so", async () => {
    let list: any[] = TRASH;
    const d = mount(async () => list);
    try {
        expect(d.calls.rpc).toEqual([]);
        d.setOpen(true);
        expect(d.calls.rpc).toEqual([["sessions.trash", {}]]);
        await settle();
        expect(d.rows().map((r) => text(byClass(r, "deleted-title")[0]!))).toEqual(["Add a dark theme", "Why does the login test fail"]);
        expect(d.rows().map((r) => text(byClass(r, "deleted-meta")[0]!))).toEqual(["acme · Deleted 5m ago", "Deleted just now"]);
        expect(d.rows().map((r) => button(r, "Restore") !== undefined)).toEqual([true, true]);
        // Opened again, it asks again.
        list = [];
        d.setOpen(false);
        d.setOpen(true);
        await settle();
        expect(d.calls.rpc).toHaveLength(2);
        expect(d.rows()).toHaveLength(0);
        expect(text(byClass(d.root, "deleted-empty")[0]!)).toBe("Nothing deleted in the past week.");
    } finally {
        d.dispose();
    }
});

test("Restore puts it back and offers Open, which closes the dialog and opens it; a failed restore is reported and stays", async () => {
    let fail = false;
    let release!: () => void;
    const d = mount(async (method) => {
        if (method === "sessions.trash") return TRASH;
        await new Promise<void>((r) => (release = r));
        if (fail) throw new Error("Couldn't restore");
        return null;
    });
    try {
        d.setOpen(true);
        await settle();
        button(d.rows()[1]!, "Restore")!.props.onClick();
        expect(d.calls.rpc.at(-1)).toEqual(["session.restore", { id: "a" }]);
        // One at a time: every Restore waits while one runs.
        expect(d.rows().map((r) => button(r, "Restore")!.props.disabled)).toEqual([true, true]);
        release();
        await settle();
        await settle();
        const back = d.rows()[1]!;
        expect(has(back, "back")).toBe(true);
        expect(text(byClass(back, "deleted-meta")[0]!)).toBe("Restored");
        expect(button(d.rows()[0]!, "Restore")!.props.disabled).toBe(false);
        button(back, "Open")!.props.onClick();
        expect(d.open()).toBe(false);
        expect(d.calls.opened).toEqual(["a"]);
        // Reopened: the restored one is no longer marked, and a failure leaves Restore in place.
        d.setOpen(true);
        await settle();
        fail = true;
        button(d.rows()[0]!, "Restore")!.props.onClick();
        release();
        await settle();
        await settle();
        expect(d.calls.errors.map((e) => (e as Error).message)).toEqual(["Couldn't restore"]);
        expect(has(d.rows()[0]!, "back")).toBe(false);
        expect(button(d.rows()[0]!, "Restore")!.props.disabled).toBe(false);
    } finally {
        d.dispose();
    }
});
