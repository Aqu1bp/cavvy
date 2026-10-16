// Home: one question, the composer, and where the session will run. The
// project is picked in the question itself; the folder and branch sit in a
// strip under the composer.

import { createResource, createSignal, For, Show } from "solid-js";
import { ChevronDown, Folder, FolderGit2, FolderOpen, KeyRound, ShieldAlert } from "lucide-solid";
import { app, refreshProjects, rpc } from "../state/app";
import { chooseProject, connectCli, openProject, trustAndContinue } from "../state/actions";
import { requestComposerFocus, setSettingsTab } from "../state/ui";
import { ago, basename, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { Composer } from "./Composer";
import { Popover } from "./ui/Popover";
import { WorktreePicker } from "./WorktreePicker";

export function Home() {
    const [pickerOpen, setPickerOpen] = createSignal(false);
    /** The question's project name or the strip's folder: the menu opens by the one you used. */
    const [pickerAnchor, setPickerAnchor] = createSignal<HTMLElement>();
    const [info, { refetch }] = createResource(
        () => app.homeCwd,
        (path) => rpc.call("projects.inspect", { path }),
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
    const projectButton = () => (
        <button class="inline-pick" aria-haspopup="menu" aria-expanded={pickerOpen()} onClick={togglePicker}>
            <span class="truncate">{app.homeCwd ? basename(app.homeCwd) : "Choose a project"}</span>
        </button>
    );

    return (
        <div class="home">
            <div class="home-inner">
                <h1 class="home-q" aria-label={app.homeCwd ? `What should we build in ${basename(app.homeCwd)}?` : "Choose a project to start"}>
                    <Show when={app.homeCwd} fallback={<>{projectButton()} to start</>}>
                        What should we build in {projectButton()}?
                    </Show>
                </h1>
                <Popover open={pickerOpen()} anchor={pickerAnchor} onClose={() => setPickerOpen(false)} width={420}>
                    <div class="menu-head">Recent projects</div>
                    <For each={app.projects} fallback={<div class="menu-note">No projects yet.</div>}>
                        {(pr) => (
                            <button
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
                    <button class="menu-item" onClick={() => void pick()}>
                        <FolderOpen size={15} />
                        <span class="menu-label">Open folder…</span>
                    </button>
                </Popover>

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

                <Composer
                    variant="home"
                    autofocus
                    placeholder={app.homeCwd ? "Describe a task, ask a question, or paste an error…" : "Choose a project folder to start"}
                    strip={
                        app.homeCwd ? (
                            <>
                                <button class="strip-ctl" title={`${tildify(app.homeCwd, app.hello?.homeDir)}: choose another folder`} aria-haspopup="menu" onClick={togglePicker}>
                                    <Folder size={13} />
                                    <span class="truncate">{tildify(app.homeCwd, app.hello?.homeDir)}</span>
                                    <ChevronDown size={12} class="chv" />
                                </button>
                                <span class="grow" />
                                <Show when={info()?.git}>
                                    <WorktreePicker cwd={app.homeCwd!} branch={info()?.branch} />
                                </Show>
                            </>
                        ) : undefined
                    }
                />
            </div>
        </div>
    );
}
