// The card for a sign-in Cavvy runs (RequestSignIn, or a feature that found something signed out). One card
// that changes as the sign-in goes: the question, then what this kind needs from you (a browser to finish in, a
// code to enter, a code to paste back, a token, a prompt to type at, a command to run yourself). It closes by
// itself once the service says it's signed in. Loaded with the first one, not with the window.

import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { Check, ExternalLink, SquareTerminal } from "lucide-solid";
import type { ConfirmInteraction, SignInAction, SignInInteraction } from "@shared/protocol";
import { respond } from "../state/actions";
import { machine as windowMachine, openExternal } from "../lib/platform";
import { home } from "../lib/machines";
import { awayMachine, rpc } from "../state/app";
import { signInPressed } from "../lib/card-keys";
import { terminalActions } from "../state/ui";
import { Head, Key, mayFocus, useKeys } from "./InteractionDock";
import { usePane } from "../state/split";
import { CopyButton, Spinner } from "./ui/bits";

/** Masks a text field without making it a password field, which browsers offer to save. */
const MASKS = typeof CSS !== "undefined" && CSS.supports("-webkit-text-security", "disc");

/** A key as a terminal would send it, or undefined for one that isn't sent (a modifier alone, a shortcut of the app's). */
export function terminalKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): string | undefined {
    if (e.metaKey || e.altKey) return undefined;
    if (e.ctrlKey) return /^[a-z]$/i.test(e.key) ? String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96) : undefined;
    switch (e.key) {
        case "Enter": return "\r";
        case "Backspace": return "\x7f";
        case "Tab": return "\t";
        case "ArrowUp": return "\x1b[A";
        case "ArrowDown": return "\x1b[B";
        case "ArrowRight": return "\x1b[C";
        case "ArrowLeft": return "\x1b[D";
        default: return e.key.length === 1 || [...e.key].length === 1 ? e.key : undefined;
    }
}

export default function SignInCard(p: { sessionId: string; it: SignInInteraction }) {
    const it = () => p.it;
    const [sending, setSending] = createSignal(false);
    const send = async (a: SignInAction) => {
        if (a.action === "start" || a.action === "retry" || a.action === "pick") signInPressed.at = Date.now();
        setSending(true);
        try {
            return await respond(p.sessionId, p.it.id, { kind: "signin", ...a });
        } finally {
            setSending(false);
        }
    };
    // The server it's on: named by the session, or the one this window is on.
    const where = () => it().machine ?? windowMachine;
    // The sign-in command gave up: only starting over is left. (An error without that is about what was just entered.)
    const failed = () => Boolean(it().ended);
    const open = () => it().url && void openExternal(it().url!);
    const openTerminal = () => {
        if (terminalActions.signIn?.(p.sessionId, p.it.id)) void send({ action: "ran" });
    };
    const primary = (): (() => void) | undefined => {
        const i = it();
        if (failed() || i.expired) return () => void send({ action: "retry" });
        if (i.busy) return undefined;
        if (i.step === "ask") return () => void send({ action: "start" });
        if (i.step === "code" || (i.step === "browser" && i.open)) return i.url ? open : undefined;
        if (i.step === "command") return i.ran ? () => void send({ action: "done" }) : openTerminal;
        return undefined;
    };
    const second = (): (() => void) | undefined => {
        const i = it();
        if (failed() || i.expired || i.busy) return undefined;
        if (i.step === "ask" && i.canToken) return () => void send({ action: "token" });
        if (i.step === "command" && i.ran && i.canSave) return () => void send({ action: "done", save: true });
        return undefined;
    };
    // Its page calls back on the server: this window, on the user's own machine, brings that port over for as long as the card asks.
    createEffect(on(() => it().forward, (port) => {
        const target = it().target;
        // Only for a sign-in the user started in this window just now: a card can't have this machine listen by itself.
        if (!port || !target || Date.now() - signInPressed.at > 60_000) return;
        // The server: the session's, opened in a window on this computer, or the one the window is on. This
        // computer's Cavvy brings the port over: the window's own, or the one a window on a server keeps beside it.
        const name = awayMachine(p.sessionId) || windowMachine;
        const far = windowMachine ? home : rpc;
        if (!name || !far) return void send({ action: "port", error: "Open this session in the desktop app to finish signing in." });
        let asking = true;
        far.call("servers.forward", { name, port, target }).then(() => asking && send({ action: "port" }), (e: Error) => asking && send({ action: "port", error: e.message }));
        onCleanup(() => {
            asking = false;
            void far.call("servers.unforward", { name, port }).catch(() => undefined);
        });
    }));
    useKeys((k) => {
        if (k === "Escape") return void send({ action: "later" }), true;
        const act = k === "1" ? primary() : k === "2" ? second() : undefined;
        if (!act) return false;
        act();
        return true;
    });
    const named = () => it().step !== "list" && Boolean(it().name);
    const title = (): JSX.Element => (
        <>
            {named() ? "Sign in to " : "Sign in"}
            <Show when={named()}>
                {/* One Cavvy has no name for is a command's: shown as one. */}
                <Show when={it().name === it().target && it().step === "command"} fallback={it().name}>
                    <code>{it().name}</code>
                </Show>
            </Show>
            <Show when={where()}>
                {" on "}
                <code>{where()}</code>
            </Show>
            ?
        </>
    );
    /** The way out, at the far end: back to the list this came from, or put off. */
    const Out = () => (
        <>
            <button class="btn" onClick={() => void send({ action: "later" })}>
                <span class="dock-btn-label">{it().back && it().step !== "list" && it().step !== "token" ? "Back" : "Later"}</span>
                <Key k="Esc" />
            </button>
        </>
    );
    const Problem = () => (
        <Show when={it().error}>
            <p class="dock-warn selectable" role="alert">{it().error}</p>
        </Show>
    );
    return (
        <>
            <Head title={title()} sub={it().step === "ask" ? it().warning : undefined} />
            <Switch>
                <Match when={it().step === "list"}>
                    <ul class="si-services">
                        <For each={it().rows ?? []}>
                            {(r) => (
                                <li class="si-service">
                                    <span class="si-service-name">{r.name}</span>
                                    <Show
                                        when={r.state === "in"}
                                        fallback={
                                            <button class="btn btn-sm" disabled={sending()} aria-label={`Sign in to ${r.name}`} onClick={() => void send({ action: "pick", target: r.target })}>
                                                Sign in
                                            </button>
                                        }
                                    >
                                        <span class="si-who">
                                            <Check size={13} /> {r.who ?? "Signed in"}
                                        </span>
                                    </Show>
                                </li>
                            )}
                        </For>
                    </ul>
                    <div class="dock-actions">
                        <Out />
                    </div>
                </Match>
                <Match when={failed()}>
                    <Show when={it().step === "typed" && it().term}>
                        <pre class="si-term">{it().term}</pre>
                    </Show>
                    <Show when={it().step !== "typed"}>
                        <Problem />
                    </Show>
                    <div class="dock-actions">
                        <button class="btn btn-primary" disabled={sending()} onClick={() => void send({ action: "retry" })}>
                            <span class="dock-btn-label">Try again</span>
                            <Key k="1" />
                        </button>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "ask"}>
                    <Show when={it().busy}>
                        <Waiting text="Starting" />
                    </Show>
                    <div class="dock-actions">
                        <Show when={!it().busy}>
                            <button class="btn btn-primary" disabled={sending()} onClick={() => void send({ action: "start" })}>
                                <span class="dock-btn-label">Sign in</span>
                                <Key k="1" />
                            </button>
                            <Show when={it().canToken}>
                                <button class="btn" disabled={sending()} onClick={() => void send({ action: "token" })}>
                                    <span class="dock-btn-label">Use a token</span>
                                    <Key k="2" />
                                </button>
                            </Show>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "browser"}>
                    <Waiting text={it().busy ? "Starting" : "Finish in your browser"} />
                    <div class="dock-actions">
                        <Show when={it().url && !it().busy}>
                            <button class={`btn ${it().open ? "btn-primary" : ""}`} onClick={open}>
                                <ExternalLink size={13} />
                                <span class="dock-btn-label">{it().open ? <>Open {host(it().site)}</> : "Open again"}</span>
                                <Show when={it().open}>
                                    <Key k="1" />
                                </Show>
                            </button>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "code"}>
                    <Show when={it().expired} fallback={
                        <>
                            <div class="si-code">
                                <span class="si-code-value mono selectable">{it().code}</span>
                                <CopyButton text={() => it().code ?? ""} label="Copy the code" class="icon-btn-sm" />
                            </div>
                            <Waiting text={`Enter the code at ${it().site ?? "the page"}`} />
                        </>
                    }>
                        <p class="dock-line">This code expired</p>
                    </Show>
                    <div class="dock-actions">
                        <Show
                            when={it().expired}
                            fallback={
                                <button class="btn btn-primary" onClick={open}>
                                    <ExternalLink size={13} />
                                    <span class="dock-btn-label">Open {host(it().site)}</span>
                                    <Key k="1" />
                                </button>
                            }
                        >
                            <button class="btn btn-primary" disabled={sending()} onClick={() => void send({ action: "retry" })}>
                                <span class="dock-btn-label">New code</span>
                                <Key k="1" />
                            </button>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "paste"}>
                    <Field it={it()} label="Code" placeholder="Paste the code from the page" send={send} masked={false} action="Continue">
                        <button class="btn" onClick={open}>
                            <ExternalLink size={13} />
                            <span class="dock-btn-label">Open page</span>
                        </button>
                    </Field>
                </Match>
                <Match when={it().step === "token"}>
                    <Field it={it()} label={`${it().name} token`} placeholder="Token" send={send} masked action="Sign in" link={it().tokenUrl}>
                        <Show when={it().back}>
                            <button class="btn" onClick={() => void send({ action: "back" })}>
                                <span class="dock-btn-label">Back</span>
                            </button>
                        </Show>
                    </Field>
                </Match>
                <Match when={it().step === "typed"}>
                    <Prompt term={it().term ?? ""} keys={(value) => void respond(p.sessionId, p.it.id, { kind: "signin", action: "keys", value })} later={() => void send({ action: "later" })} />
                    <div class="dock-actions">
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "command"}>
                    <pre class="dock-code selectable">{it().command}</pre>
                    <div class="dock-actions">
                        <Show
                            when={it().ran}
                            fallback={
                                <button class="btn btn-primary" onClick={openTerminal}>
                                    <SquareTerminal size={13} />
                                    <span class="dock-btn-label">Open in terminal</span>
                                    <Key k="1" />
                                </button>
                            }
                        >
                            <button class="btn btn-primary" disabled={sending()} onClick={() => void send({ action: "done" })}>
                                <span class="dock-btn-label">Done</span>
                                <Key k="1" />
                            </button>
                            <Show when={it().canSave}>
                                <button class="btn" disabled={sending()} title="Runs automatically next time" onClick={() => void send({ action: "done", save: true })}>
                                    <span class="dock-btn-label">Done, and remember</span>
                                    <Key k="2" />
                                </button>
                            </Show>
                        </Show>
                        <Out />
                    </div>
                </Match>
            </Switch>
        </>
    );
}

/** "github.com" from "github.com/login/device": a button's worth of the address. */
const host = (site: string | undefined) => site?.split("/")[0] ?? "the page";

function Waiting(p: { text: string }) {
    return (
        <p class="dock-line si-wait" role="status">
            <Spinner size={13} /> {p.text}
        </p>
    );
}

/**
 * A code to paste back, or a token: one field, sent with Enter. The value stays in the input element alone (no
 * signal, no draft, no storage) and is cleared once it's sent or the card goes away.
 */
function Field(p: { it: SignInInteraction; label: string; placeholder: string; masked: boolean; action: string; link?: string; send: (a: SignInAction) => Promise<boolean>; children?: JSX.Element }) {
    let input!: HTMLInputElement;
    const [ready, setReady] = createSignal(false);
    const submit = async () => {
        const value = input.value.trim();
        if (!value || p.it.busy) return;
        if (await p.send({ action: "submit", value })) {
            input.value = "";
            setReady(false);
        }
    };
    onMount(() => mayFocus() && usePane().focused() && input.focus());
    onCleanup(() => {
        if (input) input.value = "";
    });
    return (
        <>
            <input
                ref={input}
                class={`input dock-input mono ${p.masked && MASKS ? "masked" : ""}`}
                type={p.masked && !MASKS ? "password" : "text"}
                name={`signin-${p.it.id}`}
                autocomplete={p.masked && !MASKS ? "new-password" : "off"}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                data-bwignore=""
                data-form-type="other"
                placeholder={p.placeholder}
                aria-label={p.label}
                disabled={p.it.busy}
                onInput={() => setReady(Boolean(input.value.trim()))}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        void submit();
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        void p.send({ action: "later" });
                    }
                }}
            />
            <Show when={p.it.error}>
                <p class="dock-warn selectable" role="alert">{p.it.error}</p>
            </Show>
            <Show when={p.link}>
                <button class="link-btn si-link" onClick={() => void openExternal(p.link!)}>
                    New token <ExternalLink size={11} />
                </button>
            </Show>
            <div class="dock-actions">
                <Show when={!p.masked}>{p.children}</Show>
                <button class="btn btn-primary" aria-busy={p.it.busy} disabled={!ready() || p.it.busy} onClick={() => void submit()}>
                    <span class="dock-btn-label">{p.action}</span>
                </button>
                <Show when={p.masked}>{p.children}</Show>
                <button class="btn" onClick={() => void p.send({ action: "later" })}>
                    <span class="dock-btn-label">Later</span>
                    <Key k="Esc" />
                </button>
            </div>
        </>
    );
}

/** What a CLI that asks at prompts shows, and the keyboard for it: each key goes to the CLI, which echoes what it wants seen. */
function Prompt(p: { term: string; keys: (text: string) => void; later: () => void }) {
    let el!: HTMLPreElement;
    onMount(() => mayFocus() && usePane().focused() && el.focus());
    createEffect(on(() => p.term, () => { el.scrollTop = el.scrollHeight; }));
    return (
        <pre
            ref={el}
            class="si-term"
            tabIndex={0}
            role="textbox"
            aria-label="Sign-in prompt"
            aria-multiline="true"
            onKeyDown={(e) => {
                // Esc is the card's (Later); the rest is the CLI's.
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    return p.later();
                }
                const k = terminalKey(e);
                if (k === undefined) return;
                e.preventDefault();
                e.stopPropagation();
                p.keys(k);
            }}
            onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData?.getData("text/plain");
                if (text) p.keys(text.replace(/\r?\n/g, "\r"));
            }}
        >
            {p.term}
            <span class="si-caret" />
        </pre>
    );
}

/**
 * Before something an agent set in motion that spends money or can't be taken back (creating a server, deleting
 * one): what it is, and the answer. Asked in every permission mode.
 */
export function ConfirmCard(p: { sessionId: string; it: ConfirmInteraction }) {
    const [busy, setBusy] = createSignal(false);
    const answer = async (choice: "yes" | "other" | "no") => {
        if (busy()) return;
        setBusy(true);
        if (!(await respond(p.sessionId, p.it.id, { kind: "confirm", choice }))) setBusy(false);
    };
    useKeys((k) => {
        if (k === "1") return void answer("yes"), true;
        if (k === "2" && p.it.other) return void answer("other"), true;
        if (k === "Escape") return void answer("no"), true;
        return false;
    });
    return (
        <>
            <Head title={<>{p.it.title}?</>} />
            <Show when={p.it.facts?.length}>
                <dl class="dock-facts">
                    <For each={p.it.facts}>
                        {([k, v]) => (
                            <div>
                                <dt>{k}</dt>
                                <dd class={`selectable ${k === "Name" || k === "Key" || k === "Address" ? "mono" : ""}`}>{v}</dd>
                            </div>
                        )}
                    </For>
                </dl>
            </Show>
            <Show when={p.it.commands?.length}>
                <pre class="dock-code selectable">{p.it.commands!.join("\n")}</pre>
            </Show>
            <div class="dock-actions">
                <button class="btn btn-primary" disabled={busy()} onClick={() => void answer("yes")}>
                    <span class="dock-btn-label">{p.it.yes}</span>
                    <Key k="1" />
                </button>
                <Show when={p.it.other}>
                    <button class="btn" disabled={busy()} onClick={() => void answer("other")}>
                        <span class="dock-btn-label">{p.it.other}</span>
                        <Key k="2" />
                    </button>
                </Show>
                <button class="btn" disabled={busy()} onClick={() => void answer("no")}>
                    <span class="dock-btn-label">{p.it.no}</span>
                    <Key k="Esc" />
                </button>
            </div>
        </>
    );
}
