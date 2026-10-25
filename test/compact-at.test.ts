import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCompactWindow, codexCompactLimit, harnessCompactAt, modelKeys, outputReserve } from "../src/backends/compact-at";

const dir = () => mkdtempSync(join(tmpdir(), "compact-at-"));

test("Claude Code: the model's autoCompactWindow, the project's settings over the account's", () => {
    const config = dir(), project = dir();
    expect(claudeCompactWindow(config, project, ["claude-opus-5-5"])).toBeUndefined();
    writeFileSync(join(config, "settings.json"), JSON.stringify({ theme: "dark", modelSettings: { "claude-opus-5-5": { autoCompactWindow: 500_000 }, "claude-sonnet-5-5": { autoCompactWindow: "big" } } }));
    expect(claudeCompactWindow(config, project, ["claude-opus-5-5"])).toBe(500_000);
    // Under another id of the same model (the alias asked for, then what it resolved to).
    expect(claudeCompactWindow(config, project, ["opus", "claude-opus-5-5"])).toBe(500_000);
    expect(claudeCompactWindow(config, project, ["claude-sonnet-5-5"])).toBeUndefined();
    mkdirSync(join(project, ".claude"));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ modelSettings: { "claude-opus-5-5": { autoCompactWindow: 300_000 } } }));
    expect(claudeCompactWindow(config, project, ["claude-opus-5-5"])).toBe(300_000);
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
    expect(claudeCompactWindow(config, project, ["claude-opus-5-5"])).toBe(300_000);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ modelSettings: { "claude-opus-5-5": { autoCompactWindow: 250_000 } } }));
    expect(claudeCompactWindow(config, project, ["claude-opus-5-5"])).toBe(250_000);
});

test("Codex: model_auto_compact_token_limit at the top of config.toml, not inside a table", () => {
    const home = dir();
    expect(codexCompactLimit(home)).toBeUndefined();
    writeFileSync(join(home, "config.toml"), 'model = "gpt-6"\nmodel_auto_compact_token_limit = 250_000 # tokens\n\n[profiles.fast]\nmodel_auto_compact_token_limit = 9\n');
    expect(codexCompactLimit(home)).toBe(250_000);
    writeFileSync(join(home, "config.toml"), '[profiles.fast]\nmodel_auto_compact_token_limit = 9\n');
    expect(codexCompactLimit(home)).toBeUndefined();
});

test("model keys: the model served, the one asked for, and what its name says it resolves to", () => {
    expect(modelKeys({ id: "opus", name: "Opus 5.5 (claude-opus-5-5)" }, "claude-opus-5-5")).toEqual(["claude-opus-5-5", "opus"]);
    expect(modelKeys({ id: "opus", name: "Opus 5.5 (claude-opus-5-5)" })).toEqual(["opus", "claude-opus-5-5"]);
    expect(modelKeys({ id: "gpt-6" })).toEqual(["gpt-6"]);
});

test("Harness's own point: the threshold of the window less the answer's room", () => {
    expect(outputReserve(200_000)).toBe(32_000);
    expect(outputReserve(200_000, 8_000)).toBe(8_000);
    expect(outputReserve(64_000, 64_000)).toBe(16_000);
    expect(harnessCompactAt(200_000, undefined)).toBeCloseTo((200_000 - 32_000) * 0.92);
    expect(harnessCompactAt(200_000, 8_000, 0.8)).toBeCloseTo(192_000 * 0.8);
});
