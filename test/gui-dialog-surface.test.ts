import { expect, test } from "bun:test";
import { parseRules } from "./helpers/contrast";

const read = (path: string) => Bun.file(new URL(`../gui/src/${path}`, import.meta.url)).text();

// Under a dialog the window dims (the scrim's colour); nothing is blurred, neither the app (a filter over the whole window,
// redrawn with everything under it) nor the scrim's backdrop. The dialog's surface is opaque.
test("a dialog's surface is opaque; the window behind it dims, and nothing blurs", async () => {
    const dialog = await read("components/ui/Dialog.tsx");
    expect(dialog).toContain('class={`dialog-backdrop ${p.top ? "top" : ""}`}');
    expect(dialog).toContain('toggleAttribute("data-dialog", true)');
    expect(dialog).toContain('toggleAttribute("data-dialog", stack.length > 0)');
    const rules = parseRules(await read("styles/overlays.css"));
    const surface = rules.filter((r) => r.selectors.includes(".dialog"));
    expect(surface.length).toBe(1);
    const d = surface[0]!.decls;
    // The window's own colour, which is opaque in every theme (src/themes/palette.ts: --sheet).
    expect(d.get("background")).toBe("var(--sheet)");
    expect(d.get("backdrop-filter")).toBeUndefined();
    const scrim = rules.find((r) => r.selectors.includes(".dialog-backdrop"))!.decls;
    expect(scrim.get("background")).toBe("var(--overlay)");
    expect(scrim.get("backdrop-filter")).toBeUndefined();
    expect(rules.some((r) => r.selectors.some((s) => s.includes("[data-dialog]")) && r.decls.has("filter"))).toBe(false);
});
