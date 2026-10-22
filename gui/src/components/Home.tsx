// Home (a new session): the mark, one question, where the session will run
// (project, branch or worktree), the composer, and a few ways to start.

import { createResource, createSignal, For, Show } from "solid-js";
import { ChevronDown, Folder, FolderGit2, FolderOpen, KeyRound, ListChecks, MessageSquareText, ShieldAlert, TerminalIcon } from "lucide-solid";
import { app, refreshProjects, reportError, rpc } from "../state/app";
import { chooseProject, connectCli, openProject, trustAndContinue } from "../state/actions";
import { columnHeight, requestComposerFocus, setSettingsTab } from "../state/ui";
import { ago, basename, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { CliSessions } from "./CliSessions";
import { Composer } from "./Composer";
import { Menu } from "./ui/Menu";
import { WorktreePicker } from "./WorktreePicker";
import { Logo } from "./ui/bits";

/** Ways to start, under the composer: a click puts the prompt in it, to edit or send. */
const STARTS = [
    { icon: MessageSquareText, label: "Explain this project", prompt: "Give me a tour of this project: what it does, how it's laid out, and where to start reading." },
    { icon: ListChecks, label: "Review my changes", prompt: "Review my uncommitted changes and point out anything that looks wrong." },
    { icon: TerminalIcon, label: "Fix failing tests", prompt: "Run the tests, find what fails, and fix it." },
];

/** Puts text in the composer under `root` as typing would (its draft, undo and autosize follow). */
function fillComposer(root: HTMLElement | undefined, text: string) {
    const ta = root?.querySelector("textarea");
    if (!ta) return;
    ta.focus();
    ta.select();
    if (!document.execCommand?.("insertText", false, text)) {
        ta.value = text;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    ta.setSelectionRange(text.length, text.length);
}

export function Home() {
    const [pickerOpen, setPickerOpen] = createSignal(false);
    /** The project pill: the recent-projects menu opens by it. */
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

    return (
        <div class="home">
            <div class="home-col" style={{ "--column-h": columnHeight() }}>
                <div class="home-hero">
                    <Logo size={44} />
                    <h1 class="home-q">{app.homeCwd ? "What should we work on?" : "Choose a project to start"}</h1>
                    <div class="home-where">
                        <button
                            class="pillbtn"
                            title={app.homeCwd ? `${tildify(app.homeCwd, app.hello?.homeDir)}: choose another folder` : "Choose a project folder"}
                            aria-haspopup="menu"
                            aria-expanded={pickerOpen()}
                            onClick={togglePicker}
                        >
                            <Folder size={14} />
                            <span class="truncate">{app.homeCwd ? basename(app.homeCwd) : "Choose a project"}</span>
                            <ChevronDown size={13} class="chev" />
                        </button>
                        <Show when={app.homeCwd && info()?.git}>
                            <WorktreePicker cwd={app.homeCwd!} branch={info()?.branch} />
                        </Show>
                    </div>
                </div>
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

                <Show when={info()?.needsTrust.length}>
                    <div class="trust-callout">
                        <ShieldAlert size={18} />
                        <div>
                            <div class="trust-title">Do you trust this folder?</div>
                            <div class="muted small">
                                It has configuration ({info()!.needsTrust.join(", ")}) that can run commands on your machine through hooks and MCP servers, and permission rules that let the agent act without asking. If you don't trust it, that configuration is ignored.
                            </div>
                            <div class="trust-actions">
                                <button class="btn primary sm" onClick={async () => { await trustAndContinue(app.homeCwd!, true); void refetch(); void refreshProjects(); }}>
                                    Trust this folder
                                </button>
                                <button class="btn secondary sm" onClick={async () => { await trustAndContinue(app.homeCwd!, false); void refetch(); }}>
                                    Open without its configuration
                                </button>
                            </div>
                        </div>
                    </div>
                </Show>

                <Show when={app.modelsLoaded && !app.modelsLoading && app.models.every((g) => !g.models.length)}>
                    <div class="trust-callout onboard">
                        <KeyRound size={18} />
                        <div>
                            <div class="trust-title">Connect a model provider</div>
                            <div class="muted small">
                                {clis().length ? "Use the plan you already have through the CLI installed on this computer, or paste" : "Paste"} an API key from Anthropic, OpenAI, Google, OpenRouter, Groq, DeepSeek, xAI, Mistral and others, or start Ollama or LM Studio on this machine. Keys go to your OS keychain and only to their own provider.
                            </div>
                            <div class="trust-actions">
                                <For each={clis()}>
                                    {(pr) => (
                                        <button class="btn primary sm" disabled={connecting() === pr.id} onClick={async () => {
                                            setConnecting(pr.id);
                                            await connectCli(pr);
                                            setConnecting(undefined);
                                        }}>
                                            Use my {pr.agentCli!.plan}
                                        </button>
                                    )}
                                </For>
                                <button class={`btn sm ${clis().length ? "secondary" : "primary"}`} onClick={() => setSettingsTab("providers")}>
                                    Add an API key
                                </button>
                            </div>
                        </div>
                    </div>
                </Show>

                <div class="home-composer" ref={composer}>
                    <Composer
                        variant="home"
                        autofocus
                        compare={info()?.git ? { available: true } : { available: false, why: app.homeCwd ? "Comparing models needs a Git repository: each model works in a worktree of its own." : "Choose a project folder first." }}
                        placeholder={app.homeCwd ? "Describe the task. / for commands, @ for files, ! to run a command" : "Choose a project folder to start"}
                    />
                </div>

                <Show when={app.homeCwd}>
                    <div class="home-starts">
                        <For each={STARTS}>
                            {(start) => (
                                <button title={start.prompt} onClick={() => fillComposer(composer, start.prompt)}>
                                    <start.icon size={14} />
                                    {start.label}
                                </button>
                            )}
                        </For>
                    </div>
                </Show>

                <Show when={app.homeCwd} keyed>
                    {(cwd) => <CliSessions cwd={cwd} />}
                </Show>
            </div>
        </div>
    );
}
