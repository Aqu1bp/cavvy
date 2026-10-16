import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const gui = join(import.meta.dir, "../gui/src");

// Read only class values, including literal branches of Solid's template expressions.
// Searching the whole source would confuse props/variables named "split" with classes.
function classes(source: string): Set<string> {
    const result = new Set<string>();
    for (const attr of source.matchAll(/\bclass=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
        const value = attr[1] ?? attr[2] ?? attr[3]!.replace(/\$\{([^}]*)\}/g, (_, expression: string) =>
            [...expression.matchAll(/["']([^"']*)["']/g)].map((literal) => literal[1]).join(" "));
        for (const word of value.split(/\s+/)) if (word) result.add(word);
    }
    return result;
}

test("project-scripts bare CSS classes do not target other components", async () => {
    const bare = new Set<string>();
    // Stop at the next section so unrelated features appended later aren't treated
    // as project-script styles; only selectors with no component scope are guarded.
    for (const [sheet, marker] of [
        ["layout.css", "/* ---- Project scripts (title line)"],
        ["overlays.css", "/* ---- Labelled form fields (the project script dialog)"],
    ] as const) {
        const css = readFileSync(join(gui, "styles", sheet), "utf8");
        expect(css).toContain(marker);
        const start = css.indexOf(marker);
        const end = css.indexOf("/* ----", start + marker.length);
        const section = css.slice(start, end < 0 ? undefined : end).replace(/\/\*[\s\S]*?\*\//g, "");
        for (const rule of section.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
            for (const selector of rule[1]!.split(",")) {
                const match = /^\.([\w-]+)$/.exec(selector.trim());
                if (match) bare.add(match[1]!);
            }
        }
    }
    expect(bare.size).toBeGreaterThan(0);
    const collisions: string[] = [];
    for await (const path of new Bun.Glob("**/*.tsx").scan(join(gui, "components"))) {
        if (path === "ProjectScripts.tsx") continue;
        const used = classes(readFileSync(join(gui, "components", path), "utf8"));
        for (const name of bare) if (used.has(name)) collisions.push(`.${name} also matches ${path}`);
    }
    expect(collisions.sort()).toEqual([]);
});
