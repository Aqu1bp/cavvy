import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCompactAt, claudeCompactWindow, claudeEnvWindow, claudeSettingsKey, codexCompactLimit, cavvyCompactAt, modelKeys, outputReserve } from "../src/backends/compact-at";

const dir = () => mkdtempSync(join(tmpdir(), "compact-at-"));
const json = (file: string, v: unknown) => writeFileSync(file, JSON.stringify(v));
const window = (w: unknown) => ({ autoCompactWindow: w });

afterEach(() => delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);

test("Claude Code: the model's autoCompactWindow, a trusted project's settings over the account's", () => {
    const config = dir(), cwd = dir();
    const trusted = { cwd, trusted: true };
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBeUndefined();
    json(join(config, "settings.json"), { theme: "dark", modelSettings: { "claude-opus-5-5": window(500_000), "claude-sonnet-5-5": window("big") } });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(500_000);
    // Under another id of the same model (the alias asked for, then what it resolved to).
    expect(claudeCompactWindow(config, trusted, ["opus", "claude-opus-5-5"])).toBe(500_000);
    expect(claudeCompactWindow(config, trusted, ["claude-sonnet-5-5"])).toBeUndefined();
    mkdirSync(join(cwd, ".claude"));
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { "claude-opus-5-5": window(300_000) } });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(300_000);
    // An untrusted folder's settings are off for Claude Code (--setting-sources user), so here too.
    expect(claudeCompactWindow(config, { cwd, trusted: false }, ["claude-opus-5-5"])).toBe(500_000);
    writeFileSync(join(cwd, ".claude", "settings.local.json"), "{ not json");
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(300_000);
    json(join(cwd, ".claude", "settings.local.json"), { modelSettings: { "claude-opus-5-5": window(250_000) } });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(250_000);
});

test("Claude Code: a layer's top-level window replaces the ones before it, \"auto\" is none, and only 100K-1M counts", () => {
    const config = dir(), cwd = dir();
    const trusted = { cwd, trusted: true };
    mkdirSync(join(cwd, ".claude"));
    json(join(config, "settings.json"), { modelSettings: { "claude-opus-5-5": window(500_000) } });
    json(join(cwd, ".claude", "settings.json"), { autoCompactWindow: 300_000 });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(300_000);
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { "claude-opus-5-5": window("auto") } });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBeUndefined();
    // Out of range: ignored, so the account's stands.
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { "claude-opus-5-5": window(50_000) }, autoCompactWindow: 2_000_000 });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(500_000);
    // A per-model value in the same layer as a top-level one wins for that model.
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { "claude-opus-5-5": window(400_000) }, autoCompactWindow: 200_000 });
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(400_000);
    expect(claudeCompactWindow(config, trusted, ["claude-sonnet-5-5"])).toBe(200_000);
    // The environment's window comes first, as for Claude Code.
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "150000";
    expect(claudeCompactWindow(config, trusted, ["claude-opus-5-5"])).toBe(150_000);
});

test("Claude Code: the environment's window as Claude Code reads it, suffixes and clamping", () => {
    expect(claudeEnvWindow("500k")).toBe(500_000);
    expect(claudeEnvWindow("0.5m")).toBe(500_000);
    expect(claudeEnvWindow(" 250000 ")).toBe(250_000);
    expect(claudeEnvWindow("50k")).toBe(100_000);
    expect(claudeEnvWindow("2m")).toBe(1_000_000);
    for (const bad of [undefined, "", "big", "0", "-5"]) expect(claudeEnvWindow(bad)).toBeUndefined();
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "500k";
    expect(claudeCompactAt(1_000_000, claudeCompactWindow(dir(), undefined, ["claude-opus-5-5"]), 64_000)).toBe(467_000);
});

test("Claude Code: an alias and the model it stands for are one model across layers", () => {
    const config = dir(), cwd = dir();
    mkdirSync(join(cwd, ".claude"));
    json(join(config, "settings.json"), { modelSettings: { "claude-opus-5-5": window(500_000) } });
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { opus: window(300_000) } });
    expect(claudeCompactWindow(config, { cwd, trusted: true }, ["claude-opus-5-5", "opus"])).toBe(300_000);
    expect(claudeCompactWindow(config, { cwd, trusted: true }, ["opus", "claude-opus-5-5"])).toBe(300_000);
    // Within a layer, the full id as keyed wins over the alias.
    json(join(cwd, ".claude", "settings.json"), { modelSettings: { opus: window(300_000), "claude-opus-5-5": window(400_000) } });
    expect(claudeCompactWindow(config, { cwd, trusted: true }, ["opus", "claude-opus-5-5"])).toBe(400_000);
});

test("Claude Code: one model however it's spelled", () => {
    for (const id of ["claude-opus-5-5[1m]", "claude-opus-5-5-20260101", "claude-opus-5-5@20260101", "us.anthropic.claude-opus-5-5-20260101-v1:0", "anthropic.claude-opus-5-5-v1", "Claude-Opus-5-5"]) expect(claudeSettingsKey(id)).toBe("claude-opus-5-5");
    const config = dir();
    json(join(config, "settings.json"), { modelSettings: { "claude-opus-5-5": window(500_000) } });
    expect(claudeCompactWindow(config, undefined, ["claude-opus-5-5[1m]"])).toBe(500_000);
});

test("Claude Code compacts below its window: the answer's room (at most 20K) and a 13K margin", () => {
    expect(claudeCompactAt(1_000_000, 500_000, 64_000)).toBe(467_000);
    expect(claudeCompactAt(200_000, undefined, 8_000)).toBe(179_000);
    expect(claudeCompactAt(200_000, 500_000)).toBe(167_000);
    expect(claudeCompactAt(undefined, 300_000)).toBe(267_000);
    expect(claudeCompactAt(undefined, undefined)).toBeUndefined();
});

test("Codex: model_auto_compact_token_limit at the top of config.toml, read as TOML", () => {
    const home = dir();
    expect(codexCompactLimit(home)).toBeUndefined();
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6"\nmodel_auto_compact_token_limit = 250_000 # tokens\n\n[profiles.fast]\nmodel_auto_compact_token_limit = 9\n');
    expect(codexCompactLimit(home)).toBe(250_000);
    writeFileSync(join(home, "config.toml"), '[profiles.fast]\nmodel_auto_compact_token_limit = 9\n');
    expect(codexCompactLimit(home)).toBeUndefined();
    // A multi-line string that looks like the setting (or a table) is a string; a quoted key is the key.
    writeFileSync(join(home, "config.toml"), 'notes = """\nmodel_auto_compact_token_limit = 100000\n[x]\n"""\n"model_auto_compact_token_limit" = 250000\n');
    expect(codexCompactLimit(home)).toBe(250_000);
    writeFileSync(join(home, "config.toml"), 'model_auto_compact_token_limit = "250000"\n');
    expect(codexCompactLimit(home)).toBeUndefined();
    writeFileSync(join(home, "config.toml"), "model_auto_compact_token_limit = [\n");
    expect(codexCompactLimit(home)).toBeUndefined();
});

test("model keys: the model served, the one asked for, and what its name says it resolves to", () => {
    expect(modelKeys({ id: "opus", name: "Opus 5.5 (claude-opus-5-5)" }, "claude-opus-5-5")).toEqual(["claude-opus-5-5", "opus"]);
    expect(modelKeys({ id: "opus", name: "Opus 5.5 (claude-opus-5-5)" })).toEqual(["opus", "claude-opus-5-5"]);
    expect(modelKeys({ id: "gpt-6" })).toEqual(["gpt-6"]);
});

test("Cavvy's own point: the threshold of the window less the answer's room; a null threshold is the default", () => {
    expect(outputReserve(200_000)).toBe(32_000);
    expect(outputReserve(200_000, 8_000)).toBe(8_000);
    expect(outputReserve(64_000, 64_000)).toBe(16_000);
    expect(cavvyCompactAt(200_000, undefined)).toBeCloseTo((200_000 - 32_000) * 0.92);
    expect(cavvyCompactAt(200_000, undefined, null)).toBeCloseTo(154_560);
    expect(cavvyCompactAt(200_000, 8_000, 0.8)).toBeCloseTo(192_000 * 0.8);
});
