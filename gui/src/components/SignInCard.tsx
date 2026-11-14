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
import { signInPressed } from "../lib/card-keys";
import { terminalActions } from "../state/ui";
import { Head, mayFocus, useKeys } from "./InteractionDock";
import { CopyButton, Spinner } from "./ui/bits";
import "../styles/sign-in.css";

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
        if (!windowMachine || !home) return void send({ action: "port", error: "Open this session in the desktop app to finish signing in." });
        const far = home;
        const name = windowMachine;
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
                    <span class="mono ask-code">{it().name}</span>
                </Show>
            </Show>
            <Show when={where()}>
                {" on "}
                <span class="mono ask-code">{where()}</span>
            </Show>
            ?
        </>
    );
    /** The way out, at the far end: back to the list this came from, or put off. */
    const Out = () => (
        <>
            <span class="grow" />
            <button class="pbtn quiet" onClick={() => void send({ action: "later" })}>
                {it().back && it().step !== "list" && it().step !== "token" ? "Back" : "Later"} <kbd>Esc</kbd>
            </button>
        </>
    );
    const Problem = () => (
        <Show when={it().error}>
            <div class="si-error selectable" role="alert">{it().error}</div>
        </Show>
    );
    return (
        <>
            <Head title={title()} sub={it().step === "ask" ? it().warning : undefined} />
            <Switch>
                <Match when={it().step === "list"}>
                    <div class="itab-body">
                        <div class="si-rows">
                            <For each={it().rows ?? []}>
                                {(r) => (
                                    <div class="si-row">
                                        <span class="si-name">{r.name}</span>
                                        <Show
                                            when={r.state === "in"}
                                            fallback={
                                                <button class="pbtn sm" disabled={sending()} aria-label={`Sign in to ${r.name}`} onClick={() => void send({ action: "pick", target: r.target })}>
                                                    Sign in
                                                </button>
                                            }
                                        >
                                            <span class="si-done">
                                                <Check size={13} /> {r.who ?? "Signed in"}
                                            </span>
                                        </Show>
                                    </div>
                                )}
                            </For>
                        </div>
                    </div>
                    <div class="itab-actions ask-row">
                        <Out />
                    </div>
                </Match>
                <Match when={failed()}>
                    <div class="itab-body">
                        <Show when={it().step === "typed" && it().term}>
                            <pre class="si-term mono">{it().term}</pre>
                        </Show>
                        <Show when={it().step !== "typed"}>
                            <Problem />
                        </Show>
                    </div>
                    <div class="itab-actions ask-row">
                        <button class="pbtn primary" disabled={sending()} onClick={() => void send({ action: "retry" })}>
                            Try again <kbd>1</kbd>
                        </button>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "ask"}>
                    <Show when={it().busy}>
                        <div class="itab-body">
                            <Waiting text="Starting" />
                        </div>
                    </Show>
                    <div class="itab-actions ask-row">
                        <Show when={!it().busy}>
                            <button class="pbtn primary" disabled={sending()} onClick={() => void send({ action: "start" })}>
                                Sign in <kbd>1</kbd>
                            </button>
                            <Show when={it().canToken}>
                                <button class="pbtn" disabled={sending()} onClick={() => void send({ action: "token" })}>
                                    Use a token <kbd>2</kbd>
                                </button>
                            </Show>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "browser"}>
                    <div class="itab-body">
                        <Waiting text={it().busy ? "Starting" : "Finish in your browser"} />
                    </div>
                    <div class="itab-actions ask-row">
                        <Show when={it().url && !it().busy}>
                            <button class={`pbtn ${it().open ? "primary" : ""}`} onClick={open}>
                                <ExternalLink size={13} /> {it().open ? <>Open {host(it().site)}</> : "Open again"}
                                <Show when={it().open}>
                                    <kbd>1</kbd>
                                </Show>
                            </button>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "code"}>
                    <div class="itab-body">
                        <div class={`si-code ${it().expired ? "old" : ""}`}>
                            <span class="mono selectable">{it().code}</span>
                            <Show when={!it().expired}>
                                <CopyButton text={() => it().code ?? ""} label="Copy the code" />
                            </Show>
                        </div>
                        <Show when={it().expired} fallback={<Waiting text={`Enter the code at ${it().site ?? "the page"}`} />}>
                            <div class="si-wait">This code expired</div>
                        </Show>
                    </div>
                    <div class="itab-actions ask-row">
                        <Show
                            when={it().expired}
                            fallback={
                                <button class="pbtn primary" onClick={open}>
                                    <ExternalLink size={13} /> Open {host(it().site)} <kbd>1</kbd>
                                </button>
                            }
                        >
                            <button class="pbtn primary" disabled={sending()} onClick={() => void send({ action: "retry" })}>
                                New code <kbd>1</kbd>
                            </button>
                        </Show>
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "paste"}>
                    <Field it={it()} label="Code" placeholder="Paste the code from the page" send={send} masked={false} action="Continue">
                        <button class="pbtn" onClick={open}>
                            <ExternalLink size={13} /> Open page
                        </button>
                    </Field>
                </Match>
                <Match when={it().step === "token"}>
                    <Field it={it()} label={`${it().name} token`} placeholder="Token" send={send} masked action="Sign in" link={it().tokenUrl}>
                        <Show when={it().back}>
                            <button class="pbtn quiet" onClick={() => void send({ action: "back" })}>
                                Back
                            </button>
                        </Show>
                    </Field>
                </Match>
                <Match when={it().step === "typed"}>
                    <div class="itab-body">
                        <Prompt term={it().term ?? ""} keys={(value) => void respond(p.sessionId, p.it.id, { kind: "signin", action: "keys", value })} later={() => void send({ action: "later" })} />
                    </div>
                    <div class="itab-actions ask-row">
                        <Out />
                    </div>
                </Match>
                <Match when={it().step === "command"}>
                    <div class="itab-body">
                        <pre class="itab-code mono selectable">{it().command}</pre>
                    </div>
                    <div class="itab-actions ask-row">
                        <Show
                            when={it().ran}
                            fallback={
                                <button class="pbtn primary" onClick={openTerminal}>
                                    <SquareTerminal size={13} /> Open in terminal <kbd>1</kbd>
                                </button>
                            }
                        >
                            <button class="pbtn primary" disabled={sending()} onClick={() => void send({ action: "done" })}>
                                Done <kbd>1</kbd>
                            </button>
                            <Show when={it().canSave}>
                                <button class="pbtn" disabled={sending()} title="Cavvy runs it for you next time" onClick={() => void send({ action: "done", save: true })}>
                                    Done, and remember <kbd>2</kbd>
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
        <div class="si-wait" role="status">
            <Spinner size={13} /> {p.text}
        </div>
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
    onMount(() => mayFocus() && input.focus());
    onCleanup(() => {
        if (input) input.value = "";
    });
    return (
        <>
            <div class="itab-body">
                <div class="secret-field">
                    <input
                        ref={input}
                        class={`itab-input mono ${p.masked && MASKS ? "masked" : ""}`}
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
                </div>
                <Show when={p.it.error}>
                    <div class="si-error selectable" role="alert">{p.it.error}</div>
                </Show>
                <Show when={p.link}>
                    <button class="link-btn si-link" onClick={() => void openExternal(p.link!)}>
                        New token <ExternalLink size={11} />
                    </button>
                </Show>
            </div>
            <div class="itab-actions ask-row">
                <Show when={!p.masked}>{p.children}</Show>
                <button class="pbtn primary" aria-busy={p.it.busy} disabled={!ready() || p.it.busy} onClick={() => void submit()}>
                    {p.action}
                </button>
                <Show when={p.masked}>{p.children}</Show>
                <span class="grow" />
                <button class="pbtn quiet" onClick={() => void p.send({ action: "later" })}>
                    Later <kbd>Esc</kbd>
                </button>
            </div>
        </>
    );
}

/** What a CLI that asks at prompts shows, and the keyboard for it: each key goes to the CLI, which echoes what it wants seen. */
function Prompt(p: { term: string; keys: (text: string) => void; later: () => void }) {
    let el!: HTMLPreElement;
    onMount(() => mayFocus() && el.focus());
    createEffect(on(() => p.term, () => { el.scrollTop = el.scrollHeight; }));
    return (
        <pre
            ref={el}
            class="si-term mono"
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
            <div class="itab-body">
                <Show when={p.it.facts?.length}>
                    <dl class="si-facts">
                        <For each={p.it.facts}>
                            {([k, v]) => (
                                <>
                                    <dt>{k}</dt>
                                    <dd class={`selectable ${k === "Name" || k === "Key" || k === "Address" ? "mono" : ""}`}>{v}</dd>
                                </>
                            )}
                        </For>
                    </dl>
                </Show>
                <Show when={p.it.commands?.length}>
                    <pre class="itab-code mono selectable">{p.it.commands!.join("\n")}</pre>
                </Show>
            </div>
            <div class="itab-actions ask-row">
                <button class="pbtn primary" disabled={busy()} onClick={() => void answer("yes")}>
                    {p.it.yes} <kbd>1</kbd>
                </button>
                <Show when={p.it.other}>
                    <button class="pbtn" disabled={busy()} onClick={() => void answer("other")}>
                        {p.it.other} <kbd>2</kbd>
                    </button>
                </Show>
                <span class="grow" />
                <button class="pbtn quiet" disabled={busy()} onClick={() => void answer("no")}>
                    {p.it.no} <kbd>Esc</kbd>
                </button>
            </div>
        </>
    );
}
