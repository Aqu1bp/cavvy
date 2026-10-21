// Dragging an edge changes a size on every frame. A custom property that inherits restyles every
// element under the one it's set on, so on <html> or .app each frame restyled the whole window.
// The sizes the shell keeps don't inherit, and go on the elements that use them.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parseRules } from "./helpers/contrast";

const gui = join(import.meta.dir, "../gui/src");
const read = (path: string) => readFileSync(join(gui, path), "utf8");
const rules = [...parseRules(read("styles/shell.css")), ...parseRules(read("styles/sidebar.css"))];
const decl = (selector: string, property: string) => rules.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);

test("the sizes App.tsx sets are registered as not inherited", () => {
    const set = new Set([...read("App.tsx").matchAll(/"(--[\w-]+)":/g)].map((m) => m[1]!));
    expect(set).toEqual(new Set(["--rail-w", "--insp-col", "--term-h", "--insp-w", "--insp-bottom"]));
    for (const name of set) {
        expect({ name, inherits: decl(`@property ${name}`, "inherits") }).toEqual({ name, inherits: "false" });
        expect(decl(`@property ${name}`, "syntax")).toBe('"<length>"');
    }
});

test("the few children that use one inherit it explicitly", () => {
    // .win holds --rail-w; the rail's column and the sidebar in it take it from there.
    expect(decl(".win-rail", "--rail-w")).toBe("inherit");
    expect(decl(".sidebar", "--rail-w")).toBe("inherit");
    expect(decl(".sidebar", "width")).toBe("var(--rail-w)");
    // .insp holds --insp-w; its content keeps that width while the column opens and closes.
    expect(decl(".insp > :not(.insp-resizer)", "--insp-w")).toBe("inherit");
});

test("nothing in the app writes to <html>'s style but the preferences", () => {
    const files = (dir: string): string[] => readdirSync(join(gui, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    const writers = files(".").filter((f) => /documentElement\.style|documentElement\)\.style/.test(read(f)));
    expect(writers).toEqual([]);
    // The title bar's place reaches the toasts as a signal, set on .toasts alone.
    expect(read("components/Header.tsx")).not.toContain("--bar-start");
    expect(read("components/Toasts.tsx")).toContain('"--bar-start"');
});
