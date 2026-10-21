import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { component, node, renderer, text } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";
import { firstChangedLine, plural } from "../../gui/src/lib/format";

// The real ChangesCard (compiled from TurnView.tsx); only the server call and leaf widgets are stubbed.
const source = readFileSync(new URL("../../gui/src/components/TurnView.tsx", import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
const calls: unknown[][] = [];
let fail = false;
let incomplete = false;
const hunk = { header: "@@ -1,1 +1,1 @@", oldStart: 1, newStart: 4, lines: [{ kind: "add", text: "x", newLine: 4 }] };
const fetchGitChanges = async (...args: unknown[]) => {
    calls.push(args);
    if (fail) return { repo: true, turnId: args[4], error: "git failed", files: [] };
    return { repo: true, turnId: args[4], snapshotAvailable: true, incomplete, notes: incomplete ? ["Couldn't read the snapshot."] : [], more: 0, files: [{ path: "src/a.ts", status: "modified", added: 3, removed: 1, hunks: [hunk] }] };
};
const stub = () => node("widget");
const ChangesCard = component(source, "ChangesCard", {
    RenderBoundary: boundary(), fetchGitChanges, firstChangedLine, plural, openReview() {}, openInEditor() {},
    FileDiff: stub, SquareArrowOutUpRight: stub, SplitPath: (p: { path: string }) => { const n = node("path"); n.text = p.path; return n; },
});
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const mount = (turnId: number, sessionId = "s1") => {
    const root = node("root");
    const dispose = renderer.render(() => ChangesCard({ turn: { id: `t${turnId}`, snapshotId: turnId, blocks: [] }, cwd: "/p", sessionId, busy: false }), root);
    return { root, dispose };
};

test("a finished turn's changes card asks the server for its diff once, and keeps the file list without hunks", async () => {
    const first = mount(7);
    await settle();
    expect(calls).toHaveLength(1);
    expect(text(first.root)).toContain("1 changed file");
    expect(text(first.root)).toContain("src/a.ts");
    first.dispose();

    // Mounted again (switching back to the session): shown at once, nothing fetched.
    const again = mount(7);
    expect(text(again.root)).toContain("1 changed file");
    expect(text(again.root)).toContain("+3");
    await settle();
    expect(calls).toHaveLength(1);
    again.dispose();

    // Another turn, or the same snapshot id in another session, is its own entry.
    mount(8).dispose();
    mount(7, "s2").dispose();
    await settle();
    expect(calls).toHaveLength(3);
});

test("a failed diff isn't kept: the next card to mount asks again", async () => {
    calls.length = 0;
    fail = true;
    const a = mount(20);
    await settle();
    a.dispose();
    fail = false;
    const b = mount(20);
    await settle();
    expect(calls).toHaveLength(2);
    expect(text(b.root)).toContain("src/a.ts");
    b.dispose();
});

test("an incomplete read isn't kept either: once the snapshot reads, a reopened card shows it whole", async () => {
    calls.length = 0;
    incomplete = true;
    const a = mount(30);
    await settle();
    expect(text(a.root)).toContain("incomplete");
    a.dispose();
    incomplete = false;
    const b = mount(30);
    await settle();
    expect(calls).toHaveLength(2);
    expect(text(b.root)).not.toContain("incomplete");
    b.dispose();
});
