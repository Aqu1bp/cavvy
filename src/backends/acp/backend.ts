// ACP agents (OpenCode, Grok Build) as agent backends: one process per Cavvy session on
// the live CLI layer (src/backends/live), kept between turns, as Claude Code's
// are (claude-live.ts). The protocol is connection.ts; what each agent does
// its own way is its def (defs.ts) and agents.ts.
//
// Cavvy never reads or copies the agent's sign-in: it starts the user's own
// installed program, whose environment (childEnv) has Cavvy's provider keys
// removed, so it signs in its own way.

import { homedir } from "os";
import type { PermissionMode } from "../../permissions/modes";
import type { ProviderDef } from "../../providers/registry";
import { ProviderError, type AssistantMessage, type ChatRequest, type ModelInfo } from "../../providers/types";
import { TurnRecord } from "../claude-live";
import { JsonLinesProcess, cliMessage, extraArgs, findCli, requireCli } from "../cli";
import { STRICTNESS, modeSwitched } from "../codex";
import { agentCli, type AgentCliDef } from "../defs";
import type { AgentCliStatus } from "../index";
import { liveDebug } from "../live/debug";
import { LiveCliPool, type PoolOptions } from "../live/pool";
import { EXIT_DRAIN_MS, spawnFingerprint, type LiveCliSession, type LiveTurnResult } from "../live/session";
import type { AgentCliAdapter, CliConnection, CliEventSink, SpawnConfig, SpawnSpec } from "../live/types";
import { oneOffRefusal } from "../one-off";
import { backendModel, type AgentBackendClient, type BackendResult, type BackendTurn, type SessionHost } from "../types";
import { acpAgent, type AcpAgent } from "./agents";
import { AcpConnection, RESUME_FAILED, type SteerSource } from "./connection";
import { AcpGone, AcpRpc } from "./rpc";

/** How long the status check waits for initialize. */
const STATUS_TIMEOUT_MS = 20_000;

/** The def an ACP provider runs, by its id. */
function acpDef(id: string): AgentCliDef {
    const def = agentCli(id);
    if (def?.protocol !== "acp") throw new Error(`${id} isn't an ACP agent`);
    return def;
}

/** How a session's process is started, and spoken to: one per Cavvy session. */
class AcpAdapter implements AgentCliAdapter {
    /** The turn under way, or the last one (set before each). */
    current?: Pick<BackendTurn, "cwd" | "orchestrator" | "readOnly">;
    /** Where the turn under way takes messages to steer it with. */
    steering?: SteerSource;
    conn?: AcpConnection;

    constructor(
        readonly def: AgentCliDef,
        private agent: AcpAgent,
    ) {}

    spawn(cfg: SpawnConfig): SpawnSpec {
        const bin = requireCli(this.def.id, this.def.cli);
        const own = this.agent.spawn(cfg);
        const args = [...extraArgs(this.def.id), ...(this.def.acpArgs ?? []), ...own.args];
        return { bin, args, cwd: cfg.cwd, env: own.env, fingerprint: spawnFingerprint({ bin, args, cwd: cfg.cwd, env: own.env }) };
    }

    async connect(proc: JsonLinesProcess, events: CliEventSink, host: SessionHost): Promise<CliConnection> {
        const conn = new AcpConnection(proc, events, host, this.def, this.agent, this.current?.cwd ?? homedir(), () => this.steering, () => (this.current?.readOnly ? undefined : this.current?.orchestrator));
        this.conn = conn;
        liveDebug("acp", "spawned", { agent: this.def.id, pid: proc.pid });
        try {
            await conn.initialize();
        } catch (e) {
            if (!(e instanceof AcpGone)) throw e;
            // Gone before it answered: why is in its stderr.
            await Promise.race([proc.exited, Bun.sleep(this.def.stopGraceMs ?? 3000)]);
            await Promise.race([proc.stderrEnded, Bun.sleep(EXIT_DRAIN_MS)]);
            throw new Error(`${this.def.name} stopped: ${cliMessage(proc.stderr()) || "it closed its output"}`);
        }
        return conn;
    }

    status(_accountId: string | undefined, signal?: AbortSignal) {
        return acpStatus(this.def.id, signal).then((status) => ({ status }));
    }

    listModels(signal?: AbortSignal) {
        return acpModels(this.def.id, signal);
    }
}

/**
 * Is it installed, and does it start and answer initialize? Its sign-in isn't read: OpenCode runs its free models
 * without one, so an agent that answers is usable. Its name and version from that answer describe it. An agent with
 * a status of its own (AcpAgent.status) says instead.
 */
export async function acpStatus(providerId: string, signal?: AbortSignal): Promise<AgentCliStatus> {
    const def = acpDef(providerId);
    const base = { signIn: def.cli.signIn, signOut: def.cli.signOut, installHint: def.cli.install };
    const path = findCli(providerId, def.cli);
    if (!path) return { ...base, installed: false, signedIn: false, description: "not installed" };
    // One that says whether it's signed in (Grok: `grok models`), without Cavvy reading its sign-in.
    const own = acpAgent(providerId).status;
    if (own) {
        try {
            const s = await own(path, signal);
            return { ...base, installed: true, path, signedIn: s.signedIn, description: `${def.name}, ${s.description}` };
        } catch (e) {
            if (signal?.aborted) throw new Error("aborted");
            return { ...base, installed: true, path, signedIn: false, description: `${def.name} didn't answer: ${cliMessage((e as Error).message) || "no answer"}` };
        }
    }
    const proc = new JsonLinesProcess(path, [...extraArgs(providerId), ...(def.acpArgs ?? [])], { cwd: homedir() });
    const kill = () => void proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, STATUS_TIMEOUT_MS);
    try {
        const rpc = new AcpRpc(proc, () => {}, async () => {
            throw new Error("not now");
        });
        const r = await Promise.race([
            rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }),
            proc.exited.then(async (code) => {
                await Promise.race([proc.stderrEnded, Bun.sleep(500)]);
                throw new Error(cliMessage(proc.stderr()) || `exit code ${code}`);
            }),
        ]);
        const info = r?.agentInfo ?? {};
        const name = typeof info.title === "string" ? info.title : typeof info.name === "string" ? info.name : def.name;
        const version = typeof info.version === "string" ? ` ${info.version}` : "";
        return { ...base, installed: true, path, signedIn: true, description: `${name}${version}, answering over ACP` };
    } catch (e) {
        if (signal?.aborted) throw new Error("aborted");
        await Promise.race([proc.stderrEnded, Bun.sleep(500)]);
        return { ...base, installed: true, path, signedIn: false, description: `${def.name} didn't start: ${cliMessage(proc.stderr()) || cliMessage((e as Error).message) || "no answer"}` };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        await proc.stop(def.stopGraceMs ?? 3000);
    }
}

/** Its models, listed without opening a session (agents.ts). */
export async function acpModels(providerId: string, signal?: AbortSignal): Promise<ModelInfo[]> {
    const def = acpDef(providerId);
    const bin = requireCli(providerId, def.cli);
    const listed = await acpAgent(providerId).listModels(bin, signal);
    return listed.map((m) => backendModel(providerId, m.id, m.name ?? m.id, { supportsImages: def.caps.images }));
}

/** A turn running here, for a mode change mid-turn (setMode). */
interface AcpRun {
    t: BackendTurn;
    live?: LiveCliSession;
    /** The mode its process was readied in, for the part of the turn running now. */
    mode: PermissionMode;
    /** That part, aborted (with the turn's own signal too) to stop it. */
    part: AbortController;
    /** It's being stopped to go on under this mode. */
    restartFor?: PermissionMode;
}

export class AcpBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    readonly pool: LiveCliPool;
    private cli: AgentCliDef;
    private agent: AcpAgent;
    private runs = new Set<AcpRun>();

    constructor(
        readonly def: ProviderDef,
        o: PoolOptions = {},
    ) {
        const base = acpDef(def.id);
        this.cli = { ...base, name: def.name };
        const agent = (this.agent = acpAgent(def.id));
        // An adapter per session (the pool makes one with each): it's told what turn is under way.
        this.pool = new LiveCliPool(() => new AcpAdapter(this.cli, agent), { stopGraceMs: this.cli.stopGraceMs ?? 3000, ...o });
    }

    /** It runs whole turns only: no one-off requests (set smallModel to another provider's model for those). */
    async stream(req: ChatRequest): Promise<AssistantMessage> {
        throw oneOffRefusal(this.cli.name, req) ?? new ProviderError(`${this.cli.name} runs whole turns only, so it can't answer a one-off request. Set smallModel to another provider's model for those.`);
    }

    listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        return acpModels(this.def.id, signal);
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const name = this.cli.name;
        if (t.adopt) return { reason: "error", text: "", actions: [], error: `${name} doesn't start turns of its own.` };
        // A fork shares the session it came from: it can't be copied, so the fork starts one of its own with the conversation.
        if (t.forkSession && t.resumeId) return { reason: "error", text: "", actions: [], error: `${RESUME_FAILED} ${name} session: ${name} sessions can't be forked`, resumeFailed: true, refused: true };
        const key = t.sessionKey;
        // The mode now, not t.mode: a Stop hook's continuation reuses the turn it went on from, readied before a switch.
        const run: AcpRun = { t, mode: t.session.mode(), part: new AbortController() };
        const onAbort = () => run.part.abort();
        t.signal.addEventListener("abort", onAbort, { once: true });
        if (t.signal.aborted) onAbort();
        this.runs.add(run);
        let stopSteering: (() => void) | undefined;
        try {
            let live = this.pool.session(key, this.def.id);
            // Another session than the one running (rewound, or a fresh start): the old process goes.
            if (live.sessionId && t.resumeId !== live.sessionId) {
                liveDebug("acp", "session changed: releasing", { key, was: live.sessionId, now: t.resumeId });
                await this.release(key);
                live = this.pool.session(key, this.def.id);
            }
            run.live = live;
            const adapter = live.adapter as AcpAdapter;
            adapter.current = t;
            const rec = new TurnRecord(t.sink);
            // A message the user sends to steer the turn goes as it's queued (the connection sends it into the running
            // turn), recorded after what was said before it; one taken that never went goes with the next turn.
            const steering: SteerSource = {
                drain: async (live, flush) => rec.sink.drainQueued(() => (flush(), rec.take()), live),
                undelivered: (messages) => rec.sink.undelivered?.(messages),
            };
            adapter.steering = steering;
            stopSteering = t.sink.onQueued?.(() => (adapter.steering === steering ? adapter.conn?.steerQueued() : undefined));
            let input = { text: t.prompt, images: t.images };
            let sent = false;
            for (;;) {
                const r = await live.runTurn(input, rec.sink, run.part.signal, { spawn: t, settings: { model: t.model, mode: run.mode, effort: t.effort, fastMode: t.fastMode }, host: t.session });
                liveDebug("acp", "turn result", { key, ref: r.ref, reason: r.reason, unanswered: r.unanswered });
                sent ||= !r.refused;
                const restart = run.restartFor;
                run.restartFor = undefined;
                if (!restart || t.signal.aborted || r.reason !== "aborted") return this.result(t, rec, { ...r, refused: r.refused && !sent });
                // Stopped for the mode, not by the user: it goes on under it (its prompt again, if it never got there).
                liveDebug("acp", "mode restart", { key, mode: restart });
                if (!r.refused) input = { text: modeSwitched(restart), images: [] };
                run.mode = restart;
                run.part = new AbortController();
            }
        } finally {
            stopSteering?.();
            const adapter = run.live?.adapter as AcpAdapter | undefined;
            if (adapter?.current === t) adapter.steering = undefined;
            this.runs.delete(run);
            t.signal.removeEventListener("abort", onAbort);
        }
    }

    private result(t: BackendTurn, rec: TurnRecord, r: LiveTurnResult): BackendResult {
        const name = this.cli.name;
        if (r.unanswered) t.sink.emit({ type: "notice", level: "warn", message: `${name} didn't answer the stop in time. The turn ended here; if it stays busy, its next turn says so.` });
        const out = rec.take();
        const refused = r.refused ? { refused: true } : {};
        if (r.reason === "error") {
            const error = r.error ?? `${name} stopped with an error.`;
            return { ...out, reason: "error", error, resumeFailed: Boolean(t.resumeId && error.startsWith(RESUME_FAILED)), ...refused };
        }
        if (r.reason === "done" && !rec.any) t.sink.emit({ type: "notice", level: "warn", message: `${name} ended the turn without a reply.` });
        return { ...out, reason: r.reason, ...refused };
    }

    /** Not supported: it compacts by itself, if at all (Agent.compactBackend says so before this). */
    async compact(): Promise<BackendResult> {
        return { reason: "error", text: "", actions: [], error: `Compaction isn't supported for ${this.cli.name}.` };
    }

    /**
     * Asks are decided by the mode when they come; its own plan mode follows at the next turn (apply). A mode its
     * session must be opened with (Grok's auto) can't change mid-turn: a stricter one stops the turn, which goes on
     * under it in a process that resumed the session (one being readied is readied again); a looser one waits for the
     * next turn.
     */
    setMode() {
        for (const run of this.runs) {
            const m = run.t.session.mode();
            if (!run.restartFor && !this.stale(run.mode, m)) continue;
            run.restartFor = m;
            // The prompt's turn, held to the deadline: unanswered, it ends with why, and the process goes.
            void run.live?.interrupt(undefined, { error: `${this.cli.name} didn't stop a turn running under the permission mode from before, so it was stopped. Send your message again to go on under the new mode.` });
            run.part.abort();
        }
    }

    /** A turn readied in mode `was` can't go on in `now`: its session was opened for another, and `now` is stricter. */
    private stale(was: PermissionMode, now: PermissionMode): boolean {
        const meta = this.agent.sessionMeta;
        return Boolean(meta) && JSON.stringify(meta!(was) ?? null) !== JSON.stringify(meta!(now) ?? null) && STRICTNESS[now] > STRICTNESS[was];
    }

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
