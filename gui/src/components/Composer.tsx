import { createEffect, createMemo, createSignal, createUniqueId, For, on, onCleanup, Show, type JSX } from "solid-js";
import { ArrowUp, FileText, Folder, ListEnd, Paperclip, Pencil, Slash, SquareTerminal, X } from "lucide-solid";
import type { CommandInfo, PermissionModeId } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast, wasDeleted } from "../state/app";
import { interrupt, send, setMode } from "../state/actions";
import { prefs } from "../state/prefs";
import { comparePicks, setComparePicks, contextCardOpen, focusComposer, modePickerOpen, modelPickerOpen, setContextCardOpen, setModePickerOpen, setModelPickerOpen } from "../state/ui";
import { cost, tokens } from "../lib/format";
import { isMod, mod } from "../lib/platform";
import { EffortMenu, FastModeToggle, ModelPicker, type CompareOption } from "./ModelPicker";
import { startRun } from "./RunSheet";
import { ModePicker, nextMode } from "./ModePicker";
import { InteractionTab } from "./InteractionDock";
import { Popover } from "./ui/Popover";
import { Ring } from "./ui/bits";
import { PlanMeter } from "./PlanMeter";
import { AttachmentChips } from "./AttachmentChips";
import { blockedBy, fromWire, isLongPaste, pastedText, readAttachment } from "../lib/attachments";
import { contextView } from "../lib/context";
import { createLifetimeGuard } from "../lib/lifetime";
import { createComposerDraft } from "../lib/composer-draft";

import { composerStorage } from "../lib/drafts";
import { composingKey, revealMenuOption } from "../lib/composer-menu";

type MenuItem = { kind: "command"; cmd: CommandInfo } | { kind: "file"; path: string };

/** The ring, and on hover what it stands for: tokens, spend, and compacting now. */
function ContextRing(p: { sessionId: string }) {
    let btn: HTMLButtonElement | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    // Shared so /context can open it.
    const [open, setOpen] = [contextCardOpen, setContextCardOpen];
    const st = () => handleFor(p.sessionId)?.view.state;
    const view = () => contextView(st(), open());
    const pct = () => view().pct ?? 0;
    const show = () => (clearTimeout(closeTimer), setOpen(true));
    const hide = () => (closeTimer = setTimeout(() => setOpen(false), 160));
    onCleanup(() => clearTimeout(closeTimer));
    return (
        <Show when={view().ring}>
            <button
                ref={btn}
                class="hb ctx-ring"
                aria-haspopup="dialog"
                aria-expanded={open()}
                aria-label={view().pct === undefined ? "Context window: size not known yet" : `Context: ${Math.round(pct() * 100)}% used`}
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
                        <span class="num">{view().line}</span>
                        <Show when={view().pct !== undefined}>
                            <span class="ctx-pct num">{Math.round(pct() * 100)}%</span>
                        </Show>
                    </div>
                    <Show when={view().pct !== undefined}>
                        <div class="ctx-bar">
                            <div class={`ctx-fill ${pct() >= 0.85 ? "danger" : pct() >= 0.7 ? "warn" : ""}`} style={{ width: `${Math.min(100, pct() * 100)}%` }} />
                        </div>
                    </Show>
                    <div class="ctx-grid">
                        <span>Spent</span>
                        <span class="num" title={st()!.costUnknown ? "No price is known for some of the models used, so their usage isn't counted" : undefined}>
                            {cost(st()!.cost, st()!.costUnknown)}
                        </span>
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

export function Composer(p: { sessionId?: string; placeholder?: string; autofocus?: boolean; variant?: "home" | "session"; /** Tucked under the card, like a drawer (Home's folder and branch). */ strip?: JSX.Element; /** Home: sending to several models at once. */ compare?: CompareOption }) {
    const whileMounted = createLifetimeGuard();
    let ta: HTMLTextAreaElement | undefined;
    let fileInput: HTMLInputElement | undefined;
    let box: HTMLDivElement | undefined;
    const draftKey = () => p.sessionId ?? "home";
    const draft = createComposerDraft(draftKey, wasDeleted);
    const { text, setText, attachments, setAttachments } = draft;
    const [menu, setMenu] = createSignal<MenuItem[]>([]);
    const [menuSel, setMenuSel] = createSignal(0);
    const [menuDismissedFor, setMenuDismissedFor] = createSignal<string>();
    const [dragging, setDragging] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const [effortOpen, setEffortOpen] = createSignal(false);
    let histIdx = -1;
    let historyDraft = "";
    const menuId = `composer-menu-${createUniqueId()}`;
    let menuList: HTMLDivElement | undefined;
    const [menuStatus, setMenuStatus] = createSignal<"loading" | "empty" | "error">();
    const menuOpen = () => menu().length > 0 || !!menuStatus();
    let commands: CommandInfo[] = [];

    const h = () => handleFor(p.sessionId);
    const st = () => h()?.view.state;
    const busy = () => Boolean(st()?.busy);
    const mode = (): PermissionModeId => st()?.mode ?? app.homeMode ?? app.settings.defaultMode ?? "default";
    const bypassAllowed = () => Boolean(st()?.bypassAllowed || app.settings.allowBypass);
    const shell = () => text().startsWith("!");
    /** Compare is only available on Home in a Git project. */
    const runPicks = () => (!p.sessionId && p.compare?.available ? comparePicks() : undefined);
    const resize = () => {
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    };

    createEffect(on([draftKey, text], () => requestAnimationFrame(resize)));
    // What the server hands back (interrupted queue, rewound prompt).
    createEffect(() => {
        const d = h()?.draft();
        if (d === undefined) return;
        h()!.setDraft(undefined);
        if (d.text) setText((t) => (t.trim() ? `${d.text}\n${t}` : d.text));
        if (d.images?.length || d.files?.length) setAttachments((a) => [...a, ...fromWire(d.images, d.files)]);
        requestAnimationFrame(() => {
            resize();
            ta?.focus();
        });
    });
    createEffect(on(focusComposer, () => requestAnimationFrame(() => ta?.focus()), { defer: true }));

    createEffect(on(draftKey, () => {
        histIdx = -1;
        historyDraft = "";
        dismissMenu();
        setMenuDismissedFor(undefined);
        const frame = requestAnimationFrame(() => {
            if (window.matchMedia("(max-width: 760px)").matches) return;
            const active = document.activeElement;
            if (active !== ta && active?.matches("input, textarea, select, [contenteditable='true']")) return;
            if (document.querySelector('[role="dialog"]')) return;
            ta?.focus();
        });
        onCleanup(() => cancelAnimationFrame(frame));
    }));
    createEffect(() => {
        const selected = menuSel();
        const items = menu();
        const frame = requestAnimationFrame(() => {
            const option = menuList?.children[selected] as HTMLElement | undefined;
            if (items.length && menuList && option) revealMenuOption(menuList, option);
        });
        onCleanup(() => cancelAnimationFrame(frame));
    });
    createEffect(
        on(
            [() => (app.conn === "open" ? st()?.cwd ?? app.homeCwd : undefined), () => st()?.model?.provider],
            ([cwd, provider]) => {
                let current = true;
                onCleanup(() => { current = false; });
                commands = [];
                // A reply from the previous project or provider must not replace this menu.
                if (cwd) void rpc.call("commands.list", { cwd, provider }).then((c) => { if (current) commands = c; }).catch(() => undefined);
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
    let mentionVersion = 0;
    const dismissMenu = () => {
        mentionVersion++;
        clearTimeout(mentionTimer);
        setMenu([]);
        setMenuStatus(undefined);
    };
    const updateMenu = () => {
        dismissMenu();
        const version = mentionVersion;
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
            setMenuStatus("loading");
            mentionTimer = setTimeout(async () => {
                try {
                    const found = await rpc.call("fs.mentions", { cwd, query: tok.query });
                    if (version !== mentionVersion) return;
                    setMenu(found.map((path) => ({ kind: "file" as const, path })));
                    setMenuSel(0);
                    setMenuStatus(found.length ? undefined : "empty");
                } catch {
                    if (version === mentionVersion) setMenuStatus("error");
                }
            }, 60);
            return;
        }
        setMenu([]);
    };
    onCleanup(dismissMenu);

    const apply = (item: MenuItem, run: boolean) => {
        if (item.kind === "command") {
            const next = `/${item.cmd.name}${item.cmd.args ? " " : ""}`;
            setText(next);
            dismissMenu();
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
        if (app.conn !== "open") return toast("Not sent: not connected");
        const t = text();
        if (!canSend() || sending()) return;
        const picks = runPicks();
        if (picks && (picks.length < 2 || !app.homeCwd)) return toast(picks.length < 2 ? "Pick 2 to 4 models, or turn off Compare in the model picker." : "Choose a project folder first.", "warn");
        setSending(true);
        const submitted = draft.capture();
        const { attachments: atts } = submitted.draft;
        // A toast retry may finish after Home has unmounted too.
        const resizeAfterSend = whileMounted(() => requestAnimationFrame(resize));
        const sent = () => {
            draft.clearSent(submitted);
            resizeAfterSend();
        };
        const finish = whileMounted((ok: boolean | "command") => {
            setSending(false);
            if (!ok) return;
            histIdx = -1;
            dismissMenu();
            requestAnimationFrame(resize);
        });
        const ok = picks ? await startRun({ path: app.homeCwd!, models: [...picks], text: t, attachments: atts, mode: mode() }) : await send(t, atts, { sent, accepted: (id) => {
            if (!wasDeleted(id)) composerStorage.remember(id, t);
        } });
        if (ok) {
            if (picks) {
                composerStorage.remember(submitted.key, t);
                setComparePicks(undefined);
            }
            draft.clearSent(submitted, ok === "command");
            if (ok === "command" && t.trim() && !atts.length) {
                if (!wasDeleted(submitted.key)) composerStorage.remember(submitted.key, t);
            }
        }
        finish(ok);
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (composingKey(e)) return;
        if (e.key === "Escape" && menuOpen()) {
            e.preventDefault();
            e.stopPropagation();
            setMenuDismissedFor(text());
            dismissMenu();
            return;
        }
        const history = composerStorage.history(draftKey());
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
        }
        if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            void setMode(nextMode(mode(), bypassAllowed()));
            return;
        }
        if (e.key === "Enter") {
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
        if (e.key === "ArrowUp" && (!text() || (histIdx >= 0 && (ta?.selectionStart ?? 0) === 0)) && history.length) {
            e.preventDefault();
            if (histIdx < 0) historyDraft = text();
            histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
            setText(history[histIdx]!);
            requestAnimationFrame(resize);
        } else if (e.key === "ArrowDown" && histIdx >= 0 && (ta?.selectionStart ?? 0) === text().length) {
            e.preventDefault();
            histIdx = histIdx + 1 >= history.length ? -1 : histIdx + 1;
            setText(histIdx < 0 ? historyDraft : history[histIdx]!);
            requestAnimationFrame(resize);
        }
    };

    // ---- attachments: any file (sorted by what's in it, see lib/attachments), and long pastes
    const addFiles = async (files: FileList | File[]) => {
        for (const f of Array.from(files)) {
            const a = await readAttachment(f, attachments());
            setAttachments((list) => [...list, a]);
        }
    };
    const onPaste = (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length) {
            e.preventDefault();
            void addFiles(files);
            return;
        }
        const pasted = e.clipboardData?.getData("text/plain") ?? "";
        if (isLongPaste(pasted)) {
            e.preventDefault();
            setAttachments((list) => [...list, pastedText(pasted, list)]);
        }
    };
    /** A "Pasted text" chip back into the box as plain text, where the cursor is. */
    const toText = (i: number) => {
        const a = attachments()[i];
        if (a?.kind !== "text") return;
        setAttachments((list) => list.filter((_, j) => j !== i));
        const at = ta?.selectionStart ?? text().length;
        setText((t) => t.slice(0, at) + a.text + t.slice(ta?.selectionEnd ?? at));
        requestAnimationFrame(() => {
            resize();
            ta?.focus();
        });
    };
    /** The model this message goes to: the session's, or (Home) the one a new session starts with. */
    const model = () => st()?.model ?? app.models.flatMap((g) => g.models).find((m) => m.ref === app.settings.model);
    // Run members are validated separately by the server; the default model is irrelevant.
    const readsPdf = () => Boolean(runPicks()) || model()?.supportsPdf !== false;
    const blocked = createMemo(() => blockedBy(attachments(), readsPdf()));

    /** A queued message back into the box, out of the queue. */
    // By the message's id, so a queue that moved on meanwhile doesn't lose a different one. Edited, it
    // comes back with its images and files, into this session's draft (even if another is shown by then).
    const dequeue = async (i: number, edit: boolean) => {
        const queueId = st()?.queueIds[i];
        const handle = h();
        if (queueId === undefined || !p.sessionId || !handle) return;
        try {
            const r = await rpc.call("session.dequeue", { id: p.sessionId, queueId, edit });
            if (!r.removed) toast("That message has already been sent", "info");
            else if (edit) handle.addDraft({ text: r.text ?? "", images: r.images, files: r.files });
        } catch (e) {
            reportError(e);
        }
    };

    const placeholder = () => {
        if (shell()) return "Run a shell command";
        if (busy()) return "Queue a message for the next step…";
        return p.placeholder ?? "Ask, plan, or describe a change…  (@ for files, / for commands)";
    };
    const hasContent = () => Boolean(text().trim() || attachments().length);
    const canSend = createMemo(() => hasContent() && !blocked());
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
                                <Show when={st()!.queuedAttached?.[i()]}>
                                    {(label) => (
                                        <span class="queue-attached truncate" title={label()}>
                                            <Paperclip size={12} /> {label()}
                                        </span>
                                    )}
                                </Show>
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
            <Show when={menuOpen()}>
                <div class="composer-menu" ref={menuList} id={menuId} role="listbox" aria-label="Composer suggestions" aria-busy={menuStatus() === "loading"}>
                    <For each={menu()}>
                        {(item, i) => (
                            <button
                                id={`${menuId}-${i()}`}
                                role="option"
                                aria-selected={i() === menuSel()}
                                tabIndex={-1}
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
                    <Show when={menuStatus()}>
                        <div class="cm-status" role="status">
                            {menuStatus() === "loading" ? "Searching…" : menuStatus() === "empty" ? "No matching files" : "Could not search files"}
                        </div>
                    </Show>
                </div>
            </Show>
            <div class="composer-box" ref={box}>
                <Show when={attachments().length}>
                    <AttachmentChips items={attachments()} readsPdf={readsPdf()} blocked={blocked()} onRemove={(i) => setAttachments((list) => list.filter((_, j) => j !== i))} onToText={toText} />
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
                            histIdx = -1;
                            setText(e.currentTarget.value);
                            setMenuDismissedFor(undefined);
                            resize();
                            updateMenu();
                        }}
                        onKeyDown={onKeyDown}
                        onKeyUp={(e) => {
                            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && !composingKey(e)) updateMenu();
                        }}
                        onPaste={onPaste}
                        onClick={updateMenu}
                        aria-label="Message"
                        role="combobox"
                        aria-autocomplete="list"
                        aria-haspopup="listbox"
                        aria-expanded={menuOpen()}
                        aria-controls={menuOpen() ? menuId : undefined}
                        aria-activedescendant={menu().length ? `${menuId}-${menuSel()}` : undefined}
                    />
                </div>
                <div class="composer-bar">
                    <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        onChange={(e) => {
                            const input = e.currentTarget;
                            if (input.files) void addFiles(Array.from(input.files));
                            // Picking the same file again should add it again.
                            input.value = "";
                        }}
                    />
                    <ModelPicker current={st()?.model} currentRef={app.settings.model} open={modelPickerOpen()} setOpen={setModelPickerOpen} edge={edge} placement={menuSide()} compare={p.sessionId ? undefined : p.compare} />
                    <FastModeToggle current={st()?.model} currentRef={app.settings.model} enabled={st() ? st()!.fastMode : app.settings.fastMode} busy={st()?.busy} />
                    <EffortMenu current={st()?.model} currentRef={app.settings.model} effort={st() ? st()!.effort : app.settings.effort} open={effortOpen()} setOpen={setEffortOpen} edge={edge} placement={menuSide()} />
                    <ModePicker mode={mode()} bypassAllowed={bypassAllowed()} open={modePickerOpen()} setOpen={setModePickerOpen} edge={edge} placement={menuSide()} />
                    <span class="spacer" />
                    <button class="hb" title="Attach files" aria-label="Attach files" onClick={() => fileInput?.click()}>
                        <Paperclip size={16} />
                    </button>
                    <PlanMeter sessionId={p.sessionId} provider={st()?.model?.provider ?? app.settings.model?.split(":")[0]} />
                    <Show when={p.sessionId}>
                        <ContextRing sessionId={p.sessionId!} />
                    </Show>
                    <Show
                        when={busy() && !hasContent()}
                        fallback={
                            <button
                                class={`send ${(runPicks()?.length ?? 0) >= 2 ? "wide" : ""}`}
                                disabled={app.conn !== "open" || !canSend() || sending() || Boolean(runPicks() && runPicks()!.length < 2)}
                                onClick={() => void submit()}
                                title={app.conn !== "open" ? "Not connected" : runPicks() ? "Each model gets this prompt in a new worktree" : prefs.enterSends ? "Send (Enter)" : `Send (${mod}+Enter)`}
                                aria-description={app.conn !== "open" ? "Not connected" : undefined}
                                aria-label={runPicks() ? `Send to ${runPicks()!.length} models` : "Send"}
                            >
                                <Show when={(runPicks()?.length ?? 0) >= 2}><span>Send to {runPicks()!.length} models</span></Show>
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
