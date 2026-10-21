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

test("the composer dock's height doesn't inherit: only the transcript's boxes that use it take it", () => {
    // Set on .stage as the composer grows; inherited, each new line restyled every turn under it.
    const stage = parseRules(read("styles/stage.css"));
    const at = (selector: string, property: string) => stage.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
    expect(at("@property --dock-h", "inherits")).toBe("false");
    expect(at("@property --dock-h", "syntax")).toBe('"<length>"');
    // The chain from .stage down to the two boxes that read it (.transcript-end, .jump), and .transcript, which FindBar reads.
    for (const box of [".transcript-wrap", ".transcript", ".transcript-col", ".transcript-end", ".jump"]) expect({ box, value: at(`.stage ${box}`, "--dock-h") }).toEqual({ box, value: "inherit" });
    const users = readdirSync(join(gui, "styles")).flatMap((f) => parseRules(read(`styles/${f}`)).filter((r) => [...r.decls.values()].some((v) => v.includes("var(--dock-h)"))).flatMap((r) => r.selectors));
    expect(new Set(users)).toEqual(new Set([".transcript-end", ".jump"]));
});

test("the title bar doesn't read its box as it mounts: its ResizeObserver's first report places the toasts", () => {
    const bar = read("components/Header.tsx");
    const mount = bar.slice(bar.indexOf("export function TitleBar"), bar.indexOf("return (", bar.indexOf("export function TitleBar")));
    expect(mount).toContain("new ResizeObserver(place)");
    expect(mount).not.toMatch(/^\s*place\(\);/m);
});
