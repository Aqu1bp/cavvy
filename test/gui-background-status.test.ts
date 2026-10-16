import { expect, test } from "bun:test";
import { readFileSync } from "fs";

// Render the actual LiveHead branches without a browser or a listening socket.
const source = readFileSync(new URL("../gui/src/components/TurnView.tsx", import.meta.url), "utf8");
const liveHead = source.slice(source.indexOf("const SPECIAL"), source.indexOf("type Changed"));
const code = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node", jsxFragmentFactory: "Fragment" } } }).transformSync(liveHead).replace("export function LiveHead", "function LiveHead");
const node = (tag: string, props: any, ...children: any[]): any => {
    if (tag === "Show") return props.when ? children.map((child) => typeof child === "function" ? child(() => props.when) : child) : props.fallback;
    return children;
};
const render = new Function("node", "Show", "Fragment", "now", "duration", `${code}; return LiveHead;`)(node, "Show", "Fragment", () => 1000, () => "1s");
const text = (tree: any): string => Array.isArray(tree) ? tree.map(text).join("") : tree == null ? "" : String(tree);

for (const kind of ["command", "monitor", "sub-agent"]) test(`GUI shows the actual background ${kind} wait, not the generic working label`, () => {
    const label = `Waiting for background ${kind}: Run checks · Esc to stop it`;
    const displayed = text(render({ state: { activity: { label, since: 0 } } }));
    expect(displayed).toContain(label);
    expect(displayed).not.toContain("Working for");
    expect(displayed.match(/Esc/g)).toHaveLength(1);
});

test("ordinary work and approval waiting keep their existing labels", () => {
    expect(text(render({ state: { activity: { label: "Thinking", since: 0 } } }))).toContain("Working for");
    expect(text(render({ state: {}, waiting: true }))).toContain("Waiting for you");
});
