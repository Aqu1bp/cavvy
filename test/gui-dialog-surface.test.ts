import { expect, test } from "bun:test";
import { parseRules } from "./helpers/contrast";

const read = (path: string) => Bun.file(new URL(`../gui/src/${path}`, import.meta.url)).text();

// Under a dialog the window dims (the scrim's colour); nothing is blurred, neither the app (a filter over the whole window,
// redrawn with everything under it) nor the scrim's backdrop. The dialog's surface is opaque.
test("a dialog's surface is opaque; the window behind it dims, and nothing blurs", async () => {
    const dialog = await read("components/ui/Dialog.tsx");
    expect(dialog).toContain('class={`overlay dialog-backdrop ${p.top ? "top" : ""}`}');
    expect(dialog).toContain('toggleAttribute("data-dialog", true)');
    expect(dialog).toContain('toggleAttribute("data-dialog", stack.length > 0)');
    // The design's kit (styles/kit.css): .dlg is the surface, .overlay the scrim.
    const rules = parseRules(await read("styles/kit.css"));
    const surface = rules.filter((r) => r.selectors.includes(".dlg") && r.decls.has("background"));
    expect(surface.length).toBe(1);
    const d = surface[0]!.decls;
    // The window's own colour, which is opaque in every theme (src/themes/palette.ts: --sheet; --bg is its alias).
    expect(d.get("background")).toBe("var(--bg)");
    expect(parseRules(await read("styles/tokens.css")).some((r) => r.selectors.includes(":root") && r.decls.get("--bg") === "var(--sheet)")).toBe(true);
    expect(d.get("backdrop-filter")).toBeUndefined();
    const scrim = rules.find((r) => r.selectors.includes(".overlay"))!.decls;
    expect(scrim.get("background")).toBe("var(--overlay)");
    expect(scrim.get("backdrop-filter")).toBeUndefined();
    for (const sheet of ["styles/kit.css", "styles/overlays.css"]) {
        const all = parseRules(await read(sheet));
        expect(all.some((r) => r.selectors.some((s) => s.includes("[data-dialog]")) && r.decls.has("filter"))).toBe(false);
        expect(all.some((r) => r.selectors.some((s) => /\.(dlg|dialog|overlay|dialog-backdrop)\b/.test(s)) && r.decls.has("backdrop-filter"))).toBe(false);
    }
});
