// Inlines Lucide icon nodes (from the GUI's own lucide-solid) into icons.js for the mockup.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const dir = new URL("../../../gui/node_modules/lucide-solid/dist/esm/icons/", import.meta.url).pathname;
const names = process.argv.slice(2);
const out: Record<string, string> = {};
const missing: string[] = [];
for (const n of names) {
    const f = `${dir}${n}.mjs`;
    if (!existsSync(f)) { missing.push(n); continue; }
    const src = readFileSync(f, "utf8");
    const i = src.indexOf("const __iconData = ");
    const j = src.indexOf("\n};", i);
    if (i < 0 || j < 0) { missing.push(n); continue; }
    const data = new Function(`return ${src.slice(i + 19, j + 3)}`)() as { node: [string, Record<string, string>][] };
    const node = data.node;
    out[n] = node.map(([tag, a]) => `<${tag} ${Object.entries(a).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
}
writeFileSync(new URL("../icons.js", import.meta.url), `window.ICONS=${JSON.stringify(out)};\n`);
console.log("ok", Object.keys(out).length, "missing:", missing.join(" ") || "none");
