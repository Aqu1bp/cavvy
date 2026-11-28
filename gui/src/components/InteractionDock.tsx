// What the agent is waiting on you for: a permission, a question, a plan, a secret, a sign-in.
// A card in the dock above the composer. It opens with the question itself
// ("Run `bun test auth`?"), then what you need to answer it, then the answers:
// the one that goes ahead first, filled; the way out at the far end, plain.
// Something destructive is ringed in red. Its buttons never take focus by
// themselves, so an Enter meant for the input can't approve anything; the
// number keys and Esc work when you're not typing.

import { createEffect, createResource, createUniqueId, createSignal, For, lazy, Match, on, onCleanup, onMount, Show, Suspense, Switch, type JSX } from "solid-js";
import { AlertTriangle, Eye, EyeOff, KeyRound } from "lucide-solid";
import type { ConfirmInteraction, Interaction, PermissionInteraction, PlanInteraction, QuestionInteraction, SecretInteraction, SignInInteraction } from "@shared/protocol";
import { openAgents, respond } from "../state/actions";
import { handleFor, rpc } from "../state/app";
import { agentProvider } from "../lib/agent-marks";
import { approvalChoices, approvalQuestion } from "../lib/approval";
import { cardsKey, typingIn } from "../lib/card-keys";
import { AgentMark } from "./ui/AgentMark";
import { columnHeight, setPlanDialog, settingsTab } from "../state/ui";
import { cardArrived } from "../lib/terminal-keys";
import { Counts, DiffView } from "./blocks/DiffView";
import { Markdown } from "./blocks/Markdown";
import { keysHere, usePane } from "../state/split";

const typing = () => typingIn(document.activeElement as HTMLElement | null);

/** A card arriving takes focus only when it's in sight and nothing is typed elsewhere (Settings covers it, kept mounted). */
export const mayFocus = () => !typing() && !settingsTab();

/** A sign-in's card, loaded with the first one. */
const SignInCard = lazy(() => import("./SignInCard"));
/** A question's card, loaded with the first one (with what attaching to an answer takes). */
const QuestionCard = lazy(() => import("./QuestionCard"));
/** The card that asks before money is spent or something is deleted: in the same chunk. */
const ConfirmCard = lazy(() => import("./SignInCard").then((m) => ({ default: m.ConfirmCard })));

/** A key pressed this soon after a card appears was meant for something else. */
const SETTLE_MS = 400;

/** Number keys and Esc, while this card is the one showing. */
export function useKeys(handler: (key: string) => boolean) {
    // Two sessions side by side: the keys answer the focused one's.
    const pane = usePane();
    onMount(() => {
        const shown = performance.now();
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || !cardsKey(e.key, document.activeElement as HTMLElement | null) || document.querySelector(".dialog-backdrop, .popover")) return;
            // Nor while an edge is dragged (Esc is the drag's then: Panes.tsx).
            if (performance.now() - shown < SETTLE_MS || !keysHere(pane) || document.body.classList.contains("resizing")) return;
            // Not while the card is out of sight: Settings over it (lib/cover.ts), or the terminal maximized
            // over the conversation (which hides it with visibility, seen by checkVisibility only when asked).
            // The one shown: not one kept out of sight (Panes.tsx), which can come first.
            const card = document.querySelector<HTMLElement>(".itab:not([data-parked] *)");
            if (card?.closest("[data-covered]") || card?.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) === false) return;
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
                // A terminal that took the keyboard by itself gives it up, so the card's keys answer it.
                cardArrived(),
                <div class={`ask card-surface itab itab-${first()!.kind} ${(first()!.kind === "permission" && (first() as PermissionInteraction).dangerous) || (first()!.kind === "confirm" && (first() as ConfirmInteraction).danger) ? "danger" : ""}`} style={{ "--column-h": columnHeight() }} role="alertdialog" aria-label="Waiting for you">
                    <Show when={p.items.length > 1}>
                        <div class="itab-count">1 of {p.items.length} waiting</div>
                    </Show>
                    <Switch>
                        <Match when={first()!.kind === "permission"}>
                            <PermissionCard sessionId={p.sessionId} it={first() as PermissionInteraction} />
                        </Match>
                        <Match when={first()!.kind === "question"}>
                            <Suspense>
                                <QuestionCard sessionId={p.sessionId} it={first() as QuestionInteraction} />
                            </Suspense>
                        </Match>
                        <Match when={first()!.kind === "plan"}>
                            <PlanCard sessionId={p.sessionId} it={first() as PlanInteraction} />
                        </Match>
                        <Match when={first()!.kind === "secret"}>
                            <SecretCard sessionId={p.sessionId} it={first() as SecretInteraction} />
                        </Match>
                        <Match when={first()!.kind === "signin"}>
                            <Suspense>
                                <SignInCard sessionId={p.sessionId} it={first() as SignInInteraction} />
                            </Suspense>
                        </Match>
                        <Match when={first()!.kind === "confirm"}>
                            <Suspense>
                                <ConfirmCard sessionId={p.sessionId} it={first() as ConfirmInteraction} />
                            </Suspense>
                        </Match>
                    </Switch>
                </div>
            )}
        </Show>
    );
}

/** An option's label, with `code` in mono, on one line. Short of room, the code (a rule list,
 * a path) gives way first, cut with an ellipsis, so the sentence around it
 * stays whole: "Always allow `cat, wc…` in project", not "… in proj".
 */
function FitLabel(p: { text: string }) {
    return (
        <span class="plabel">
            <For each={p.text.split(/(`[^`]+`)/).filter(Boolean)}>
                {(part) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <span class="mono plabel-c">{part.slice(1, -1)}</span> : <span class="plabel-t">{part}</span>)}
            </For>
        </span>
    );
}

/**
 * A card's question, then its lines under it: `sub` (a hint, or who asked) and `note` (why it's asking), each whole.
 * `end`: at the question's far end (what an edit adds and removes).
 */
export function Head(p: { title: JSX.Element; sub?: JSX.Element; note?: string; end?: JSX.Element }) {
    return (
        <>
            <div class="ask-h">
                <span class="ask-title selectable">{p.title}</span>
                <Show when={p.end}>
                    <span class="ask-end">{p.end}</span>
                </Show>
            </div>
            <Show when={p.sub}>
                <div class="itab-sub selectable">{p.sub}</div>
            </Show>
            <Show when={p.note}>
                <div class="itab-sub selectable">{p.note}</div>
            </Show>
        </>
    );
}

function PermissionCard(p: { sessionId: string; it: PermissionInteraction }) {
    const [feedback, setFeedback] = createSignal<string | undefined>();
    /** Who runs the sub-agent asking, as its row in the sub-agent card says; not known without its run. */
    const askerProvider = () => {
        const h = handleFor(p.sessionId);
        const a = p.it.agentId ? h?.view.agents.find((x) => x.id === p.it.agentId) : undefined;
        return a && agentProvider(a, h?.view.state.model?.provider, h?.view.agents);
    };
    // Its task, without the model's id after it ("(anthropic:claude-…)"): its mark says whose it is.
    const asker = () => p.it.agentLabel?.replace(/ \([^()\s]+:[^()\s]+\)$/, "");
    const [busy, setBusy] = createSignal(false);
    const answer = async (choice: PermissionInteraction["options"][number]["id"]) => {
        if (busy()) return;
        setBusy(true);
        // Answered, the card goes away; if the answer didn't go through, it can be given again.
        if (!(await respond(p.sessionId, p.it.id, { kind: "permission", choice, feedback: choice === "no" ? feedback() : undefined }))) setBusy(false);
    };
    const choices = () => approvalChoices(p.it.options);
    const question = () => approvalQuestion(p.it);
    useKeys((k) => {
        const opt = choices().keys[Number(k) - 1];
        if (opt) {
            void answer(opt.id);
            return true;
        }
        if (k === "Escape") {
            void answer("no");
            return true;
        }
        return false;
    });
    const Choice = (c: { o: PermissionInteraction["options"][number]; key: number }) => (
        <button
            class={`btn ${c.o.id === "yes" ? "btn-primary" : c.o.id === "no" ? "deny" : "wide"}`}
            disabled={busy()}
            title={c.o.label.replaceAll("`", "")}
            onClick={() => {
                if (c.o.id === "no" && feedback() === undefined) setFeedback("");
                else void answer(c.o.id);
            }}
        >
            <FitLabel text={c.o.id === "no" && feedback() !== undefined ? "Deny" : c.o.short ?? c.o.label} />
            <kbd>{c.o.id === "no" ? "Esc" : c.key}</kbd>
        </button>
    );
    return (
        <>
            <Head
                title={
                    <>
                        {question().before}
                        <Show when={question().code}>
                            <code class="ask-code mono">{question().code}</code>
                        </Show>
                        ?
                    </>
                }
                end={
                    <Show when={p.it.diff}>
                        {(d) => (
                            <span class="stat">
                                <Counts added={d().added} removed={d().removed} />
                            </span>
                        )}
                    </Show>
                }
                note={p.it.classifierReason ? `Auto mode asked because: ${p.it.classifierReason}` : undefined}
                sub={
                    p.it.where && !p.it.agentLabel ? (
                        <span class="truncate">{p.it.where}</span>
                    ) : p.it.agentLabel ? (
                        <>
                            <AgentMark provider={askerProvider()} size={12} /> Requested by sub-agent ·{" "}
                            <Show when={p.it.agentId} fallback={asker()}>
                                <button class="link-btn" tabIndex={-1} title="See its work so far" onClick={() => openAgents(p.it.agentId)}>
                                    {asker()}
                                </button>
                            </Show>
                        </>
                    ) : undefined
                }
            />
            <div class="itab-body">
                <Show when={p.it.plain}>
                    <div class="itab-desc selectable">
                        <span class="lbl">{p.it.plainLabel ?? "AI summary"}:</span> {p.it.plain}
                    </div>
                </Show>
                <Show when={p.it.dangerous}>
                    <div class="itab-warn selectable">
                        <AlertTriangle size={14} /> {p.it.reason ?? "This action looks potentially destructive."}
                    </div>
                </Show>
                <Show when={p.it.command !== undefined}>
                    <Show when={!question().inline}>
                        <pre class="itab-code ask-cmd mono">{p.it.command}</pre>
                    </Show>
                    {/* Not a shell command's: those are the agent's own words for it, and the command is right there. */}
                    <Show when={p.it.description && p.it.toolName !== "Bash" && p.it.toolName !== "Monitor"}>
                        <div class="itab-desc why selectable">{p.it.description}</div>
                    </Show>
                    <Show when={p.it.hosts?.length}>
                        <div class="itab-desc why selectable">Sandboxed, with network access to {p.it.hosts!.join(", ")}</div>
                    </Show>
                    <Show when={p.it.secrets?.length}>
                        <div class="itab-desc secret-names selectable">
                            <KeyRound size={13} /> It gets <span class="mono">{p.it.secrets!.map((n) => `$${n}`).join(", ")}</span> in its environment.
                        </div>
                    </Show>
                </Show>
                <Show when={p.it.diff}>
                    <DiffView diff={p.it.diff!} maxLines={40} class="inline itab-diff" />
                </Show>
                <Show when={!p.it.diff && p.it.path && !question().inline}>
                    <div class="itab-code mono">{p.it.path}</div>
                </Show>
                <Show when={p.it.url}>
                    <div class="itab-code mono">{p.it.url}</div>
                    <Show when={p.it.description}>
                        <div class="itab-desc why selectable">{p.it.description}</div>
                    </Show>
                </Show>
                <Show when={p.it.json}>
                    <div class="itab-desc selectable">{p.it.title}</div>
                    <pre class="itab-code mono">{p.it.json}</pre>
                </Show>
                {/* Nothing more to show: what it does in words, or, for a tool no heading names, its call. */}
                <Show when={!p.it.command && !p.it.diff && !p.it.path && !p.it.url && !p.it.json && (p.it.description || p.it.heading === "Use a tool")}>
                    <div class="itab-desc selectable">{p.it.description ?? p.it.title}</div>
                </Show>
                <Show when={!p.it.dangerous && p.it.reason && p.it.toolName !== "Bash" && p.it.toolName !== "Monitor"}>
                    <div class="itab-desc why selectable">{p.it.reason}</div>
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
            <div class="itab-actions ask-row perm-row">
                <For each={choices().row}>{Choice}</For>
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
    // Nor in the other pane of a split: taking focus would move the split's focus to it.
    onMount(() => mayFocus() && usePane().focused() && input.focus());
    onCleanup(() => {
        if (input) input.value = "";
    });
    return (
        <>
            <Head title={<>Provide <code class="ask-code mono">{p.it.name}</code>?</>} sub="Only its shell commands see the value" />
            <div class="itab-body">
                <p class="secret-purpose selectable" id={descriptionId}>{p.it.purpose}<span class="sr-only"> At least {MIN_SECRET} characters.</span></p>
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
            <div class="itab-actions ask-row">
                <button class="btn btn-primary" aria-busy={busy()} disabled={!ready() || busy()} title={ready() ? undefined : `At least ${MIN_SECRET} characters`} onClick={() => void provide()}>
                    Provide
                </button>
                <button class="btn" onClick={decline}>
                    Decline <kbd>Esc</kbd>
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
            <Head title="Go ahead with this plan?" sub="Nothing has been changed yet" />
            <div class="itab-body">
                <div class="plan-body" ref={body}>
                    <Markdown text={p.it.plan} />
                </div>
                <Show when={feedback() !== undefined}>
                    <textarea
                        class="itab-feedback plan-fb"
                        rows={2}
                        placeholder="What should change? Enter sends, Esc cancels"
                        aria-label="What should change in the plan"
                        value={feedback()}
                        onInput={(e) => setFeedback(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void reject();
                            } else if (e.key === "Escape") {
                                // Like the permission card's: closes the field, without stopping the turn.
                                e.preventDefault();
                                e.stopPropagation();
                                setFeedback(undefined);
                            }
                        }}
                        ref={(el) => requestAnimationFrame(() => el.focus())}
                    />
                </Show>
            </div>
            <div class="itab-actions ask-row plan-row">
                <button class="btn btn-primary" onClick={() => void approve("acceptEdits")}>
                    Approve, auto-accept edits <kbd>1</kbd>
                </button>
                <button class="btn" onClick={() => void approve("default")}>
                    Approve, ask for edits <kbd>2</kbd>
                </button>
                <button class="btn" onClick={() => void approve("auto")}>
                    Auto mode <kbd>3</kbd>
                </button>
                <button class="btn" onClick={() => (feedback() === undefined ? setFeedback("") : void reject())}>
                    {feedback() === undefined ? "Keep planning" : "Send feedback"} <kbd>4</kbd>
                </button>
            </div>
            <div class="itab-actions ask-row plan-row quiet-row">
                <button
                    class="btn"
                    disabled={!info()?.git}
                    title={info()?.notGit ?? "Implement in a new worktree; this session stops, still in plan mode"}
                    onClick={worktree}
                >
                    New worktree… <kbd>5</kbd>
                </button>
                <button class="btn" title="Save as Markdown" onClick={save}>
                    Save… <kbd>6</kbd>
                </button>
            </div>
        </>
    );
}
