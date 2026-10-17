import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseRules } from "./helpers/contrast";

const gui = join(import.meta.dir, "../gui/src");

test("markdown tables preserve word widths while prose still wraps long content", () => {
    const rules = parseRules(readFileSync(join(gui, "styles/markdown.css"), "utf8"));
    const declaration = (selector: string, property: string) =>
        rules.findLast((rule) => rule.selectors.includes(selector) && rule.decls.has(property))?.decls.get(property);
    for (const selector of [".md th", ".md td", ".md th > code", ".md td > code", ".md th :not(pre) > code", ".md td :not(pre) > code"]) {
        expect(declaration(selector, "overflow-wrap")).toBe("break-word");
    }
    expect(declaration(".md", "overflow-wrap")).toBe("anywhere");
    expect(declaration(".md :not(pre) > code", "overflow-wrap")).toBe("anywhere");
    expect(declaration(".md-table", "overflow-x")).toBe("auto");
    expect(declaration(".md .md-pre", "overflow-x")).toBe("auto");
});

test("forced-colors selection outlines preserve keyboard focus on selected controls", () => {
    const css = readFileSync(join(gui, "styles/base.css"), "utf8");
    const forced = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(forced).toBeDefined();
    const rules = parseRules(forced!);
    expect(rules.find((r) => r.selectors.includes(":focus-visible"))?.decls.get("outline")).toBe("2px solid Highlight");
    expect(parseRules(css).find((r) => r.selectors.includes(":focus-visible"))?.decls.get("outline-offset")).toBe("2px");

    // These classes belong to focusable controls. Card/model/file row wrappers
    // instead keep their selection outline while a child button receives focus.
    for (const selector of [".navi.on", ".segmented button.on", ".menu-item.sel", ".menu-item.current", ".rw-item.on", ".toggle.on"]) {
        const outlines = rules.filter((r) => r.decls.has("outline") && r.selectors.some((s) => s.startsWith(selector)));
        expect(outlines).toHaveLength(1);
        expect(outlines[0]!.selectors.filter((s) => s.startsWith(selector))).toEqual([`${selector}:not(:focus-visible)`]);
        expect(outlines[0]!.decls.get("outline")).toBe(selector === ".toggle.on" ? "1px solid Highlight" : "1px solid SelectedItem");
        if (selector !== ".toggle.on") expect(outlines[0]!.decls.get("outline-offset")).toBe("-1px");
    }
    // Enabled toggles retain their state background even while focused.
    expect(rules.find((r) => r.selectors.includes(".toggle.on"))?.decls.get("background")).toBe("Highlight");
});

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
