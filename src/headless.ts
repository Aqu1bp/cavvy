// Non-interactive mode: `harness -p "prompt"`. Runs one prompt to completion
// and prints the result. Anything that would need an approval prompt is
// denied unless a rule, --allowedTools or the permission mode allows it.

import type { AgentEvent, TurnEndReason } from "./agent/agent";
import type { Effort } from "./config/settings";
import type { PermissionMode } from "./permissions/modes";
import { formatSkill, skillMentions, withSkills } from "./agent/skills";
import { cliRunsSkills } from "./backends/native-skills";
import { slashCommand } from "./commands/custom";
import { expandMentions } from "./ui/mentions";
import { expandMcpMentions } from "./mcp/mentions";
import { redact, redactedJson } from "./util/redact";
import { sanitizeLine } from "./ui/ansi";
import { isAgentBackend } from "./backends/types";
import { createRunAgent, endRun, setupRun, startRun, SetupError, type RunSetup } from "./run-setup";
import { messageOf, TurnTally, type SDKSystemInitMessage } from "./sdk/messages";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
    cwd: string;
    prompt: string;
    trusted: boolean;
    modelRef?: string;
    mode: PermissionMode;
    outputFormat: OutputFormat;
    verbose: boolean;
    maxTurns?: number;
    allowedTools: string[];
    disallowedTools: string[];
    appendSystemPrompt?: string;
    resumeFile?: string;
    addDirs: string[];
    startupNotes: string[];
    effort?: Effort;
    fastMode?: boolean;
    fallbackModel?: string;
}

export async function runHeadless(o: HeadlessOptions): Promise<number> {
    const started = Date.now();
    const json = (obj: unknown) => process.stdout.write(redactedJson(obj) + "\n");
    // Tool titles, errors and model text can carry terminal escapes (title
    // changes, clipboard writes); only colors and links get through to a terminal.
    const stderr = (s: string) => process.stderr.write(sanitizeLine(redact(s)) + "\n");
    const fail = (message: string): number => {
        if (o.outputFormat === "text") stderr(`error: ${message}`);
        else json({ type: "result", subtype: "error_during_execution", is_error: true, result: message, duration_ms: Date.now() - started });
        return 1;
    };

    for (const n of o.startupNotes) stderr(`warning: ${n}`);
    const warn = (m: string, level: "info" | "warn" = "warn") => stderr(level === "info" ? m : `warning: ${m}`);
    const tally = new TurnTally();

    let setup: RunSetup;
    try {
        setup = await setupRun({ ...o, warn, onUsage: (u, usd) => tally.addUsage(u, usd) });
    } catch (e) {
        if (e instanceof SetupError) return fail(e.message);
        throw e;
    }
    const { session, client, ref, model, skills, toolState, checker, mcp, settings } = setup;
    let mode = o.mode;


    // ---- output
    const map = { sessionId: session.meta.id, thinking: o.verbose, partial: false, subagents: false };
    const emit = (e: AgentEvent) => {
        tally.observe(e);
        if (o.outputFormat === "stream-json") {
            const m = messageOf(e, map);
            if (m) json(m);
            return;
        }
        switch (e.type) {
            case "tool_start":
                if (o.outputFormat === "text" && o.verbose) stderr(`⏺ ${e.title}`);
                break;
            case "tool_end":
                if (o.verbose) stderr(`  ⎿  ${e.result.isError ? "error: " : ""}${e.result.display?.summary ?? e.result.content.split("\n")[0]?.slice(0, 200) ?? ""}`);
                break;
            case "notice":
                if (e.level !== "info" || o.verbose) stderr(`${e.level}: ${e.message}`);
                break;
            case "retry":
                // Always: otherwise a provider that's down looks like a hang for minutes.
                stderr(`retrying in ${Math.ceil(e.delayMs / 1000)}s (attempt ${e.attempt}): ${e.reason}`);
                break;
            case "subagent":
                if (o.verbose && o.outputFormat === "text" && e.event.type === "tool_start") stderr(`  ↳ ${e.label}: ${e.event.title}`);
                break;
        }
    };

    const agent = createRunAgent(setup, {
        mode: { get: () => mode, set: (m) => (mode = m) },
        maxTurns: o.maxTurns,
        appendSystemPrompt: o.appendSystemPrompt,
        host: {
            emit,
            ui: {
                askQuestion: async () => undefined,
                approvePlan: async () => ({ approved: false, feedback: "This is a non-interactive run, so the plan can't be approved here. Give the complete plan as your final answer." }),
            },
        },
    });

    if (o.outputFormat === "stream-json") {
        const init: SDKSystemInitMessage = {
            type: "system",
            subtype: "init",
            session_id: session.meta.id,
            cwd: o.cwd,
            model: ref,
            permission_mode: mode,
            // An agent backend (Claude Code, Codex) uses its own tools.
            tools: isAgentBackend(client) ? [] : setup.tools().map((t) => t.name),
            ...(isAgentBackend(client) ? { agent_backend: setup.provider.name } : {}),
            mcp_servers: [...mcp.servers.values()].map((s) => ({ name: s.name, status: s.status })),
        };
        json(init);
    }

    const sessionStarted = startRun(setup, warn);
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    let reason: string;
    try {
        // What SessionStart hooks add goes with this one prompt, so it waits for them.
        if (settings.hooks?.SessionStart?.length) await sessionStarted;
        // `-p "/name args"` runs a skill, and $name brings one along, as in the TUI; a skill's own text has no @mentions to attach.
        const slash = slashCommand(o.prompt);
        // Claude Code and Codex are sent the prompt as it is, and run the skills it names themselves.
        const native = cliRunsSkills(model.provider);
        const invoked = slash && !native ? skills.find((s) => s.userInvocable && s.name === slash.name) : undefined;
        const body = invoked ? formatSkill(invoked, slash!.args) : undefined;
        const mentioned = invoked || native ? [] : skillMentions(o.prompt, skills);
        const scan = body !== undefined ? slash!.args : o.prompt;
        const { parts, notices } = await expandMentions(scan, toolState, [o.cwd, ...(settings.permissions?.additionalDirectories ?? [])], checker);
        parts[0] = { type: "text", text: body ?? withSkills(o.prompt, mentioned) };
        // Nobody to answer a server's form here: those are declined.
        const res = await expandMcpMentions(scan, mcp, {}, ac.signal);
        parts.push(...res.parts);
        for (const n of [...notices, ...res.notices]) stderr(`warning: ${n}`);
        reason = await agent.run(parts, { signal: ac.signal, display: o.prompt });
    } catch (e) {
        reason = "error";
        stderr(`error: ${(e as Error).message}`);
    } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
        await endRun(setup, agent, sessionStarted, warn);
    }

    const result = tally.result(reason as TurnEndReason, session.meta.id, ref);
    if (o.outputFormat === "text") {
        if (tally.lastText) process.stdout.write((process.stdout.isTTY ? sanitizeLine(redact(tally.lastText)) : redact(tally.lastText)) + "\n");
        if (result.is_error) stderr(`(stopped: ${reason})`);
        if (tally.denials.length && !o.verbose) stderr(`note: ${tally.denials.length} tool call(s) were denied because they need approval. Use --allowedTools, --permission-mode, or permission rules.`);
    } else json(result);
    return result.is_error ? 1 : 0;
}
