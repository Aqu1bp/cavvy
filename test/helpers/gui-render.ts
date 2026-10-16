import { transformSync } from "../../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createRenderer } from "../../gui/node_modules/solid-js/universal/dist/universal.js";

export type Node = { tag: string; props: Record<string, any>; children: Node[]; parent?: Node; text?: string };
export const node = (tag: string): Node => ({ tag, props: {}, children: [] });
// Real Solid reconciliation, with an in-memory DOM boundary for non-socket tests.
export const renderer = createRenderer<Node>({
    createElement: node,
    createTextNode: (text) => ({ ...node("#text"), text }),
    isTextNode: (n) => n.tag === "#text",
    replaceText: (n, text) => { n.text = text; },
    setProperty: (n, key, value) => { n.props[key] = value; },
    insertNode: (parent, n, anchor) => {
        if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1);
        parent.children.splice(anchor ? parent.children.indexOf(anchor) : parent.children.length, 0, n);
        n.parent = parent;
    },
    removeNode: (parent, n) => { parent.children.splice(parent.children.indexOf(n), 1); n.parent = undefined; },
    getParentNode: (n) => n.parent,
    getFirstChild: (n) => n.children[0],
    getNextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1],
});

export function component(source: string, name: string, dependencies: Record<string, any>) {
    const compiled = transformSync(source, {
        filename: `${name}.tsx`, parserOpts: { plugins: ["typescript", "jsx"] },
        presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false,
    })!.code!;
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled)
        .replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;")
        .replace(/export function /g, "function ");
    const scope = { ...solid, renderer: { ...solid, ...renderer }, ...dependencies };
    return new Function(...Object.keys(scope), `${js}; return ${name};`)(...Object.values(scope));
}

export const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
export const text = (n: Node): string => (n.text ?? "") + n.children.map(text).join("");
