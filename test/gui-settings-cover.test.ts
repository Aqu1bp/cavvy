import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("leaving Settings shows the session it covered without building it again", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/gui-settings-cover.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
});

test("nothing in the covered session paints over the settings page", async () => {
    // The composer dock (z-index 30) and the "Latest" pill (25) sat over the page (6) without it.
    const { parseRules } = await import("./helpers/contrast");
    const rules = parseRules(await Bun.file(new URL("../gui/src/styles/shell.css", import.meta.url)).text());
    const decl = (selector: string, property: string) => rules.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
    expect(decl(".main > .keep", "isolation")).toBe("isolate");
    expect(decl(".main > .settings-host", "z-index")).toBe("6");
});

test("nothing in the covered session takes focus on its own while Settings is up", async () => {
    // Focus going there would be moved on (lib/cover.ts), out of what's being typed in Settings.
    const read = (f: string) => Bun.file(new URL(`../gui/src/components/${f}`, import.meta.url)).text();
    const composer = await read("Composer.tsx");
    const restore = composer.slice(composer.indexOf("What the server hands back"), composer.indexOf("createEffect(on(focusComposer"));
    expect(restore).toContain("if (!settingsTab()) ta?.focus();");
    expect(restore).not.toMatch(/^\s*ta\?\.focus\(\);/m);
    expect(composer).toMatch(/const focusSoon = [\s\S]{0,120}if \(settingsTab\(\) \|\|/);
    const dock = await read("InteractionDock.tsx");
    expect(dock).toContain("const mayFocus = () => !typing() && !settingsTab();");
    expect(dock).not.toMatch(/!typing\(\) && el\.focus\(\)|typing\(\) \|\| input\.focus\(\)/);
});
