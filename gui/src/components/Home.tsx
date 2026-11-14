// Home (a new session): one question; the composer, with where the session will run
// (project, branch or worktree) and the composer's prefixes in a drawer under it; and
// sessions from this project's terminal to carry on here. The whole group sits a
// little above the middle of the column (home.css).

import { createEffect, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChevronDown, Folder, FolderGit2, FolderOpen, KeyRound, Shield } from "lucide-solid";
import type { ProviderInfo } from "@shared/protocol";
import { app, refreshProjects, reportError, rpc, serversUi } from "../state/app";
import { chooseProject, connectCli, openProject, trustAndContinue } from "../state/actions";
import { columnHeight, requestComposerFocus, setSettingsTab, shellLayout } from "../state/ui";
import { sp } from "../state/prefs";
import { ago, basename, tildify } from "../lib/format";
import { isElectron, isWindowShown, machine } from "../lib/platform";
import { now } from "../lib/clock";
import { CliSessions } from "./CliSessions";
import { Composer } from "./Composer";
import { Menu } from "./ui/Menu";
import { ProviderIcon } from "./ui/ProviderIcon";
import { WorktreePicker } from "./WorktreePicker";
import { ErrorCards } from "./ErrorCards";

/** The composer's prefixes, at the strip's end: a click types one where the caret is. */
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

// Heights (px at text size 14) that decide how many terminal rows fit under the composer, as home.css
// places the group: the title bar's row and the foot, the question and the composer with its strip, a
// card above it (taller in a narrow column, its buttons stacked), the list's heading, and a row.
const FRAME_H = 80, GROUP_H = 200, CARD_H = 150, NARROW_CARD_H = 220, LIST_H = 62, ROW_H = 47;

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
    const [info, { refetch }] = createResource(
        () => app.conn === "open" && app.homeCwd,
        (path) =>
            rpc.call("projects.inspect", { path }).catch((e) => {
                if (app.conn === "open") reportError(e);
                return undefined;
            }),
    );
    // Claude Code / Codex on this computer that aren't turned on yet: the user's own plan, one click away.
    const clis = () => app.providers.filter((p) => p.agentCli?.installed && !p.configured);
    const [connecting, setConnecting] = createSignal<string>();
    // Once known, kept while the lists load again (opening the model picker does that): the row under the question
    // would otherwise go and come back.
    const noModel = () => Boolean(app.modelsLoaded && app.models.every((g) => !g.models.length));
    const needsTrust = () => info()?.needsTrust ?? [];
    const askTrust = () => Boolean(info()?.askTrust);
    // The card for a folder whose settings run commands; the row of ways to connect a model is a third of one.
    const cards = () => (needsTrust().length ? 1 : 0) + (noModel() ? 1 / 3 : 0);
    const [trustOpen, setTrustOpen] = createSignal(false);
    const [trustAnchor, setTrustAnchor] = createSignal<HTMLElement>();
    const trust = async (yes: boolean) => {
        setTrustOpen(false);
        await trustAndContinue(app.homeCwd!, yes);
        void refetch();
        if (yes) void refreshProjects();
    };

    // The terminal rows shown under the composer: home.css places the group by them. When they arrive
    // (or go) after Home is up, the group glides to its new place rather than jumping.
    const [cliRows, setCliRows] = createSignal(0);
    const [glide, setGlide] = createSignal(false);
    let glideTimer: ReturnType<typeof setTimeout> | undefined;
    const [cliOn, setCliOn] = createSignal(false);
    const shown = (n: number, section: boolean) => {
        if (n === cliRows() && section === cliOn()) return;
        clearTimeout(glideTimer);
        setGlide(isWindowShown());
        setCliRows(n);
        setCliOn(section);
        glideTimer = setTimeout(() => setGlide(false), 600);
    };
    onCleanup(() => clearTimeout(glideTimer));


    const togglePicker = (e: MouseEvent) => {
        setPickerAnchor(e.currentTarget as HTMLElement);
        setPickerOpen(!pickerOpen());
    };
    const pick = async () => {
        setPickerOpen(false);
        const path = await chooseProject();
        if (path) await openProject(path);
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
    let where: HTMLSpanElement | undefined;
    /** Takes it away again: undefined until it's shown; called at once if this screen went first. */
    let unmountWhere: (() => void) | undefined;
    let whereShown = false;
    let left = false;
    createEffect(() => {
        if (whereShown || !where || !(isElectron || machine || app.hello?.servers)) return;
        whereShown = true;
        const el = where;
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

    /** Under the composer, like a drawer: where the session runs, then the composer's prefixes. */
    const strip = (
        <>
            {/* Where it runs, and the servers to add or pick (components/Servers.tsx puts it here). */}
            <span class="strip-at" ref={where} />
            <button
                class="strip-ctl"
                title={app.homeCwd ? `${tildify(app.homeCwd, app.hello?.homeDir)}: choose another folder` : "Choose a project folder"}
                aria-haspopup="menu"
                aria-expanded={pickerOpen()}
                onClick={togglePicker}
            >
                <Folder size={14} class="ic" />
                <span class="truncate">{app.homeCwd ? basename(app.homeCwd) : "Choose a project"}</span>
                <ChevronDown size={12} stroke-width={2} class="chv" />
            </button>
            <Show when={app.homeCwd && info()?.git}>
                <WorktreePicker cwd={app.homeCwd!} branch={info()?.branch} />
            </Show>
            {/* Only the edits' checks wait on it, so it's asked here, quietly, by the folder it's about. */}
            <Show when={app.homeCwd && !needsTrust().length && askTrust()}>
                <button ref={setTrustAnchor} class="strip-ctl" title="Edits get checked for errors only in folders you trust" aria-haspopup="menu" aria-expanded={trustOpen()} onClick={() => setTrustOpen(!trustOpen())}>
                    <Shield size={14} class="ic" />
                    <span class="truncate">Not trusted</span>
                    <ChevronDown size={12} stroke-width={2} class="chv" />
                </button>
            </Show>
            <span class="grow" />
            <Show when={app.homeCwd}>
                <span class="strip-hints">
                    <For each={HINTS}>
                        {(h) => (
                            // Pressed, it leaves the caret in the composer, where the prefix goes.
                            <button
                                title={h.starts && typed() ? `${h.title}: start a message with ${h.key}` : h.title}
                                aria-disabled={h.starts && typed() ? "true" : undefined}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => (h.starts && filled() ? composer?.querySelector("textarea")?.focus() : typeInComposer(composer, h.key))}
                            >
                                <kbd class="k">{h.key}</kbd>
                                {h.word}
                            </button>
                        )}
                    </For>
                </span>
            </Show>
        </>
    );

    return (
        <div class="home" classList={{ instant, glide: glide() }}>
            <div
                class="home-col"
                style={{ "--column-h": columnHeight(), "--cli-rows": app.homeCwd ? cliRows() : 0, "--cli-on": app.homeCwd && cliOn() ? 1 : 0, "--home-cards": cards() }}
            >
                <h1 class="home-q">{!app.homeCwd ? "Choose a project to start" : noModel() ? "Connect a model to start" : "What should we work on?"}</h1>
                <Menu label="Trust this folder" open={trustOpen()} anchor={trustAnchor} onClose={() => setTrustOpen(false)} width={280}>
                    <div class="menu-head">Trust {basename(app.homeCwd ?? "")}?</div>
                    <div class="menu-note">Edits get checked for errors only in folders you trust.</div>
                    <div class="menu-sep" />
                    <button role="menuitem" class="menu-item" onClick={() => void trust(true)}>
                        <span class="menu-label">Trust</span>
                    </button>
                    <button role="menuitem" class="menu-item" onClick={() => void trust(false)}>
                        <span class="menu-label">Not now</span>
                    </button>
                </Menu>
                <Menu label="Recent projects" open={pickerOpen()} anchor={pickerAnchor} onClose={() => setPickerOpen(false)} width={420}>
                    <div class="menu-head">Recent projects</div>
                    <For each={app.projects} fallback={<div class="menu-note">No projects yet.</div>}>
                        {(pr) => (
                            <button
                                role="menuitem"
                                class={`menu-item ${pr.path === app.homeCwd ? "current" : ""}`}
                                onClick={() => {
                                    setPickerOpen(false);
                                    void openProject(pr.path);
                                    requestComposerFocus();
                                }}
                            >
                                <FolderGit2 size={15} />
                                <span class="menu-text">
                                    <span class="menu-label">{pr.name}</span>
                                    <span class="menu-desc mono truncate">{tildify(pr.path, app.hello?.homeDir)}</span>
                                </span>
                                <Show when={pr.openedAt}>
                                    <span class="muted small">{(now(), ago(pr.openedAt!))}</span>
                                </Show>
                            </button>
                        )}
                    </For>
                    <div class="menu-sep" />
                    <button role="menuitem" class="menu-item" onClick={() => void pick()}>
                        <FolderOpen size={15} />
                        <span class="menu-label">Open folder…</span>
                    </button>
                </Menu>

                <div class="home-composer" ref={(el) => (composer = el)}>
                    <ErrorCards place="home" />

                    {/* What comes before the first message, shaped like the request cards: trusting the folder, connecting a model. */}
                    <Show when={needsTrust().length}>
                        <div class="hcard card-surface trust" role="group" aria-label="Trust this folder">
                            <div class="ask-h">
                                <span class="ask-title">Do you trust this folder?</span>
                            </div>
                            <p>
                                <b>{basename(app.homeCwd ?? "")}</b> has settings (
                                <For each={needsTrust()}>{(f, i) => <>{i() ? ", " : ""}<code>{f}</code></>}</For>
                                ) that can run commands on this computer.
                            </p>
                            <div class="ask-row">
                                <button class="pbtn primary" onClick={async () => { await trustAndContinue(app.homeCwd!, true); void refetch(); void refreshProjects(); }}>
                                    Trust this folder
                                </button>
                                <span class="grow" />
                                <button class="pbtn quiet" onClick={async () => { await trustAndContinue(app.homeCwd!, false); void refetch(); }}>
                                    Open without them
                                </button>
                            </div>
                        </div>
                    </Show>

                    {/* No model yet: the ways to connect one, under the question that asks for it. A plan the user already
                        has (Claude Code, Codex…) is one click; a key is in Settings. */}
                    <Show when={noModel()}>
                        <div class="home-connect" role="group" aria-label="Connect a model">
                            <For each={clis()}>
                                {(pr) => (
                                    <button class="strip-ctl" title={`Use your ${pr.agentCli!.plan}`} disabled={connecting() === pr.id} onClick={async () => {
                                        setConnecting(pr.id);
                                        await connectCli(pr);
                                        setConnecting(undefined);
                                    }}>
                                        <ProviderIcon id={pr.id} name={pr.name} size={16} />
                                        {planName(pr)}
                                    </button>
                                )}
                            </For>
                            <button class="strip-ctl" title="Anthropic, OpenAI, Gemini and more, in Settings" onClick={() => setSettingsTab("providers")}>
                                <KeyRound size={15} class="ic" />
                                API key
                            </button>
                        </div>
                    </Show>

                    <Composer
                        variant="home"
                        autofocus
                        strip={strip}
                        onText={(t) => setTyped(Boolean(t))}
                        compare={info()?.git ? { available: true } : { available: false, why: app.homeCwd ? "Comparing models needs a Git repository." : "Choose a project folder first." }}
                        placeholder={!app.homeCwd ? "Choose a project folder to start" : "Describe a task or ask a question"}
                    />
                </div>

                <Show when={app.homeCwd} keyed>
                    {(cwd) => <CliSessions cwd={cwd} rows={rowsFitting(shellLayout().column, cards())} onShown={shown} />}
                </Show>
            </div>
        </div>
    );
}
