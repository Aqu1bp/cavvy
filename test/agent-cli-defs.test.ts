// The agent CLI defs (src/backends/defs.ts) say what today's branches on the
// provider's id do, until those read the defs (#219 PR 6).

import { expect, test } from "bun:test";
import { CLAUDE_CLI, CODEX_CLI } from "../src/backends/cli";
import { AGENT_CLIS, agentCli } from "../src/backends/defs";
import { vendorOf } from "../src/backends/index";
import { ACCOUNT_PROVIDERS } from "../src/providers/accounts";
import { BUILTIN_PROVIDERS } from "../src/providers/registry";
import { agentProjectConfig } from "../src/config/trust";
import { nativeModel } from "../src/agent/delegation";
import { providerReadsPdf } from "../src/providers/files";
import { loadsPluginsNatively } from "../src/plugins/native";

test("CLAUDE_CLI and CODEX_CLI are the defs' CLI info", () => {
    expect(CLAUDE_CLI).toMatchObject({ command: "claude", product: "Claude Code", install: "Install Claude Code (https://code.claude.com/docs/en/setup)", signIn: "claude auth login" });
    expect(CODEX_CLI).toMatchObject({ command: "codex", product: "Codex", install: "Install the Codex CLI (npm install -g @openai/codex)", signIn: "codex login" });
    expect(vendorOf("claude-code")).toBe("Anthropic");
    expect(vendorOf("codex")).toBe("OpenAI");
});

test("every def is an agent provider; those with accounts are the account providers", () => {
    expect(AGENT_CLIS.filter((d) => d.account).map((d) => d.id)).toEqual([...ACCOUNT_PROVIDERS]);
    expect(AGENT_CLIS.map((d) => d.id)).toEqual(["claude-code", "codex", "opencode", "grok"]);
    for (const d of AGENT_CLIS) {
        const p = BUILTIN_PROVIDERS.find((p) => p.id === d.id);
        expect(p).toMatchObject({ kind: "agent", auth: "cli", name: d.name });
    }
    // An ACP agent says how it's started, and what it can't do here.
    for (const d of AGENT_CLIS.filter((d) => d.protocol === "acp")) {
        expect(d.acpArgs?.length).toBeGreaterThan(0);
        // Steering with text everywhere; images only where a steer is a prompt of its own (OpenCode's).
        expect(d.caps.steersAttachments).toEqual(d.id === "opencode" ? ["image", "text"] : ["text"]);
        expect(d.caps).toMatchObject({ steering: "between-tool-rounds", backgroundTasks: false, fork: false, compact: "none", planLimits: "none", hooks: "none", mcpAttach: "none", skills: "paste", importSessions: false, usageLogs: false });
    }
});

test("the defs' capabilities agree with the branches they will replace", () => {
    for (const d of AGENT_CLIS) {
        expect(d.caps.pdfs).toBe(providerReadsPdf({ id: d.id, kind: "agent" }));
        expect(d.caps.loadsPlugins).toBe(loadsPluginsNatively(d.id));
    }
});

test("project config and delegation agree with trust.ts and delegation.ts", () => {
    const all = (p: string) => p.includes(".claude") || p.includes(".codex");
    const settingsOnly = (p: string) => p.endsWith("settings.json");
    expect(agentProjectConfig("/p", "opencode", () => true)).toEqual(["opencode.json", "opencode.jsonc", ".opencode/"]);
    expect(agentProjectConfig("/p", "nope", () => true)).toEqual([]);
    // Grok's own project settings are behind its own folder trust: Cavvy's doesn't change what it loads.
    expect(agentProjectConfig("/p", "grok", () => true)).toEqual([]);
    for (const id of ["claude-code", "codex"] as const) {
        const def = agentCli(id)!;
        for (const has of [all, settingsOnly, () => false]) expect(def.projectConfig!("/p", has)).toEqual(agentProjectConfig("/p", id, has));
        const n = def.delegation!;
        for (const provider of n.providers) expect(nativeModel(id, { provider, id: "x" })).toBe(true);
        expect(nativeModel(id, { provider: "openrouter", id: `${n.vendorPrefix}x` })).toBe(true);
        expect(nativeModel(id, { provider: "gemini", id: "x" })).toBe(false);
    }
});
