import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { elements, node } from "./gui-component-harness";

// Evaluate the actual JSX attributes without a browser/socket. Focus and layout
// still require browser verification; this checks the accessible name contract.
function dialogs() {
    const source = readFileSync(new URL("../gui/src/components/ui/Dialog.tsx", import.meta.url), "utf8")
        .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const js = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node" } } }).transformSync(source);
    let id = 0;
    const scope = {
        node, Show: "Show", Portal: "Portal", X: "X",
        createUniqueId: () => `title-${++id}`,
        onMount() {}, onCleanup() {}, document: { activeElement: null },
    };
    return new Function(...Object.keys(scope), `${js}; return DialogInner;`)(...Object.values(scope));
}

test("standard dialogs reference their own visible title, including simultaneous dialogs", () => {
    const render = dialogs();
    const ids = new Set<string>();
    for (const title of ["Commit", "Delete conversation", "MCP servers", "Rewind"]) {
        const tree = render({ title, onClose() {}, children: "Content" });
        const dialog = elements(tree, "div").find((n) => n.props.role === "dialog")!;
        const heading = elements(tree, "div").find((n) => n.props.id === dialog.props["aria-labelledby"])!;
        expect(heading.children).toEqual([title]);
        expect(dialog.props["aria-modal"]).toBe("true");
        ids.add(heading.props.id);
    }
    expect(ids.size).toBe(4);
});

test("a bare dialog uses the title supplied by its content without a dangling generated ID", () => {
    const render = dialogs();
    const tree = render({ bare: true, labelledBy: "trust-title", children: node("h2", { id: "trust-title" }, "Trust this folder"), onClose() {} });
    const dialog = elements(tree, "div").find((n) => n.props.role === "dialog")!;
    expect(dialog.props["aria-labelledby"]).toBe(elements(tree, "h2")[0]!.props.id);
    const unnamed = render({ bare: true, children: "Content", onClose() {} });
    expect(elements(unnamed, "div").find((n) => n.props.role === "dialog")!.props["aria-labelledby"]).toBeUndefined();
});
