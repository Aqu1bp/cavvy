import { expect, test } from "bun:test";
import { parseRules } from "./helpers/contrast";

const read = (path: string) => Bun.file(new URL(`../gui/src/${path}`, import.meta.url)).text();

// A dialog sits inside its scrim, and the scrim's backdrop-filter makes it the dialog's backdrop root: a blur on the
// dialog would blur only the scrim, and the page would read through a see-through surface. So the surface is opaque.
test("a dialog's surface is opaque and blurs nothing of its own; the scrim does the blurring", async () => {
    expect(await read("components/ui/Dialog.tsx")).toContain('class={`dialog-backdrop ${p.top ? "top" : ""}`}');
    const rules = parseRules(await read("styles/overlays.css"));
    const surface = rules.filter((r) => r.selectors.includes(".dialog"));
    expect(surface.length).toBe(1);
    const d = surface[0]!.decls;
    // Its last layer is the window's own colour, which is opaque in every theme (src/themes/palette.ts: --sheet).
    expect(d.get("background")).toMatch(/,\s*var\(--sheet\)$/);
    expect(d.get("backdrop-filter")).toBe("none");
    expect(d.get("-webkit-backdrop-filter")).toBe("none");
    const scrim = rules.find((r) => r.selectors.includes(".dialog-backdrop"))!.decls;
    expect(scrim.get("backdrop-filter")).toMatch(/blur\(/);
});
