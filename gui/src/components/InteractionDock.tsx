// What the agent is waiting on you for: a permission, a question, a plan.
// Shown above the input box. Its buttons never take focus by themselves, so
// an Enter meant for the input can't approve anything; the number keys and
// Esc work when you're not typing.

import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { AlertTriangle, Bot, ClipboardList, FilePen, Globe, MessageCircleQuestion, Plug, ShieldAlert, SquareTerminal, Zap } from "lucide-solid";
import type { Interaction, PermissionInteraction, PlanInteraction, QuestionInteraction } from "@shared/protocol";
import { openAgents, respond } from "../state/actions";
import { CodeBlock } from "./blocks/CodeBlock";
import { DiffView } from "./blocks/DiffView";
import { Markdown } from "./blocks/Markdown";

function typing(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return Boolean(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable));
}

/** Number keys and Esc, while this card is the one showing. */
function useKeys(handler: (key: string) => boolean) {
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || typing() || document.querySelector(".dialog-backdrop, .popover")) return;
            if (handler(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", onKey, true);
        onCleanup(() => window.removeEventListener("keydown", onKey, true));
    });
}

export function InteractionDock(p: { sessionId: string; items: Interaction[] }) {
    const first = () => p.items[0];
    return (
        <Show when={first()} keyed>
            {(it) => (
                <div class={`dock dock-${it.kind} ${it.kind === "permission" && it.dangerous ? "danger" : ""}`} role="alertdialog" aria-label="Waiting for you">
                    <Show when={p.items.length > 1}>
                        <div class="dock-count">1 of {p.items.length} waiting</div>
                    </Show>
                    <Switch>
                        <Match when={it.kind === "permission"}>
                            <PermissionCard sessionId={p.sessionId} it={it as PermissionInteraction} />
                        </Match>
                        <Match when={it.kind === "question"}>
                            <QuestionCard sessionId={p.sessionId} it={it as QuestionInteraction} />
                        </Match>
                        <Match when={it.kind === "plan"}>
                            <PlanCard sessionId={p.sessionId} it={it as PlanInteraction} />
                        </Match>
                    </Switch>
                </div>
            )}
        </Show>
    );
}

function PermIcon(p: { it: PermissionInteraction }) {
    return (
        <Switch fallback={<ShieldAlert size={16} />}>
            <Match when={p.it.toolName === "Bash"}>
                <SquareTerminal size={16} />
            </Match>
            <Match when={p.it.category === "edit"}>
                <FilePen size={16} />
            </Match>
            <Match when={p.it.toolName === "WebFetch"}>
                <Globe size={16} />
            </Match>
            <Match when={p.it.category === "mcp"}>
                <Plug size={16} />
            </Match>
        </Switch>
    );
}

function PermissionCard(p: { sessionId: string; it: PermissionInteraction }) {
    const [feedback, setFeedback] = createSignal<string | undefined>();
    const [busy, setBusy] = createSignal(false);
    const answer = async (choice: PermissionInteraction["options"][number]["id"]) => {
        if (busy()) return;
        setBusy(true);
        await respond(p.sessionId, p.it.id, { kind: "permission", choice, feedback: choice === "no" ? feedback() : undefined });
    };
    useKeys((k) => {
        const i = Number(k);
        if (i >= 1 && i <= p.it.options.length) {
            const opt = p.it.options[i - 1]!;
            if (opt.id === "no") setFeedback((f) => f ?? "");
            else void answer(opt.id);
            return true;
        }
        if (k === "Escape") {
            void answer("no");
            return true;
        }
        return false;
    });
    return (
        <>
            <div class="dock-head">
                <span class="dock-icon">
                    <PermIcon it={p.it} />
                </span>
                <div class="dock-titles">
                    <div class="dock-title">{p.it.heading}</div>
                    <Show when={p.it.agentLabel}>
                        <div class="dock-sub">
                            <Bot size={12} /> Requested by sub-agent ·{" "}
                            <Show when={p.it.agentId} fallback={p.it.agentLabel}>
                                <button class="link-btn" tabIndex={-1} title="See what it has done so far" onClick={() => openAgents(p.it.agentId)}>
                                    {p.it.agentLabel}
                                </button>
                            </Show>
                        </div>
                    </Show>
                </div>
            </div>
            <Show when={p.it.dangerous}>
                <div class="dock-warn">
                    <AlertTriangle size={14} /> {p.it.reason ?? "This action looks potentially destructive."}
                </div>
            </Show>
            <div class="dock-body">
                <Show when={p.it.command !== undefined}>
                    <CodeBlock code={p.it.command!} lang="bash" bare maxHeight={220} />
                    <Show when={p.it.description}>
                        <div class="dock-desc">{p.it.description}</div>
                    </Show>
                    <Show when={p.it.hosts?.length}>
                        <div class="dock-desc">Sandboxed, with network access to {p.it.hosts!.join(", ")}</div>
                    </Show>
                </Show>
                <Show when={p.it.diff}>
                    <DiffView diff={p.it.diff!} header maxLines={40} class="dock-diff" />
                </Show>
                <Show when={!p.it.diff && p.it.path}>
                    <div class="dock-path mono">{p.it.path}</div>
                </Show>
                <Show when={p.it.url}>
                    <div class="dock-path mono">{p.it.url}</div>
                    <Show when={p.it.description}>
                        <div class="dock-desc">{p.it.description}</div>
                    </Show>
                </Show>
                <Show when={p.it.json}>
                    <div class="dock-path">{p.it.title}</div>
                    <CodeBlock code={p.it.json!} lang="json" bare maxHeight={200} />
                </Show>
                <Show when={!p.it.command && !p.it.diff && !p.it.path && !p.it.url && !p.it.json}>
                    <div class="dock-path">{p.it.title}</div>
                </Show>
                <Show when={!p.it.dangerous && p.it.reason && p.it.toolName !== "Bash"}>
                    <div class="dock-desc">{p.it.reason}</div>
                </Show>
                <Show when={p.it.classifierReason}>
                    <div class="dock-auto">
                        <Zap size={13} /> Auto mode asked you because: {p.it.classifierReason}
                    </div>
                </Show>
            </div>
            <Show when={feedback() !== undefined}>
                <textarea
                    class="dock-feedback"
                    rows={2}
                    autofocus
                    placeholder="Tell it what to do instead (optional), then press Enter"
                    value={feedback()}
                    onInput={(e) => setFeedback(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void answer("no");
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setFeedback(undefined);
                        }
                    }}
                    ref={(el) => requestAnimationFrame(() => el.focus())}
                />
            </Show>
            <div class="dock-actions">
                <For each={p.it.options}>
                    {(o, i) => (
                        <button
                            class={`btn ${o.id === "yes" ? "primary" : o.id === "no" ? "ghost" : "secondary"}`}
                            disabled={busy()}
                            onClick={() => {
                                if (o.id === "no" && feedback() === undefined) setFeedback("");
                                else void answer(o.id);
                            }}
                        >
                            <span class="truncate">{o.id === "no" && feedback() !== undefined ? "Deny" : o.label}</span>
                            <kbd>{o.id === "no" ? "Esc" : i() + 1}</kbd>
                        </button>
                    )}
                </For>
            </div>
        </>
    );
}

function QuestionCard(p: { sessionId: string; it: QuestionInteraction }) {
    const [picked, setPicked] = createSignal<string[]>([]);
    const [other, setOther] = createSignal("");
    const submit = (answers: string[] | undefined) => respond(p.sessionId, p.it.id, { kind: "question", answers });
    const toggle = (label: string) => {
        if (!p.it.multi) return void submit([label]);
        setPicked((l) => (l.includes(label) ? l.filter((x) => x !== label) : [...l, label]));
    };
    useKeys((k) => {
        const i = Number(k);
        const o = p.it.options[i - 1];
        if (o) {
            toggle(o.label);
            return true;
        }
        if (k === "Escape") {
            void submit(undefined);
            return true;
        }
        return false;
    });
    return (
        <>
            <div class="dock-head">
                <span class="dock-icon">
                    <MessageCircleQuestion size={16} />
                </span>
                <div class="dock-titles">
                    <div class="dock-title">{p.it.question}</div>
                    <div class="dock-sub">{p.it.multi ? "Pick any that apply" : "Pick one, or type your own answer"}</div>
                </div>
            </div>
            <div class="q-options">
                <For each={p.it.options}>
                    {(o, i) => (
                        <button class={`q-option ${picked().includes(o.label) ? "on" : ""}`} onClick={() => toggle(o.label)}>
                            <kbd>{i() + 1}</kbd>
                            <span class="q-text">
                                <span class="q-label">{o.label}</span>
                                <Show when={o.description}>
                                    <span class="q-desc">{o.description}</span>
                                </Show>
                            </span>
                        </button>
                    )}
                </For>
            </div>
            <div class="q-other">
                <input
                    value={other()}
                    placeholder="Something else…"
                    onInput={(e) => setOther(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && other().trim()) void submit([...picked(), other().trim()]);
                    }}
                />
            </div>
            <div class="dock-actions">
                <Show when={p.it.multi || other().trim()}>
                    <button class="btn primary" disabled={!picked().length && !other().trim()} onClick={() => void submit([...picked(), ...(other().trim() ? [other().trim()] : [])])}>
                        Answer
                    </button>
                </Show>
                <button class="btn ghost" onClick={() => void submit(undefined)}>
                    Skip <kbd>Esc</kbd>
                </button>
            </div>
        </>
    );
}

function PlanCard(p: { sessionId: string; it: PlanInteraction }) {
    const [feedback, setFeedback] = createSignal<string | undefined>();
    const approve = (mode: "acceptEdits" | "default" | "auto") => respond(p.sessionId, p.it.id, { kind: "plan", approved: true, mode });
    const reject = () => respond(p.sessionId, p.it.id, { kind: "plan", approved: false, feedback: feedback()?.trim() || undefined });
    let body: HTMLDivElement | undefined;
    createEffect(on(() => p.it.id, () => body?.scrollTo({ top: 0 })));
    useKeys((k) => {
        if (k === "1") return void approve("acceptEdits"), true;
        if (k === "2") return void approve("default"), true;
        if (k === "3") return void approve("auto"), true;
        if (k === "4" || k === "Escape") return setFeedback((f) => f ?? ""), true;
        return false;
    });
    return (
        <>
            <div class="dock-head">
                <span class="dock-icon">
                    <ClipboardList size={16} />
                </span>
                <div class="dock-titles">
                    <div class="dock-title">Plan ready for review</div>
                    <div class="dock-sub">Nothing has been changed yet</div>
                </div>
            </div>
            <div class="plan-body" ref={body}>
                <Markdown text={p.it.plan} />
            </div>
            <Show when={feedback() !== undefined}>
                <textarea
                    class="dock-feedback"
                    rows={3}
                    placeholder="What should change in the plan?"
                    value={feedback()}
                    onInput={(e) => setFeedback(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void reject();
                        }
                    }}
                    ref={(el) => requestAnimationFrame(() => el.focus())}
                />
            </Show>
            <div class="dock-actions">
                <button class="btn primary" onClick={() => void approve("acceptEdits")}>
                    Approve, auto-accept edits <kbd>1</kbd>
                </button>
                <button class="btn secondary" onClick={() => void approve("default")}>
                    Approve, ask for edits <kbd>2</kbd>
                </button>
                <button class="btn secondary" onClick={() => void approve("auto")}>
                    Auto mode <kbd>3</kbd>
                </button>
                <button class="btn ghost" onClick={() => (feedback() === undefined ? setFeedback("") : void reject())}>
                    {feedback() === undefined ? "Keep planning" : "Send feedback"} <kbd>4</kbd>
                </button>
            </div>
        </>
    );
}
