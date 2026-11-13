// What was picked for a new session (model, effort, fast mode) goes with the window when it changes machines:
// each machine saves its own, so the composer used to change under the user's hand when they changed only where
// the session would run. The permission mode stays each machine's own.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { PICKED_KEY, pickedOf, pickedPatch, takePicked } from "../gui/src/lib/picked";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const store = (value?: string) => {
    const kept = new Map<string, string>(value === undefined ? [] : [[PICKED_KEY, value]]);
    return { kept, getItem: (k: string) => kept.get(k) ?? null, removeItem: (k: string) => void kept.delete(k) };
};

test("what's carried is the model with its effort and fast mode, and never the permission mode", () => {
    expect(pickedOf({ model: "codex:gpt-6-luna", effort: "high", fastMode: true, defaultMode: "bypassPermissions" })).toEqual({ model: "codex:gpt-6-luna", effort: "high", fastMode: true });
    expect(pickedOf({ model: "claude-code:haiku" })).toEqual({ model: "claude-code:haiku" });
    // No model picked: nothing to bring.
    expect(pickedOf({ effort: "high", defaultMode: "default" })).toBeUndefined();
    expect(read("gui/src/lib/picked.ts")).not.toMatch(/defaultMode|homeMode/);
});

test("it's taken once, and anything that isn't a pick is nothing", () => {
    const s = store(JSON.stringify({ model: "codex:gpt-6-luna", effort: "high", fastMode: false, defaultMode: "bypassPermissions" }));
    expect(takePicked(() => s)).toEqual({ model: "codex:gpt-6-luna", effort: "high", fastMode: false });
    expect([s.kept.size, takePicked(() => s)]).toEqual([0, undefined]);
    for (const bad of ["", "{", "null", "[]", JSON.stringify({ model: 3 }), JSON.stringify({ effort: "high" })]) expect(takePicked(() => store(bad))).toBeUndefined();
    expect(takePicked(() => store(JSON.stringify({ model: "m", effort: 3, fastMode: "yes" })))).toEqual({ model: "m" });
    // Where there's no storage at all (it throws), there's nothing.
    expect(takePicked(() => { throw new Error("denied"); })).toBeUndefined();
});

test("a machine that has the model takes the pick; one that hasn't keeps its own", () => {
    const here = { model: "claude-code:haiku", effort: "medium" as const, fastMode: false, defaultMode: "bypassPermissions" as const };
    const refs = ["claude-code:haiku", "codex:gpt-6-luna"];
    expect(pickedPatch({ model: "codex:gpt-6-luna", effort: "high", fastMode: true }, here, refs)).toEqual({ model: "codex:gpt-6-luna", effort: "high", fastMode: true });
    // Only what differs is changed, and nothing when it's all the same already.
    expect(pickedPatch({ model: "claude-code:haiku", effort: "high" }, here, refs)).toEqual({ effort: "high" });
    expect(pickedPatch({ model: "claude-code:haiku", effort: "medium", fastMode: false }, here, refs)).toBeUndefined();
    // An effort or fast mode that wasn't set there doesn't unset this machine's.
    expect(pickedPatch({ model: "codex:gpt-6-luna" }, here, refs)).toEqual({ model: "codex:gpt-6-luna" });
    // Not a model this machine has: its own stays, effort and all.
    expect(pickedPatch({ model: "grok:fast", effort: "high", fastMode: true }, here, refs)).toBeUndefined();
    expect(pickedPatch({ model: "codex:gpt-6-luna" }, here, [])).toBeUndefined();
});

test("the window brings it from one new-session screen to another, and takes it up once settings and models are in", () => {
    const machines = read("gui/src/lib/machines.ts");
    // Not from a session (which has its own model), and not to one.
    expect(machines).toContain("const picked = !session && !app.activeId ? pickedOf(app.settings) : undefined;");
    expect(machines).toMatch(/if \(picked\) sessionStorage\.setItem\(PICKED_KEY, JSON\.stringify\(picked\)\);\s+else sessionStorage\.removeItem\(PICKED_KEY\);/);
    const app = read("gui/src/state/app.ts");
    expect(app).toContain("if (!picked || !settingsIn || !app.modelsLoaded) return;");
    expect(app).toMatch(/setApp\("modelsLoaded", true\);\s+usePicked\(\);/);
    expect(app).toMatch(/settingsIn = true;\s+usePicked\(\);/);
    // Saved on this machine as a pick made here would be.
    expect(app).toContain('void rpc.call("settings.update", { patch }).then((s) => setApp("settings", s), (e) => (reportError(e), refreshSettings()));');
});
