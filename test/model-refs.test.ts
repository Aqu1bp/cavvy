import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { writeProvidersFile } = await import("../src/providers/registry");
const { addInstance, removeInstance } = await import("../src/providers/instances");
const { clearModelSettings, fallbackNotice, forgetRemovedProvider, resetNote, unavailableReason } = await import("../src/providers/model-refs");
const { setKey, removeKey } = await import("../src/auth/credentials");

afterAll(() => iso.cleanup());
const cwd = tempDir("model-refs-");
const settingsFile = () => join(iso.home, "settings.json");
const settings = () => JSON.parse(readFileSync(settingsFile(), "utf-8"));

beforeEach(() => {
    writeProvidersFile({ agents: { "claude-code": { path: "/bin/true" } } });
    writeFileSync(settingsFile(), JSON.stringify({ model: "claude-code@router:router/a", smallModel: "openai:gpt-6-luna", reviewModel: "claude-code@router:sonnet", effort: "high" }));
});

test("a removed instance, a CLI turned off, a missing key: each said by name, never its id", async () => {
    const id = await addInstance("claude-code", { name: "My Router" });
    expect(await unavailableReason(`${id}:sonnet`)).toBeUndefined();
    await removeInstance(id);
    expect(await unavailableReason(`${id}:sonnet`)).toBe("Claude Code · My Router was removed");
    expect(await unavailableReason("openai:gpt-6-sol")).toBe("OpenAI has no key");
    expect(await unavailableReason("codex:gpt-6-sol")).toBe("Codex is turned off");
    expect(await unavailableReason("not a ref")).toBe("That model isn't available");
    expect(fallbackNotice("Claude Code · My Router was removed", { provider: "claude-code", id: "default", name: "Default (claude-test-1)" })).toBe("Claude Code · My Router was removed, so this session uses Default on Claude Code.");
});

test("only the user's saved models naming what went are reset, and the rest of the file stays", () => {
    expect(clearModelSettings(cwd, (r) => r.provider === "claude-code@router")).toEqual(["model", "reviewModel"]);
    expect(settings()).toEqual({ smallModel: "openai:gpt-6-luna", effort: "high" });
    // Nothing names it: the file isn't written.
    const before = readFileSync(settingsFile(), "utf-8");
    expect(clearModelSettings(cwd, (r) => r.provider === "gemini")).toEqual([]);
    expect(readFileSync(settingsFile(), "utf-8")).toBe(before);
    expect(resetNote(["model"])).toBe("The default model is now automatic.");
    expect(resetNote(["smallModel"])).toBe("Defaults that used it were reset.");
    expect(resetNote([])).toBe("");
});

test("a key removed resets what named it; one still usable (from the environment) doesn't", async () => {
    await setKey("openai", "sk-test-0123456789abcdef");
    expect(await forgetRemovedProvider(cwd, "openai")).toEqual([]);
    await removeKey("openai");
    expect(await forgetRemovedProvider(cwd, "openai")).toEqual(["smallModel"]);
    expect(settings().smallModel).toBeUndefined();
});
