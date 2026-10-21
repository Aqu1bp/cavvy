// The engine behind query(): a run like `harness -p` (run-setup.ts), kept open
// for more prompts, with permission prompts going to canUseTool. Loaded on a
// query's first use, so importing the SDK stays cheap.

import { dirname, resolve } from "path";
import { existsSync, statSync } from "fs";
import type { Agent, AgentEvent, PermissionRequest, PermissionResponse, TurnEndReason } from "../agent/agent";
import { findSession, listSessions } from "../agent/session";
import { loadHarnessEnv, preloadKeys } from "../auth/credentials";
import { harnessHome } from "../config/paths";
import { isTrusted, projectConfigSummary, trustUntilExit } from "../config/trust";
import { PERMISSION_MODES, startMode, type PermissionMode } from "../permissions/modes";
import { BUILTIN_TOOLS } from "../tools/index";
import type { Tool } from "../tools/types";
import { isAgentBackend } from "../backends/types";
import { expandMentions } from "../ui/mentions";
import { createRunAgent, endRun, setupRun, startRun, SetupError, type RunSetup } from "../run-setup";
import { messageOf, TurnTally, type MapOptions, type SDKMessage } from "./messages";
import { HarnessSdkError } from "./errors";
import type { SdkTool } from "./tool";
import type { CanUseTool, Options, QueryParams, SDKUserMessage } from "./types";

export interface Sink {
    push(m: SDKMessage): void;
    /** The query is over: with a failure, the iterator throws its error (whatever was thrown, null included). */
    end(failure?: { error: unknown }): void;
}

export interface RunControl {
    interrupt(): void;
    /** Into the running turn, or the next turn when none is running. False once the query is over. */
    steer(text: string): boolean;
    setPermissionMode(mode: PermissionMode): void;
    /** Stop everything and clean up; resolves once that's done. */
    close(): Promise<void>;
    readonly sessionId: Promise<string>;
}

/** Session files open in a query of this process: a second one would write over the first. */
const openSessions = new Set<string>();

/** The .env notes have been reported (by the first query). */
let noted = false;

let envLoaded: Promise<{ legacyModel?: string; notes: string[] }> | undefined;

/** The harness's own .env files and stored keys, once a process, as the CLI loads them: the legacy .env model, and notes about them for the first query. */
function loadEnv(): Promise<{ legacyModel?: string; notes: string[] }> {
    return (envLoaded ??= (async () => {
        const installDir = resolve(dirname(import.meta.dir), "..");
        const env = loadHarnessEnv([resolve(harnessHome(), ".env"), resolve(installDir, ".env")]);
        await preloadKeys();
        return env;
    })());
}

/** Tools the run adds besides the built-ins, in any folder (the Skill tool, when it has skills). */
const RESERVED_TOOLS = ["Skill"];

function checkOptions(o: Options): void {
    const fail = (m: string): never => {
        throw new HarnessSdkError(m);
    };
    if (o.cwd !== undefined && (typeof o.cwd !== "string" || !existsSync(o.cwd) || !statSync(o.cwd).isDirectory())) fail(`cwd "${o.cwd}" is not a folder.`);
    if (o.permissionMode !== undefined && !PERMISSION_MODES.includes(o.permissionMode)) fail(`Unknown permissionMode "${o.permissionMode}". Use one of: ${PERMISSION_MODES.join(", ")}.`);
    if (o.maxTurns !== undefined && !(Number.isInteger(o.maxTurns) && o.maxTurns > 0)) fail("maxTurns must be a positive whole number.");
    if (o.canUseTool !== undefined && typeof o.canUseTool !== "function") fail("canUseTool must be a function.");
    const names = new Set<string>();
    for (const t of o.tools ?? []) {
        if ((t as SdkTool)?.kind !== "sdk-tool") fail("tools: make each tool with tool().");
        if (BUILTIN_TOOLS.some((b) => b.name === t.name) || RESERVED_TOOLS.includes(t.name)) fail(`tools: "${t.name}" is the name of a built-in tool. Pick another name.`);
        if (names.has(t.name)) fail(`tools: two tools are named "${t.name}".`);
        names.add(t.name);
    }
}

/** A tool() as the agent's Tool. */
function toAgentTool(t: SdkTool): Tool<any> {
    const readOnly = Boolean(t.options.readOnly);
    return {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
        // Allowed without a prompt (deny and ask rules still apply).
        category: "meta",
        readOnly,
        title: (input) => {
            try {
                return t.options.title?.(input) ?? t.name;
            } catch {
                return t.name;
            }
        },
        validate: (_input, ctx) => (!readOnly && ctx.mode() === "plan" ? `Plan mode is active: ${t.name} isn't marked read-only, so it can't run until the plan is approved.` : undefined),
        run: async (input, ctx) => {
            try {
                const r = await t.handler(input, { signal: ctx.signal, cwd: ctx.state.cwd });
                if (typeof r === "string") return { content: r };
                if (r && typeof r === "object" && typeof r.content === "string") return { content: r.content, isError: Boolean(r.isError) };
                return { content: `${t.name} returned ${r === undefined ? "nothing" : "a value that isn't a string or { content }"}.`, isError: true };
            } catch (e) {
                return { content: `${t.name} failed: ${(e as Error)?.message ?? String(e)}`, isError: true };
            }
        },
    };
}

function textOfInput(m: SDKUserMessage): string {
    if (typeof m === "string") return m;
    if (m && typeof m === "object" && m.type === "user" && typeof m.content === "string") return m.content;
    throw new HarnessSdkError('A prompt message must be a string or { type: "user", content: string }.');
}

/** One query. Its methods are safe to call at any point, including after it ended. */
export function startQuery(params: QueryParams, sink: Sink): RunControl {
    const o: Options = params.options ?? {};
    const closed = new AbortController();
    let turn: AbortController | undefined;
    let pendingMode: PermissionMode | undefined;
    /** Turns can still start: false once the last one ended (or the query is closing). */
    let accepting = true;
    /** Prompts not started yet, in order: each one is a turn. */
    const pending: string[] = [];
    /** Messages for the running turn (steer()), taken between its steps. */
    const steering: string[] = [];
    let wake: (() => void) | undefined;
    const poke = () => {
        const w = wake;
        wake = undefined;
        w?.();
    };
    let setMode: ((m: PermissionMode) => void) | undefined;
    /** The run's agent, once it has one. */
    let agentRef: Agent | undefined;
    let resolveId!: (id: string) => void;
    let rejectId!: (e: unknown) => void;
    const sessionId = new Promise<string>((res, rej) => ((resolveId = res), (rejectId = rej)));
    sessionId.catch(() => {});

    const userAbort = o.abortController?.signal;
    const onUserAbort = () => closed.abort();
    if (userAbort?.aborted) closed.abort();
    else userAbort?.addEventListener("abort", onUserAbort, { once: true });
    closed.signal.addEventListener("abort", () => turn?.abort(), { once: true });

    // ---- input: a string is one turn; an iterable is read from the start, alongside the turns.
    let inputDone = false;
    /** The input iterable threw: what it threw, kept as is (a falsy value too). */
    let inputFailure: { error: unknown } | undefined;
    let reading = false;
    function readInput() {
        if (reading) return;
        reading = true;
        if (typeof params.prompt === "string") {
            pending.unshift(params.prompt);
            inputDone = true;
            return;
        }
        const it = params.prompt[Symbol.asyncIterator]();
        // Closing doesn't wait for a message that may never come.
        const stop = () => void Promise.resolve()
            .then(() => it.return?.())
            .catch(() => {});
        closed.signal.addEventListener("abort", stop, { once: true });
        void (async () => {
            try {
                while (!closed.signal.aborted) {
                    const r = await it.next();
                    if (r.done || closed.signal.aborted) break;
                    pending.push(textOfInput(r.value));
                    poke();
                }
            } catch (e) {
                if (!closed.signal.aborted) {
                    inputFailure = { error: e };
                    closed.abort();
                }
            } finally {
                inputDone = true;
                closed.signal.removeEventListener("abort", stop);
                poke();
            }
        })();
    }
    closed.signal.addEventListener("abort", poke, { once: true });

    const done = run().then(
        () => ((accepting = false), sink.end()),
        (e) => ((accepting = false), sink.end({ error: e })),
    );

    async function run(): Promise<void> {
        let setup: RunSetup | undefined;
        let agent: Agent | undefined;
        let started: Promise<unknown> | undefined;
        let held: string[] | undefined;
        let tally: TurnTally | undefined;
        // Warnings from before the init message wait for it: init comes first.
        let early: { message: string; level: "info" | "warn" }[] | undefined = [];
        // Hooks also tell (level info) what they did.
        const warn = (message: string, level: "info" | "warn" = "warn") => (early ? early.push({ message, level }) : sink.push({ type: "system", subtype: "notice", level, message }));
        try {
            checkOptions(o);
            const cwd = resolve(o.cwd ?? process.cwd());
            readInput();
            const env = await loadEnv();
            if (!noted) for (const n of env.notes) warn(n);
            noted = true;

            // Trust, as `harness -p`, but a folder trusted for having nothing to protect is trusted for
            // this query only: one that has project configuration by the next query is judged again.
            let trusted = o.trusted;
            // Said by the caller, as the user saying yes to the trust prompt: agent CLIs get the project's configuration too.
            if (trusted) trustUntilExit(cwd);
            else if (trusted === undefined) {
                const found = projectConfigSummary(cwd);
                trusted = isTrusted(cwd) || !found.length;
                if (!trusted) warn(`This folder isn't trusted, so ${found.join(", ")} and its memory files are ignored (except deny/ask rules). Pass trusted: true, or run harness there once to trust it.`);
            }

            let resumeFile: string | undefined;
            if (o.resume !== undefined) {
                resumeFile = findSession(cwd, o.resume);
                if (!resumeFile) throw new HarnessSdkError(`No session matching "${o.resume}" in ${cwd}.`);
            } else if (o.continue) resumeFile = listSessions(cwd, 1)[0]?.file;
            if (resumeFile && openSessions.has(resumeFile)) throw new HarnessSdkError(`Session ${o.resume ?? resumeFile} is open in another query in this process. Close that one first.`);
            if (closed.signal.aborted) {
                if (inputFailure) throw inputFailure.error;
                return;
            }

            try {
                setup = await setupRun({
                    cwd,
                    trusted,
                    modelRef: o.model,
                    fallbackModel: env.legacyModel,
                    resumeFile,
                    allowedTools: o.allowedTools ?? [],
                    disallowedTools: o.disallowedTools ?? [],
                    addDirs: o.additionalDirectories ?? [],
                    effort: o.effort,
                    fastMode: o.fastMode,
                    settings: o.settings,
                    persist: o.persistSession ?? true,
                    warn,
                    onUsage: (u, usd) => tally?.addUsage(u, usd),
                });
            } catch (e) {
                throw e instanceof SetupError ? new HarnessSdkError(e.message.replace("pass --model provider:model", 'set the model option ("provider:model")')) : e;
            }
            const s = setup;
            // An unsaved copy holds its original too: the copy forks the original's agent backend sessions.
            const files = [s.session.path, ...(s.original ? [s.original.path] : [])];
            if (files.some((f) => openSessions.has(f))) throw new HarnessSdkError(`Session ${s.original?.meta.id ?? s.session.meta.id} is open in another query in this process. Close that one first.`);
            held = files;
            for (const f of files) openSessions.add(f);
            resolveId(s.session.meta.id);

            // ---- permission mode: options > settings (bypass from settings only from the user's own, or from options.settings)
            const start = startMode(pendingMode ?? o.permissionMode, s.settings, cwd, o.settings?.permissions?.defaultMode === "bypassPermissions");
            let mode = start.mode;
            if (start.ignoredBypass) warn("Ignored defaultMode bypassPermissions from project settings; only your user settings or the permissionMode option can enable it.");
            setMode = (m) => {
                const from = mode;
                mode = m;
                // As the terminal does: a backend's running turn takes it, and the model hears of it.
                agent?.noteModeChange(from, m);
            };

            const custom = (o.tools ?? []).map(toAgentTool);
            const backend = isAgentBackend(s.client);
            if (custom.length && backend) warn(`${s.provider.name} runs its own tools, so the SDK tools (${custom.map((t) => t.name).join(", ")}) aren't offered to it.`);
            const tools = () => [...s.tools(), ...custom];

            const map: MapOptions = { sessionId: s.session.meta.id, thinking: true, partial: Boolean(o.includePartialMessages), subagents: true };
            const emit = (e: AgentEvent) => {
                tally?.observe(e);
                const m = messageOf(e, map);
                if (m) sink.push(m);
            };
            const ask = o.canUseTool;
            agent = createRunAgent(s, {
                mode: { get: () => mode, set: (m) => (mode = m) },
                tools,
                maxTurns: o.maxTurns,
                appendSystemPrompt: o.appendSystemPrompt,
                host: {
                    emit,
                    askPermission: ask ? (req) => askVia(ask, req, turn?.signal ?? closed.signal, emit, (name) => tally?.denials.push(name)) : undefined,
                    ui: {
                        askQuestion: async () => undefined,
                        approvePlan: async () => ({ approved: false, feedback: "This run can't approve plans. Give the complete plan as your final answer." }),
                    },
                    drainQueued: () => steering.splice(0),
                },
            });

            agentRef = agent;
            sink.push({
                type: "system",
                subtype: "init",
                session_id: s.session.meta.id,
                cwd,
                model: s.ref,
                permission_mode: mode,
                tools: backend ? [] : tools().map((t) => t.name),
                ...(backend ? { agent_backend: s.provider.name } : {}),
                mcp_servers: [...s.mcp.servers.values()].map((m) => ({ name: m.name, status: m.status })),
            });
            const notes = early;
            early = undefined;
            for (const n of notes) warn(n.message, n.level);
            started = startRun(s, warn);

            while (!closed.signal.aborted) {
                if (!pending.length) {
                    if (inputDone) break;
                    await new Promise<void>((r) => (wake = r));
                    continue;
                }
                const prompt = pending.shift()!;
                turn = new AbortController();
                tally = new TurnTally();
                let reason: TurnEndReason;
                try {
                    const { parts, notices } = await expandMentions(prompt, s.toolState, [cwd, ...(s.settings.permissions?.additionalDirectories ?? [])], s.checker);
                    for (const n of notices) warn(n);
                    reason = await agent.run(parts, { signal: turn.signal, display: prompt });
                } catch (e) {
                    reason = turn.signal.aborted ? "aborted" : "error";
                    if (reason === "error") tally.errors.push((e as Error)?.message ?? String(e));
                }
                // A turn stopped because the input failed has no result: the query throws that failure instead.
                if (!inputFailure) sink.push(tally.result(reason, s.session.meta.id, s.ref));
                tally = undefined;
                turn = undefined;
                // Sent too late for the turn to take: the next turn.
                pending.unshift(...steering.splice(0));
            }
            accepting = false;
            if (inputFailure) throw inputFailure.error;
        } catch (e) {
            // What was said before it failed (an MCP server that didn't start, say) still helps.
            for (const n of early ?? []) sink.push({ type: "system", subtype: "notice", level: n.level, message: n.message });
            early = undefined;
            rejectId(e);
            throw e;
        } finally {
            // The input stops with the query (its generator's finally runs once it next yields or returns).
            closed.abort();
            userAbort?.removeEventListener("abort", onUserAbort);
            if (setup) {
                await endRun(setup, agent, started, warn).catch(() => {});
                setup.session.release();
            }
            for (const f of held ?? []) openSessions.delete(f);
            rejectId(new HarnessSdkError("The query ended before its session started."));
        }
    }

    return {
        interrupt: () => turn?.abort(),
        steer: (text) => {
            if (!accepting || closed.signal.aborted) return false;
            if (turn) {
                steering.push(text);
                // A backend that can (Codex) takes it into the running turn now.
                agentRef?.queueChanged();
            }
            else {
                pending.push(text);
                poke();
            }
            return true;
        },
        setPermissionMode: (m) => {
            if (!PERMISSION_MODES.includes(m)) throw new HarnessSdkError(`Unknown permission mode "${m}".`);
            if (setMode) setMode(m);
            else pendingMode = m;
        },
        close: async () => {
            closed.abort();
            await done;
        },
        sessionId,
    };
}

/** A permission prompt, answered by canUseTool. Gives up (denies) when the turn ends first. */
async function askVia(ask: CanUseTool, req: PermissionRequest, turnSignal: AbortSignal, emit: (e: AgentEvent) => void, denied: (tool: string) => void): Promise<PermissionResponse> {
    const signal = req.signal ? AbortSignal.any([req.signal, turnSignal]) : turnSignal;
    if (signal.aborted) return { allow: false };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<undefined>((r) => {
        onAbort = () => r(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        const answer = await Promise.race([
            Promise.resolve().then(() =>
                ask(req.tool.name, structuredClone(req.input ?? {}), {
                    signal,
                    title: req.title,
                    reason: req.decision.reason,
                    suggestions: [...(req.decision.suggestions ?? [])],
                    toolUseId: req.callId,
                    agent: req.agentLabel,
                }),
            ),
            aborted,
        ]);
        if (!answer) return { allow: false };
        if (answer.behavior === "allow") return { allow: true, ...(answer.rules?.length ? { rules: answer.rules, scope: "session" as const } : {}) };
        denied(req.tool.name);
        return { allow: false, ...(answer.message?.trim() ? { feedback: answer.message } : {}) };
    } catch (e) {
        denied(req.tool.name);
        const message = (e as Error)?.message ?? String(e);
        emit({ type: "notice", level: "warn", message: `canUseTool failed for ${req.title}, so the call was denied: ${message}` });
        return { allow: false, feedback: `The permission check failed (${message}), so this call was denied.` };
    } finally {
        signal.removeEventListener("abort", onAbort!);
    }
}
