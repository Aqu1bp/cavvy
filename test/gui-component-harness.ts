import { readFileSync } from "node:fs";

/** Execute the real component handlers without a browser or global module mocks. */
/** `file`: the component's file in gui/src/components, when it isn't named after it. */
export function componentCode(name: string, dependencies: Record<string, unknown>, handlers?: string[], file = name) {
    let source = readFileSync(new URL(`../gui/src/components/${file}.tsx`, import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    if (handlers) {
        // MCP's JSX needs Solid's DOM compiler. Its request handlers can run without rendering.
        const end = source.indexOf("\n    return (", source.indexOf(`function ${name}()`));
        if (end < 0) throw new Error(`No component return in ${name}`);
        source = `${source.slice(0, end)}\nreturn { ${handlers.join(", ")} };\n}`;
    }
    const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "node" } } });
    const code = transpiler.transformSync(source);
    return new Function(...Object.keys(dependencies), `${code}\nreturn ${name};`)(...Object.values(dependencies));
}

export interface Element {
    tag: string;
    props: Record<string, any>;
    children: any[];
}

export function node(tag: string, props: Record<string, any> | null, ...children: any[]): Element | any[] {
    if (tag === "Show") return props?.when ? children : [props?.fallback];
    return { tag, props: props ?? {}, children };
}

export function elements(tree: any, tag: string): Element[] {
    if (!tree || typeof tree !== "object") return [];
    if (Array.isArray(tree)) return tree.flatMap((child) => elements(child, tag));
    return [...(tree.tag === tag ? [tree] : []), ...elements(tree.children, tag)];
}
