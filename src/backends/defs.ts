// The agent CLIs, declared: what each is called, how it's installed and signed
// in, where its accounts live and what it can do. The API providers' counterpart
// is BUILTIN_PROVIDERS (src/providers/registry.ts); each id here is also a
// ProviderDef of kind "agent". The live layer (src/backends/live) runs the
// protocol a def names; everything else reads the def instead of branching on
// the provider's id. Most of those branches still do (#219 PR 6 moves them
// here): the values below are what they do today, and test/agent-cli-defs
// checks the ones that would drift.

import { join } from "path";
import type { CliInfo } from "./cli";

/** What's attached to a message, by how a backend takes it: images, text files (sent as text) and PDFs. */
export type AttachmentKind = "image" | "text" | "pdf";

/** What an agent CLI can do, for the harness to read instead of its id. Static defaults; a connection may refine them after its handshake. */
export interface CliCapabilities {
    /** How a message sent mid-turn reaches it: folded in between tool rounds (Claude Code's stdin), at once (Codex's turn/steer), or not at all. */
    steering: "between-tool-rounds" | "immediate" | "none";
    /**
     * What a message steering a running turn can carry, by kind, sent as a prompt carries them. One carrying
     * any other kind waits for its own turn, whole (not split).
     */
    steersAttachments: readonly AttachmentKind[];
    /** It runs work that outlives a turn (background shells, sub-agents, monitors). */
    backgroundTasks: boolean;
    /** One background task can be stopped on its own. */
    stopTask: boolean;
    /** A running foreground sub-agent can be moved to the background. */
    moveToBackground: boolean;
    /** Who starts the turn that reports finished background work: the CLI itself, the harness, or nobody. */
    wakes: "native" | "host" | "none";
    /** What changes on a running process without a restart: the model, the effort, and the permission mode (by a control request, with each turn, or not at all). */
    live: { model: boolean; effort: boolean; mode: "control" | "per-turn" | "restart" };
    fork: boolean;
    /** It can rewind its own session to an earlier message. */
    rewind: boolean;
    compact: "native" | "none";
    /** It keeps goals of its own (/goal): whether one can be paused, and whether it starts turns for one by itself. */
    goal?: { canPause: boolean; ownTurns: boolean };
    /** How its plan limits are known: pushed as they change, by asking, only inside a turn, or not at all. */
    planLimits: "push" | "status-call" | "in-turn" | "none";
    /** How the harness's hooks run: the CLI calls back for each (hook_callback), calls a harness MCP tool, or the harness runs them itself. */
    hooks: "callback" | "mcp-hook-server" | "none";
    /** How the harness's MCP server is attached: a control request on the running process, the thread's config, or not at all. */
    mcpAttach: "control" | "thread-config" | "none";
    /** MCP server instructions reach the model through its system prompt (otherwise the harness passes them as developer instructions). */
    mcpInstructionsInSystemPrompt: boolean;
    /** It has a Monitor tool of its own (otherwise it gets the harness's). */
    ownMonitor: boolean;
    /** The harness's agents run on its own Agent tool. */
    nativeAgents: boolean;
    /** It loads the harness's plugins itself (--plugin-dir). */
    loadsPlugins: boolean;
    /** How it gets the harness's skills: as a plugin, as an extra skills root, or pasted into the prompt. */
    skills: "plugin" | "skills-root" | "paste";
    /** The commands it lists are its skills (for the $ menu too). */
    cliCommandsAreSkills: boolean;
    pdfs: boolean;
    images: boolean;
    /** It has a reviewer of its own for auto mode, so a read-only agent keeps auto. */
    autoReviewer: boolean;
    /** It resolves a /command the harness doesn't know (its own skills and built-ins). */
    resolvesUnknownCommands: boolean;
    /** Its saved sessions can be imported (src/server/cli-sessions.ts). */
    importSessions: boolean;
    /** Its usage logs are read for /usage (src/server/usage-reader.ts). */
    usageLogs: boolean;
}

export interface AgentCliDef {
    /** Also its ProviderDef's id. */
    id: string;
    name: string;
    /** Whose sign-in it is, for messages ("Anthropic's own sign-in"). */
    vendor: string;
    /** What it bills to, in the provider list. */
    planLabel: string;
    cli: CliInfo & { signOut: string };
    /** The protocol its live sessions speak (src/backends/live). */
    protocol: "claude-stream-json" | "codex-app-server" | "acp";
    /** The arguments that start an ACP CLI in ACP mode. */
    acpArgs?: string[];
    /** Separate accounts, each a config folder of its own. Left out: only the CLI's default sign-in. */
    account?: {
        /** The environment variable that selects the folder. */
        configDirEnv: string;
        /** The folder when that isn't set, ~ for home. */
        defaultFolder: string;
        /** Sign-in files in a folder: denied to tools, never read by the harness. */
        credentialFiles: string[];
        /** Its sign-in is in the keychain, under a service named after the folder: each account needs its own. */
        keychain?: "claude";
        /** What the accounts help says about isolation. */
        notes?: string[];
    };
    /** The project's own configuration for it, which it loads only in a trusted folder (src/config/trust.ts). */
    projectConfig?: (cwd: string, has: (path: string) => boolean) => string[];
    /** Its models to prefer, best first (src/providers/models.ts PREFERRED). */
    preferredModels?: RegExp[];
    /** What it runs with its own sub-agents, so those providers' models aren't offered to it (src/agent/delegation.ts). */
    delegation?: { providers: string[]; vendorPrefix: string; models: string; own: string };
    caps: CliCapabilities;
}

const CLAUDE_CODE: AgentCliDef = {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    planLabel: "Claude subscription",
    cli: {
        command: "claude",
        product: "Claude Code",
        install: "Install Claude Code (https://code.claude.com/docs/en/setup)",
        signIn: "claude auth login",
        signOut: "claude auth logout",
    },
    protocol: "claude-stream-json",
    account: {
        configDirEnv: "CLAUDE_CONFIG_DIR",
        defaultFolder: "~/.claude",
        credentialFiles: [".credentials.json"],
        keychain: "claude",
        notes: ["Claude Console sign-in without an API key is stored outside this folder and is not isolated per account."],
    },
    projectConfig: (cwd, has) => [
        ...["settings.json", "settings.local.json"].filter((f) => has(join(cwd, ".claude", f))).map((f) => `.claude/${f}`),
        ...["skills", "agents", "commands"].filter((d) => has(join(cwd, ".claude", d))).map((d) => `.claude/${d}/`),
    ],
    preferredModels: [/^default$/, /^opus$/],
    delegation: { providers: ["claude-code", "anthropic"], vendorPrefix: "anthropic/", models: "Claude models", own: "your own Agent tool" },
    caps: {
        steering: "between-tool-rounds",
        // A mid-turn stream-json user message's image blocks reach the model; its document blocks (PDFs) are dropped
        // without a word (2.1.304: test/fixtures/protocol/claude-2.1.304-steer-*.jsonl). Text files go as text.
        steersAttachments: ["image", "text"],
        backgroundTasks: true,
        stopTask: true,
        // background_tasks {tool_use_id} exists in 2.1.304; nothing sends it yet.
        moveToBackground: false,
        wakes: "native",
        // set_permission_mode today; set_model and apply_flag_settings once probed (#219 PR 0).
        live: { model: false, effort: false, mode: "control" },
        fork: true,
        rewind: false,
        compact: "native",
        goal: { canPause: false, ownTurns: false },
        planLimits: "in-turn",
        hooks: "callback",
        mcpAttach: "control",
        mcpInstructionsInSystemPrompt: true,
        ownMonitor: true,
        nativeAgents: true,
        loadsPlugins: true,
        skills: "plugin",
        cliCommandsAreSkills: false,
        pdfs: true,
        images: true,
        autoReviewer: false,
        resolvesUnknownCommands: true,
        importSessions: true,
        usageLogs: true,
    },
};

const CODEX: AgentCliDef = {
    id: "codex",
    name: "Codex",
    vendor: "OpenAI",
    planLabel: "ChatGPT plan",
    cli: {
        command: "codex",
        product: "Codex",
        install: "Install the Codex CLI (npm install -g @openai/codex)",
        signIn: "codex login",
        signOut: "codex logout",
    },
    protocol: "codex-app-server",
    account: {
        configDirEnv: "CODEX_HOME",
        defaultFolder: "~/.codex",
        credentialFiles: ["auth.json"],
        notes: ["A new Codex home does not inherit your settings or MCP servers."],
    },
    projectConfig: (cwd, has) => (has(join(cwd, ".codex")) ? [".codex/"] : []),
    delegation: { providers: ["codex", "openai"], vendorPrefix: "openai/", models: "OpenAI models", own: "your own sub-agents" },
    caps: {
        steering: "immediate",
        // turn/steer takes the same UserInput items as turn/start, images included (0.163: generate-ts, and
        // test/fixtures/protocol/codex-0.163-steer-image.jsonl). It has no document item: a PDF is a note in the
        // text, as in turn/start (and one is refused when it's sent: the model can't read it).
        steersAttachments: ["image", "text", "pdf"],
        backgroundTasks: true,
        // thread/backgroundTerminals/terminate (with experimentalApi), and turn/interrupt on a sub-agent's thread (codex-live.ts).
        stopTask: true,
        moveToBackground: false,
        // Codex starts goal turns itself; for a background command that finished after its turn, the harness starts
        // one (codex.wakeOnBackgroundCommand): Codex reports only the item's end (#219 §2).
        wakes: "host",
        // turn/start carries the model, effort, approval policy and sandbox.
        live: { model: true, effort: true, mode: "per-turn" },
        fork: true,
        rewind: false,
        compact: "native",
        goal: { canPause: true, ownTurns: true },
        // account/rateLimits/updated; account/rateLimits/read answers too.
        planLimits: "push",
        hooks: "mcp-hook-server",
        mcpAttach: "thread-config",
        mcpInstructionsInSystemPrompt: false,
        ownMonitor: false,
        nativeAgents: false,
        loadsPlugins: false,
        skills: "skills-root",
        cliCommandsAreSkills: true,
        pdfs: false,
        images: true,
        autoReviewer: true,
        resolvesUnknownCommands: false,
        importSessions: true,
        usageLogs: true,
    },
};

export const AGENT_CLIS: readonly AgentCliDef[] = [CLAUDE_CODE, CODEX];

export function agentCli(id: string): AgentCliDef | undefined {
    return AGENT_CLIS.find((d) => d.id === id);
}
