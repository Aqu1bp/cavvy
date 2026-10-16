// Secrets for Claude Code and Codex sessions, through the harness MCP server.
// Their own shells send output straight to their model, so a secret never
// goes into their environment. Instead request_secret asks the user (the
// same card as RequestSecret) and run_with_secrets runs one command with
// Harness's own Bash, the secrets in its environment, after a permission
// check of its own, and returns the output redacted.

import type { ServerTool, ServerToolResult } from "../mcp/server";
import { redact } from "../util/redact";
import { cleanPurpose, requestSecret, secretNameError, type SecretAsk, type SecretStore } from "./secrets";
import { MCP_SERVER_NAME } from "./delegation";

export const MAX_COMMAND = 20_000;
const MAX_TIMEOUT_MS = 600_000;

export interface SecretToolHost {
    store: SecretStore;
    ask: SecretAsk;
    /** Checks the command (rules, mode, the user), then runs it with those secrets. */
    run(o: { command: string; names: string[]; description?: string; timeoutMs?: number }, signal: AbortSignal): Promise<ServerToolResult>;
}

export const SECRET_INSTRUCTIONS = `# Secrets (${MCP_SERVER_NAME})

When a command needs a credential the user hasn't set up (an API token, a password), don't ask for it in the chat: call request_secret with the environment variable it becomes and what it's for. The user types it into a masked field and you get its name back, never the value. Your own shell doesn't have it: run commands that need it with run_with_secrets, writing $NAME in the command. Each such command is checked like a shell command and usually needs the user's approval. Its output comes back with the value replaced by [REDACTED …]; never try to print, encode or copy the value.`;

const fail = (text: string): ServerToolResult => ({ text, isError: true });

export function secretTools(h: SecretToolHost): ServerTool[] {
    return [
        {
            name: "request_secret",
            title: "Ask the user for a secret",
            description:
                "Asks the user to type in a secret (an API token, a password) a command needs, without its value reaching you. name is the environment variable it becomes (e.g. GITHUB_TOKEN); purpose is one or two sentences on what it's for, shown to the user. You get back whether it was provided, never the value; use it with run_with_secrets. If the user declines, don't ask again unless they bring it up. Asking again for the same name replaces the value.",
            inputSchema: {
                type: "object",
                properties: {
                    name: { type: "string", description: "The environment variable it becomes: capital letters, digits and underscores (e.g. GITHUB_TOKEN)" },
                    purpose: { type: "string", description: "One or two sentences on what it's for" },
                },
                required: ["name", "purpose"],
            },
            annotations: { readOnlyHint: true, openWorldHint: false },
            async call(args, ctx) {
                const bad = secretNameError(args.name);
                if (bad) return fail(bad);
                const p = cleanPurpose(args.purpose);
                if ("error" in p) return fail(p.error);
                const r = await requestSecret({ store: h.store, ask: h.ask, name: args.name as string, purpose: redact(p.text), signal: ctx.signal, using: "run_with_secrets" });
                return { text: r.text, isError: r.isError };
            },
        },
        {
            name: "run_with_secrets",
            title: "Run a command with secrets",
            description: `Runs one shell command in the session's folder with Harness's shell, with the named secrets (from request_secret) in its environment, and returns its output with their values redacted. Write $NAME in the command, never a value. It's checked like any shell command: deny rules and plan mode refuse it, and anything no rule allows asks the user, who sees the command as written. Redaction can't catch a value that's been deliberately transformed (split, reversed, re-encoded), so don't. timeout is in milliseconds (default 120000, max ${MAX_TIMEOUT_MS}).`,
            inputSchema: {
                type: "object",
                properties: {
                    command: { type: "string", description: "The command to run, using $NAME for each secret" },
                    secrets: { type: "array", items: { type: "string" }, description: "The secrets it needs, by name" },
                    description: { type: "string", description: "Clear 5-10 word description of what the command does" },
                    timeout: { type: "number", description: "Timeout in milliseconds" },
                },
                required: ["command", "secrets"],
            },
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            async call(args, ctx) {
                const command = typeof args.command === "string" ? args.command : "";
                if (!command.trim()) return fail("command must be a non-empty string.");
                if (command.length > MAX_COMMAND) return fail(`command must be at most ${MAX_COMMAND} characters.`);
                const names = args.secrets;
                if (!Array.isArray(names) || !names.length || names.length > 16) return fail("secrets must list the secrets the command needs by name (1 to 16 of them).");
                for (const n of names) {
                    const bad = secretNameError(n);
                    if (bad) return fail(bad);
                    if (!h.store.has(n)) return fail(`This session doesn't hold ${n}. Ask the user for it with request_secret first.`);
                }
                if (args.description !== undefined && typeof args.description !== "string") return fail("description must be a string.");
                if (args.timeout !== undefined && (typeof args.timeout !== "number" || !Number.isFinite(args.timeout) || args.timeout <= 0)) return fail("timeout must be a positive number of milliseconds.");
                const timeoutMs = args.timeout === undefined ? undefined : Math.min(MAX_TIMEOUT_MS, args.timeout as number);
                const r = await h.run({ command, names: [...new Set(names as string[])], description: args.description as string | undefined, timeoutMs }, ctx.signal);
                return { text: redact(r.text), isError: r.isError };
            },
        },
    ];
}

/** The transcript's label for one of these tools (by its MCP name), or undefined. */
export function secretToolTitle(name: string, input: Record<string, unknown>): string | undefined {
    const tool = name.replace(`mcp__${MCP_SERVER_NAME}__`, "");
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    if (tool === "request_secret") return `RequestSecret(${s(input.name).slice(0, 64)})`;
    if (tool === "run_with_secrets") return `RunWithSecrets(${s(input.description) || s(input.command).split("\n")[0]!.slice(0, 80)})`;
    return undefined;
}
