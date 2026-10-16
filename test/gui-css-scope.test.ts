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
    const css = readFileSync(join(gui, "styles/layout.css"), "utf8");
    const marker = "/* ---- Project scripts (title line)";
    expect(css).toContain(marker);
    // This feature owns the final section of layout.css. Shared UI utilities are
    // deliberately outside it; only selectors with no component scope are guarded.
    const section = css.slice(css.indexOf(marker)).replace(/\/\*[\s\S]*?\*\//g, "");
    const bare = new Set<string>();
    for (const rule of section.matchAll(/(?:^|[{}])\s*([^{}]+)\{/g)) {
        for (const selector of rule[1]!.split(",")) {
            const match = /^\.([\w-]+)$/.exec(selector.trim());
            if (match) bare.add(match[1]!);
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
