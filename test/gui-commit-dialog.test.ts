import { expect, test } from "bun:test";
import { readFileSync } from "fs";

// Exercise the dialog's event handlers without a browser DOM. Signals and JSX
// are reduced to values and nodes; the component and commit callback are real.
const source = readFileSync(new URL("../gui/src/components/CommitDialog.tsx", import.meta.url), "utf8");
const compiled = new Bun.Transpiler({
    loader: "tsx",
    tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node" } },
}).transformSync(source).replace(/^import .*;\n/gm, "").replace("export function CommitDialog", "function CommitDialog");

type Node = { tag: unknown; props: Record<string, any>; children: unknown[] };
function node(tag: unknown, props: Record<string, any> | null, ...children: unknown[]): Node {
    return { tag, props: props ?? {}, children };
}
function find(tree: unknown, match: (node: Node) => boolean): Node | undefined {
    if (!tree || typeof tree !== "object" || !("tag" in tree)) return;
    const current = tree as Node;
    if (match(current)) return current;
    for (const child of current.children.flat(Infinity)) {
        const found = find(child, match);
        if (found) return found;
    }
}

async function mountDialog(branch: string | undefined) {
    const effects: (() => unknown)[] = [];
    const calls: unknown[][] = [];
    const sha = "1234567890abcdef1234567890abcdef12345678";
    const request = { id: "session", paths: ["selected.txt"] };
    let activeRequest: typeof request | undefined = request;
    const dependencies = {
        createSignal: (initial: unknown) => {
            let value = initial;
            return [() => value, (next: unknown) => {
                value = next;
            }];
        },
        createEffect: (effect: () => unknown) => effects.push(effect),
        on: (read: () => unknown, effect: (value: unknown) => unknown) => () => effect(read()),
        For: "For",
        Show: "Show",
        app: { activeId: request.id },
        handleFor: () => ({}),
        rpc: { call: async () => ({ repo: true, head: { branch, sha }, files: [{ path: "selected.txt" }] }) },
        gitCommit: async (...args: unknown[]) => {
            calls.push(args);
        },
        gitCommitMessage: () => {
            throw new Error("Generating was not clicked");
        },
        commitUnavailable: () => undefined,
        commitRequest: () => activeRequest,
        setCommitRequest: (value: typeof activeRequest) => {
            activeRequest = value;
        },
        Dialog: "Dialog",
        plural: (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`,
        os: "macos",
        mod: "⌘",
        Spinner: "Spinner",
        node,
    };
    const render = new Function(...Object.keys(dependencies), `${compiled}\nreturn CommitDialog;`)(...Object.values(dependencies));
    const tree = render();
    for (const effect of effects) await effect();
    return {
        tree: () => tree,
        calls,
        request,
        sha,
        get activeRequest() { return activeRequest; },
    };
}

for (const branch of ["main", undefined]) {
    test(`commit dialog sends its displayed ${branch ?? "detached HEAD"} snapshot`, async () => {
        const d = await mountDialog(branch);
        const tree = d.tree();
        find(tree, (n) => n.tag === "textarea")!.props.onInput({ currentTarget: { value: "feat: selected file" } });
        find(tree, (n) => n.tag === "button" && n.props.class === "btn primary")!.props.onClick();
        await Promise.resolve();
        expect(d.calls).toEqual([[d.request.id, d.request.paths, "feat: selected file", branch ? { branch, detached: false } : { sha: d.sha, detached: true }]]);
        expect(d.activeRequest).toBeUndefined();
    });
}

test("⌘↵ in the message commits, as the button's key cap says; a plain Enter is a new line", async () => {
    const d = await mountDialog("feature");
    const tree = d.tree();
    const textarea = find(tree, (n) => n.tag === "textarea")!;
    textarea.props.onInput({ currentTarget: { value: "fix: the thing" } });
    let prevented = 0;
    const key = (extra: Record<string, unknown>) => textarea.props.onKeyDown({ key: "Enter", isComposing: false, metaKey: false, ctrlKey: false, preventDefault: () => prevented++, ...extra });
    key({});
    key({ ctrlKey: true }); // Ctrl is not the commit key on macOS.
    key({ metaKey: true, isComposing: true });
    await Promise.resolve();
    expect(d.calls).toEqual([]);
    expect(prevented).toBe(0);
    key({ metaKey: true });
    await Promise.resolve();
    expect(prevented).toBe(1);
    expect(d.calls).toEqual([[d.request.id, d.request.paths, "fix: the thing", { branch: "feature", detached: false }]]);
});
