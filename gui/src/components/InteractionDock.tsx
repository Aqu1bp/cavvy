// What the agent is waiting on you for: a permission, a question, a plan, a secret, a sign-in.
// A card in the dock above the composer. It opens with the question itself
// ("Run `bun test auth`?"), then what you need to answer it, then the answers:
// the one that goes ahead first, filled; the way out at the far end, plain.
// Something destructive is ringed in red. Its buttons never take focus by
// themselves, so an Enter meant for the input can't approve anything; the
// number keys and Esc work when you're not typing.

import { createEffect, createResource, createUniqueId, createSignal, For, lazy, Match, on, onCleanup, onMount, Show, Suspense, Switch, type JSX } from "solid-js";
import { AlertTriangle, Eye, EyeOff } from "lucide-solid";
import type { ConfirmInteraction, Interaction, PermissionInteraction, PlanInteraction, QuestionInteraction, SecretInteraction, SignInInteraction } from "@shared/protocol";
import { openAgents, respond } from "../state/actions";
import { handleFor, rpc } from "../state/app";
import { agentProvider } from "../lib/agent-marks";
import { approvalChoices, approvalQuestion } from "../lib/approval";
import { cardsKey, typingIn } from "../lib/card-keys";
import { AgentMark } from "./ui/AgentMark";
import { columnHeight, setPlanDialog, settingsTab } from "../state/ui";
import { cardArrived } from "../lib/terminal-keys";
import { DiffView } from "./blocks/DiffView";
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
                <div class={`ask card-surface itab dock`} data-kind={first()!.kind} data-danger={(first()!.kind === "permission" && (first() as PermissionInteraction).dangerous) || (first()!.kind === "confirm" && (first() as ConfirmInteraction).danger) || undefined} style={{ "--column-h": columnHeight() }} role="alertdialog" aria-label="Waiting for you">
                    <Show when={p.items.length > 1}>
                        <div class="dock-pager">
                            <span class="num">1 of {p.items.length} waiting</span>
                        </div>
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
    const parts = () => p.text.split(/(`[^`]+`)/).filter(Boolean);
    const code = (part: string) => part.startsWith("`") && part.endsWith("`") && part.length > 2;
    return (
        <Show when={parts().some(code)} fallback={<span class="dock-btn-label">{p.text}</span>}>
            <span class="dock-btn-label plabel">
                <For each={parts()}>{(part) => (code(part) ? <span class="mono plabel-c">{part.slice(1, -1)}</span> : <span class="plabel-t">{part}</span>)}</For>
            </span>
        </Show>
    );
}

/**
 * A card's question, then its lines under it: `sub` (a hint, or who asked) and `note` (why it's asking), each whole.
 * `end`: at the question's far end (what an edit adds and removes).
 */
export function Head(p: { title: JSX.Element; sub?: JSX.Element; note?: string; end?: JSX.Element }) {
    return (
        <>
            <div class="dock-head">
                <h3 class="dock-title selectable">
                    {p.title}
                    {p.end}
                </h3>
            </div>
            <Show when={p.sub}>
                <p class="dock-sub selectable">{p.sub}</p>
            </Show>
            <Show when={p.note}>
                <p class="dock-line selectable">{p.note}</p>
            </Show>
        </>
    );
}

/** A key that answers the card, after its button's words (the number keys, Esc). */
export function Key(p: { k: string }) {
    return (
        <span class="kbd-group" aria-hidden="true">
            <kbd class="kbd">{p.k}</kbd>
        </span>
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
            class={`btn ${c.o.id === "yes" ? "btn-primary" : c.o.id === "no" ? "btn-danger" : ""}`}
            disabled={busy()}
            title={c.o.label.replaceAll("`", "")}
            onClick={() => {
                if (c.o.id === "no" && feedback() === undefined) setFeedback("");
                else void answer(c.o.id);
            }}
        >
            <FitLabel text={c.o.id === "no" && feedback() !== undefined ? "Deny" : c.o.short ?? c.o.label} />
            <Key k={c.o.id === "no" ? "Esc" : String(c.key)} />
        </button>
    );
    return (
        <>
            <Head
                title={
                    <>
                        {question().before}
                        <Show when={question().code}>
                            <code>{question().code}</code>
                        </Show>
                        ?
                    </>
                }
                end={
                    <Show when={p.it.diff}>
                        {(d) => (
                            <span class="stat dock-stat">
                                <Show when={d().added}>
                                    <span class="stat-add">+{d().added!.toLocaleString()}</span>
                                </Show>
                                <Show when={d().removed}>
                                    <span class="stat-del">−{d().removed!.toLocaleString()}</span>
                                </Show>
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
            <Show when={p.it.plain}>
                <p class="dock-line selectable">
                    <span class="dock-line-label">{p.it.plainLabel ?? "AI summary"}:</span> {p.it.plain}
                </p>
            </Show>
            <Show when={p.it.dangerous}>
                <p class="dock-warn selectable">
                    <AlertTriangle size={13} /> {p.it.reason ?? "This action looks potentially destructive."}
                </p>
            </Show>
            <Show when={p.it.command !== undefined}>
                <Show when={!question().inline}>
                    <pre class="dock-code">{p.it.command}</pre>
                </Show>
                {/* Not a shell command's: those are the agent's own words for it, and the command is right there. */}
                <Show when={p.it.description && p.it.toolName !== "Bash" && p.it.toolName !== "Monitor"}>
                    <p class="dock-line selectable">{p.it.description}</p>
                </Show>
                <Show when={p.it.hosts?.length}>
                    <p class="dock-line selectable">Sandboxed, with network access to {p.it.hosts!.join(", ")}</p>
                </Show>
                <Show when={p.it.secrets?.length}>
                    <p class="dock-line selectable">
                        It gets <code>{p.it.secrets!.map((n) => `$${n}`).join(", ")}</code> in its environment.
                    </p>
                </Show>
            </Show>
            <Show when={p.it.diff}>
                <div class="tool-card dock-diff">
                    <DiffView diff={p.it.diff!} maxLines={40} class="inline" />
                </div>
            </Show>
            <Show when={!p.it.diff && p.it.path && !question().inline}>
                <pre class="dock-code">{p.it.path}</pre>
            </Show>
            <Show when={p.it.url}>
                <pre class="dock-code">{p.it.url}</pre>
                <Show when={p.it.description}>
                    <p class="dock-line selectable">{p.it.description}</p>
                </Show>
            </Show>
            <Show when={p.it.json}>
                <p class="dock-line selectable">{p.it.title}</p>
                <pre class="dock-code">{p.it.json}</pre>
            </Show>
            {/* Nothing more to show: what it does in words, or, for a tool no heading names, its call. */}
            <Show when={!p.it.command && !p.it.diff && !p.it.path && !p.it.url && !p.it.json && (p.it.description || p.it.heading === "Use a tool")}>
                <p class="dock-line selectable">{p.it.description ?? p.it.title}</p>
            </Show>
            <Show when={!p.it.dangerous && p.it.reason && p.it.toolName !== "Bash" && p.it.toolName !== "Monitor"}>
                <p class="dock-line selectable">{p.it.reason}</p>
            </Show>
            <Show when={feedback() !== undefined}>
                <textarea
                    class="input dock-input"
                    rows={1}
                    placeholder="Tell it what to do instead (optional), then press Enter"
                    aria-label="What to do instead"
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
    // Whether anything is typed, for the hint; the value itself stays in the input.
    const [typed, setTyped] = createSignal(false);
    const check = () => (setReady(value().length >= MIN_SECRET), setTyped(value().length > 0));
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
            <Head title={<>Provide <code>{p.it.name}</code>?</>} sub="Only its shell commands see the value" />
            <p class="dock-line selectable" id={descriptionId}>{p.it.purpose}<span class="sr-only"> At least {MIN_SECRET} characters.</span></p>
            <div class="dock-secret">
                <input
                    ref={input}
                    class={`input mono ${!shown() && MASKS ? "masked" : ""}`}
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
                <button class="icon-btn" title={shown() ? "Hide" : "Show"} aria-label={shown() ? "Hide the value" : "Show the value"} aria-pressed={shown()} onClick={() => setShown((s) => !s)}>
                    {shown() ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
            </div>
            <div class="dock-actions">
                <button class="btn btn-primary" aria-busy={busy()} disabled={!ready() || busy()} title={ready() ? undefined : `At least ${MIN_SECRET} characters`} onClick={() => void provide()}>
                    <span class="dock-btn-label">Provide</span>
                </button>
                <button class="btn" onClick={decline}>
                    <span class="dock-btn-label">Decline</span>
                    <Key k="Esc" />
                </button>
                <Show when={typed() && !ready()}>
                    <span class="dock-hint">At least {MIN_SECRET} characters</span>
                </Show>
            </div>
        </>
    );
}

function PlanCard(p: { sessionId: string; it: PlanInteraction }) {
    const [feedback, setFeedback] = createSignal<string | undefined>();
    const approve = (mode: "acceptEdits" | "default" | "auto") => respond(p.sessionId, p.it.id, { kind: "plan", approved: true, mode });
    const reject = () => respond(p.sessionId, p.it.id, { kind: "plan", approved: false, feedback: feedback()?.trim() || undefined });
    let body: HTMLDivElement | undefined;
    // The plan's first heading is its title, over the rest.
    const planParts = () => {
        const m = /^\s*#{1,3}\s+(.+)\n+/.exec(p.it.plan);
        return m ? { title: m[1]!.trim(), body: p.it.plan.slice(m[0].length) } : { title: undefined, body: p.it.plan };
    };
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
            <div class="dock-plan" ref={body} tabIndex={0}>
                <Show when={planParts().title}>{(t) => <h4 class="dock-plan-title">{t()}</h4>}</Show>
                <Markdown text={planParts().body} />
            </div>
            <Show when={feedback() !== undefined}>
                <textarea
                    class="input dock-input"
                    rows={1}
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
            <div class="dock-actions">
                <button class="btn btn-primary" onClick={() => void approve("acceptEdits")}>
                    <span class="dock-btn-label">Approve, auto-accept edits</span>
                    <Key k="1" />
                </button>
                <button class="btn" onClick={() => void approve("default")}>
                    <span class="dock-btn-label">Approve, ask for edits</span>
                    <Key k="2" />
                </button>
                <button class="btn" onClick={() => void approve("auto")}>
                    <span class="dock-btn-label">Auto mode</span>
                    <Key k="3" />
                </button>
                <button class="btn" onClick={() => (feedback() === undefined ? setFeedback("") : void reject())}>
                    <span class="dock-btn-label">{feedback() === undefined ? "Keep planning" : "Send feedback"}</span>
                    <Key k="4" />
                </button>
                <span class="grow" />
                <button
                    class="btn"
                    disabled={!info()?.git}
                    title={info()?.notGit ?? "Implement in a new worktree; this session stops, still in plan mode"}
                    onClick={worktree}
                >
                    <span class="dock-btn-label">New worktree…</span>
                    <Key k="5" />
                </button>
                <button class="btn" title="Save as Markdown" onClick={save}>
                    <span class="dock-btn-label">Save…</span>
                    <Key k="6" />
                </button>
            </div>
        </>
    );
}
