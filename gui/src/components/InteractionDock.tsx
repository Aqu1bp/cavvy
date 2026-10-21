// What the agent is waiting on you for: a permission, a question, a plan, a secret.
// A tab on the composer's top edge, the box it blocks. Its buttons never take
// focus by themselves, so an Enter meant for the input can't approve
// anything; the number keys and Esc work when you're not typing.

import { createEffect, createResource, createUniqueId, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { AlertTriangle, Bot, ClipboardList, Eye, EyeOff, FilePen, FolderGit2, Globe, KeyRound, MessageCircleQuestion, Plug, Save, ShieldAlert, SquareTerminal, GitCommitHorizontal, ArrowUpFromLine, GitPullRequestArrow } from "lucide-solid";
import type { Interaction, PermissionInteraction, PlanInteraction, QuestionInteraction, SecretInteraction } from "@shared/protocol";
import { openAgents, respond } from "../state/actions";
import { rpc } from "../state/app";
import { setPlanDialog } from "../state/ui";
import { DiffView } from "./blocks/DiffView";
import { Markdown } from "./blocks/Markdown";

function typing(): boolean {
    const el = document.activeElement as HTMLElement | null;
    // The find bar's buttons too: its Esc closes it, and it has no use for the number keys.
    return Boolean(el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable || el.closest(".find-bar")));
}

/** A key pressed this soon after a card appears was meant for something else. */
const SETTLE_MS = 400;

/** Number keys and Esc, while this card is the one showing. */
function useKeys(handler: (key: string) => boolean) {
    onMount(() => {
        const shown = performance.now();
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || typing() || document.querySelector(".dialog-backdrop, .popover")) return;
            if (performance.now() - shown < SETTLE_MS) return;
            if (handler(e.key)) {
                e.preventDefault();
                e.stopPropagation();
            }
        };
        window.addEventListener("keydown", onKey, true);
        onCleanup(() => window.removeEventListener("keydown", onKey, true));
    });
}

export function InteractionTab(p: { sessionId: string; items: Interaction[] }) {
    const first = () => p.items[0];
    // State patches replace objects; only a new interaction should clear input.
    return (
        <Show when={first()?.id} keyed>
            {(_id) => (
                <div class={`tab itab itab-${first()!.kind} ${first()!.kind === "permission" && (first() as PermissionInteraction).dangerous ? "danger" : ""}`} role="alertdialog" aria-label="Waiting for you">
                    <Show when={p.items.length > 1}>
                        <div class="itab-count">1 of {p.items.length} waiting</div>
                    </Show>
                    <Switch>
                        <Match when={first()!.kind === "permission"}>
                            <PermissionCard sessionId={p.sessionId} it={first() as PermissionInteraction} />
                        </Match>
                        <Match when={first()!.kind === "question"}>
                            <QuestionCard sessionId={p.sessionId} it={first() as QuestionInteraction} />
                        </Match>
                        <Match when={first()!.kind === "plan"}>
                            <PlanCard sessionId={p.sessionId} it={first() as PlanInteraction} />
                        </Match>
                        <Match when={first()!.kind === "secret"}>
                            <SecretCard sessionId={p.sessionId} it={first() as SecretInteraction} />
                        </Match>
                    </Switch>
                </div>
            )}
        </Show>
    );
}

/** An option's label, with `code` in mono. */
function Label(p: { text: string }) {
    return <For each={p.text.split(/(`[^`]+`)/)}>{(part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <span class="mono">{part.slice(1, -1)}</span> : part)}</For>;
}

function Head(p: { icon: JSX.Element; title: string; aside?: string; sub?: JSX.Element }) {
    return (
        <>
            <div class="itab-head">
                <span class="itab-icon">{p.icon}</span>
                <span class="itab-title">{p.title}</span>
                <Show when={p.aside}>
                    <span class="itab-aside truncate" title={p.aside}>
                        {p.aside}
                    </span>
                </Show>
            </div>
            <Show when={p.sub}>
                <div class="itab-sub">{p.sub}</div>
            </Show>
        </>
    );
}

function PermIcon(p: { it: PermissionInteraction }) {
    return (
        <Switch fallback={<ShieldAlert size={14} />}>
            <Match when={p.it.toolName === "Bash"}>
                <SquareTerminal size={14} />
            </Match>
            <Match when={p.it.category === "edit"}>
                <FilePen size={14} />
            </Match>
            <Match when={p.it.toolName === "WebFetch"}>
                <Globe size={14} />
            </Match>
            <Match when={p.it.category === "mcp"}>
                <Plug size={14} />
            </Match>
            <Match when={p.it.toolName === "GitCommit"}>
                <GitCommitHorizontal size={14} />
            </Match>
            <Match when={p.it.toolName === "GitPush"}>
                <ArrowUpFromLine size={14} />
            </Match>
            <Match when={p.it.toolName === "CreatePullRequest"}>
                <GitPullRequestArrow size={14} />
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
        // Answered, the card goes away; if the answer didn't go through, it can be given again.
        if (!(await respond(p.sessionId, p.it.id, { kind: "permission", choice, feedback: choice === "no" ? feedback() : undefined }))) setBusy(false);
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
    const order = () => {
        // On screen: Deny, then the broader choices, then Allow once at the end, where the eye lands.
        const opts = p.it.options.map((o, i) => ({ o, key: i + 1 }));
        return [...opts.filter((x) => x.o.id === "no"), ...opts.filter((x) => x.o.id !== "no" && x.o.id !== "yes"), ...opts.filter((x) => x.o.id === "yes")];
    };
    return (
        <>
            <Head
                icon={<PermIcon it={p.it} />}
                title={p.it.heading}
                aside={p.it.classifierReason ? `Auto mode asked because: ${p.it.classifierReason}` : undefined}
                sub={
                    p.it.agentLabel ? (
                        <>
                            <Bot size={12} /> Requested by sub-agent ·{" "}
                            <Show when={p.it.agentId} fallback={p.it.agentLabel}>
                                <button class="link-btn" tabIndex={-1} title="See what it has done so far" onClick={() => openAgents(p.it.agentId)}>
                                    {p.it.agentLabel}
                                </button>
                            </Show>
                        </>
                    ) : undefined
                }
            />
            <div class="itab-body">
                <Show when={p.it.plain}>
                    <div class="itab-desc">
                        {p.it.plainLabel ?? "AI summary"}: <b>{p.it.plain}</b>
                    </div>
                </Show>
                <Show when={p.it.dangerous}>
                    <div class="itab-warn">
                        <AlertTriangle size={14} /> {p.it.reason ?? "This action looks potentially destructive."}
                    </div>
                </Show>
                <Show when={p.it.command !== undefined}>
                    <pre class="itab-code mono">{p.it.command}</pre>
                    <Show when={p.it.description}>
                        <div class="itab-desc">{p.it.description}</div>
                    </Show>
                    <Show when={p.it.hosts?.length}>
                        <div class="itab-desc">Sandboxed, with network access to {p.it.hosts!.join(", ")}</div>
                    </Show>
                    <Show when={p.it.secrets?.length}>
                        <div class="itab-desc secret-names">
                            <KeyRound size={13} /> It gets <span class="mono">{p.it.secrets!.map((n) => `$${n}`).join(", ")}</span> in its environment.
                        </div>
                    </Show>
                </Show>
                <Show when={p.it.diff}>
                    <DiffView diff={p.it.diff!} header maxLines={40} class="itab-diff" />
                </Show>
                <Show when={!p.it.diff && p.it.path}>
                    <div class="itab-code mono">{p.it.path}</div>
                </Show>
                <Show when={p.it.url}>
                    <div class="itab-code mono">{p.it.url}</div>
                    <Show when={p.it.description}>
                        <div class="itab-desc">{p.it.description}</div>
                    </Show>
                </Show>
                <Show when={p.it.json}>
                    <div class="itab-desc">{p.it.title}</div>
                    <pre class="itab-code mono">{p.it.json}</pre>
                </Show>
                <Show when={!p.it.command && !p.it.diff && !p.it.path && !p.it.url && !p.it.json}>
                    <div class="itab-desc">{p.it.title}</div>
                </Show>
                <Show when={!p.it.dangerous && p.it.reason && p.it.toolName !== "Bash"}>
                    <div class="itab-desc">{p.it.reason}</div>
                </Show>
                <Show when={feedback() !== undefined}>
                    <textarea
                        class="itab-feedback"
                        rows={2}
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
            </div>
            <div class="itab-actions">
                <For each={order()}>
                    {({ o, key }) => (
                        <>
                            <button
                                class={`pbtn ${o.id === "yes" ? "primary" : o.id === "no" ? "quiet" : "outlined"}`}
                                disabled={busy()}
                                title={o.label.replaceAll("`", "")}
                                onClick={() => {
                                    if (o.id === "no" && feedback() === undefined) setFeedback("");
                                    else void answer(o.id);
                                }}
                            >
                                <span class="truncate">{o.id === "no" && feedback() !== undefined ? "Deny" : <Label text={o.label} />}</span>
                                <kbd>{o.id === "no" ? "Esc" : key}</kbd>
                            </button>
                            <Show when={o.id === "no"}>
                                <span class="spacer" />
                            </Show>
                        </>
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
            <Head icon={<MessageCircleQuestion size={14} />} title={p.it.question} aside={p.it.multi ? "Pick any that apply" : "Pick one, or type your own answer"} />
            <div class="itab-body">
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
                <input
                    class="itab-input"
                    value={other()}
                    placeholder="Something else…"
                    aria-label="Your own answer"
                    onInput={(e) => setOther(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && other().trim()) void submit([...picked(), other().trim()]);
                    }}
                />
            </div>
            <div class="itab-actions">
                <button class="pbtn quiet" onClick={() => void submit(undefined)}>
                    Skip <kbd>Esc</kbd>
                </button>
                <span class="spacer" />
                <Show when={p.it.multi || other().trim()}>
                    <button class="pbtn primary" disabled={!picked().length && !other().trim()} onClick={() => void submit([...picked(), ...(other().trim() ? [other().trim()] : [])])}>
                        Answer
                    </button>
                </Show>
            </div>
        </>
    );
}

/** Same minimum as the server's: anything shorter couldn't be kept out of the output. */
const MIN_SECRET = 8;
/** Masks a text field without making it a password field, which browsers offer to save. */
const MASKS = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");

/**
 * The value stays in the input element alone (no signal, no draft, no
 * storage) and is cleared once it's sent or the card goes away.
 */
function SecretCard(p: { sessionId: string; it: SecretInteraction }) {
    const descriptionId = createUniqueId();
    let input!: HTMLInputElement;
    const [shown, setShown] = createSignal(false);
    const [ready, setReady] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    // Exactly as typed: spaces can be part of a password.
    const value = () => input.value;
    const check = () => setReady(value().length >= MIN_SECRET);
    const provide = async () => {
        if (busy() || !ready()) return;
        setBusy(true);
        const ok = await respond(p.sessionId, p.it.id, { kind: "secret", value: value() });
        if (ok) input.value = "";
        setBusy(false);
        check();
    };
    const decline = () => {
        input.value = "";
        void respond(p.sessionId, p.it.id, { kind: "secret" });
    };
    useKeys((k) => {
        if (k !== "Escape") return false;
        decline();
        return true;
    });
    // Not while typing elsewhere: what was meant for the message box would land in here.
    onMount(() => typing() || input.focus());
    onCleanup(() => {
        if (input) input.value = "";
    });
    return (
        <>
            <Head icon={<KeyRound size={14} />} title={`The agent asks for a secret: ${p.it.name}`} aside="Only its shell commands see the value" />
            <div class="itab-body">
                <p class="secret-purpose" id={descriptionId}>{p.it.purpose}<span class="sr-only"> At least {MIN_SECRET} characters.</span></p>
                <div class="secret-field">
                    <input
                        ref={input}
                        class={`itab-input mono ${!shown() && MASKS ? "masked" : ""}`}
                        type={shown() || MASKS ? "text" : "password"}
                        name={`secret-${p.it.id}`}
                        autocomplete={shown() || MASKS ? "off" : "new-password"}
                        autocapitalize="off"
                        autocorrect="off"
                        spellcheck={false}
                        data-1p-ignore=""
                        data-lpignore="true"
                        data-bwignore=""
                        data-form-type="other"
                        placeholder={`Value for ${p.it.name}`}
                        aria-label={`Value for ${p.it.name}`}
                        aria-describedby={descriptionId}
                        onInput={check}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                e.preventDefault();
                                void provide();
                            } else if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                decline();
                            }
                        }}
                    />
                    <button class="act hb sm" title={shown() ? "Hide" : "Show"} aria-label={shown() ? "Hide the value" : "Show the value"} aria-pressed={shown()} onClick={() => setShown((s) => !s)}>
                        {shown() ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                </div>
            </div>
            <div class="itab-actions">
                <button class="pbtn quiet" onClick={decline}>
                    Decline <kbd>Esc</kbd>
                </button>
                <span class="spacer" />
                <button class="pbtn primary" aria-busy={busy()} disabled={!ready() || busy()} title={ready() ? undefined : `At least ${MIN_SECRET} characters`} onClick={() => void provide()}>
                    Provide
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
    // Whether there's a repository to make a worktree in (and, if not, why).
    const [info] = createResource(() => p.it.id, () => rpc.call("session.planInfo", { id: p.sessionId, toolId: p.it.toolId ?? p.it.id }).catch(() => undefined));
    const planId = () => p.it.toolId ?? p.it.id;
    const worktree = () => info()?.git && setPlanDialog({ kind: "worktree", sessionId: p.sessionId, planId: planId() });
    const save = () => setPlanDialog({ kind: "save", sessionId: p.sessionId, planId: planId() });
    useKeys((k) => {
        if (k === "1") return void approve("acceptEdits"), true;
        if (k === "2") return void approve("default"), true;
        if (k === "3") return void approve("auto"), true;
        if (k === "4" || k === "Escape") return setFeedback((f) => f ?? ""), true;
        if (k === "5") return worktree(), true;
        if (k === "6") return save(), true;
        return false;
    });
    return (
        <>
            <Head icon={<ClipboardList size={14} />} title="Plan ready for review" aside="Nothing has been changed yet" />
            <div class="itab-body">
                <div class="plan-body" ref={body}>
                    <Markdown text={p.it.plan} />
                </div>
                <Show when={feedback() !== undefined}>
                    <textarea
                        class="itab-feedback"
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
            </div>
            <div class="itab-actions">
                <button class="pbtn quiet" onClick={() => (feedback() === undefined ? setFeedback("") : void reject())}>
                    {feedback() === undefined ? "Keep planning" : "Send feedback"} <kbd>4</kbd>
                </button>
                <button class="pbtn quiet" title="Save the plan as a Markdown file" onClick={save}>
                    <Save size={13} /> Save… <kbd>6</kbd>
                </button>
                <button
                    class="pbtn outlined"
                    disabled={!info()?.git}
                    title={info()?.notGit ?? "Build it in a new Git worktree, in a new session; this one stops, still in plan mode"}
                    onClick={worktree}
                >
                    <FolderGit2 size={13} /> New worktree… <kbd>5</kbd>
                </button>
                <span class="spacer" />
                <button class="pbtn outlined" onClick={() => void approve("auto")}>
                    Auto mode <kbd>3</kbd>
                </button>
                <button class="pbtn outlined" onClick={() => void approve("default")}>
                    Approve, ask for edits <kbd>2</kbd>
                </button>
                <button class="pbtn primary" onClick={() => void approve("acceptEdits")}>
                    Approve, auto-accept edits <kbd>1</kbd>
                </button>
            </div>
        </>
    );
}
