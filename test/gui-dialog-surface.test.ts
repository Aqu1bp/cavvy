import { expect, test } from "bun:test";
import { parseRules } from "./helpers/contrast";

const read = (path: string) => Bun.file(new URL(`../gui/src/${path}`, import.meta.url)).text();

// Under a dialog the app itself blurs (a filter), not the scrim's backdrop: where the window is see-through, the sharp
// page shows through a backdrop-filter's blurred copy. The dialog's surface is opaque and blurs nothing of its own.
test("a dialog's surface is opaque; the app behind it blurs, not the scrim's backdrop", async () => {
    const dialog = await read("components/ui/Dialog.tsx");
    expect(dialog).toContain('class={`dialog-backdrop ${p.top ? "top" : ""}`}');
    expect(dialog).toContain('toggleAttribute("data-dialog", true)');
    expect(dialog).toContain('toggleAttribute("data-dialog", stack.length > 0)');
    const rules = parseRules(await read("styles/overlays.css"));
    const surface = rules.filter((r) => r.selectors.includes(".dialog"));
    expect(surface.length).toBe(1);
    const d = surface[0]!.decls;
    // Its last layer is the window's own colour, which is opaque in every theme (src/themes/palette.ts: --sheet).
    expect(d.get("background")).toMatch(/,\s*var\(--sheet\)$/);
    expect(d.get("backdrop-filter")).toBe("none");
    expect(d.get("-webkit-backdrop-filter")).toBe("none");
    const scrim = rules.find((r) => r.selectors.includes(".dialog-backdrop"))!.decls;
    expect(scrim.get("backdrop-filter")).toBeUndefined();
    const app = rules.find((r) => r.selectors.includes(":root[data-dialog] .app"))!.decls;
    expect(app.get("filter")).toMatch(/blur\(/);
});
