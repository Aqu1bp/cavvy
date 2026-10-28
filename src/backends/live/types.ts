// The live CLI layer's interfaces (#219 §6). One long-lived CLI process serves
// a Cavvy session's turns (LiveCliSession, session.ts); a pool holds them
// (pool.ts). What differs between CLIs is only an AgentCliAdapter: how to start
// the process, and a CliConnection that speaks its protocol and reports what
// happens as CliEvents. Nothing in the runtime uses this layer yet.

import type { AgentEvent, TurnEndReason } from "../../agent/agent";
import type { NativeGoal } from "../../agent/goal";
import type { AssistantMessage, ChatRequest, ImagePart, ModelInfo, PdfPart, Usage } from "../../providers/types";
import type { PlanLimits } from "../../server/protocol";
import type { JsonLinesProcess } from "../cli";
import type { AgentCliDef, CliCapabilities } from "../defs";
import type { AgentCliStatus } from "../index";
import type { BackendTurn, SessionHost } from "../types";
import type { BackgroundTaskInfo } from "./info";

export type { BackgroundTaskInfo } from "./info";

/**
 * What a process is started with: the turn's settings without its prompt. The
 * model, mode, effort and fast mode are the first turn's (LiveSettings change
 * them later). A resumed or forked session is the session's to choose:
 * LiveCliSession resumes the session its process reported, once there is one.
 */
export type SpawnConfig = Omit<BackendTurn, "prompt" | "images" | "documents" | "request" | "requestAfter" | "synthetic" | "goalContext" | "signal" | "session" | "sink" | "adopt" | "sessionKey">;

/** How to start the process. */
export interface SpawnSpec {
    bin: string;
    args: string[];
    cwd: string;
    /** Over Cavvy's child environment: the account's folder (accountEnv). */
    env?: Record<string, string>;
    /**
     * A hash of everything only settable at spawn (spawnFingerprint): the binary, its arguments
     * and environment, hook registrations. Not the resumed session, and not LiveSettings.
     * A different one at a turn's start means the process must be restarted to take it.
     */
    fingerprint: string;
    /** Sessions whose spawn is the same can share a process (a later optimization; none do yet). */
    shareKey?: string;
}

/** What a running process changes without a restart (CliConnection.apply). */
export type LiveSettings = Pick<BackendTurn, "model" | "mode" | "effort" | "fastMode">;

/** A prompt: its text, and what's attached. */
export interface TurnInput {
    text: string;
    images: ImagePart[];
    documents?: PdfPart[];
    /** As BackendTurn's: not only the user's own words, so read as written. */
    synthetic?: boolean;
    /** As BackendTurn's: the user's message as typed, and what follows it in `text`. */
    request?: string;
    requestAfter?: string;
}

// What a live process asks of Cavvy, between turns too (bound once a session), and where one turn's
// events go: src/backends/types.ts.
export type { SessionHost, TurnSink } from "../types";

/** What a connection reports, in the layer's terms. `ref` names a turn: the prompt's uuid (Claude Code), the turn id (Codex). */
export type CliEvent =
    /** A turn began. Not from one of our prompts (`wake`, `goal`): the CLI started it itself. `answers`: the prompts it takes in. */
    | { t: "turn_started"; ref: string; origin: "user" | "wake" | "goal"; answers?: string[] }
    /** Something in a turn; without a ref, in the one running. */
    | { t: "turn_event"; ref?: string; event: AgentEvent }
    /**
     * A turn ended. `answers`: every prompt it answered (steering messages folded into it). `refused`: its prompt never
     * reached the CLI's session (Esc withdrew it, and the CLI said it dropped it): LiveTurnResult.refused.
     */
    | { t: "turn_ended"; ref: string; answers?: string[]; reason: TurnEndReason; error?: string; usage?: Usage; limit?: { resetsAt?: number; window?: string }; refused?: boolean }
    /** The CLI has ended a turn (it answered the stop), whose end waits on cleanup of its own, bounded: the stop watchdog lets go. */
    | { t: "turn_ending"; ref: string }
    /**
     * A background task started, changed or ended. `wakeDue`: the CLI will start a turn of its own to report
     * it (Claude Code after a task_notification); until a turn starts or ends, the session isn't quiet.
     * `false`: a report said to be due won't come after all (none started in time).
     */
    | { t: "task"; task: BackgroundTaskInfo; wakeDue?: boolean }
    /**
     * The connection stopped a turn itself (Cavvy's own stop: ACP's tripwire, a no that ends the turn), having asked the
     * CLI to: held to interrupt's deadline. Unanswered by then, the turn ends with `error` (aborted without one), and the
     * process is stopped: it may still be doing what it was stopped for.
     */
    | { t: "stop"; ref: string; error?: string }
    | { t: "session_id"; id: string }
    | { t: "limits"; limits: PlanLimits; partial: boolean }
    | { t: "goal"; goal: NativeGoal | null }
    | { t: "commands"; names: string[] }
    /** The folder the CLI's session works in now (Claude Code's: it entered or left a worktree, or a turn began there). */
    | { t: "cwd"; cwd: string };

export type CliEventSink = (e: CliEvent) => void;

/** A connection to a running CLI: the protocol, mapped. */
export interface CliConnection {
    caps: CliCapabilities;
    /** Settles once the CLI's output has ended (read with quietAfterExitMs: EXIT_DRAIN_MS), after its last events. */
    done: Promise<void>;
    /** Start, resume or fork the CLI's session; its id. */
    open(o: { resumeId?: string; fork?: boolean; settings: LiveSettings }): Promise<{ sessionId: string }>;
    /** Send a prompt; the ref its turn_ended will name. */
    prompt(input: TurnInput): Promise<{ ref: string }>;
    /** Add to the running turn; false when it can't take it now. */
    steer?(ref: string, input: TurnInput): Promise<boolean>;
    /** Interrupt a turn. Never stops the process or its background work. */
    interrupt(ref: string): Promise<void>;
    /**
     * The session is ending a turn itself (its stop went unanswered): what the turn said so far that's still held, and
     * the tools it started, go into it now, as its end would have put them.
     */
    settle?(ref: string): void;
    /**
     * Once what the last interrupt left to clean up is done (no prompt goes before): false when the process was
     * stopped for it, so the next prompt goes to a new one.
     */
    settled?(): Promise<boolean>;
    /** Ask for a background task to stop; its task event says when it has. */
    stopTask?(id: string): Promise<void>;
    moveToBackground?(toolUseId: string): Promise<boolean>;
    /** Change settings on the running process; "restart" when it can't. */
    apply(s: Partial<LiveSettings>): Promise<"applied" | "restart">;
    setMcpServers?(servers: Record<string, unknown>): Promise<{ failed: string[] }>;
    /** Ask the CLI to finish (stdin EOF, end_session); the session then stops the process. */
    close(): Promise<void>;
}

/** One agent CLI's protocol: the only per-CLI code. */
export interface AgentCliAdapter {
    readonly def: AgentCliDef;
    /** How to start a process for this config. Called at every turn's start to compare fingerprints, so without side effects. */
    spawn(cfg: SpawnConfig): SpawnSpec;
    /**
     * Start talking to a process just started: read its output, reporting it to `events`. `resume`: the session it was
     * started to resume or fork (what it says before its first turn can be about an earlier process's work).
     */
    connect(proc: JsonLinesProcess, events: CliEventSink, host: SessionHost, resume?: { resumeId?: string; fork?: boolean }): Promise<CliConnection>;
    status(accountId: string | undefined, signal?: AbortSignal): Promise<{ status: AgentCliStatus; limits?: PlanLimits }>;
    listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
    /** A one-off request with no tools (stream() today). */
    oneOff?(req: ChatRequest): Promise<AssistantMessage>;
}

/** Time, for the layer's timers: tests pass one they move by hand. */
export interface LiveClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
