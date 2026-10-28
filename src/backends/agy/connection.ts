// One Antigravity CLI process (`agy -p= --input-format stream-json --output-format stream-json`): its conversation, its
// turns as CliEvents, and its tool calls through Cavvy's rules at the gate (gate.ts).
//
// agy 1.4.9's protocol (test/fixtures/protocol/agy-1.4.9-*.jsonl):
//   - It says {"event":"init","conversation_id",...} once it's ready, before any message. Started with --conversation it
//     goes on with that one; one it can't find, it warns on stderr and starts a new one (-resume.jsonl).
//   - A message is {"event":"user","message":{"role":"user","content":"..."}}: text only (an image block fails the run,
//     -image.jsonl). Each is one turn; one sent while a turn runs waits for the next (-midturn.jsonl).
//   - A turn says what it does as {"event":"step_update"} steps: user_input, agent_response (text_delta pieces, usage once
//     DONE), tool (ACTIVE, then DONE with tool_info.output or ERROR with tool_info.error). It ends with {"event":"result"}:
//     status SUCCESS or ERROR (and its error). Usage there is the conversation's so far; each step's is its own.
//   - Nothing on stdin stops a turn (-cancel-*.jsonl). SIGINT does: the result says "interrupted", and the process exits.

import { randomUUID } from "crypto";
import { relative } from "path";
import type { AgentEvent, TurnEndReason } from "../../agent/agent";
import { APP_TITLE } from "../../config/paths";
import { stableStringify } from "../../permissions/classifier";
import type { Usage } from "../../providers/types";
import { titleFor } from "../claude-code";
import { cliMessage, type JsonLinesProcess } from "../cli";
import type { AgentCliDef, CliCapabilities } from "../defs";
import { RESUME_FAILED } from "../acp/connection";
import { liveDebug } from "../live/debug";
import { EXIT_DRAIN_MS, PromptRefused } from "../live/session";
import type { CliConnection, CliEventSink, LiveSettings, TurnInput } from "../live/types";
import type { BackendPermission, PermissionAnswer, SessionHost } from "../types";
import { GATE_DEADLINE_MS, agyTool, onGate, sessionStartAnswer, type AgyTool } from "./gate";

/** How long to wait for it to say it's ready (it takes 5 to 8 seconds), and how often to look for a sign-in prompt meanwhile. */
const INIT_TIMEOUT_MS = 90_000;
const SIGN_IN_POLL_MS = 250;

/** What it prints when it isn't signed in, before it waits for a sign-in in the browser. */
export const SIGN_IN_NEEDED = /Authentication required|Please sign in/i;

/** Cavvy's tools whose titles and rows are Cavvy's own. */
const CAVVY_TOOLS = new Set(["Bash", "Edit", "Write", "Read", "LS", "Grep", "Glob", "WebFetch", "WebSearch", "Task"]);

/** A tool step, as the stream and the gate have told it. */
interface Row {
    id: string;
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
    diff?: { path: string; before: string; after: string };
}

interface Turn {
    ref: string;
    /** Text said in the step under way. */
    text: string;
    /** Its tool steps with a row, by their step index. */
    rows: Map<number, Row>;
    /** Steps the gate saw, as `conversation:step`. */
    gated: Set<string>;
    /** Gate calls waiting on an answer: they're refused when the turn stops. */
    waiting: Set<(reason: string) => void>;
    usage: Usage;
    /** The context as its last model call had it. */
    context?: number;
    /** SIGINT was sent. */
    cancelling?: boolean;
    /** Why the tripwire stopped it. */
    tripped?: string;
    ended?: boolean;
}

type Decision = { allow: true } | { allow: false; reason: string; stop?: boolean; late?: boolean };

export class AgyConnection implements CliConnection {
    caps: CliCapabilities;
    readonly done: Promise<void>;
    private conversationId?: string;
    private turn?: Turn;
    private gone = false;
    /** A SIGINT went: the process is on its way out, so the next prompt goes to a new one. */
    private interrupted = false;
    private ready: Promise<string>;
    private readyResolve!: (id: string) => void;
    private readyReject!: (e: Error) => void;
    private unroute: () => void;
    private model?: string;

    constructor(
        readonly proc: JsonLinesProcess,
        private events: CliEventSink,
        private host: SessionHost,
        private def: AgentCliDef,
        private cwd: string,
        /** The gate folder, and the token the hook calls back with. */
        private gate: { dir: string; token: string },
    ) {
        this.caps = { ...def.caps };
        this.ready = new Promise<string>((resolve, reject) => ((this.readyResolve = resolve), (this.readyReject = reject)));
        this.ready.catch(() => {});
        this.unroute = onGate(gate.token, (event, input) => this.onGate(event, input));
        this.done = this.read();
    }

    private async read() {
        try {
            for await (const msg of this.proc.messages({ quietAfterExitMs: EXIT_DRAIN_MS })) this.onMessage(msg);
        } finally {
            this.lost();
        }
    }

    async open(o: { resumeId?: string; fork?: boolean; settings: LiveSettings }): Promise<{ sessionId: string }> {
        if (o.fork) throw new Error(`${this.def.name} conversations can't be forked here`);
        this.model = o.settings.model.id;
        // Not signed in, it prints a sign-in address and waits for the browser instead of starting.
        let poll: ReturnType<typeof setInterval> | undefined;
        const signIn = new Promise<never>((_, reject) => {
            poll = setInterval(() => {
                if (SIGN_IN_NEEDED.test(this.proc.stderr())) reject(new Error(`${this.def.name} isn't signed in. Run \`${this.def.cli.signIn}\` in a terminal to sign in, then try again.`));
            }, SIGN_IN_POLL_MS);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${this.def.name} didn't start in time: ${cliMessage(this.proc.stderr()) || "no answer"}`)), INIT_TIMEOUT_MS)));
        try {
            const id = await Promise.race([this.ready, signIn, late]);
            // One it can't find, it replaces with a new one (and warns on stderr).
            if (o.resumeId && id !== o.resumeId) throw new Error(`${RESUME_FAILED} ${this.def.name} conversation: ${cliMessage(this.proc.stderr()) || "it wasn't found"}`);
            return { sessionId: id };
        } finally {
            clearInterval(poll);
            clearTimeout(timer);
        }
    }

    async prompt(input: TurnInput): Promise<{ ref: string }> {
        if (!this.conversationId) throw new PromptRefused(`${this.def.name} has no conversation open`);
        if (this.turn && !this.turn.ended) throw new PromptRefused(`${this.def.name} is still finishing its last turn. Try again in a moment.`);
        if (this.interrupted) throw new PromptRefused(`${this.def.name} is stopping. Try again in a moment.`);
        const turn: Turn = { ref: randomUUID(), text: "", rows: new Map(), gated: new Set(), waiting: new Set(), usage: { inputTokens: 0, outputTokens: 0 } };
        this.turn = turn;
        const dropped = input.images.length + (input.documents?.length ?? 0);
        if (dropped) this.emit({ type: "notice", level: "warn", message: `${this.def.name} takes text only, so ${dropped === 1 ? "the attachment wasn't" : "the attachments weren't"} sent.` });
        if (!(await this.proc.send({ event: "user", message: { role: "user", content: input.text } }))) {
            turn.ended = true;
            if (this.turn === turn) this.turn = undefined;
            throw new PromptRefused(`${this.def.name} stopped before it took the message`);
        }
        return { ref: turn.ref };
    }

    /** Nothing on its stdin stops a turn: SIGINT does, and the process exits after (settled says so). */
    async interrupt(ref: string): Promise<void> {
        const turn = this.turn;
        if (!turn || turn.ref !== ref || turn.ended) return;
        this.cancel(turn);
    }

    private cancel(turn: Turn) {
        if (turn.cancelling) return;
        turn.cancelling = true;
        for (const w of [...turn.waiting]) w("Turn stopped");
        this.interrupted = true;
        liveDebug("agy", "SIGINT", { pid: this.proc.pid });
        try {
            process.kill(this.proc.pid, "SIGINT");
        } catch {
            // gone already
        }
    }

    /** After a SIGINT the process exits: the next prompt goes to a new one, which resumes the conversation. */
    async settled(): Promise<boolean> {
        return !this.interrupted;
    }

    /**
     * The mode is Cavvy's, decided at the gate at each call. The model is set only when it starts (it's in the spawn's
     * fingerprint, so a change restarts it), and the effort is the model's (its ids name one).
     */
    async apply(s: Partial<LiveSettings>): Promise<"applied" | "restart"> {
        return s.model && s.model.id !== this.model ? "restart" : "applied";
    }

    async close(): Promise<void> {
        this.proc.end();
    }

    private emit(event: AgentEvent) {
        this.events({ t: "turn_event", ...(this.turn ? { ref: this.turn.ref } : {}), event });
    }

    private onMessage(msg: Record<string, any>) {
        switch (msg.event) {
            case "init":
                if (typeof msg.conversation_id === "string" && msg.conversation_id && !this.conversationId) {
                    this.conversationId = msg.conversation_id;
                    if (typeof msg.init?.model === "string") this.model = msg.init.model;
                    this.readyResolve(msg.conversation_id);
                }
                return;
            case "step_update":
                return this.onStep(msg.step_update ?? {});
            case "result":
                return this.onResult(msg.result ?? {});
        }
    }

    private onStep(s: Record<string, any>) {
        const turn = this.turn;
        // Between turns, or a subagent's step (its calls go through the gate all the same).
        if (!turn || turn.ended || s.conversation_id !== this.conversationId) return;
        const step = typeof s.step_index === "number" ? s.step_index : -1;
        if (s.step_type === "agent_response") {
            if (typeof s.text_delta === "string" && s.text_delta) {
                turn.text += s.text_delta;
                this.emit({ type: "text", text: s.text_delta });
            }
            if (s.state === "DONE") {
                this.flushText(turn);
                this.addUsage(turn, s.usage);
            }
            return;
        }
        if (s.step_type !== "tool" || step < 0) return;
        const name = typeof s.tool_name === "string" ? s.tool_name : String(s.tool_info?.name ?? "tool");
        const args = s.tool_info?.parameters && typeof s.tool_info.parameters === "object" ? s.tool_info.parameters : {};
        if (s.state === "ACTIVE") return void this.startRow(turn, step, agyTool(name, args, this.cwd, this.gate.dir), name, args);
        if (s.state !== "DONE" && s.state !== "ERROR") return;
        const mapped = agyTool(name, args, this.cwd, this.gate.dir);
        const row = this.startRow(turn, step, mapped, name, args);
        // The tripwire: a change that ran without the gate seeing it got past Cavvy (the hook wasn't loaded).
        const changes = !mapped || mapped.toolName === "Bash" || mapped.toolName === "Write" || mapped.toolName === "Edit" || mapped.toolName === "Antigravity";
        if (s.state === "DONE" && changes && !turn.gated.has(`${this.conversationId}:${step}`) && !turn.cancelling && !turn.tripped && this.host.mode() !== "bypassPermissions") {
            turn.tripped = `${this.def.name} ran \`${row.title}\` without ${APP_TITLE}'s permission check, so the turn was stopped.`;
            liveDebug("agy", "tripwire", { step, name });
            this.events({ t: "stop", ref: turn.ref, error: turn.tripped });
        }
        const failed = s.state === "ERROR";
        const output = failed ? String(s.tool_info?.error?.message ?? "Failed") : typeof s.tool_info?.output === "string" && s.tool_info.output ? s.tool_info.output : "Done";
        this.endRow(turn, step, output, failed);
    }

    /** Its row: from the gate's view of the call when that came first, else from what the stream says. */
    private startRow(turn: Turn, step: number, mapped: AgyTool | undefined, name: string, args: Record<string, unknown>): Row {
        const had = turn.rows.get(step);
        if (had) return had;
        this.flushText(turn);
        const tool = mapped && !mapped.refuse ? mapped : { toolName: this.def.name, input: { tool: name, ...args }, title: `${this.def.name}: ${name}` };
        const shown = tool.toolName === "Write" || tool.toolName === "Edit" ? { file_path: tool.input.file_path } : tool.input;
        const row: Row = {
            id: `${this.conversationId}:${step}`,
            name: tool.toolName,
            input: shown,
            title: CAVVY_TOOLS.has(tool.toolName) ? titleFor(tool.toolName, shown) : (tool.title ?? tool.toolName),
            started: Date.now(),
        };
        const path = typeof tool.input.file_path === "string" ? tool.input.file_path : undefined;
        if (mapped?.diff && path) row.diff = { path: path.startsWith(this.cwd + "/") ? relative(this.cwd, path) : path, ...mapped.diff };
        turn.rows.set(step, row);
        this.emit({ type: "tool_start", call: { type: "tool_call", id: row.id, name: row.name, input: row.input }, title: row.title });
        return row;
    }

    private endRow(turn: Turn, step: number, content: string, isError: boolean) {
        const row = turn.rows.get(step);
        if (!row) return;
        turn.rows.delete(step);
        const display = row.diff && !isError ? { diff: row.diff } : undefined;
        this.emit({ type: "tool_end", call: { type: "tool_call", id: row.id, name: row.name, input: row.input }, result: { content, isError, ...(display ? { display } : {}) }, durationMs: Date.now() - row.started });
    }

    private flushText(turn: Turn) {
        const text = turn.text;
        turn.text = "";
        if (text.trim()) this.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }], provider: this.def.id, model: this.model ?? "default" } });
    }

    private addUsage(turn: Turn, u: any) {
        if (!u || typeof u !== "object") return;
        const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
        turn.usage.inputTokens += n(u.input_tokens);
        turn.usage.outputTokens += n(u.output_tokens);
        if (n(u.thinking_tokens)) turn.usage.reasoningTokens = (turn.usage.reasoningTokens ?? 0) + n(u.thinking_tokens);
        if (n(u.cache_read_tokens)) turn.usage.cacheReadTokens = (turn.usage.cacheReadTokens ?? 0) + n(u.cache_read_tokens);
        if (n(u.input_tokens)) turn.context = n(u.input_tokens) + n(u.output_tokens);
    }

    private onResult(r: Record<string, any>) {
        // Before it's ready: it couldn't start (an unknown model, a failed sign-in).
        if (!this.conversationId) return void this.readyReject(new Error(`${this.def.name} couldn't start: ${String(r.error || "no reason given")}`));
        const turn = this.turn;
        if (!turn || turn.ended) return;
        let reason: TurnEndReason = "done";
        let error: string | undefined;
        if (turn.tripped) [reason, error] = ["error", turn.tripped];
        else if (turn.cancelling || r.error === "interrupted") reason = "aborted";
        else if (r.status !== "SUCCESS") [reason, error] = ["error", r.error ? `${this.def.name}: ${String(r.error)}` : `${this.def.name} stopped with an error.`];
        this.finish(turn, reason, error);
    }

    private finish(turn: Turn, reason: TurnEndReason, error?: string) {
        turn.ended = true;
        for (const w of [...turn.waiting]) w("Turn stopped");
        this.flushText(turn);
        for (const step of [...turn.rows.keys()]) this.endRow(turn, step, "Cancelled: the turn ended before it finished.", true);
        if (turn.usage.inputTokens || turn.usage.outputTokens) {
            if (this.model) turn.usage.resolvedModel = `${this.def.id}:${this.model}`;
            this.host.usage(turn.usage, turn.context ? { contextTokens: turn.context } : {});
        }
        this.events({ t: "turn_ended", ref: turn.ref, reason, ...(error ? { error } : {}) });
        if (this.turn === turn) this.turn = undefined;
    }

    /** Its output ended: a turn still going ends with the process (the session says why), its tools closed. */
    private lost() {
        this.gone = true;
        this.unroute();
        this.readyReject(new Error(`${this.def.name} stopped: ${cliMessage(this.proc.stderr()) || "it closed its output"}`));
        const turn = this.turn;
        if (!turn || turn.ended) return;
        for (const w of [...turn.waiting]) w("Turn stopped");
        this.flushText(turn);
        for (const step of [...turn.rows.keys()]) this.endRow(turn, step, `Cancelled: ${this.def.name} stopped before it finished.`, true);
    }

    // --- The gate -----------------------------------------------------------------------------------------------

    private async onGate(event: string, input: any): Promise<Record<string, unknown>> {
        if (event === "session") return sessionStartAnswer(this.cwd, this.gate.dir);
        if (event !== "pre") return {};
        const deny = (reason: string) => ({ decision: "deny", reason });
        const name = typeof input?.toolCall?.name === "string" ? input.toolCall.name : undefined;
        const args = input?.toolCall?.args && typeof input.toolCall.args === "object" && !Array.isArray(input.toolCall.args) ? input.toolCall.args : undefined;
        if (!name || !args) {
            this.emit({ type: "notice", level: "warn", message: `Refused a tool call of ${this.def.name}'s: ${APP_TITLE} couldn't read it.` });
            return deny(`${APP_TITLE} couldn't read this call, so it was refused.`);
        }
        const turn = this.turn;
        // Between turns nothing may run.
        if (this.gone || !turn || turn.ended) return deny(`${APP_TITLE} isn't running a turn, so nothing may run now.`);
        if (turn.cancelling || turn.tripped) return deny("Turn stopped");
        const conversation = typeof input.conversationId === "string" ? input.conversationId : "";
        const step = typeof input.stepIdx === "number" ? input.stepIdx : -1;
        const main = conversation === this.conversationId;
        turn.gated.add(`${conversation}:${step}`);
        const withdraw = new AbortController();
        let settle!: (d: Decision) => void;
        const decided = new Promise<Decision>((r) => (settle = r));
        const timer = setTimeout(() => settle({ allow: false, reason: `No answer from ${APP_TITLE} in time`, late: true }), GATE_DEADLINE_MS);
        const stopped = (reason: string) => settle({ allow: false, reason });
        turn.waiting.add(stopped);
        this.decide(turn, name, args, main, step, withdraw.signal).then(settle, (e) => {
            liveDebug("agy", "gate failed", { name, error: String(e) });
            this.emit({ type: "notice", level: "warn", message: `Refused ${this.def.name}'s \`${name}\` call: ${APP_TITLE} couldn't check it (${e instanceof Error ? e.message : String(e)}).` });
            settle({ allow: false, reason: `${APP_TITLE} couldn't check this call, so it was refused.` });
        });
        let d: Decision;
        try {
            d = await decided;
        } finally {
            clearTimeout(timer);
            turn.waiting.delete(stopped);
            withdraw.abort();
        }
        liveDebug("agy", "gate", { name, step, main, allow: d.allow });
        if (!d.allow) {
            if (d.late) this.emit({ type: "notice", level: "warn", message: `${this.def.name} waited too long for an answer about \`${name}\`, so ${APP_TITLE} refused it.` });
            // A no that ends the turn, by the user, about a call of its own: after the no has gone.
            if (d.stop && main) setTimeout(() => turn.ended || this.events({ t: "stop", ref: turn.ref }), 0);
            return deny(d.reason);
        }
        if (turn.ended || turn.cancelling) return deny("Turn stopped");
        return { decision: "auto_approve" };
    }

    /** A gated call, decided as an ask is: by Cavvy's rules and its mode now. */
    private async decide(turn: Turn, name: string, args: Record<string, any>, main: boolean, step: number, signal: AbortSignal): Promise<Decision> {
        const own = agyTool(name, args, this.cwd, this.gate.dir);
        if (own?.refuse) return { allow: false, reason: own.refuse };
        const label = main ? undefined : `${this.def.name} subagent`;
        // Its own bookkeeping goes, unless a deny rule names it.
        if (own?.free) {
            const a = await this.host.permission({ toolName: own.toolName, input: own.input, asksAlways: true, exempt: true, ...(label ? { agentLabel: label } : {}), signal });
            return a.allow ? { allow: true } : { allow: false, reason: a.message || "Denied.", stop: a.stop };
        }
        // One of its tools Cavvy has none for: checked by the agent's name, with all it says.
        const req: AgyTool = own ?? { toolName: this.def.name, input: { tool: name, ...args }, title: `${this.def.name} asks to use ${name}` };
        // Its row, from the gate (an ask makes it wait). The stream may have started it first, without what it writes.
        const row = main ? this.startRow(turn, step, own, name, args) : undefined;
        const path = typeof req.input.file_path === "string" ? req.input.file_path : undefined;
        if (row && own?.diff && path && !row.diff) row.diff = { path: path.startsWith(this.cwd + "/") ? relative(this.cwd, path) : path, ...own.diff };
        const bypass = this.host.mode() === "bypassPermissions";
        const asked: BackendPermission = {
            toolName: req.toolName,
            input: req.input,
            ...(req.title ? { title: req.title } : {}),
            ...(req.reason ? { reason: req.reason } : {}),
            asksAlways: true,
            ...(bypass ? { hooksOnly: true } : req.elsewhere ? { hookDecision: "ask" as const } : {}),
            ...(row ? { callId: row.id } : {}),
            ...(label ? { agentLabel: label } : {}),
            signal,
        };
        const a = await this.host.permission(asked);
        // A hook's rewrite: the call would run as agy asked, so neither runs.
        if (a.allow && rewritten(a, req.input)) return { allow: false, reason: `A hook rewrote this call, and ${this.def.name} runs calls only as it asked them, so neither ran.` };
        if (a.allow) return { allow: true };
        return { allow: false, reason: a.message || "Denied.", stop: a.stop };
    }
}

/** A hook approved other input than was asked about. */
function rewritten(a: Extract<PermissionAnswer, { allow: true }>, input: Record<string, unknown>): boolean {
    return a.updatedInput !== undefined && stableStringify(a.updatedInput) !== stableStringify(input);
}
