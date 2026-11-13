// What was picked for a new session (model, effort, fast mode) goes with the window when it changes machines:
// each machine saves its own, so the composer used to change under the user's hand when they changed only where
// the session would run. The permission mode stays each machine's own.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { fileURLToPath } from "node:url";
import { PICKED_KEY, pickedPatch, takePicked } from "../gui/src/lib/picked";
import { pickedOf } from "../gui/src/lib/picked-leaving";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const store = (value?: string) => {
    const kept = new Map<string, string>(value === undefined ? [] : [[PICKED_KEY, value]]);
    return { kept, getItem: (k: string) => kept.get(k) ?? null, removeItem: (k: string) => void kept.delete(k) };
};
const luna = { ref: "codex:gpt-6-luna", effortLevels: ["low", "medium", "high"] as const, supportsFastMode: true };
const haiku = { ref: "claude-code:haiku", effortLevels: ["medium", "high"] as const };
const plain = { ref: "grok:fast" };
const models = [luna, haiku, plain].map((m) => ({ ...m, effortLevels: "effortLevels" in m ? [...m.effortLevels] : undefined }));

test("what a window leaves with is the pick as its composer shows it, and never the permission mode", () => {
    expect(pickedOf({ model: "codex:gpt-6-luna", effort: "high", fastMode: true, defaultMode: "bypassPermissions" }, models)).toEqual({ model: "codex:gpt-6-luna", effort: "high", fastMode: true });
    expect(pickedOf({ model: "claude-code:haiku" }, models)).toEqual({ model: "claude-code:haiku" });
    // An effort or fast mode saved from an earlier model, which this one doesn't take and the composer doesn't show.
    expect(pickedOf({ model: "claude-code:haiku", effort: "low", fastMode: true }, models)).toEqual({ model: "claude-code:haiku", fastMode: false });
    expect(pickedOf({ model: "grok:fast", effort: "high" }, models)).toEqual({ model: "grok:fast" });
    // No model picked, or one this machine doesn't list: nothing to bring.
    expect(pickedOf({ effort: "high", defaultMode: "default" }, models)).toBeUndefined();
    expect(pickedOf({ model: "gone:model" }, models)).toBeUndefined();
    for (const file of ["gui/src/lib/picked.ts", "gui/src/lib/picked-leaving.ts"]) expect(read(file).replace(/^\/\/.*$/gm, "")).not.toMatch(/defaultMode|homeMode|allowBypass/);
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
    expect(pickedPatch({ model: "codex:gpt-6-luna", effort: "high", fastMode: true }, here, models)).toEqual({ model: "codex:gpt-6-luna", effort: "high", fastMode: true });
    // Only what differs is changed, and nothing when it's all the same already.
    expect(pickedPatch({ model: "claude-code:haiku", effort: "high" }, here, models)).toEqual({ effort: "high" });
    expect(pickedPatch({ model: "claude-code:haiku", effort: "medium", fastMode: false }, here, models)).toBeUndefined();
    // An effort or fast mode that wasn't set there doesn't unset this machine's.
    expect(pickedPatch({ model: "codex:gpt-6-luna" }, here, models)).toEqual({ model: "codex:gpt-6-luna" });
    // Not a model this machine has: its own stays, effort and all.
    expect(pickedPatch({ model: "gone:model", effort: "high", fastMode: true }, here, models)).toBeUndefined();
    expect(pickedPatch({ model: "codex:gpt-6-luna" }, here, [])).toBeUndefined();
});

test("what this machine's model can't take is left out, so the machine doesn't refuse the rest", () => {
    const here = { model: "codex:gpt-6-luna", effort: "medium" as const };
    // Fast mode where the model can't run fast here (an older CLI): the model and effort still come.
    expect(pickedPatch({ model: "claude-code:haiku", effort: "high", fastMode: true }, here, models)).toEqual({ model: "claude-code:haiku", effort: "high" });
    // Turning it off is always possible.
    expect(pickedPatch({ model: "claude-code:haiku", fastMode: false }, { ...here, fastMode: true }, models)).toEqual({ model: "claude-code:haiku", fastMode: false });
    // An effort the model doesn't take here, or a level this build has never heard of (it would be saved as none).
    expect(pickedPatch({ model: "claude-code:haiku", effort: "low" }, here, models)).toEqual({ model: "claude-code:haiku" });
    expect(pickedPatch({ model: "codex:gpt-6-luna", effort: "ultra" as never }, here, models)).toBeUndefined();
    expect(pickedPatch({ model: "grok:fast", effort: "high" }, here, models)).toEqual({ model: "grok:fast" });
});

test("only the servers code carries what a window leaves with; it leaves with it from a new-session screen only", () => {
    const machines = read("gui/src/lib/machines.ts");
    // Not from a session (which has its own model), and not to one. A pick the window came with and never took up
    // (the machine couldn't be reached) goes on with it.
    expect(machines).toContain("const picked = !session && !app.activeId ? (pickedOf(app.settings, app.models.flatMap((g) => g.models)) ?? pendingPicked()) : undefined;");
    expect(machines).toMatch(/if \(picked\) sessionStorage\.setItem\(PICKED_KEY, JSON\.stringify\(picked\)\);\s+else sessionStorage\.removeItem\(PICKED_KEY\);/);
    expect(read("gui/src/state/app.ts")).not.toContain("picked-leaving");
});

// The page that loads, driven against a server that answers as one would (test/fixtures/gui-picked-flow.ts).
for (const mode of ["has", "lacks", "fast-not-here", "slow-models", "from-a-cover"]) {
    test(`a window that came with a pick: ${mode}`, async () => {
        const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-picked-flow.ts", import.meta.url)), mode], { stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    });
}
