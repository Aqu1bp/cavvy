import { createEffect, createMemo, createSignal, createUniqueId, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { isMod, mod } from "../lib/platform";
import { ArrowUp, AtSign, CornerDownRight, Database, FileText, Folder, ListEnd, Paperclip, Slash, Sparkles, SquareTerminal } from "lucide-solid";
import type { CommandInfo, FollowUpMode, McpResourceInfo, PermissionModeId } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast, wasDeleted } from "../state/app";
import { interrupt, send, setMode } from "../state/actions";
import { prefs } from "../state/prefs";
import { comparePicks, setComparePicks, focusComposer, modePickerOpen, modelPickerOpen, setModePickerOpen, setModelPickerOpen, setReview, settingsTab } from "../state/ui";
import { keymap, matchKey, shortcut, shortcutHint, withShortcut } from "../state/keybindings";
import { eventStrokes } from "../lib/keystrokes";
import type { MatchResult } from "../../../src/keybindings/core";
import { EffortPicker, ModelPicker, type CompareOption } from "./ModelPicker";
import { startRun } from "./RunSheet";
import { ModePicker, nextMode } from "./ModePicker";
import { InteractionTab } from "./InteractionDock";
import { ScheduleTab } from "./ScheduleTab";
import { GoalTab } from "./GoalTab";
import { ComposerMeter } from "./ComposerMeter";
import { BackgroundChip } from "./BackgroundTasks";
import { AttachmentChips } from "./AttachmentChips";
import { ReviewCommentChips } from "./ReviewCommentChips";
import { splitComments, takesComments, withComments } from "../lib/review-comments";
import { plural } from "../lib/format";
import { aroundOf, newCommentId, reviewComments } from "../state/review-comments";
import { blockedBy, fromWire, isLongPaste, pastedText, readAttachment } from "../lib/attachments";
import { createLifetimeGuard } from "../lib/lifetime";
import { createComposerDraft } from "../lib/composer-draft";

import { composerStorage } from "../lib/drafts";
import { composingKey, revealMenuOption } from "../lib/composer-menu";
import { matchSkills, skillToken } from "../lib/commands";
import { firstSendable, followUpFor, otherFollowUp } from "../lib/queue";
import { canStop } from "../lib/session-status";
import { now } from "../lib/clock";
import { turnDuration } from "../lib/format";
import { QueueTab } from "./QueueTab";

/** `mention`: a skill picked from the $ menu, which goes in where the $ is. */
type MenuItem = { kind: "command"; cmd: CommandInfo; mention?: boolean } | { kind: "file"; path: string } | { kind: "resource"; res: McpResourceInfo };

export function Composer(p: { sessionId?: string; placeholder?: string; autofocus?: boolean; variant?: "home" | "session"; /** Tucked under the card, like a drawer (Home's folder and branch). */ strip?: JSX.Element; /** Home: sending to several models at once. */ compare?: CompareOption }) {
    /** The last @ search asked MCP servers too, so its empty state says so. */
    const [searchedResources, setSearchedResources] = createSignal(false);
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
    /** dragenters less dragleaves: entering a child comes before leaving its parent, so it's 0 only once the drag is out. */
    let dragDepth = 0;
    const [sending, setSending] = createSignal(false);
    const [effortOpen, setEffortOpen] = createSignal(false);
    let histIdx = -1;
    let historyDraft = "";
    const menuId = `composer-menu-${createUniqueId()}`;
    let menuList: HTMLDivElement | undefined;
    const [menuStatus, setMenuStatus] = createSignal<"loading" | "empty" | "error" | "no-skills">();
    const menuOpen = () => menu().length > 0 || !!menuStatus();
    let commands: CommandInfo[] = [];
    /** The list came back (not still loading, not failed), so an empty one means there are none. */
    let commandsLoaded = false;
    /** Asks for the commands again (a skill added since): set while the composer has a project. */
    let refetchCommands: (() => void) | undefined;

    const h = () => handleFor(p.sessionId);
    const st = () => h()?.view.state;
    const busy = () => Boolean(st()?.busy);
    const mode = (): PermissionModeId => st()?.mode ?? app.homeMode ?? app.settings.defaultMode ?? "default";
    const bypassAllowed = () => Boolean(st()?.bypassAllowed || app.settings.allowBypass);
    const shell = () => text().startsWith("!");
    /** Review comments left in this session's diff; they go with the next message. */
    const comments = () => (p.sessionId && !wasDeleted(p.sessionId) ? reviewComments.list(p.sessionId) : []);
    /** A command or a shell line doesn't take them: they wait for the next message. */
    const holdsComments = () => !takesComments(text());
    /** Compare is only available on Home in a Git project. */
    const runPicks = () => (!p.sessionId && p.compare?.available ? comparePicks() : undefined);
    const resize = () => {
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    };

    createEffect(on([draftKey, text], () => requestAnimationFrame(resize)));
    // A message being written means the user is back: the server holds off compacting while idle.
    const writing = () => Boolean(text().trim() || attachments().length);
    createEffect(on([() => p.sessionId, writing, () => h()?.ready?.()], ([id, present, ready]) => {
        if (!id || !ready) return;
        void rpc.call("session.draft", { id, present }).catch(() => undefined);
        if (present) onCleanup(() => void rpc.call("session.draft", { id, present: false }).catch(() => undefined));
    }));
    // What the server hands back (interrupted queue, rewound prompt).
    createEffect(() => {
        const d = h()?.draft();
        if (d === undefined) return;
        h()!.setDraft(undefined);
        // Comments sent with it come back as comments, not as their markup.
        const back = splitComments(d.text);
        if (back.comments.length) reviewComments.restore(h()!.id, back.comments.map((c) => ({ ...c, ...aroundOf(h()!.id, c), id: newCommentId(), created: Date.now() })));
        if (back.text) setText((t) => (t.trim() ? `${back.text}\n${t}` : back.text));
        if (d.images?.length || d.files?.length) setAttachments((a) => [...a, ...fromWire(d.images, d.files)]);
        // Restored without focus while Settings covers it: that would take focus from what's typed there.
        requestAnimationFrame(() => {
            resize();
            if (!settingsTab()) ta?.focus();
        });
    });
    // Not while Settings covers it (App.tsx keeps it mounted there).
    createEffect(on(focusComposer, () => requestAnimationFrame(() => !settingsTab() && ta?.focus()), { defer: true }));

    /** Takes focus on the next frame, as on opening, unless something else is being typed in or a dialog is open. */
    const focusSoon = () => {
        const frame = requestAnimationFrame(() => {
            if (settingsTab() || window.matchMedia("(max-width: 760px)").matches) return;
            const active = document.activeElement;
            if (active !== ta && active?.matches("input, textarea, select, [contenteditable='true']")) return;
            if (document.querySelector('[role="dialog"]')) return;
            ta?.focus();
        });
        onCleanup(() => cancelAnimationFrame(frame));
    };
    createEffect(on(draftKey, () => {
        histIdx = -1;
        historyDraft = "";
        dismissMenu();
        setMenuDismissedFor(undefined);
        focusSoon();
    }));
    // Back from Settings, which keeps this mounted under it: focused as when it opened.
    createEffect(on(settingsTab, (tab, was) => { if (was && !tab) focusSoon(); }, { defer: true }));
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
            // MCP prompts are commands too: the list is read again when a server's prompts come or go.
            [() => (app.conn === "open" ? st()?.cwd ?? app.homeCwd : undefined), () => st()?.model?.provider, () => (st()?.mcp ?? []).map((m) => `${m.name}:${m.prompts ?? 0}`).join("\0")],
            ([cwd, provider]) => {
                let current = true;
                onCleanup(() => { current = false; });
                commands = [];
                commandsLoaded = false;
                // A reply from the previous project or provider must not replace this menu.
                const fetch = () => {
                    if (cwd) void rpc.call("commands.list", { cwd, provider }).then((c) => {
                        if (!current) return;
                        commands = c;
                        commandsLoaded = true;
                        // Typed while it loaded: the open menu shows the new list.
                        if (menuOpen() || /^\/\S*$/.test(text()) || skillAtCursor()) updateMenu(false);
                    }).catch(() => undefined);
                };
                fetch();
                refetchCommands = fetch;
                onCleanup(() => { if (refetchCommands === fetch) refetchCommands = undefined; });
            },
        ),
    );

    // ---- menus: /commands at the start, @files and $skills at the cursor
    const skillAtCursor = () => (ta ? skillToken(text().slice(0, ta.selectionStart ?? text().length)) : undefined);
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
    /** `refresh`: a menu that just opened asks the server again, which reads new skills. */
    const updateMenu = (refresh = true) => {
        dismissMenu();
        const version = mentionVersion;
        const t = text();
        if (menuDismissedFor() === t) return setMenu([]);
        const skill = skillAtCursor();
        if (refresh && (t === "/" || (skill && !skill.query))) refetchCommands?.();
        if (skill && !(/^\/\S*$/.test(t))) {
            const items = matchSkills(commands, skill.query).map((cmd) => ({ kind: "command" as const, cmd, mention: true }));
            setMenu(items.length === 1 && items[0]!.cmd.name === skill.query ? [] : items);
            setMenuSel(0);
            // A lone $ asks for skills; with none, say how to add one (a price like $5 just closes the menu).
            if (!items.length && t.trim() === "$" && commandsLoaded && !commands.some((c) => c.skill)) setMenuStatus("no-skills");
            return;
        }
        if (/^\/\S*$/.test(t)) {
            const q = t.slice(1).toLowerCase();
            const items = commands
                .filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)))
                // The menu scrolls: skills and custom commands after the built-ins stay reachable.
                .slice(0, 100)
                .map((cmd) => ({ kind: "command" as const, cmd }));
            setMenu(items.length === 1 && `/${items[0]!.cmd.name}` === t ? [] : items);
            setMenuSel(0);
            return;
        }
        const tok = token();
        const cwd = st()?.cwd ?? app.homeCwd;
        if (tok && cwd && p.sessionId) {
            setMenuStatus("loading");
            const sid = p.sessionId;
            // Only a session whose servers offer resources is asked for them.
            const hasResources = (st()?.mcp ?? []).some((m) => m.status === "connected" && m.resources);
            mentionTimer = setTimeout(async () => {
                try {
                    const [found, resources] = await Promise.all([
                        rpc.call("fs.mentions", { cwd, query: tok.query }),
                        hasResources && tok.query ? rpc.call("session.mcpResources", { id: sid, query: tok.query }).catch(() => [] as McpResourceInfo[]) : Promise.resolve([] as McpResourceInfo[]),
                    ]);
                    if (version !== mentionVersion) return;
                    const files = found.map((path) => ({ kind: "file" as const, path }));
                    const res = resources.map((r) => ({ kind: "resource" as const, res: r }));
                    // "server:" asks for that server's resources first; otherwise files lead.
                    setMenu(tok.query.includes(":") ? [...res, ...files].slice(0, 12) : [...files.slice(0, Math.max(6, 12 - res.length)), ...res].slice(0, 12));
                    setMenuSel(0);
                    setMenuStatus(found.length || resources.length ? undefined : "empty");
                    setSearchedResources(hasResources && Boolean(tok.query));
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
        if (item.kind === "command" && item.mention) {
            const tok = skillAtCursor();
            if (!tok || !ta) return;
            const end = ta.selectionStart ?? text().length;
            const ins = `$${item.cmd.name} `;
            setText(text().slice(0, tok.start) + ins + text().slice(end));
            const pos = tok.start + ins.length;
            dismissMenu();
            requestAnimationFrame(() => ta!.setSelectionRange(pos, pos));
        } else if (item.kind === "command") {
            const next = `/${item.cmd.name}${item.cmd.args ? " " : ""}`;
            setText(next);
            dismissMenu();
            if (run && !item.cmd.args) void submit();
        } else {
            const tok = token();
            if (!tok || !ta) return;
            const end = ta.selectionStart ?? text().length;
            const ins = item.kind === "resource" ? `@${item.res.mention} ` : `@${item.path.includes(" ") ? `"${item.path}"` : item.path}${item.path.endsWith("/") ? "" : " "}`;
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
    /** What a message sent now does while a turn runs: the setting, or with `opposite` (the steer-or-queue key, mod-click) the other. */
    const followUp = (opposite = false): FollowUpMode => followUpFor(app.settings.followUpBehavior, opposite);
    /** mod+shift held in the box: the send button shows the other. */
    const [flipped, setFlipped] = createSignal(false);
    const shown = () => followUp(flipped());
    const submit = async (opposite = false) => {
        if (app.conn !== "open") return toast("Not sent: not connected");
        const t = text();
        if (!canSend() || sending()) return;
        const picks = runPicks();
        if (picks && (picks.length < 2 || !app.homeCwd)) return toast(picks.length < 2 ? "Pick 2 to 4 models, or turn off Compare in the model picker." : "Choose a project folder first.", "warn");
        setSending(true);
        const submitted = draft.capture();
        const { attachments: atts } = submitted.draft;
        const sessionId = p.sessionId;
        const sentComments = sessionId && !holdsComments() ? [...comments()] : [];
        const message = withComments(t, sentComments);
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
        const ok = picks ? await startRun({ path: app.homeCwd!, models: [...picks], text: t, attachments: atts, mode: mode() }) : await send(message, atts, { followUp: busy() ? followUp(opposite) : undefined, sent, accepted: (id) => {
            if (!wasDeleted(id) && t.trim()) composerStorage.remember(id, t);
            // Sent: out of the box and the diff. Ones added meanwhile stay for the next message.
            if (sentComments.length) reviewComments.removeSent(id, sentComments);
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

    /** Adds a line where the caret is, keeping the box's own undo. */
    const newline = () => {
        if (!ta) return;
        if (!document.execCommand?.("insertText", false, "\n")) ta.setRangeText("\n", ta.selectionStart, ta.selectionEnd, "end");
        setText(ta.value);
        requestAnimationFrame(resize);
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (composingKey(e)) return;
        const items = menu();
        // Enter on the / and @ menu takes the suggestion, whatever Enter is bound to (a modified Enter goes by its binding).
        if (items.length && e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            apply(items[menuSel()] ?? items[0]!, true);
            return;
        }
        // A menu with nothing to pick (a status line) only takes the key that closes it.
        const closesStatus = !items.length && menuOpen() && eventStrokes(e).some((id) => keymap().table.get("Autocomplete")?.get(id) === "autocomplete:dismiss");
        const r: MatchResult = closesStatus ? { kind: "action", action: "autocomplete:dismiss", context: "Autocomplete", abandoned: 0 } : matchKey(e, items.length ? ["Autocomplete", "Chat", "Global"] : ["Chat", "Global"]);
        if (r.kind !== "action") return;
        const history = composerStorage.history(draftKey());
        switch (r.action) {
            case "autocomplete:dismiss":
                if (!menuOpen()) return;
                e.preventDefault();
                // Not also a way out of the view behind.
                e.stopPropagation();
                setMenuDismissedFor(text());
                dismissMenu();
                return;
            case "autocomplete:previous":
            case "autocomplete:next":
                if (!items.length) return;
                e.preventDefault();
                setMenuSel((s) => (s + (r.action === "autocomplete:next" ? 1 : -1) + items.length) % items.length);
                return;
            case "autocomplete:accept":
                if (!items.length) return;
                e.preventDefault();
                apply(items[menuSel()] ?? items[0]!, false);
                return;
            case "chat:cycleMode":
                e.preventDefault();
                void setMode(nextMode(mode(), bypassAllowed()));
                return;
            case "chat:submit":
                e.preventDefault();
                // Sending with the menu open takes the suggestion (and runs a command).
                if (items.length) return apply(items[menuSel()] ?? items[0]!, true);
                void submit();
                return;
            case "chat:newline":
                e.preventDefault();
                newline();
                return;
            case "chat:submitOtherWay":
                // While a turn runs, with the / and @ menu open too: the message goes the other way, or the first queued one now.
                if (!busy()) return;
                e.preventDefault();
                if (hasContent()) void submit(true);
                else sendFirstQueued();
                return;
            case "app:interrupt":
                if (!canStop(st())) return;
                e.preventDefault();
                interrupt(p.sessionId);
                return;
            case "history:previous":
                if ((text() && !(histIdx >= 0 && (ta?.selectionStart ?? 0) === 0)) || !history.length) return;
                e.preventDefault();
                if (histIdx < 0) historyDraft = text();
                histIdx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
                setText(history[histIdx]!);
                requestAnimationFrame(resize);
                return;
            case "history:next":
                if (histIdx < 0 || (ta?.selectionStart ?? 0) !== text().length) return;
                e.preventDefault();
                histIdx = histIdx + 1 >= history.length ? -1 : histIdx + 1;
                setText(histIdx < 0 ? historyDraft : history[histIdx]!);
                requestAnimationFrame(resize);
                return;
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

    const sendFirstQueued = () => {
        const s = st();
        const i = s && p.sessionId ? firstSendable(s.queuedModes ?? s.queued.map(() => "steer" as const), busy()) : -1;
        const queueId = i >= 0 ? s!.queueIds[i] : undefined;
        if (queueId === undefined) return;
        void rpc.call("session.sendQueuedNow", { id: p.sessionId!, queueId }).catch(reportError);
    };

    const placeholder = () => {
        if (shell()) return "Run a shell command";
        // A message doesn't wait for an idle compaction: it stops it and goes.
        if (busy() && st()?.activity?.idle) return "Send a message to stop compacting and carry on…";
        if (busy()) return followUp() === "steer" ? "Steer: add to the current turn at its next step…" : "Queue a message for after this turn…";
        return p.placeholder ?? "Ask, plan, or describe a change…  (@ files, / commands, $ skills)";
    };
    const hasContent = () => Boolean(text().trim() || attachments().length || comments().length);
    const sendTitle = () => {
        const key = prefs.enterSends ? "Enter" : `${mod}+Enter`;
        const other = otherFollowUp(followUp());
        const now = followUp() === "steer" ? `Steer: joins the current turn at its next step (${key})` : `Queue: runs after this turn (${key})`;
        const otherKey = shortcut("chat:submitOtherWay");
        return `${now}. ${mod}-click${otherKey ? ` or ${otherKey}` : ""} to ${other} instead.`;
    };
    const canSend = createMemo(() => hasContent() && !blocked());
    // The pickers open from their own button, left-aligned with it (design/glass placePop): above it in a
    // session, at the bottom of the window; below it on Home, which has the page below it. Each flips if there's no room.
    const menuSide = () => (p.variant === "home" ? "bottom" : "top");
    const interactions = () => st()?.interactions ?? [];
    /** The status row: while a turn runs, unless a request card already says what's happening. */
    const working = () => Boolean(p.sessionId && busy() && !interactions().length);
    /** Compacting while idle: no turn runs, so it counts from the compaction's start (the placeholder says a message stops it). */
    const idle = () => Boolean(st()?.activity?.idle);
    const since = () => (idle() ? st()?.activity?.since : (h()?.view.turns?.at(-1)?.startedAt ?? st()?.activity?.since));
    const elapsed = () => (since() === undefined ? "" : turnDuration(Math.max(0, now() - since()!)));
    /** Puts an @ where the caret is (after a space), which opens the file menu. */
    const mention = () => {
        if (!ta) return;
        const start = ta.selectionStart ?? text().length;
        const end = ta.selectionEnd ?? start;
        const before = text().slice(0, start);
        const ins = `${before && !/\s$/.test(before) ? " " : ""}@`;
        histIdx = -1;
        setText(before + ins + text().slice(end));
        setMenuDismissedFor(undefined);
        const pos = start + ins.length;
        ta.focus();
        requestAnimationFrame(() => {
            ta!.setSelectionRange(pos, pos);
            resize();
            updateMenu();
        });
    };

    return (
        <div
            class={`composer v-${p.variant ?? "session"} ${shell() ? "shell" : ""} ${dragging() ? "dragging" : ""} ${working() ? "running" : ""}`}
            onDragEnter={(e) => {
                if (!e.dataTransfer?.types.includes("Files")) return;
                dragDepth++;
                setDragging(true);
            }}
            onDragOver={(e) => {
                if (e.dataTransfer?.types.includes("Files")) {
                    e.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => {
                // Leaving for one of its own children isn't leaving: the ring stays on, instead of blinking off and fading back.
                dragDepth = Math.max(0, dragDepth - 1);
                if (!dragDepth) setDragging(false);
            }}
            onDrop={(e) => {
                e.preventDefault();
                dragDepth = 0;
                setDragging(false);
                if (e.dataTransfer?.files) void addFiles(e.dataTransfer.files);
            }}
        >
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
                                <Switch>
                                    <Match when={item.kind === "command" && item}>
                                        {(c) => (
                                            <>
                                                <span class={`cm-icon ${c().cmd.skill ? "skill" : ""}`}>
                                                    <Show when={c().cmd.skill} fallback={<Slash size={13} />}>
                                                        <Sparkles size={13} />
                                                    </Show>
                                                </span>
                                                <span class="cm-name mono">
                                                    {c().mention ? "$" : ""}
                                                    {c().cmd.name}
                                                    <Show when={c().cmd.args && !c().mention}>
                                                        <span class="cm-args"> {c().cmd.args}</span>
                                                    </Show>
                                                </span>
                                                {/* /compact and the like answer without the model: what's attached would be lost, so the server refuses it. */}
                                                <Show when={c().cmd.noAttachments && !c().mention && attachments().length} fallback={<span class="cm-desc truncate">{c().cmd.description}</span>}>
                                                    <span class="cm-desc cm-warn truncate">Doesn't take attachments: send them on their own</span>
                                                </Show>
                                            </>
                                        )}
                                    </Match>
                                    <Match when={item.kind === "resource" && item}>
                                        {(r) => (
                                            <>
                                                <span class="cm-icon" title="MCP resource">
                                                    <Database size={13} />
                                                </span>
                                                <span class="cm-name mono truncate">
                                                    {r().res.server}:{r().res.uri}
                                                </span>
                                                <span class="cm-desc truncate">{r().res.title ?? (r().res.name !== r().res.uri ? r().res.name : r().res.description)}</span>
                                            </>
                                        )}
                                    </Match>
                                    <Match when={item.kind === "file" && item}>
                                        {(f) => (
                                            <>
                                                <span class="cm-icon">{f().path.endsWith("/") ? <Folder size={14} /> : <FileText size={14} />}</span>
                                                <span class="cm-name mono truncate">{f().path}</span>
                                            </>
                                        )}
                                    </Match>
                                </Switch>
                            </button>
                        )}
                    </For>
                    <Show when={menuStatus()}>
                        <div class="cm-status" role="status">
                            {menuStatus() === "loading" ? "Searching…" : menuStatus() === "empty" ? (searchedResources() ? "No matching files or resources" : "No matching files") : menuStatus() === "no-skills" ? (
                                <>No skills yet. Add one as <span class="mono">&lt;name&gt;/SKILL.md</span> in <span class="mono">~/.harness/skills</span> or the project's <span class="mono">.harness/skills</span>.</>
                            ) : "Could not search files"}
                        </div>
                    </Show>
                </div>
            </Show>
            <div class="composer-box glass" ref={box}>
                <Show when={working()}>
                    <div class="c-status">
                        <span class="c-spin" aria-hidden="true" />
                        <span class="lbl truncate" title={st()?.activity?.detail}>
                            {st()?.activity?.label ?? "Working"}
                        </span>
                        <span class="tm num">{elapsed()}</span>
                        <span class="grow" />
                        <Show when={shortcut("app:interrupt")}>{(k) => <kbd class="c-stop">{k()} to stop</kbd>}</Show>
                    </div>
                </Show>
                <Show when={p.sessionId ? st()?.goal : undefined}>
                    {(goal) => <GoalTab sessionId={p.sessionId!} goal={goal()} />}
                </Show>
                <Show when={p.sessionId && st()?.schedules?.length}>
                    <ScheduleTab sessionId={p.sessionId!} items={st()!.schedules} />
                </Show>
                <Show when={p.sessionId && st()?.queued.length}>
                    <QueueTab sessionId={p.sessionId!} state={st()!} dequeue={(i, edit) => void dequeue(i, edit)} />
                </Show>
                <Show when={comments().length}>
                    <ReviewCommentChips
                        items={comments()}
                        held={holdsComments() ? "Review comments wait for your next message: commands and shell lines don't take them" : undefined}
                        onOpen={(c) => setReview({ path: c.path })}
                        onRemove={(c) => reviewComments.remove(p.sessionId!, [c.id])}
                        onClear={() => reviewComments.remove(p.sessionId!, comments().map((c) => c.id))}
                    />
                </Show>
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
                        onKeyDown={(e) => {
                            setFlipped(isMod(e) && e.shiftKey);
                            onKeyDown(e);
                        }}
                        onKeyUp={(e) => {
                            setFlipped(isMod(e) && e.shiftKey);
                            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && !composingKey(e)) updateMenu();
                        }}
                        onBlur={() => setFlipped(false)}
                        onPaste={onPaste}
                        onClick={() => updateMenu()}
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
                    <button class="cb" title="Attach files" aria-label="Attach files" onClick={() => fileInput?.click()}>
                        <Paperclip size={16} />
                    </button>
                    <Show when={p.sessionId}>
                        <button class="cb" title="Mention a file (@)" aria-label="Mention a file" onClick={mention}>
                            <AtSign size={16} />
                        </button>
                    </Show>
                    <span class="vsep" aria-hidden="true" />
                    <ModelPicker current={st()?.model} currentRef={app.settings.model} open={modelPickerOpen()} setOpen={setModelPickerOpen} placement={menuSide()} compare={p.sessionId ? undefined : p.compare} />
                    <EffortPicker current={st()?.model} currentRef={app.settings.model} effort={st() ? st()!.effort : app.settings.effort} fast={st() ? st()!.fastMode : app.settings.fastMode} busy={st()?.busy && !st()?.activity?.idle} open={effortOpen()} setOpen={setEffortOpen} placement={menuSide()} />
                    <ModePicker mode={mode()} bypassAllowed={bypassAllowed()} open={modePickerOpen()} setOpen={setModePickerOpen} placement={menuSide()} />
                    <span class="grow" />
                    <BackgroundChip sessionId={p.sessionId} />
                    <ComposerMeter sessionId={p.sessionId} provider={st()?.model?.provider ?? app.settings.model?.split(":")[0]} />
                    {/* Writing while a turn runs: the key that sends it the other way, by the button that sends it this way. */}
                    <Show when={busy() && hasContent() && !runPicks() && shortcutHint("chat:submitOtherWay")}>
                        {(key) => (
                            <kbd class="c-alt" title={sendTitle()}>
                                {key()} {otherFollowUp(shown())}
                            </kbd>
                        )}
                    </Show>
                    <Show
                        when={canStop(st()) && !hasContent()}
                        fallback={
                            <button
                                class={`send ${(runPicks()?.length ?? 0) >= 2 ? "wide" : ""} ${busy() ? `mid-${shown()}` : ""}`}
                                disabled={app.conn !== "open" || !canSend() || sending() || Boolean(runPicks() && runPicks()!.length < 2)}
                                onClick={(e) => void submit(busy() && isMod(e))}
                                title={app.conn !== "open" ? "Not connected" : runPicks() ? "Each model gets this prompt in a new worktree" : busy() ? sendTitle() : withShortcut("Send", "chat:submit")}
                                aria-description={app.conn !== "open" ? "Not connected" : undefined}
                                aria-label={runPicks() ? `Send to ${runPicks()!.length} models` : busy() ? (shown() === "steer" ? "Steer the current turn" : "Queue for after this turn") : "Send"}
                            >
                                <Show when={(runPicks()?.length ?? 0) >= 2}><span>Send to {runPicks()!.length} models</span></Show>
                                <Show when={busy()} fallback={shell() ? <SquareTerminal size={16} stroke-width={2.25} /> : <ArrowUp size={17} stroke-width={2.4} />}>
                                    {shown() === "steer" ? <CornerDownRight size={16} stroke-width={2.4} /> : <ListEnd size={16} stroke-width={2.4} />}
                                </Show>
                            </button>
                        }
                    >
                        <button class="send stop" onClick={() => interrupt(p.sessionId)} title={busy() ? "Stop (Esc)" : "Pause the goal (Esc)"} aria-label={busy() ? "Stop" : "Pause the goal"}>
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

