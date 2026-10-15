import { createResource, createSignal, For, Show } from "solid-js";
import { Bug, ChevronDown, Compass, FlaskConical, FolderGit2, FolderOpen, GitPullRequest, KeyRound, ShieldAlert } from "lucide-solid";
import { activate, app, refreshProjects, rpc } from "../state/app";
import { chooseProject, openProject, send, trustAndContinue } from "../state/actions";
import { requestComposerFocus, setSettingsTab } from "../state/ui";
import { ago, basename, tildify } from "../lib/format";
import { now } from "../lib/clock";
import { Composer } from "./Composer";
import { Popover } from "./ui/Popover";
import { Logo } from "./ui/bits";

const SUGGESTIONS = [
    { icon: Compass, label: "Explain this codebase", text: "Give me a tour of this codebase: what it does, how it's structured, and where the important pieces live." },
    { icon: Bug, label: "Find and fix a bug", text: "Find a bug in this project, explain it, and fix it." },
    { icon: FlaskConical, label: "Add missing tests", text: "Find an important piece of logic without tests and write good tests for it." },
    { icon: GitPullRequest, label: "Review my changes", text: "/review" },
];

function greeting(): string {
    const h = new Date().getHours();
    return h < 5 ? "Working late?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Home() {
    const [pickerOpen, setPickerOpen] = createSignal(false);
    let projBtn: HTMLButtonElement | undefined;
    const [info, { refetch }] = createResource(
        () => app.homeCwd,
        (path) => rpc.call("projects.inspect", { path }),
    );
    const recent = () => app.sessions.filter((s) => s.cwd === app.homeCwd).slice(0, 5);
    const [pending, setPending] = createSignal<string>();

    const pick = async () => {
        setPickerOpen(false);
        const path = await chooseProject();
        if (path) await openProject(path);
    };

    return (
        <div class="home">
            <div class="home-inner">
                <div class="home-hero">
                    <Logo size={40} />
                    <h1>{greeting()}</h1>
                    <p class="muted">What should we work on{app.homeCwd ? ` in ${basename(app.homeCwd)}` : ""}?</p>
                </div>

                <div class="home-project">
                    <button ref={projBtn} class="project-btn" onClick={() => setPickerOpen(!pickerOpen())}>
                        <FolderGit2 size={15} />
                        <Show when={app.homeCwd} fallback={<span>Choose a project folder</span>}>
                            <span class="project-name">{basename(app.homeCwd!)}</span>
                            <span class="project-path truncate">{tildify(app.homeCwd!, app.hello?.homeDir)}</span>
                            <Show when={info()?.branch}>
                                <span class="chip mono tiny">{info()!.branch}</span>
                            </Show>
                        </Show>
                        <ChevronDown size={13} />
                    </button>
                    <Popover open={pickerOpen()} anchor={() => projBtn} onClose={() => setPickerOpen(false)} width={420}>
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
                </div>

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
                            <div class="muted small">Paste an API key from Anthropic, OpenAI, Google, OpenRouter, Groq, DeepSeek, xAI, Mistral and others, or start Ollama or LM Studio on this machine. Keys go to your OS keychain and only to their own provider.</div>
                            <div class="trust-actions">
                                <button class="btn primary sm" onClick={() => setSettingsTab("providers")}>
                                    Add an API key
                                </button>
                            </div>
                        </div>
                    </div>
                </Show>

                <Composer variant="home" autofocus placeholder={app.homeCwd ? "Describe a task, ask a question, or paste an error…" : "Choose a project folder to start"} />
                <Show when={pending()}>{(t) => <div class="muted small">{t()}</div>}</Show>

                <div class="suggestions">
                    <For each={SUGGESTIONS}>
                        {(s) => (
                            <button
                                class="suggestion"
                                disabled={!app.homeCwd || Boolean(info()?.needsTrust.length)}
                                onClick={() => {
                                    setPending(undefined);
                                    void send(s.text);
                                }}
                            >
                                <s.icon size={15} />
                                <span>{s.label}</span>
                            </button>
                        )}
                    </For>
                </div>

                <Show when={recent().length}>
                    <div class="home-recent">
                        <div class="home-recent-head">Recent in {basename(app.homeCwd!)}</div>
                        <For each={recent()}>
                            {(s) => (
                                <button class="home-recent-item" onClick={() => void activate(s.id)}>
                                    <span class="truncate">{s.title}</span>
                                    <span class="muted small">{(now(), ago(s.updatedAt))}</span>
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
            </div>
        </div>
    );
}
