// A task the agent suggested (its SuggestTask call), as a card in its turn: the title and prompt to edit, where and on
// what it runs, then Start or Dismiss. Nothing starts until Start is pressed, and nothing on it takes focus by itself:
// it may come while the user types in the composer, and Enter there mustn't start it. Loaded with the first one.

import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { Check, ChevronDown, CircleAlert, Folder, GitBranchPlus, Lightbulb, Server, SquareArrowOutUpRight } from "lucide-solid";
import { createStore } from "solid-js/store";
import type { EffortLevel, SuggestionStarted, SuggestionState } from "@shared/protocol";
import { app, connOn, handleFor, machineOf } from "../../state/app";
import { chooseFolder } from "../../state/actions";
import { setFolderPickerOpen } from "../../state/ui";
import { tildify } from "../../lib/format";
import { machine as windowMachine } from "../../lib/platform";
import { awayKey, boxName, chooseEffort, chooseModel, defaultsOf, HERE, linkOn, listServers, listsOn, loadMachine, modelsKnownOn, modelsOf, openStarted, setSuggestion, startedOn, startSuggestion, visible, whyLine, windowCalls, type MachineChoice } from "../../state/suggestions";
import { ModelPicker } from "../ModelPicker";
import { Menu } from "../ui/Menu";
import { Spinner, Toggle } from "../ui/bits";
import "../../styles/suggest.css";

/** What's been changed on a card, kept while the window is open (the card may be drawn again: scrolled away and back, another pane). */
interface Draft {
    title?: string;
    prompt?: string;
    on?: { machine: string | undefined };
    cwd?: string;
    model?: string;
    effort?: EffortLevel;
    worktree?: boolean;
    resume?: string;
}
const drafts = new Map<string, Draft>();
/** Each card's Start attempts, by suggestion: changing where it starts lets the one under way go. */
const attemptsOf = new Map<string, number>();
/** Cards with a Start of this window's under way. */
const [busyOf, setBusyOf] = createStore<Record<string, boolean>>({});
/** What the last Start from this window came to, and whether where it starts has been changed since: by suggestion. */
const [problemOf, setProblemOf] = createStore<Record<string, { message: string; retry?: boolean } | undefined>>({});
const [changedOf, setChangedOf] = createStore<Record<string, boolean>>({});
/** The card's Start as it's drawn now: what the trust question runs once answered (a card drawn again has its own). */
const startOf = new Map<string, () => void>();
/** When this window first saw each claim: its age is timed by this window's clock, not the claiming machine's. */
const claimSeen = new Map<string, { claimedAt: number; at: number }>();
/** Started from this window: shown so even if the suggesting session couldn't be told. */
const [startedHere, setStartedHere] = createStore<Record<string, SuggestionStarted>>({});
/** Suggestions this window has drawn: only one it hasn't, just made, comes in with an entrance. */
const drawn = new Set<string>();
/** A claim this old with no word since may be taken over (the server's SUGGEST_LIMITS.staleClaimMs). */
const STALE_CLAIM_MS = 60_000;
/** A suggestion this recent is one being made now, not one in a session opened or loaded again. */
const FRESH_MS = 15_000;

export default function SuggestCard(p: { suggestion: SuggestionState; sessionId: string }) {
    const s = () => p.suggestion;
    const key = `${p.sessionId}#${p.suggestion.id}`;
    const enter = !drawn.has(key) && Date.now() - p.suggestion.at < FRESH_MS;
    drawn.add(key);
    // Started: as the session says, or (its saying so failed) as this window knows.
    const started = () => (s().state === "started" ? s().started : undefined) ?? (s().state === "dismissed" ? undefined : startedHere[key]);
    return (
        <div class={`tcard sg-card ${enter ? "sg-enter" : ""}`} role="group" aria-label={`Suggested task: ${s().title}`}>
            <Switch fallback={<Pending {...p} key={key} />}>
                <Match when={started()}>
                    {(started) => (
                        <div class="sg-line">
                            <Show when={started().problem} fallback={<Check size={14} class="sg-ok" aria-hidden="true" />}>
                                <CircleAlert size={14} class="sg-warn" aria-hidden="true" />
                            </Show>
                            <span class="truncate">
                                <Show when={started().problem} fallback={<>Started “{visible(started().title)}”{onBox(p.sessionId, startedOn(p.sessionId, started()))}</>}>
                                    Started, but the prompt wasn't sent: {started().problem}
                                </Show>
                            </span>
                            <span class="grow" />
                            <button class="pbtn sm" onClick={() => openStarted(p.sessionId, started())}>
                                <SquareArrowOutUpRight size={13} /> Open
                            </button>
                        </div>
                    )}
                </Match>
                <Match when={s().state === "dismissed"}>
                    <div class="sg-line quiet">
                        <span class="truncate">Dismissed “{visible(s().title)}”</span>
                        <span class="grow" />
                        <button class="pbtn sm quiet" onClick={() => void setSuggestion(p.sessionId, s().id, "pending")}>
                            Restore
                        </button>
                    </div>
                </Match>
            </Switch>
        </div>
    );
}

/** Esc in the card's text leaves it: it doesn't stop the agent's turn, as it would from the composer. */
const leave = (e: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    e.currentTarget.blur();
};

/** " on <box>", when it isn't the suggesting session's machine. */
const onBox = (sessionId: string, on: string | undefined) => (on !== machineOf(sessionId) ? ` on ${boxName(on)}` : "");

/** The card while it waits: everything to set, then Start or Dismiss. Also while it's being started (Starting…). */
function Pending(p: { suggestion: SuggestionState; sessionId: string; key: string }) {
    const s = () => p.suggestion;
    const draft = drafts.get(p.key) ?? {};
    drafts.set(p.key, draft);
    const view = () => handleFor(p.sessionId)?.view;
    const suggesterOn = () => machineOf(p.sessionId);

    const [title, setTitle] = createSignal(draft.title ?? visible(s().title));
    const [prompt, setPrompt] = createSignal(draft.prompt ?? visible(s().prompt ?? "", true));
    const [target, setTarget] = createSignal(draft.on);
    const [folder, setFolder] = createSignal(draft.cwd);
    const [pickedModel, setPickedModel] = createSignal(draft.model);
    const [pickedEffort, setPickedEffort] = createSignal(draft.effort);
    const [worktree, setWorktree] = createSignal(draft.worktree);
    const keep = (patch: Draft) => Object.assign(draft, patch);

    /** The machine it starts on: the suggesting session's, unless another is picked. */
    const on = () => (target() ? target()!.machine : suggesterOn());
    // The suggesting session's folder on its own machine; on another, one picked there.
    const cwd = () => folder() ?? (on() === suggesterOn() ? (view()?.state.cwd ?? "") : "");
    const models = createMemo(() => modelsOf(on()));
    // Start waits for the target's list of models, so the model and its effort are resolved from it. Another machine's
    // is asked for here when it isn't known yet (once: a failure is said, and the picker's Refresh asks again).
    const [listFailed, setListFailed] = createSignal<string>();
    createEffect(() => {
        const k = awayKey(on());
        if (k === undefined || modelsKnownOn(k) || listFailed() === k) return;
        void loadMachine(k).then(() => setListFailed(undefined), () => setListFailed(k));
    });
    const model = createMemo(() =>
        chooseModel({ picked: pickedModel(), hint: s().hint?.model, suggester: view()?.state.model?.ref, targetDefault: defaultsOf(on())?.model, models: models() }),
    );
    const modelInfo = () => models().find((m) => m.ref === model());
    const effort = createMemo(() =>
        chooseEffort(modelInfo(), { picked: pickedEffort(), hint: s().hint?.effort, suggester: model() === view()?.state.model?.ref ? view()?.state.effort : undefined, targetDefault: defaultsOf(on())?.effort }),
    );
    // In a new worktree by default where the session's folder is a Git repository (it has a branch).
    const inWorktree = () => worktree() ?? Boolean(view()?.state.branch);

    // Starting: this window's Start under way, or the suggestion claimed (in this window or another).
    // Kept by suggestion, as the attempts are: a card drawn again mid-Start still shows it starting.
    const busy = () => Boolean(busyOf[p.key]);
    const setBusy = (v: boolean) => setBusyOf(p.key, v);
    // Claimed more than a minute ago with no word since (the window that claimed it closed mid-start, say): Start
    // is offered again, and takes the claim over. A one-off timer says when that minute is up.
    const [tick, setTick] = createSignal(0);
    const seenAt = () => {
        const c = s().claimedAt ?? 0;
        const had = claimSeen.get(p.key);
        if (had?.claimedAt === c) return had.at;
        const at = Date.now();
        claimSeen.set(p.key, { claimedAt: c, at });
        return at;
    };
    const stale = () => (tick(), s().state === "starting" && Date.now() - seenAt() > STALE_CLAIM_MS);
    createEffect(() => {
        if (s().state !== "starting") return;
        const left = STALE_CLAIM_MS - (Date.now() - seenAt());
        if (left <= 0) return;
        const t = setTimeout(() => setTick((n) => n + 1), left + 50);
        onCleanup(() => clearTimeout(t));
    });
    // This window's own Start too: one that hasn't answered in that minute is let go of, and Start offered again.
    const starting = () => (busy() || s().state === "starting") && !stale();
    /** What the last Start here came to, else what the suggestion says the last one did (any window's). */
    const problem = () => problemOf[p.key];
    const setProblem = (v: { message: string; retry?: boolean } | undefined) => setProblemOf(p.key, v);
    // The last failed Start's reason stays until what it starts with is changed here.
    const changed = () => Boolean(changedOf[p.key]);
    const setChanged = (v: boolean) => setChangedOf(p.key, v);
    /** Something it starts with changed here: the last Start's news no longer applies. */
    const edited = () => {
        setProblem(undefined);
        setChanged(true);
    };
    const message = () => (offline() ? undefined : problem()?.message || (changed() ? undefined : s().failed));

    // The machines to pick from: asked for the first time the menu opens.
    let machineBtn: HTMLButtonElement | undefined;
    const [machinesOpen, setMachinesOpen] = createSignal(false);
    const [servers, setServers] = createSignal<MachineChoice[]>();
    // Only where there's another machine to pick: a window on a server, or this computer with servers.
    const hasServers = () => Boolean(windowMachine || app.hello?.servers || suggesterOn() !== undefined);
    const openMachines = () => {
        if (!machinesOpen()) void listServers().then(setServers);
        setMachinesOpen(!machinesOpen());
    };
    // Known not to be connected: as the list of machines says, or the connection to it here.
    // An open connection to it now says more than the list asked for when the menu opened.
    const offlineOn = (name: string | undefined) => {
        const state = connOn(awayKey(name));
        return state !== "open" && ((name !== undefined && Boolean(servers()?.find((m) => m.name === name)?.offline)) || ["reconnecting", "unavailable", "unauthorized"].includes(state));
    };
    const offline = () => offlineOn(on());
    const pickMachine = (name: string | undefined) => {
        setMachinesOpen(false);
        if (name === on()) return;
        setTarget({ machine: name });
        setChanged(true);
        forget();
        setFolder(undefined);
        keep({ on: { machine: name }, cwd: undefined, resume: undefined });
        setProblem(undefined);
        setListFailed(undefined);
    };

    const pickFolder = async () => {
        const at = on();
        const k = awayKey(on());
        // On another machine with no folder of its own yet: that machine's home (the picker's own start is this one's).
        const start = cwd() || (k === undefined ? undefined : "~");
        const dir =
            k === undefined
                ? await chooseFolder({ start, title: "Choose a folder" })
                : await linkOn(on()).then(
                      (link) => (on() === at ? new Promise<string | undefined>((then) => setFolderPickerOpen({ then, link, start, title: "Choose a folder" })) : undefined),
                      () => (on() === at && setProblem({ message: `${boxName(at)} isn't connected.` }), undefined),
                  );
        // Another machine picked meanwhile: this path is the other one's.
        if (!dir || on() !== at) return;
        setFolder(dir);
        setChanged(true);
        forget();
        keep({ cwd: dir, resume: undefined });
        setProblem(undefined);
    };

    const [pickerOpen, setPickerOpen] = createSignal(false);
    const why = () => {
        const w = whyLine(s());
        return w && visible(w);
    };
    const blocked = (): string | undefined => {
        if (offline()) return `${boxName(on())} isn't connected.`;
        if (!modelsKnownOn(awayKey(on()))) return listFailed() === awayKey(on()) ? `${boxName(on())} didn't answer.` : "Loading models…";
        if (!title().trim()) return "Give it a title.";
        if (!prompt().trim()) return "Write what to do.";
        if (!model() || !modelInfo()) return "Pick a model.";
        if (!cwd()) return "Choose a folder.";
        return undefined;
    };

    /** Starts so far, kept with the card's drafts (it may be drawn again meanwhile): only the latest one's outcome counts. */
    const attempts = () => attemptsOf.get(p.key) ?? 0;
    /** The Start under way let go of: no answer in a minute, or where it starts changed (its answer is then ignored). */
    const forget = () => {
        attemptsOf.set(p.key, attempts() + 1);
        setBusy(false);
    };
    const start = async () => {
        // Its card's suggestion gone meanwhile (the session deleted while the trust question was up): nothing to start.
        if (!p.suggestion || starting() || blocked()) return;
        const attempt = attempts() + 1;
        attemptsOf.set(p.key, attempt);
        setBusy(true);
        // A claim that never answers doesn't keep Start away for good.
        const deadline = setTimeout(() => attempt === attempts() && forget(), STALE_CLAIM_MS);
        setProblem(undefined);
        try {
            const outcome = await startSuggestion(
                { sessionId: p.sessionId, from: { title: view()?.state.title ?? "", on: suggesterOn() }, suggestion: s(), on: on(), cwd: cwd(), title: title().trim(), prompt: prompt(), model: model()!, effort: effort(), worktree: inWorktree(), resume: draft.resume },
                // Once the folder is trusted, Start again: unless where it starts has changed since.
                { ...windowCalls(() => attempt === attempts() && (startOf.get(p.key) ?? run)()), alive: () => attempt === attempts(), claimed: () => clearTimeout(deadline) },
            );
            if (attempt !== attempts()) return;
            if ((outcome.kind === "failed" || outcome.kind === "trust") && outcome.resume) keep({ resume: outcome.resume });
            if (outcome.kind === "failed") {
                setProblem(outcome.message ? { message: outcome.message, retry: outcome.retry } : undefined);
            } else if (outcome.kind === "started") {
                drafts.delete(p.key);
                setStartedHere(p.key, outcome.started);
            }
        } finally {
            clearTimeout(deadline);
            if (attempt === attempts()) setBusy(false);
        }
    };
    const run = () => void start();
    startOf.set(p.key, run);
    onCleanup(() => startOf.get(p.key) === run && startOf.delete(p.key));

    return (
        <>
            <div class="sg-h">
                <Lightbulb size={14} aria-hidden="true" />
                <span>Suggested task</span>
            </div>
            <fieldset class="sg-body" disabled={starting()}>
                <input
                    class="sg-title"
                    aria-label="Title"
                    value={title()}
                    spellcheck={false}
                    onInput={(e) => (setTitle(e.currentTarget.value), edited(), keep({ title: e.currentTarget.value }))}
                    // Enter doesn't start it: Start is pressed.
                    onKeyDown={(e) => (e.key === "Enter" ? e.preventDefault() : leave(e))}
                />
                <Show when={why()}>{(w) => <div class="sg-why">{w()}</div>}</Show>
                <textarea class="sg-prompt" aria-label="Prompt" rows={6} value={prompt()} spellcheck={false} onKeyDown={leave} onInput={(e) => (setPrompt(e.currentTarget.value), edited(), keep({ prompt: e.currentTarget.value }))} />
                <div class="sg-ctl">
                    <ModelPicker
                        open={pickerOpen()}
                        setOpen={setPickerOpen}
                        placement="bottom"
                        currentRef={model()}
                        effort={effort()}
                        target={{
                            ...listsOn(awayKey(on())),
                            machine: awayKey(on()),
                            model: (ref) => (setPickedModel(ref), edited(), keep({ model: ref })),
                            effort: (level) => (setPickedEffort(() => level), edited(), keep({ effort: level })),
                        }}
                    />
                    <Show when={hasServers()}>
                        <button ref={machineBtn} class={`pick ${offline() ? "sg-off" : ""}`} title="Where it runs" aria-haspopup="menu" aria-expanded={machinesOpen()} onClick={openMachines}>
                            <Server size={14} />
                            <span class="truncate">{boxName(on())}</span>
                            <ChevronDown size={13} class="chev" />
                        </button>
                        <Menu label="Machines" open={machinesOpen()} anchor={() => machineBtn} onClose={() => setMachinesOpen(false)} placement="bottom" width={220}>
                            <button role="menuitemradio" aria-checked={on() === undefined} class={`menu-item compact ${offlineOn(undefined) ? "sg-muted" : ""}`} onClick={() => pickMachine(undefined)}>
                                <span class="grow">{HERE}</span>
                                <Show when={offlineOn(undefined)}><span class="sg-muted">Offline</span></Show>
                                <Show when={on() === undefined}><Check size={14} /></Show>
                            </button>
                            <Show when={servers()} fallback={<div class="menu-item compact sg-muted"><Spinner size={12} /> Loading…</div>}>
                                <For each={servers()}>
                                    {(m) => (
                                        <button role="menuitemradio" aria-checked={on() === m.name} class={`menu-item compact ${offlineOn(m.name) ? "sg-muted" : ""}`} onClick={() => pickMachine(m.name)}>
                                            <span class="grow truncate">{m.name}</span>
                                            <Show when={offlineOn(m.name)}><span class="sg-muted">Offline</span></Show>
                                            <Show when={on() === m.name}><Check size={14} /></Show>
                                        </button>
                                    )}
                                </For>
                            </Show>
                        </Menu>
                    </Show>
                    <button class="pick sg-folder" title={cwd() ? `${tildify(cwd(), awayKey(on()) === undefined ? app.hello?.homeDir : undefined)}: choose another folder` : "Choose a folder"} onClick={() => void pickFolder()}>
                        <Folder size={14} />
                        <span class="truncate">{cwd() ? cwd().replace(/\/+$/, "").split("/").pop() || cwd() : "Choose a folder"}</span>
                    </button>
                    <label class="sg-wt" title="Work on a new branch in a worktree of its own">
                        <GitBranchPlus size={14} aria-hidden="true" />
                        <span>New worktree</span>
                        <Toggle checked={inWorktree()} onChange={(v) => (setWorktree(v), forget(), edited(), keep({ worktree: v, resume: undefined }))} label="New worktree" />
                    </label>
                </div>
            </fieldset>
            <div class="sg-f">
                <Show when={starting()} fallback={<Show when={message() || blocked()}>{(m) => <span class={`sg-msg ${message() ? "bad" : ""}`} role={message() ? "alert" : undefined}>{m()}</span>}</Show>}>
                    <span class="sg-msg"><Spinner size={13} /> Starting…</span>
                </Show>
                <span class="grow" />
                <button class="pbtn quiet" disabled={starting()} onClick={() => void setSuggestion(p.sessionId, s().id, "dismissed")}>
                    Dismiss
                </button>
                <button class="pbtn primary" disabled={starting() || Boolean(blocked())} onClick={() => void start()}>
                    {problem()?.retry && !starting() && !blocked() ? "Try again" : "Start"}
                </button>
            </div>
        </>
    );
}
