// Writes the default theme's palette into gui/src/styles/tokens.css, between its "palette" marks:
// what gui/src/lib/theme.ts derives from DEFAULT_THEME for each scheme. Run it after changing derive()
// or the default recipe; test/theme.test.ts fails while the file and the recipe disagree.
//
//   bun scripts/theme-tokens.ts           rewrite tokens.css
//   bun scripts/theme-tokens.ts --check   exit 1 if it would change

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_THEME, derive, type Scheme } from "../gui/src/lib/theme";

const file = resolve(import.meta.dir, "../gui/src/styles/tokens.css");

/** tokens.css with each scheme's palette block as the default recipe gives it. */
export function withPalettes(css: string): string {
    return (["light", "dark"] as Scheme[]).reduce((text, scheme) => {
        const open = `/* palette:${scheme} */`;
        const close = `/* /palette:${scheme} */`;
        const [start, end] = [text.indexOf(open), text.indexOf(close)];
        if (start < 0 || end < 0) throw new Error(`tokens.css: no ${open} … ${close}`);
        const body = Object.entries(derive(DEFAULT_THEME, scheme)).map(([name, value]) => `    ${name}: ${value};`).join("\n");
        return `${text.slice(0, start + open.length)}\n${body}\n    ${text.slice(end)}`;
    }, css);
}

if (import.meta.main) {
    const before = readFileSync(file, "utf8");
    const after = withPalettes(before);
    if (process.argv.includes("--check")) {
        if (before !== after) {
            console.error("gui/src/styles/tokens.css is out of date: run `bun scripts/theme-tokens.ts`");
            process.exit(1);
        }
    } else if (before !== after) writeFileSync(file, after);
}
