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

for (const branch of ["main", undefined]) {
    test(`commit dialog sends its displayed ${branch ?? "detached HEAD"} snapshot`, async () => {
        const effects: (() => unknown)[] = [];
        const calls: unknown[][] = [];
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
            rpc: { call: async () => ({ repo: true, head: { branch, sha: "1234567" }, files: [{ path: "selected.txt" }] }) },
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
            Spinner: "Spinner",
            node,
        };
        const render = new Function(...Object.keys(dependencies), `${compiled}\nreturn CommitDialog;`)(...Object.values(dependencies));
        const tree = render();
        for (const effect of effects) await effect();
        find(tree, (n) => n.tag === "textarea")!.props.onInput({ currentTarget: { value: "feat: selected file" } });
        find(tree, (n) => n.tag === "button" && n.props.class === "btn primary")!.props.onClick();
        await Promise.resolve();
        expect(calls).toEqual([[request.id, request.paths, "feat: selected file", { branch, detached: !branch }]]);
        expect(activeRequest).toBeUndefined();
    });
}
