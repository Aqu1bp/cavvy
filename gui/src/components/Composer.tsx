import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { ArrowUp, FileText, Folder, ImagePlus, ListEnd, Pencil, Slash, SquareTerminal, X } from "lucide-solid";
import type { CommandInfo, PermissionModeId } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { interrupt, send, setMode, type Attachment } from "../state/actions";
import { prefs } from "../state/prefs";
import { focusComposer, modePickerOpen, modelPickerOpen, setModePickerOpen, setModelPickerOpen } from "../state/ui";
import { tokens, usd } from "../lib/format";
import { isMod, mod } from "../lib/platform";
import { EffortMenu, ModelPicker } from "./ModelPicker";
import { ModePicker, nextMode } from "./ModePicker";
import { InteractionTab } from "./InteractionDock";
import { Popover } from "./ui/Popover";
import { Ring } from "./ui/bits";

type MenuItem = { kind: "command"; cmd: CommandInfo } | { kind: "file"; path: string };

/** Unsent text and images per session, so switching sessions doesn't lose them. */
const drafts = new Map<string, { text: string; attachments: Attachment[] }>();
/** What was sent, for ↑ in an empty box. */
const history: string[] = [];

const MAX_IMAGE = 15 * 1024 * 1024;

/** The ring, and on hover what it stands for: tokens, spend, and compacting now. */
function ContextRing(p: { sessionId: string }) {
    let btn: HTMLButtonElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const [open, setOpen] = createSignal(false);
    const st = () => handleFor(p.sessionId)?.view.state;
    const win = () => st()?.model?.contextWindow;
    const pct = () => (st() && win() ? st()!.contextTokens / win()! : 0);
    const show = () => (clearTimeout(closeTimer), setOpen(true));
    const hide = () => (closeTimer = setTimeout(() => setOpen(false), 160));
    onCleanup(() => clearTimeout(closeTimer));
    return (
        <Show when={st() && win()}>
            <button
                ref={btn}
                class="hb ctx-ring"
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-label={`Context: ${Math.round(pct() * 100)}% used`}
                onMouseEnter={show}
                onMouseLeave={hide}
                onClick={() => setOpen(!open())}
            >
                <Ring value={pct()} size={18} stroke={2.4} neutral />
            </button>
            <Popover open={open()} anchor={() => btn} onClose={() => setOpen(false)} placement="top" align="end" width={264} class="ctx-card">
                <div onMouseEnter={show} onMouseLeave={hide}>
                    <div class="ctx-label">Context window</div>
                    <div class="ctx-line">
                        <span class="num">
                            {tokens(st()!.contextTokens)} of {tokens(win()!)} tokens
                        </span>
                        <span class="ctx-pct num">{Math.round(pct() * 100)}%</span>
                    </div>
                    <div class="ctx-bar">
                        <div class={`ctx-fill ${pct() >= 0.85 ? "danger" : pct() >= 0.7 ? "warn" : ""}`} style={{ width: `${Math.min(100, pct() * 100)}%` }} />
                    </div>
                    <div class="ctx-grid">
                        <span>Spent</span>
                        <span class="num">{usd(st()!.cost)}</span>
                        <span>Tokens</span>
                        <span class="num">
                            {tokens(st()!.tokensIn)} in · {tokens(st()!.tokensOut)} out
                        </span>
                    </div>
                    <div class="ctx-foot">
                        <span>{app.settings.autoCompact === false ? "Automatic compaction is off." : "Compacts on its own near the limit."}</span>
                        <button
                            class="ghost-btn outlined"
                            disabled={st()!.busy}
                            onClick={() => {
                                setOpen(false);
                                void rpc.call("session.compact", { id: p.sessionId }).catch(reportError);
                            }}
                        >
                            Compact now
                        </button>
                    </div>
                </div>
            </Popover>
        </Show>
    );
}

export function Composer(p: { sessionId?: string; placeholder?: string; autofocus?: boolean; variant?: "home" | "session"; /** Tucked under the card, like a drawer (Home's folder and branch). */ strip?: JSX.Element }) {
    let ta: HTMLTextAreaElement | undefined;
    let fileInput: HTMLInputElement | undefined;
    let box: HTMLDivElement | undefined;
    const [text, setText] = createSignal("");
    const [attachments, setAttachments] = createSignal<Attachment[]>([]);
    const [menu, setMenu] = createSignal<MenuItem[]>([]);
    const [menuSel, setMenuSel] = createSignal(0);
    const [menuDismissedFor, setMenuDismissedFor] = createSignal<string>();
    const [dragging, setDragging] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const [effortOpen, setEffortOpen] = createSignal(false);
    let histIdx = -1;
    let commands: CommandInfo[] = [];

    const h = () => handleFor(p.sessionId);
    const st = () => h()?.view.state;
    const busy = () => Boolean(st()?.busy);
    const mode = (): PermissionModeId => st()?.mode ?? app.homeMode ?? app.settings.defaultMode ?? "default";
    const bypassAllowed = () => Boolean(st()?.bypassAllowed || app.settings.allowBypass);
    const shell = () => text().startsWith("!");
    const draftKey = () => p.sessionId ?? "home";

    const resize = () => {
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    };

    // Per-session drafts. Each session gets its own input box (it's made again
    // when another session is shown), so the draft is kept when it goes away.
    const keepDraft = (key: string) => {
        if (text().trim() || attachments().length) drafts.set(key, { text: text(), attachments: attachments() });
        else drafts.delete(key);
    };
    createEffect(
        on(draftKey, (key, prev) => {
            if (prev !== undefined) keepDraft(prev);
            const d = drafts.get(key);
            setText(d?.text ?? "");
            setAttachments(d?.attachments ?? []);
            requestAnimationFrame(resize);
        }),
    );
    onCleanup(() => keepDraft(draftKey()));
    // What the server hands back (interrupted queue, rewound prompt).
    createEffect(() => {
        const d = h()?.draft();
        if (d === undefined) return;
        h()!.setDraft(undefined);
        if (d.text) setText((t) => (t.trim() ? `${d.text}\n${t}` : d.text));
        if (d.images?.length) setAttachments((a) => [...a, ...d.images!.map((i) => ({ name: "image", mediaType: i.mediaType, data: i.data, preview: `data:${i.mediaType};base64,${i.data}` }))]);
        requestAnimationFrame(() => {
            resize();
            ta?.focus();
        });
    });
    createEffect(on(focusComposer, () => requestAnimationFrame(() => ta?.focus()), { defer: true }));

    onMount(() => {
        if (p.autofocus) requestAnimationFrame(() => ta?.focus());
    });
    createEffect(
        on(
            () => st()?.cwd ?? app.homeCwd,
            (cwd) => {
                if (cwd) void rpc.call("commands.list", { cwd }).then((c) => (commands = c)).catch(() => undefined);
            },
        ),
    );

    // ---- menus: /commands at the start, @files at the cursor
    const token = () => {
        if (!ta) return undefined;
        const upto = text().slice(0, ta.selectionStart ?? text().length);
        const m = upto.match(/(?:^|\s)@("?[^\s"]*)$/);
        return m ? { query: m[1]!.replace(/^"/, ""), start: upto.length - m[1]!.length - 1 } : undefined;
    };
    let mentionTimer: ReturnType<typeof setTimeout> | undefined;
    const updateMenu = () => {
        const t = text();
        if (menuDismissedFor() === t) return setMenu([]);
        if (/^\/\S*$/.test(t)) {
            const q = t.slice(1).toLowerCase();
            const items = commands
                .filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)))
                .slice(0, 8)
                .map((cmd) => ({ kind: "command" as const, cmd }));
            setMenu(items.length === 1 && `/${items[0]!.cmd.name}` === t ? [] : items);
            setMenuSel(0);
            return;
        }
        const tok = token();
        const cwd = st()?.cwd ?? app.homeCwd;
        if (tok && cwd && p.sessionId) {
            clearTimeout(mentionTimer);
            mentionTimer = setTimeout(async () => {
                const found = await rpc.call("fs.mentions", { cwd, query: tok.query }).catch(() => []);
                if (token()?.query === tok.query) {
                    setMenu(found.map((path) => ({ kind: "file" as const, path })));
                    setMenuSel(0);
                }
            }, 60);
            return;
        }
        setMenu([]);
    };
    onCleanup(() => clearTimeout(mentionTimer));

    const apply = (item: MenuItem, run: boolean) => {
        if (item.kind === "command") {
            const next = `/${item.cmd.name}${item.cmd.args ? " " : ""}`;
            setText(next);
            setMenu([]);
            if (run && !item.cmd.args) void submit();
        } else {
            const tok = token();
            if (!tok || !ta) return;
            const end = ta.selectionStart ?? text().length;
            const ins = `@${item.path.includes(" ") ? `"${item.path}"` : item.path}${item.path.endsWith("/") ? "" : " "}`;
            const next = text().slice(0, tok.start) + ins + text().slice(end);
            setText(next);
            const pos = tok.start + ins.length;
            requestAnimationFrame(() => {
                ta!.setSelectionRange(pos, pos);
                updateMenu();
            });
        }
        ta?.focus();
    };

    // ---- sending
    const submit = async () => {
        const t = text();
        if ((!t.trim() && !attachments().length) || sending()) return;
        setSending(true);
        const atts = attachments();
        const ok = await send(t, atts);
        setSending(false);
        if (!ok) return;
        if (t.trim()) {
            history.push(t);
            if (history.length > 100) history.shift();
        }
        histIdx = -1;
        setText("");
        setAttachments([]);
        drafts.delete(draftKey());
        setMenu([]);
        requestAnimationFrame(resize);
    };

    const onKeyDown = (e: KeyboardEvent) => {
        const items = menu();
        if (items.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setMenuSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
                return;
            }
            if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                apply(items[menuSel()] ?? items[0]!, e.key === "Enter");
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMenuDismissedFor(text());
                setMenu([]);
                return;
            }
        }
        if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            void setMode(nextMode(mode(), bypassAllowed()));
            return;
        }
        if (e.key === "Enter" && !e.isComposing) {
            const sendKey = prefs.enterSends ? !e.shiftKey && !e.altKey : isMod(e);
            if (sendKey || (isMod(e) && !e.shiftKey)) {
                e.preventDefault();
                void submit();
                return;
            }
        }
        if (e.key === "Escape" && busy()) {
            e.preventDefault();
            interrupt(p.sessionId);
            return;
        }
        if (e.key === "ArrowUp" && !text() && history.length) {
            e.preventDefault();
            histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
            setText(history[histIdx]!);
            requestAnimationFrame(resize);
        } else if (e.key === "ArrowDown" && histIdx >= 0 && (ta?.selectionStart ?? 0) === text().length) {
            e.preventDefault();
            histIdx = histIdx + 1 >= history.length ? -1 : histIdx + 1;
            setText(histIdx < 0 ? "" : history[histIdx]!);
            requestAnimationFrame(resize);
        }
    };

    // ---- images
    const addFiles = async (files: FileList | File[]) => {
        for (const f of Array.from(files)) {
            if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) continue;
            if (f.size > MAX_IMAGE) continue;
            const data = await new Promise<string>((resolve) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result));
                r.readAsDataURL(f);
            });
            const base64 = data.slice(data.indexOf(",") + 1);
            setAttachments((a) => [...a, { name: f.name || "pasted image", mediaType: f.type, data: base64, preview: URL.createObjectURL(f) }]);
        }
    };
    const onPaste = (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (files.length) {
            e.preventDefault();
            void addFiles(files);
        }
    };

    /** A queued message back into the box, out of the queue. */
    // By the message's id, so a queue that moved on meanwhile doesn't lose a different one. Edited, it
    // comes back with its images, into this session's draft (even if another is shown by then).
    const dequeue = async (i: number, edit: boolean) => {
        const queueId = st()?.queueIds[i];
        const handle = h();
        if (queueId === undefined || !p.sessionId || !handle) return;
        try {
            const r = await rpc.call("session.dequeue", { id: p.sessionId, queueId, edit });
            if (!r.removed) toast("That message has already been sent", "info");
            else if (edit) handle.setDraft({ text: r.text ?? "", images: r.images });
        } catch (e) {
            reportError(e);
        }
    };

    const placeholder = () => {
        if (shell()) return "Run a shell command";
        if (busy()) return "Queue a message for the next step…";
        return p.placeholder ?? "Ask, plan, or describe a change…  (@ for files, / for commands)";
    };
    const canSend = createMemo(() => Boolean(text().trim() || attachments().length));
    /** Menus open clear of the whole card, tabs included, so they never cover what you're typing. */
    let root: HTMLDivElement | undefined;
    const edge = () => root;
    // Home's composer has the page below it; a session's sits at the bottom of the window.
    const menuSide = () => (p.variant === "home" ? "bottom" : "top");
    const interactions = () => st()?.interactions ?? [];

    return (
        <div
            ref={root}
            class={`composer v-${p.variant ?? "session"} ${shell() ? "shell" : ""} ${dragging() ? "dragging" : ""}`}
            onDragOver={(e) => {
                if (e.dataTransfer?.types.includes("Files")) {
                    e.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
            }}
        >
            <Show when={st()?.queued.length}>
                <div class="tab queue-tab">
                    <For each={st()!.queued}>
                        {(q, i) => (
                            <div class="queue-row">
                                <ListEnd size={14} class="queue-icon" />
                                <span class="queue-text truncate">{q}</span>
                                <Show when={i() === 0}>
                                    <span class="queue-hint">Sends after this step</span>
                                </Show>
                                <button class="hb sm" title="Edit" aria-label="Edit queued message" onClick={() => void dequeue(i(), true)}>
                                    <Pencil size={13} />
                                </button>
                                <button class="hb sm" title="Remove from the queue" aria-label="Remove from the queue" onClick={() => void dequeue(i(), false)}>
                                    <X size={14} />
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
            <Show when={p.sessionId && interactions().length}>
                <InteractionTab sessionId={p.sessionId!} items={interactions()} />
            </Show>
            <Show when={menu().length}>
                <div class="composer-menu" role="listbox">
                    <For each={menu()}>
                        {(item, i) => (
                            <button
                                class={`cm-item ${i() === menuSel() ? "sel" : ""}`}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    apply(item, true);
                                }}
                                onMouseMove={() => setMenuSel(i())}
                            >
                                <Show
                                    when={item.kind === "command" && item}
                                    fallback={
                                        <>
                                            <span class="cm-icon">{(item as { path: string }).path.endsWith("/") ? <Folder size={14} /> : <FileText size={14} />}</span>
                                            <span class="cm-name mono truncate">{(item as { path: string }).path}</span>
                                        </>
                                    }
                                >
                                    {(c) => (
                                        <>
                                            <span class="cm-icon">
                                                <Slash size={13} />
                                            </span>
                                            <span class="cm-name mono">
                                                {c().cmd.name}
                                                <Show when={c().cmd.args}>
                                                    <span class="cm-args"> {c().cmd.args}</span>
                                                </Show>
                                            </span>
                                            <span class="cm-desc truncate">{c().cmd.description}</span>
                                        </>
                                    )}
                                </Show>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
            <div class="composer-box" ref={box}>
                <Show when={attachments().length}>
                    <div class="attachments">
                        <For each={attachments()}>
                            {(a, i) => (
                                <div class="attachment">
                                    <img src={a.preview} alt={a.name} />
                                    <button class="attachment-x" title="Remove" aria-label="Remove image" onClick={() => setAttachments((list) => list.filter((_, j) => j !== i()))}>
                                        <X size={11} />
                                    </button>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
                <div class="composer-input">
                    <Show when={shell()}>
                        <span class="shell-badge" title="Runs in your shell; the output is shared with the model">
                            <SquareTerminal size={14} />
                        </span>
                    </Show>
                    <textarea
                        ref={ta}
                        rows={1}
                        value={text()}
                        placeholder={placeholder()}
                        spellcheck={!shell()}
                        onInput={(e) => {
                            setText(e.currentTarget.value);
                            setMenuDismissedFor(undefined);
                            resize();
                            updateMenu();
                        }}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        onClick={updateMenu}
                        aria-label="Message"
                    />
                </div>
                <div class="composer-bar">
                    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => e.currentTarget.files && void addFiles(e.currentTarget.files)} />
                    <ModelPicker current={st()?.model} currentRef={app.settings.model} open={modelPickerOpen()} setOpen={setModelPickerOpen} edge={edge} placement={menuSide()} />
                    <EffortMenu current={st()?.model} currentRef={app.settings.model} effort={st() ? st()!.effort : app.settings.effort} open={effortOpen()} setOpen={setEffortOpen} edge={edge} placement={menuSide()} />
                    <ModePicker mode={mode()} bypassAllowed={bypassAllowed()} open={modePickerOpen()} setOpen={setModePickerOpen} edge={edge} placement={menuSide()} />
                    <span class="spacer" />
                    <button class="hb" title="Attach images" aria-label="Attach images" onClick={() => fileInput?.click()}>
                        <ImagePlus size={16} />
                    </button>
                    <Show when={p.sessionId}>
                        <ContextRing sessionId={p.sessionId!} />
                    </Show>
                    <Show
                        when={busy() && !canSend()}
                        fallback={
                            <button class="send" disabled={!canSend() || sending()} onClick={() => void submit()} title={prefs.enterSends ? "Send (Enter)" : `Send (${mod}+Enter)`} aria-label="Send">
                                <ArrowUp size={17} stroke-width={2.4} />
                            </button>
                        }
                    >
                        <button class="send stop" onClick={() => interrupt(p.sessionId)} title="Stop (Esc)" aria-label="Stop">
                            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                                <rect x="1" y="1" width="10" height="10" rx="2.5" fill="currentColor" />
                            </svg>
                        </button>
                    </Show>
                </div>
            </div>
            <Show when={p.strip}>
                <div class="composer-strip">{p.strip}</div>
            </Show>
        </div>
    );
}
