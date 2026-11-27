// Suggested tasks (an agent's SuggestTask call): what the card starts with, and starting one. The window does it, as
// the user: it claims the suggestion on the suggesting session's machine, starts the task on the machine picked on
// the card (its own connection, or one to that machine), then says on the suggesting session how that went. Loaded
// with the card (components/blocks/SuggestCard.tsx), not with the window.
//
// Machines are named as session rows name them (SessionSummary.machine): undefined, this computer; a server's name.

import type { EffortLevel, GuiSettings, ModelSummary, ProviderModels, PermissionModeId, SuggestionStarted, SuggestionState, StartTaskParams, StartTaskResult } from "@shared/protocol";
import { activate, app, linkFor, machineOf, machinesInside, refreshModels, reportError, requestTrust, restoredFrom, rpc } from "./app";
import { createStore } from "solid-js/store";
import { machine, os } from "../lib/platform";
import { RpcError, type Rpc } from "../lib/rpc";
import { effortLevels, takesEffort } from "../lib/effort";
import { tildify } from "../lib/format";

/** What this computer is called among the machines (as Servers.tsx's HERE, without loading it). */
export const HERE = os === "macos" ? "This Mac" : "This computer";

/** A machine's name for the user. */
export const boxName = (on: string | undefined) => on ?? HERE;

/** What a server can be called (src/servers/store.ts): anything else names this computer. */
const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Machine `on` as a suggestion's record names it: this computer by its name for the user, which no server can have (an empty one isn't kept). */
const recordName = (on: string | undefined) => on ?? HERE;
/** Back from a record's name: a server's, or this computer. */
const fromRecord = (name: string) => (SERVER_NAME.test(name) ? name : undefined);

/** Machine `on` as app.ts's per-machine lists key it (awayMachine's names): undefined, the window's own; "" this computer from a window on a server. */
export const awayKey = (on: string | undefined): string | undefined => (on === machine ? undefined : (on ?? ""));

/** The connection to machine `on`: the window's own, or one made to it. */
export const linkOn = (on: string | undefined): Promise<Rpc> => (on === machine ? Promise.resolve(rpc) : linkFor(on));

/** The machine `id` is on, if the window knows (opened here from it, or its row listed); null if it doesn't. */
export function knownMachineOf(id: string): string | undefined | null {
    const { awayOn, restoredOn } = machinesInside;
    if (awayOn.has(id)) return awayOn.get(id) || undefined;
    const at = [...app.sessions, ...app.archived].find((s) => s.id === id);
    if (at) return at.machine;
    return restoredOn.has(id) ? restoredOn.get(id) || undefined : null;
}
/** Machine `k`'s models (awayMachine's names; undefined: the window's own). Another's are there once asked for (loadMachine). */
export const modelsOn = (k: string | undefined): ProviderModels[] => (k === undefined ? app.models : (machinesInside.machineModels[k] ?? []));
/** The machines whose models are being asked for here. */
const [machinesLoading, setMachinesLoading] = createStore<Record<string, boolean>>({});
/**
 * Machine `k`'s models, accounts and settings: asked for over a connection to it, made if it isn't. Once: kept up to
 * date from then on (app.ts linkMade). Fails as linkFor does when it can't be reached.
 */
export async function loadMachine(k: string): Promise<void> {
    const { machineModels, machineSettings, machineReady } = machinesInside;
    if (k in machineModels && k in machineSettings) return;
    setMachinesLoading(k, true);
    try {
        await machineReady(k, await linkFor(k || undefined));
        // Its answer didn't come (it's let go of there): said, so what waits for the list isn't left waiting.
        if (!(k in machineModels)) throw new Error(`Couldn't list the models of ${k || "this computer"}`);
    } finally {
        setMachinesLoading(k, false);
    }
}
/** Machine `k`'s lists, for a model picker of a card that starts something there (ModelPicker's PickTarget). */
export function listsOn(k: string | undefined) {
    const { machineModels, machineProviders, machineLimits, machineModelsAgain } = machinesInside;
    return {
        models: () => modelsOn(k),
        providers: () => (k === undefined ? app.providers : (machineProviders[k] ?? [])),
        limits: () => (k === undefined ? app.limits : (machineLimits[k] ?? {})),
        served: () => (k === undefined ? app.served : {}),
        loading: () => (k === undefined ? app.modelsLoading : Boolean(machinesLoading[k])),
        refresh: async (again = false) => {
            if (k === undefined) return refreshModels(again).catch(() => undefined);
            if (!(k in machineModels)) return loadMachine(k).catch(() => undefined);
            setMachinesLoading(k, true);
            try {
                await machineModelsAgain(k, await linkFor(k || undefined), again);
            } catch {
                // Not reached: its list stays as it was.
            } finally {
                setMachinesLoading(k, false);
            }
        },
    };
}
/** Machine `k`'s settings (awayMachine's names): the model and effort a session made there starts with. Another's once asked for (loadMachine). */
const settingsOn = (k: string | undefined): GuiSettings | undefined => (k === undefined ? app.settings : machinesInside.machineSettings[k]);
/** Machine `k`'s models have been listed here (none may be what it has). */
export const modelsKnownOn = (k: string | undefined) => (k === undefined ? app.modelsLoaded : k in machinesInside.machineModels);
/** Whether `id`, as machine `on` named the session it made, is one this window doesn't know elsewhere: else it isn't taken. */
export function newOn(id: string, on: string | undefined): boolean {
    if (machinesInside.handles.has(id)) return false;
    const known = knownMachineOf(id);
    return known === null || known === on;
}
/**
 * Session `id`, just made on machine `on` over `link` from this window: opened from that machine from now on, and
 * what it said for this window before it was linked here (its draft) kept for it.
 */
function madeOn(id: string, on: string | undefined, link: Rpc) {
    const { away, earlyDrafts, linked, keepDraft } = machinesInside;
    if (on === machine || away.has(id)) return;
    linked(id, on, link);
    const of = earlyDrafts.get(link);
    for (const d of of?.get(id) ?? []) keepDraft(id, d);
    of?.delete(id);
}

// ---------------------------------------------------------------------------
// Showing what the agent wrote

/** Control, format (bidi, zero-width) and non-ASCII space characters: as src/mcp/approval.ts's visible(). */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}   -   　]/gu;

/**
 * Text an agent wrote, with what wouldn't show (a direction mark, a zero-width space) written out as ⟨U+202E⟩, so what's
 * read is what's sent. `lines`: line breaks and tabs stay (a prompt's).
 */
export function visible(s: string, lines = false): string {
    return s.replace(/\r\n/g, "\n").replace(INVISIBLE, (c) => (lines && (c === "\n" || c === "\t") ? c : `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`));
}

/** The why line, unless it only says the title again. */
export function whyLine(s: Pick<SuggestionState, "title" | "why">): string | undefined {
    const norm = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const why = s.why?.trim();
    if (!why) return undefined;
    const w = norm(why);
    const t = norm(s.title);
    return w === t || w === "" ? undefined : why;
}

// ---------------------------------------------------------------------------
// What the card starts with

/**
 * The model a task starts on: the user's pick; else the agent's hint, then the suggesting session's model, where the
 * target has it; else the target's default. With the target's models not listed (yet), the first of those named.
 */
export function chooseModel(o: { picked?: string; hint?: string; suggester?: string; targetDefault?: string; models: ModelSummary[] }): string | undefined {
    const has = (ref: string | undefined): ref is string => Boolean(ref) && o.models.some((m) => m.ref === ref);
    if (!o.models.length) return o.picked ?? o.hint ?? o.suggester ?? o.targetDefault;
    for (const ref of [o.picked, o.hint, o.suggester]) if (has(ref)) return ref;
    return o.targetDefault;
}

/** The effort it starts with: the first of these the model takes (the user's, the agent's, the suggester's on that model, the target's default). */
export function chooseEffort(model: ModelSummary | undefined, o: { picked?: EffortLevel; hint?: EffortLevel; suggester?: EffortLevel; targetDefault?: EffortLevel }): EffortLevel | undefined {
    if (!model || !takesEffort(model)) return undefined;
    const levels = effortLevels(model).map((e) => e.id);
    return [o.picked, o.hint, o.suggester, o.targetDefault].find((e): e is EffortLevel => Boolean(e) && levels.includes(e!));
}

/** The models listed for machine `on`. */
export const modelsOf = (on: string | undefined): ModelSummary[] => modelsOn(awayKey(on)).flatMap((g) => g.models.filter((m) => !m.deprecated));
/** Machine `on`'s default model and effort, once its settings are known here. */
export const defaultsOf = (on: string | undefined) => settingsOn(awayKey(on));

// ---------------------------------------------------------------------------
// Starting

/** What the card asks the target machine to start. */
export interface StartPick {
    /** The suggesting session. */
    sessionId: string;
    /** Its title, permission mode (the new session's is no freer), and machine. */
    from: { title: string; mode: PermissionModeId; on: string | undefined };
    suggestion: SuggestionState;
    on: string | undefined;
    cwd: string;
    title: string;
    prompt: string;
    model: string;
    effort?: EffortLevel;
    worktree: boolean;
    /** The worktree an earlier Start made, before what came after failed: started in instead of making another. */
    resume?: string;
}

/** How a Start went, for the card. */
export type StartOutcome =
    | { kind: "started"; started: SuggestionStarted }
    /** Not started: what to say, and whether Try again is what to do. */
    | { kind: "failed"; message: string; retry?: boolean; resume?: string }
    /** The folder is to be trusted first: the trust dialog is up, and Start runs again once it's answered. */
    | { kind: "trust"; resume?: string }
    /** Another window took the start over (this one went quiet): the card shows how it stands. */
    | { kind: "superseded" };

/** A model's name, for the user: as the picker shows it. */
function modelLabel(ref: string, models: ModelSummary[]): string {
    const m = models.find((x) => x.ref === ref);
    return (m?.name ?? ref.split(":").slice(1).join(":")) || ref;
}

/** The connection dropped or never came up: the machine didn't answer. */
const noAnswer = (e: unknown) => !(e instanceof RpcError) || e.code === "disconnected" || e.code === "unavailable";

/** What a failed tasks.start says on the card (its codes: StartTaskCode). */
export function startProblem(e: unknown, pick: Pick<StartPick, "on" | "cwd" | "model" | "effort">, models: ModelSummary[] = []): { message: string; retry?: boolean } {
    const box = boxName(pick.on);
    if (noAnswer(e)) return { message: `${box} didn't answer.`, retry: true };
    const err = e as RpcError;
    switch (err.code) {
        case "no_folder":
            return { message: `No folder ${tildify(err.folder ?? pick.cwd)} on ${box}.` };
        case "model_unavailable":
            return { message: `${modelLabel(pick.model, models)} isn't available on ${box}. Pick another.` };
        case "effort_unavailable":
            return { message: `${modelLabel(pick.model, models)} doesn't take ${pick.effort ?? "that"} effort. Pick another.` };
        case "not_git":
            return { message: `${tildify(pick.cwd)} isn't a Git repository. Turn off New worktree.` };
        case "worktree_failed":
            return { message: err.message || "Couldn't make the worktree.", retry: true };
        default:
            return { message: err.message || "Couldn't start it.", retry: true };
    }
}

/** The calls Start makes, separable for tests: session.suggestion on the suggesting session, tasks.start on the target. */
export interface StartCalls {
    suggestion: (params: Record<string, unknown>) => Promise<unknown>;
    link: (on: string | undefined) => Promise<Pick<Rpc, "call">>;
    trust: (folder: string, then: () => void, link: Pick<Rpc, "call">, on: string | undefined) => void;
    again: () => void;
    /** Whether this Start still stands (not let go of meanwhile): checked before anything is made or asked. */
    alive?: () => boolean;
    /** The claim was answered and taken. */
    claimed?: () => void;
    /** Whether a session id machine `on` answered with is new to this window. */
    fresh?: (sessionId: string, on: string | undefined) => boolean;
    /** The session tasks.start made, on machine `on` over `link`. */
    made?: (sessionId: string, link: Pick<Rpc, "call">, on: string | undefined) => void;
}

/** The window's calls; `again`: Start once more, after the trust dialog it brought up is answered. */
export const windowCalls = (again: () => void = () => undefined): StartCalls => ({
    suggestion: (params) => rpc.call("session.suggestion", params as never),
    link: linkOn,
    trust: (folder, then, link, on) => requestTrust(folder, then, undefined, undefined, link as Rpc, on ?? ""),
    again,
    fresh: newOn,
    made: (id, link, on) => madeOn(id, on, link as Rpc),
});

/**
 * Start a suggested task: claim it (refused if it isn't pending any more, or a terminal holds the session), start it
 * on the target machine, and say how it went on the suggesting session. Each failure puts it back to pending with the
 * reason, so the card (in any window, and after a reload) says it.
 */
export async function startSuggestion(pick: StartPick, calls: StartCalls = windowCalls()): Promise<StartOutcome> {
    const { sessionId, suggestion } = pick;
    const on = (params: Record<string, unknown>) => calls.suggestion({ id: sessionId, suggestionId: suggestion.id, ...params });
    // The claim's time: how this start is told from another window's that took it over.
    let claimedAt: number | undefined;
    try {
        claimedAt = ((await on({ action: "claim" })) as SuggestionState | undefined)?.claimedAt;
    } catch (e) {
        // Started or dismissed in another window meanwhile: the card shows that as it's told.
        if (e instanceof RpcError && e.code === "not_pending") return { kind: "failed", message: "" };
        if (e instanceof RpcError && e.code === "held") return { kind: "failed", message: e.message || "Close this session in the terminal to start it." };
        return { kind: "failed", message: noAnswer(e) ? "Cavvy didn't answer." : (e as Error).message, retry: noAnswer(e) };
    }
    const claim = claimedAt !== undefined ? { claimedAt } : {};
    const superseded = (e: unknown) => e instanceof RpcError && e.code === "superseded";
    const fail = async (message: string, extra: { retry?: boolean; resume?: string } = {}): Promise<StartOutcome> => {
        try {
            await on({ action: "failed", message, ...claim });
        } catch (e) {
            if (superseded(e)) return { kind: "superseded" };
        }
        return { kind: "failed", message, ...extra };
    };
    // Let go of while the claim was answered (no answer for a minute, or the destination changed): nothing is made.
    const gone = () => Boolean(calls.alive && !calls.alive());
    // Let go of after the claim was taken: given back, so the card isn't left starting.
    const letGo = async (): Promise<StartOutcome> => {
        await on({ action: "failed", message: "", ...claim }).catch(() => undefined);
        return { kind: "superseded" };
    };
    if (gone()) return letGo();
    calls.claimed?.();
    const models = modelsOf(pick.on);
    let link: Pick<Rpc, "call">;
    try {
        link = await calls.link(pick.on);
    } catch {
        return fail(`${boxName(pick.on)} isn't connected.`, { retry: true });
    }
    if (gone()) return letGo();
    const suggesterOn = pick.from.on;
    const params: StartTaskParams = {
        cwd: pick.cwd,
        title: pick.title,
        prompt: pick.prompt,
        model: pick.model,
        ...(pick.effort ? { effort: pick.effort } : {}),
        mode: pick.from.mode,
        ...(pick.worktree ? { worktree: true } : {}),
        ...(pick.resume ? { resume: pick.resume } : {}),
        origin: {
            key: `${sessionId}#${suggestion.id}`,
            session: sessionId,
            title: pick.from.title,
            ...(pick.on !== suggesterOn ? { machine: recordName(suggesterOn) } : {}),
        },
    };
    let result: StartTaskResult;
    try {
        result = await link.call("tasks.start", params as never) as StartTaskResult;
    } catch (e) {
        if (e instanceof RpcError && e.code === "needs_trust") {
            const folder = e.folder ?? pick.cwd;
            const out = await fail(`Trust ${tildify(folder)} to start it.`);
            if (out.kind === "superseded" || gone()) return { kind: "superseded" };
            calls.trust(folder, calls.again, link, pick.on);
            return { kind: "trust" };
        }
        const { message, retry } = startProblem(e, pick, models);
        return fail(message, { retry });
    }
    if (!result.sessionId) {
        const resume = result.worktree?.path;
        // The worktree was made, and its folder is to be trusted: asked, then started in it.
        if (result.failed?.code === "needs_trust") {
            const folder = result.failed.folder ?? resume ?? pick.cwd;
            const out = await fail(`Trust ${tildify(folder)} to start it.`, { resume });
            if (out.kind === "superseded" || gone()) return { kind: "superseded" };
            calls.trust(folder, calls.again, link, pick.on);
            return { kind: "trust", resume };
        }
        // Something was made (the worktree) but not the session: Try again starts in it.
        return fail(result.failed?.message || "Couldn't start it.", { retry: true, resume });
    }
    // Only a session new to this window, and not the suggesting one, is taken as the one it made.
    if (result.sessionId === sessionId || (calls.fresh && !calls.fresh(result.sessionId, pick.on))) return fail("Couldn't start it.", { retry: true });
    calls.made?.(result.sessionId, link, pick.on);
    const started: SuggestionStarted = {
        sessionId: result.sessionId,
        ...(pick.on !== suggesterOn ? { machine: recordName(pick.on) } : {}),
        title: result.title,
        cwd: result.cwd,
        ...(result.worktree ? { worktree: result.worktree } : {}),
        at: Date.now(),
        ...(result.failed ? { problem: result.failed.message } : {}),
    };
    // Said on the suggesting session; if that fails, the card still shows what this window knows (and asks once more).
    for (let tries = 0; tries < 2; tries++) {
        try {
            await on({ action: "started", started, ...claim });
            break;
        } catch (e) {
            if (superseded(e)) return { kind: "superseded" };
        }
    }
    return { kind: "started", started };
}

/** The machine a started task runs on (the suggesting session's, unless it says another). */
export function startedOn(sessionId: string, started: SuggestionStarted): string | undefined {
    // Where the window knows it is, first; else as the record says.
    const known = knownMachineOf(started.sessionId);
    if (known !== null) return known;
    return started.machine === undefined ? machineOf(sessionId) : fromRecord(started.machine);
}

/** Open the session a suggestion started, on whichever machine it's on. */
export function openStarted(sessionId: string, started: SuggestionStarted) {
    const on = startedOn(sessionId, started);
    if (on !== machineOf(started.sessionId)) restoredFrom(started.sessionId, on ?? "");
    void activate(started.sessionId);
}

/** Dismiss it (Restore puts it back): said on the suggesting session. */
export function setSuggestion(sessionId: string, suggestionId: string, action: "dismissed" | "pending"): Promise<boolean> {
    return rpc.call("session.suggestion", { id: sessionId, suggestionId, action }).then(
        () => true,
        (e) => {
            reportError(e);
            return false;
        },
    );
}

// ---------------------------------------------------------------------------
// The servers to pick from

export interface MachineChoice {
    name: string;
    /** Not connected to from this Cavvy now. */
    offline: boolean;
}

/** This computer's servers, as its Cavvy lists them (asked when the machine menu opens). */
export async function listServers(): Promise<MachineChoice[]> {
    const home = machine ? (await import("../lib/machines")).home : rpc;
    if (!home) return [];
    const r = await home.call("servers.list", {}).catch(() => ({ servers: [] }));
    return r.servers.map((s) => ({ name: s.name, offline: !s.connected }));
}
