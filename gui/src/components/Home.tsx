// Home (a new session): a card asking what to work on, with where the session will run (the
// machine, the project, its folder and branch or worktree); a card to trust the folder when its
// settings run commands; sessions from this project's terminal to carry on here. The cards are
// centred in the column; the composer is at its foot, where a session has it.

import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Check, ChevronDown, FolderOpen, KeyRound } from "lucide-solid";
import type { ProviderInfo } from "@shared/protocol";
import { app, homeOn, homeProjects, noModel, refreshProjects, reportError, rpcFor, serversUi } from "../state/app";
import { chooseProject, connectCli, homeJumped, openProject, trustAndContinue } from "../state/actions";
import { requestComposerFocus, setSettingsTab, shellLayout } from "../state/ui";
import { sp } from "../state/prefs";
import { ago, basename, tildify } from "../lib/format";
import { isElectron, isWindowShown, machine } from "../lib/platform";
import { now } from "../lib/clock";
import { CliSessions } from "./CliSessions";
import { forgetInspected, inspect, inspectedBefore } from "../state/home-ahead";
import { Composer } from "./Composer";
import { Menu } from "./ui/Menu";
import { ProviderIcon } from "./ui/ProviderIcon";
import { WorktreePicker } from "./WorktreePicker";
import { ErrorCards } from "./ErrorCards";
import { motionMs } from "./LiveLine";

/** The composer's prefixes, under it at its far end: a click types one where the caret is. */
const HINTS = [
    { key: "/", word: "commands", title: "Commands", starts: true },
    { key: "@", word: "files", title: "Mention a file", starts: false },
    { key: "!", word: "shell", title: "Run a shell command yourself", starts: true },
];

/**
 * Types `text` into the composer under `root` where its caret is, as typing would: its draft, undo
 * and autosize follow, and so do its / and @ menus. An @ goes after a space, as the composer's own does.
 */

function typeInComposer(root: HTMLElement | undefined, text: string) {
    const ta = root?.querySelector("textarea");
    if (!ta) return;
    ta.focus();
    const at = ta.selectionStart ?? ta.value.length;
    const ins = text === "@" && at > 0 && !/\s/.test(ta.value[at - 1]!) ? " @" : text;
    if (!document.execCommand?.("insertText", false, ins)) {
        ta.value = ta.value.slice(0, at) + ins + ta.value.slice(ta.selectionEnd ?? at);
        ta.setSelectionRange(at + ins.length, at + ins.length);
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
}

// Heights (px at text size 14) that decide how many terminal rows fit above the composer: the title bar and the
// composer at the foot, the card of rows, a card under it (taller in a narrow column), the list's heading, and a row.
const FRAME_H = 220, GROUP_H = 240, CARD_H = 130, NARROW_CARD_H = 170, LIST_H = 52, ROW_H = 46;

/** How many terminal rows fit in the column with `cards` cards above the composer: 3 at most, down to none. */
function rowsFitting(column: { w: number; h: number }, cards: number): number {
    if (!column.h) return 3;
    const card = column.w && column.w <= 600 ? NARROW_CARD_H : CARD_H;
    return Math.max(0, Math.min(3, Math.floor((column.h - sp(FRAME_H + GROUP_H + cards * card + LIST_H)) / sp(ROW_H))));
}

/** A plan's own name, short enough for the row of ways in: "Claude subscription" → "Claude". */
const planName = (p: ProviderInfo) => (p.agentCli?.plan ?? p.name).replace(/\s+(subscription|plan|account)$/i, "");

export function Home() {
    const [pickerOpen, setPickerOpen] = createSignal(false);
    /** The project chip: the recent-projects menu opens by it. */
    const [pickerAnchor, setPickerAnchor] = createSignal<HTMLElement>();
    const [inspected, { refetch: inspectAgain, mutate }] = createResource(
        // On Home's machine (another's, in a folder of its own).
        () => (app.conn === "open" && app.homeCwd ? { path: app.homeCwd, on: homeOn() } : false),
        ({ path, on }) => {
            const fresh = inspect(rpcFor(undefined), on, path).catch((e) => {
                if (app.conn === "open") reportError(e);
                return undefined;
            });
            // Asked for before Home came here (state/home-ahead.ts): shown with the folder, and replaced by what's said now.
            const before = inspectedBefore(on, path);
            if (!before) return fresh;
            void fresh.then((r) => r && app.homeCwd === path && homeOn() === on && mutate(r));
            return before;
        },
    );
    /** After trusting or not: what it says now, not what it said before. */
    const refetch = () => {
        if (app.homeCwd) forgetInspected(homeOn(), app.homeCwd);
        return inspectAgain();
    };
    // No folder (none chosen yet, or none on the machine Home came back to): what the last one was isn't this one's.
    const info = () => (app.homeCwd ? inspected() : undefined);
    // Claude Code / Codex on this computer that aren't turned on yet: the user's own plan, one click away.
    const clis = () => (homeOn() !== undefined ? [] : app.providers.filter((p) => p.agentCli?.installed && !p.configured));
    // Another machine's has its sessions' models (one is open here).
    const modelMissing = () => homeOn() === undefined && noModel();
    const [connecting, setConnecting] = createSignal<string>();
    const needsTrust = () => info()?.needsTrust ?? [];
    const askTrust = () => Boolean(info()?.askTrust);
    // Only the edits' checks wait on it: a smaller card, and only once there's a model to make edits (the ways to
    // connect one take that place first).
    const askHere = () => Boolean(app.homeCwd && !needsTrust().length && askTrust() && !modelMissing());
    // The card for a folder whose settings run commands; the row of ways to connect a model is a third of one.
    const cards = () => (needsTrust().length ? 1 : askHere() ? 2 / 3 : 0) + (modelMissing() ? 1 / 3 : 0);
    const trust = async (yes: boolean) => {
        await trustAndContinue(app.homeCwd!, yes);
        void refetch();
        if (yes) void refreshProjects();
    };

    // The cards are centred in the column above the composer. When what's in them changes after Home is up (the
    // terminal sessions arrive, a card comes or goes), they glide to their new place rather than jump.
    let stack: HTMLDivElement | undefined;
    let scroller: HTMLDivElement | undefined;
    onMount(() => {
        if (!stack || !scroller || typeof ResizeObserver === "undefined") return;
        const el = stack;
        let last: number | undefined;
        const ro = new ResizeObserver((entries) => {
            const top = el.getBoundingClientRect().top;
            const moved = entries.some((e) => e.target === el) && last !== undefined && Math.abs(top - last) > 1;
            if (moved && isWindowShown() && !homeJumped()) {
                const ms = motionMs(260);
                if (ms) el.animate([{ transform: `translateY(${last! - top}px)` }, { transform: "none" }], { duration: ms, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
            }
            last = top;
        });
        ro.observe(el);
        ro.observe(scroller);
        onCleanup(() => ro.disconnect());
    });

    const togglePicker = (e: MouseEvent) => {
        setPickerAnchor(e.currentTarget as HTMLElement);
        setPickerOpen(!pickerOpen());
    };
    const pick = async () => {
        setPickerOpen(false);
        const path = await chooseProject(true);
        if (path) await openProject(path, true);
    };
    let composer: HTMLDivElement | undefined;
    // / and ! start a message (a command, a shell command), so they only type into an empty composer; @ goes anywhere.
    // The composer says each change (history and a send clearing it too); a click reads the box itself.
    const [typed, setTyped] = createSignal(false);
    const filled = () => Boolean(composer?.querySelector("textarea")?.value);
    // Drawn before the desktop window came up (at launch): the window appearing is its entrance.
    const instant = !isWindowShown();

    // Which machine it runs on, and the way to add a server: in the desktop app, and wherever there's more than this
    // one machine, once the window knows.
    const showWhere = () => Boolean(isElectron || machine || app.hello?.servers);
    const [where, setWhere] = createSignal<HTMLSpanElement>();
    /** Takes it away again: undefined until it's shown; called at once if this screen went first. */
    let unmountWhere: (() => void) | undefined;
    let whereShown = false;
    let left = false;
    createEffect(() => {
        const el = where();
        if (whereShown || !el || !showWhere()) return;
        whereShown = true;
        void serversUi().then((m) => {
            const off = m.mountWhere(el);
            if (left) off();
            else unmountWhere = off;
        }, reportError);
    });
    onCleanup(() => {
        left = true;
        unmountWhere?.();
    });

    /** Under the composer, at its far end: the composer's prefixes. */
    const hints = (
        <Show when={app.homeCwd}>
            <span class="grow" />
            <For each={HINTS}>
                {(h) => (
                    // Pressed, it leaves the caret in the composer, where the prefix goes.
                    <button
                        type="button"
                        class="hint-chip"
                        title={h.starts && typed() ? `${h.title}: start a message with ${h.key}` : h.title}
                        aria-disabled={h.starts && typed() ? "true" : undefined}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => (h.starts && filled() ? composer?.querySelector("textarea")?.focus() : typeInComposer(composer, h.key))}
                    >
                        <kbd class="kbd">{h.key}</kbd>
                        {h.word}
                    </button>
                )}
            </For>
        </Show>
    );

    return (
        <div class="home" classList={{ instant, "home-jumped": homeJumped() }}>
            <div class="home-scroll" ref={scroller}>
                <div class="home-stack" ref={stack}>
                    <section class="home-card card-surface card" aria-label="New session">
                        <h1 class="home-title">{!app.homeCwd ? "Choose a project to start" : modelMissing() ? "Connect a model to start" : "What should we work on?"}</h1>
                        {/* No model yet: the ways to connect one. A plan the user already has (Claude Code, Codex…) is one
                            click; a key is in Settings. */}
                        <Show when={modelMissing()}>
                            <div class="home-connect" role="group" aria-label="Connect a model">
                                <For each={clis()}>
                                    {(pr) => (
                                        <button class="btn btn-sm" title={`Use your ${pr.agentCli!.plan}`} disabled={connecting() === pr.id} onClick={async () => {
                                            setConnecting(pr.id);
                                            await connectCli(pr);
                                            setConnecting(undefined);
                                        }}>
                                            <ProviderIcon id={pr.id} name={pr.name} size={14} />
                                            {planName(pr)}
                                        </button>
                                    )}
                                </For>
                                <button class="btn btn-sm" title="Anthropic, OpenAI, Gemini and more" onClick={() => setSettingsTab("providers")}>
                                    <KeyRound size={14} />
                                    API key
                                </button>
                            </div>
                        </Show>
                        {/* Where it runs, and the servers to add or pick (components/Servers.tsx puts it here). */}
                        <Show when={showWhere()}>
                            <div class="home-row">
                                <span class="home-label">Runs on</span>
                                <span class="home-at" ref={setWhere} />
                            </div>
                        </Show>
                        <div class="home-row">
                            <span class="home-label">Project</span>
                            <button class="select home-select" title={app.homeCwd ? "Choose another folder" : undefined} aria-haspopup="menu" aria-expanded={pickerOpen()} onClick={togglePicker}>
                                <span class="select-value">{app.homeCwd ? basename(app.homeCwd) : "Choose a project"}</span>
                                <ChevronDown size={13} class="select-caret" />
                            </button>
                        </div>
                        <Show when={app.homeCwd}>
                            {(cwd) => (
                                <div class="home-row">
                                    <span class="home-label">Folder</span>
                                    {/* Cut in the middle, so the folder's own name stays. */}
                                    <span class="home-value home-path mono" title={cwd()}>
                                        <span class="home-path-dir">{tildify(cwd(), app.hello?.homeDir).slice(0, tildify(cwd(), app.hello?.homeDir).length - basename(cwd()).length)}</span>
                                        <span class="home-path-name">{basename(cwd())}</span>
                                    </span>
                                </div>
                            )}
                        </Show>
                        {/* Worktrees are made on the window's own machine. */}
                        <Show when={app.homeCwd && info()?.git}>
                            <div class="home-row">
                                <span class="home-label">Branch</span>
                                <WorktreePicker cwd={app.homeCwd!} branch={info()?.branch} />
                            </div>
                        </Show>
                    </section>

                    {/* A folder whose settings run commands: asked before the first message. */}
                    <Show when={needsTrust().length}>
                        <section class="home-card card-surface card home-trust" role="group" aria-label="Trust this folder">
                            <h2 class="home-cli-title">Do you trust this folder?</h2>
                            <p class="home-trust-text">
                                {basename(app.homeCwd ?? "")} has settings (
                                <For each={needsTrust()}>{(f, i) => <>{i() ? ", " : ""}<code>{f}</code></>}</For>
                                ) that can run commands on {(homeOn() ?? machine) || "this computer"}.
                            </p>
                            <div class="home-trust-actions">
                                <button class="btn btn-primary" onClick={async () => { await trustAndContinue(app.homeCwd!, true); void refetch(); void refreshProjects(); }}>
                                    Trust this folder
                                </button>
                                <button class="btn" onClick={async () => { await trustAndContinue(app.homeCwd!, false); void refetch(); }}>
                                    Open without them
                                </button>
                            </div>
                        </section>
                    </Show>

                    {/* Only the edits' checks wait on it: asked once there's a model to make edits. */}
                    <Show when={askHere()}>
                        <section class="home-card card-surface card home-trust" role="group" aria-label="Trust this folder">
                            <h2 class="home-cli-title">Trust this folder to check edits?</h2>
                            <div class="home-trust-actions">
                                <button class="btn btn-primary" onClick={() => void trust(true)}>
                                    Trust this folder
                                </button>
                                <button class="btn" onClick={() => void trust(false)}>
                                    Not now
                                </button>
                            </div>
                        </section>
                    </Show>

                    <Show when={app.homeCwd && homeOn() === undefined ? app.homeCwd : undefined} keyed>
                        {(cwd) => <CliSessions cwd={cwd} rows={rowsFitting(shellLayout().column, cards())} />}
                    </Show>
                </div>
            </div>

            <div class="composer-wrap composer-wrap-home">
                <div class="composer-col" ref={(el) => (composer = el)}>
                    <ErrorCards place="home" />
                    <Composer
                        variant="home"
                        autofocus
                        under={hints}
                        onText={(t) => setTyped(Boolean(t))}
                        compare={homeOn() !== undefined ? { available: false, why: "Not on another machine yet." } : info()?.git ? { available: true } : { available: false, why: app.homeCwd ? "Needs a Git repository." : "Choose a project folder first." }}
                        placeholder={!app.homeCwd ? "Choose a project folder to start" : "Describe a task or ask a question"}
                    />
                </div>
            </div>

            <Menu label="Recent projects" open={pickerOpen()} anchor={pickerAnchor} onClose={() => setPickerOpen(false)} width={336} align="end" class="menu menu-wide">
                <div class="menu-label">Recent projects</div>
                <For each={homeProjects()} fallback={<p class="menu-none">No projects yet.</p>}>
                    {(pr) => (
                        <button
                            role="menuitemradio"
                            aria-checked={pr.path === app.homeCwd}
                            class="menu-item menu-item-two"
                            onClick={() => {
                                setPickerOpen(false);
                                void openProject(pr.path, true);
                                requestComposerFocus();
                            }}
                        >
                            <span class="menu-check">
                                <Show when={pr.path === app.homeCwd}>
                                    <Check size={14} />
                                </Show>
                            </span>
                            <span class="menu-item-text">
                                <span class="menu-item-name">{pr.name}</span>
                                <span class="menu-item-sub">
                                    <span class="mono">{tildify(pr.path, app.hello?.homeDir)}</span>
                                </span>
                            </span>
                            <Show when={pr.openedAt}>
                                <span class="menu-item-note">opened {(now(), /^(now|\d+[mh])$/.test(ago(pr.openedAt!)) ? "today" : ago(pr.openedAt!))}</span>
                            </Show>
                        </button>
                    )}
                </For>
                <div class="menu-sep" />
                <button role="menuitem" class="menu-item" onClick={() => void pick()}>
                    <FolderOpen size={14} />
                    <span class="menu-item-name">Open folder…</span>
                </button>
            </Menu>
        </div>
    );
}
