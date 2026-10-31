// Home (a new session): one question; the composer, with where the session will run
// (project, branch or worktree) and the composer's prefixes in a drawer under it; and
// sessions from this project's terminal to carry on here. The whole group sits a
// little above the middle of the column (home.css).

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ChevronDown, Folder, FolderGit2, FolderOpen, KeyRound, Plug, ShieldAlert } from "lucide-solid";
import { app, refreshProjects, reportError, rpc } from "../state/app";
import { chooseProject, connectCli, openProject, trustAndContinue } from "../state/actions";
import { columnHeight, requestComposerFocus, setFollowing, setSettingsTab, shellLayout } from "../state/ui";
import { sp } from "../state/prefs";
import { ago, basename, tildify } from "../lib/format";
import { isWindowShown } from "../lib/platform";
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
/** "A, B or C". */
function orList(names: string[]): string {
    return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : (names[0] ?? "");
}

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
    const noModel = () => Boolean(app.modelsLoaded && !app.modelsLoading && app.models.every((g) => !g.models.length));
    const needsTrust = () => info()?.needsTrust ?? [];
    const cards = () => (needsTrust().length ? 1 : 0) + (noModel() ? 1 : 0);

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

    // Nothing passes behind the glass here until the column scrolls: the sheet shows through, as at a reply's end (base.css).
    onMount(() => setFollowing(true));
    onCleanup(() => setFollowing(false));

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

    /** Under the composer, like a drawer: where the session runs, then the composer's prefixes. */
    const strip = (
        <>
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
        <div class="home" classList={{ instant, glide: glide() }} onScroll={(e) => setFollowing(e.currentTarget.scrollTop <= 0)}>
            <div
                class="home-col"
                style={{ "--column-h": columnHeight(), "--cli-rows": app.homeCwd ? cliRows() : 0, "--cli-on": app.homeCwd && cliOn() ? 1 : 0, "--home-cards": cards() }}
            >
                <h1 class="home-q">{app.homeCwd ? "What should we work on?" : "Choose a project to start"}</h1>
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
                        <div class="hcard glass trust" role="group" aria-label="Trust this folder">
                            <div class="ask-h">
                                <span class="ask-ic"><ShieldAlert size={16} /></span>
                                <span class="ask-title">Do you trust this folder?</span>
                            </div>
                            <p>
                                <b>{basename(app.homeCwd ?? "")}</b> has settings (
                                <For each={needsTrust()}>{(f, i) => <>{i() ? ", " : ""}<code>{f}</code></>}</For>
                                ) that can run commands on this computer.
                            </p>
                            <div class="ask-row">
                                <button class="pbtn" onClick={async () => { await trustAndContinue(app.homeCwd!, false); void refetch(); }}>
                                    Open without them
                                </button>
                                <button class="pbtn primary" onClick={async () => { await trustAndContinue(app.homeCwd!, true); void refetch(); void refreshProjects(); }}>
                                    Trust this folder
                                </button>
                            </div>
                        </div>
                    </Show>

                    <Show when={noModel()}>
                        <div class="hcard glass connect" role="group" aria-label="Connect a model">
                            <div class="ask-h">
                                <span class="ask-ic"><Plug size={16} /></span>
                                <span class="ask-title">Connect a model to start</span>
                            </div>
                            <p>
                                {clis().length === 1
                                    ? `Use the ${clis()[0]!.agentCli!.plan} you already have through ${clis()[0]!.name}, add`
                                    : clis().length
                                      ? `Use a plan you already have through ${orList(clis().map((pr) => pr.name))}, add`
                                      : "Add"}{" "}
                                an API key, or start Ollama or LM Studio on this computer.
                            </p>
                            <div class="ask-row">
                                <button class={`pbtn ${clis().length ? "" : "primary"}`} onClick={() => setSettingsTab("providers")}>
                                    <KeyRound size={14} />
                                    Add an API key
                                </button>
                                <For each={clis()}>
                                    {(pr) => (
                                        <button class="pbtn primary" disabled={connecting() === pr.id} onClick={async () => {
                                            setConnecting(pr.id);
                                            await connectCli(pr);
                                            setConnecting(undefined);
                                        }}>
                                            <ProviderIcon id={pr.id} name={pr.name} size={14} />
                                            Use my {pr.agentCli!.plan}
                                        </button>
                                    )}
                                </For>
                            </div>
                        </div>
                    </Show>

                    <Composer
                        variant="home"
                        autofocus
                        strip={strip}
                        onText={(t) => setTyped(Boolean(t))}
                        compare={info()?.git ? { available: true } : { available: false, why: app.homeCwd ? "Comparing models needs a Git repository." : "Choose a project folder first." }}
                        placeholder={!app.homeCwd ? "Choose a project folder to start" : noModel() ? "Connect a model to start" : "Describe a task or ask a question"}
                    />
                </div>

                <Show when={app.homeCwd} keyed>
                    {(cwd) => <CliSessions cwd={cwd} rows={rowsFitting(shellLayout().column, cards())} onShown={shown} />}
                </Show>
            </div>
        </div>
    );
}
