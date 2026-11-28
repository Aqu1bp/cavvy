// Removing a CLI instance says so in one toast, under 8 words.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";

function load() {
    let source = readFileSync(new URL("../gui/src/lib/reset-toast.ts", import.meta.url), "utf8");
    source = source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");
    const toasts: string[] = [];
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    const removedToast = new Function("toast", `${code}\nreturn removedToast;`)((m: string) => toasts.push(m)) as (name: string, reset?: string[]) => void;
    return { removedToast, toasts };
}

test("one toast: the name, and whether defaults that used it were reset", () => {
    const { removedToast, toasts } = load();
    removedToast("OpenRouter", undefined);
    removedToast("OpenRouter", ["smallModel"]);
    removedToast("A very long instance name for a proxy setup", []);
    removedToast("OpenRouter proxy for the whole team", ["smallModel"]);
    removedToast("Claude through the staging cluster", []);
    // Not cut after a small word ("for", "the"): "OpenRouter proxy…".
    expect(toasts).toEqual(["Removed OpenRouter", "Removed OpenRouter. Defaults reset.", "Removed A very long instance…", "Removed OpenRouter proxy… Defaults reset.", "Removed Claude through…"]);
    for (const t of toasts) expect(t.split(/\s+/).length).toBeLessThan(8);
});
