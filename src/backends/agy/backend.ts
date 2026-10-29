// Antigravity's CLI (agy) as an agent backend: one process per Cavvy session on the live CLI layer (src/backends/live),
// kept between turns, as the ACP agents' are. Its protocol is connection.ts; Cavvy's permission gate is gate.ts.
//
// Cavvy never reads or copies agy's sign-in (~/.gemini): it starts the user's own installed agy, whose environment
// (childEnv) has Cavvy's provider keys removed, so it signs in its own way.

import { randomUUID } from "crypto";
import { homedir } from "os";
import { agentNeedsTrust } from "../../config/trust";
import type { ProviderDef } from "../../providers/registry";
import { ProviderError, type AssistantMessage, type ChatRequest, type ModelInfo } from "../../providers/types";
import { RESUME_FAILED, type SteerSource } from "../acp/connection";
import { TurnRecord } from "../claude-live";
import { JsonLinesProcess, cliMessage, extraArgs, findCli, requireCli, runCli } from "../cli";
import { agentCli, type AgentCliDef } from "../defs";
import type { AgentCliStatus } from "../index";
import { expandPath } from "../../util/files";
import { liveDebug } from "../live/debug";
import { LiveCliPool, type PoolOptions } from "../live/pool";
import { spawnFingerprint, type LiveTurnResult } from "../live/session";
import type { AgentCliAdapter, CliConnection, CliEventSink, SpawnConfig, SpawnSpec } from "../live/types";
import { WholeTurnsOnly, oneOffRefusal } from "../one-off";
import { backendModel, type AgentBackendClient, type BackendResult, type BackendTurn, type SessionHost } from "../types";
import { AgyConnection, SIGN_IN_NEEDED } from "./connection";
import { GATE_TOKEN_ENV, GATE_URL_ENV, filesDir, gateDir, gateUnavailable, gateUrl } from "./gate";

function agyDef(id: string): AgentCliDef {
    const def = agentCli(id);
    if (def?.protocol !== "agy-stream-json") throw new Error(`${id} isn't Antigravity's CLI`);
    return def;
}

/** The arguments a process starts with, but the conversation it resumes (not part of its fingerprint). */
function agyArgs(id: string, cfg: Pick<SpawnConfig, "model" | "cwd" | "additionalDirectories">, gate: string): string[] {
    const dirs = [...new Set((cfg.additionalDirectories ?? []).map((d) => expandPath(d, cfg.cwd)))];
    return [...extraArgs(id), "--input-format", "stream-json", "--output-format", "stream-json", "--model", cfg.model.id, ...dirs.flatMap((d) => ["--add-dir", d]), "--add-dir", gate];
}

/** How a session's process is started, and spoken to: one per Cavvy session. */
class AgyAdapter implements AgentCliAdapter {
    /** The turn under way, or the last one (set before each). */
    current?: Pick<BackendTurn, "cwd">;
    /** Where the turn under way takes messages to steer it with. */
    steering?: SteerSource;
    /** The session's token for the gate: the hook calls back with it, so its calls reach this session only. */
    private token = randomUUID();

    constructor(readonly def: AgentCliDef) {}

    spawn(cfg: SpawnConfig): SpawnSpec {
        const bin = requireCli(this.def.id, this.def.cli);
        const cant = gateUnavailable();
        if (cant) throw new Error(cant);
        const gate = gateDir();
        const args = agyArgs(this.def.id, cfg, gate);
        const env = { [GATE_URL_ENV]: gateUrl(), [GATE_TOKEN_ENV]: this.token };
        const fingerprint = spawnFingerprint({ bin, args, cwd: cfg.cwd, env });
        // -p= last: it takes the next argument for its prompt otherwise.
        return { bin, args: [...args, ...(cfg.resumeId ? ["--conversation", cfg.resumeId] : []), "-p="], cwd: cfg.cwd, env, fingerprint };
    }

    async connect(proc: JsonLinesProcess, events: CliEventSink, host: SessionHost): Promise<CliConnection> {
        liveDebug("agy", "spawned", { pid: proc.pid });
        return new AgyConnection(proc, events, host, this.def, this.current?.cwd ?? homedir(), { dir: gateDir(), token: this.token, files: filesDir(this.token) }, () => this.steering);
    }

    status(_accountId: string | undefined, signal?: AbortSignal) {
        return agyStatus(this.def.id, signal).then((status) => ({ status }));
    }

    listModels(signal?: AbortSignal) {
        return agyModels(this.def.id, signal);
    }
}

/** How long `agy models` may take. */
const LIST_TIMEOUT_MS = 30_000;

/** `agy models`: its models (id, a tab, its name), one a line. Signed out, it says so and lists none. */
async function listed(bin: string, signal?: AbortSignal): Promise<{ models: { id: string; name: string }[]; signedIn: boolean; said: string }> {
    const started = Date.now();
    const r = await runCli(bin, ["models"], { signal, timeoutMs: LIST_TIMEOUT_MS });
    const out = `${r.stdout}\n${r.stderr}`;
    if (SIGN_IN_NEEDED.test(out)) return { models: [], signedIn: false, said: cliMessage(out) };
    // Stopped when it took too long, it says nothing.
    if (r.code !== 0) throw new Error(cliMessage(r.stderr) || cliMessage(r.stdout) || (Date.now() - started >= LIST_TIMEOUT_MS ? `no answer in ${LIST_TIMEOUT_MS / 1000} seconds` : `exit code ${r.code}`));
    const models = r.stdout
        .split("\n")
        .map((l) => /^([\w.-]+)\t(.+)$/.exec(l.trim()))
        .filter((m): m is RegExpExecArray => Boolean(m))
        .map((m) => ({ id: m[1]!, name: m[2]!.trim() }));
    return { models, signedIn: true, said: "" };
}

/** Is it installed, and signed in? Its model list says (it refuses to list them signed out). */
export async function agyStatus(providerId: string, signal?: AbortSignal): Promise<AgentCliStatus> {
    const def = agyDef(providerId);
    const base = { signIn: def.cli.signIn, signOut: def.cli.signOut, installHint: def.cli.install };
    const path = findCli(providerId, def.cli);
    if (!path) return { ...base, installed: false, signedIn: false, description: "not installed" };
    const cant = gateUnavailable();
    if (cant) return { ...base, installed: true, path, signedIn: false, description: "can't run here", problem: cant };
    try {
        const l = await listed(path, signal);
        if (!l.signedIn) return { ...base, installed: true, path, signedIn: false, description: "not signed in" };
        return { ...base, installed: true, path, signedIn: true, description: `signed in, ${l.models.length} model${l.models.length === 1 ? "" : "s"}` };
    } catch (e) {
        if (signal?.aborted) throw new Error("aborted");
        const said = cliMessage((e as Error).message) || "no answer";
        return { ...base, installed: true, path, signedIn: false, description: "didn't answer", problem: `${def.name} didn't answer: ${said}. Try again in a moment.` };
    }
}

export async function agyModels(providerId: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const def = agyDef(providerId);
    const l = await listed(requireCli(providerId, def.cli), signal);
    if (!l.signedIn) throw new ProviderError(`${def.name} isn't signed in. Run \`${def.cli.signIn}\` in a terminal to sign in.`, 401);
    // Each id names its effort (gemini-4-argon-high), so Cavvy's effort setting has nothing to set.
    return l.models.map((m) => backendModel(providerId, m.id, m.name, { supportsImages: def.caps.images, supportsReasoning: false }));
}

export class AgyBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    readonly pool: LiveCliPool;
    private cli: AgentCliDef;

    constructor(
        readonly def: ProviderDef,
        o: PoolOptions = {},
    ) {
        const base = agyDef(def.id);
        this.cli = { ...base, name: def.name };
        this.pool = new LiveCliPool(() => new AgyAdapter(this.cli), { stopGraceMs: this.cli.stopGraceMs ?? 3000, ...o });
    }

    /** It runs whole turns only: no one-off requests (set smallModel to another provider's model for those). */
    async stream(req: ChatRequest): Promise<AssistantMessage> {
        throw oneOffRefusal(this.cli.name, req) ?? new WholeTurnsOnly(this.cli.name);
    }

    listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        return agyModels(this.def.id, signal);
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const name = this.cli.name;
        if (t.adopt) return { reason: "error", text: "", actions: [], error: `${name} doesn't start turns of its own.` };
        // A fork would share the conversation it came from: it starts one of its own with the conversation so far.
        if (t.forkSession && t.resumeId) return { reason: "error", text: "", actions: [], error: `${RESUME_FAILED} ${name} conversation: ${name} conversations can't be forked`, resumeFailed: true, forkUnsupported: true, refused: true };
        // It would run a folder's own hooks, which nothing can turn off (the GUI asks before sending: needs_trust).
        const untrusted = agentNeedsTrust(this.def.id, t.cwd, t.trusted, t.additionalDirectories);
        if (untrusted) return { reason: "error", text: "", actions: [], error: untrusted.message, refused: true };
        const key = t.sessionKey;
        let live = this.pool.session(key, this.def.id);
        // Another conversation than the one running (rewound, or a fresh start): the old process goes.
        if (live.sessionId && t.resumeId !== live.sessionId) {
            liveDebug("agy", "conversation changed: releasing", { key, was: live.sessionId, now: t.resumeId });
            await this.release(key);
            live = this.pool.session(key, this.def.id);
        }
        const adapter = live.adapter as AgyAdapter;
        adapter.current = t;
        const rec = new TurnRecord(t.sink);
        // A message the user sends meanwhile joins the turn at its next model call (the gate's PreInvocation), recorded
        // after what was said before it; one taken that never went goes with the next turn.
        const steering: SteerSource = {
            drain: async (live, flush) => rec.sink.drainQueued(() => (flush(), rec.take()), live),
            undelivered: (messages) => rec.sink.undelivered?.(messages),
        };
        adapter.steering = steering;
        let r: LiveTurnResult;
        try {
            r = await live.runTurn({ text: t.prompt, images: t.images, documents: t.documents }, rec.sink, t.signal, {
                spawn: t,
                settings: { model: t.model, mode: t.session.mode(), effort: t.effort, fastMode: t.fastMode },
                host: t.session,
            });
        } finally {
            if (adapter.steering === steering) adapter.steering = undefined;
        }
        liveDebug("agy", "turn result", { key, ref: r.ref, reason: r.reason, unanswered: r.unanswered });
        return this.result(t, rec, r);
    }

    private result(t: BackendTurn, rec: TurnRecord, r: LiveTurnResult): BackendResult {
        const name = this.cli.name;
        if (r.unanswered) t.sink.emit({ type: "notice", level: "warn", message: `${name} didn't stop in time, so it was closed. Your next message reopens the conversation.` });
        const out = rec.take();
        const refused = r.refused ? { refused: true } : {};
        if (r.reason === "error") {
            const error = r.error ?? `${name} stopped with an error.`;
            return { ...out, reason: "error", error, resumeFailed: Boolean(t.resumeId && error.startsWith(RESUME_FAILED)), ...refused };
        }
        if (r.reason === "done" && !rec.any) t.sink.emit({ type: "notice", level: "warn", message: `${name} ended the turn without a reply.` });
        return { ...out, reason: r.reason, ...refused };
    }

    /** Not supported: it manages its own context (Agent.compactBackend says so before this). */
    async compact(): Promise<BackendResult> {
        return { reason: "error", text: "", actions: [], error: `Compaction isn't supported for ${this.cli.name}.` };
    }

    /** Nothing to do: the gate decides each call by the mode at that moment. */
    setMode() {}

    async restart(key: string): Promise<void> {
        await this.pool.get(key, this.def.id)?.restart();
    }

    async release(key: string): Promise<void> {
        await this.pool.release(key, this.def.id);
    }

    async shutdown(): Promise<void> {
        await this.pool.shutdownAll();
    }
}
