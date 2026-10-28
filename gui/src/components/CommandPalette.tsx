import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { Archive, Bot, ChartColumn, FileDiff, FolderGit2, FolderOpen, GitFork, History, MessageSquare, Moon, MoreHorizontal, PanelLeft, PanelRight, Plus, Search, Settings, SquareTerminal, Share, Shrink, Sparkles, Sun, Trash2, User } from "lucide-solid";
import { MODE_LABELS, type SessionSearchHit } from "@shared/protocol";
import { activate, app, handleFor, reportError, rpc, sessionPresenceVersion } from "../state/app";
import { archive, chooseProject, exportSession, fork, newSession, openProject, openReview, setMode, togglePanel, toggleSidebar } from "../state/actions";
import { setPrefs } from "../state/prefs";
import { terminalOpen, setTerminalOpen, paletteOpen, setAgentFocus, setJumpTarget, setModelPickerOpen, setPaletteOpen, setRewindOpen, setSettingsTab } from "../state/ui";
import { ago, tildify } from "../lib/format";
import { ModeIcon, MODES } from "./ModePicker";
import { Dialog } from "./ui/Dialog";
import { deleteOpen } from "./Header";
import { Spinner } from "./ui/bits";
import { searchRounds } from "../lib/search";
import { plainSnippet } from "../lib/plain-snippet";
import { entryScore, groupSections, keepSelection, messagesShown } from "../lib/palette-order";
import { shortcutHint } from "../state/keybindings";

interface Entry {
    id: string;
    section: string;
    label: string;
    /** A second line under the label. */
    desc?: string;
    /** Quiet text at the row's end (a session's project and age). */
    end?: string;
    /** Its shortcut, as key caps at the row's end. */
    kbd?: string;
    icon: JSX.Element;
    keywords?: string;
    /** A message hit: the words around the match, as plain text, and where the match is in them. */
    snippet?: { text: string; match?: [number, number] };
    /** Acts inside the palette (Show more), which stays open. */
    stay?: boolean;
    run: () => void;
}

/** Message search starts at this many characters (server: 2–200). */
const MIN_SEARCH = 2;
const MAX_SEARCH = 200;
const MAX_HITS = 50;
/** With a query, the results' groups in this order (the mockup's Sessions, Messages, Actions); the rest follow. */
const SECTION_ORDER = ["Sessions", "Messages", "Projects", "Actions", "Session", "Permission mode", "Theme"];

function Snippet(p: { text: string; match?: [number, number] }) {
    return (
        <Show when={p.match} fallback={p.text}>
            {(m) => (
                <>
                    {p.text.slice(0, m()[0])}
                    <mark>{p.text.slice(m()[0], m()[1])}</mark>
                    {p.text.slice(m()[1])}
                </>
            )}
        </Show>
    );
}

export function CommandPalette() {
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    /** Every message hit, not only the first few (Show more). */
    const [allMessages, setAllMessages] = createSignal(false);
    let list: HTMLDivElement | undefined;
    let input: HTMLInputElement | undefined;
    const close = () => setPaletteOpen(false);
    const id = () => app.activeId;

    // What was said, from the server: typed slowly enough, and only the latest answer.
    // With the query they were found for: they stay on the list while the next one is asked, and open with their own.
    const [hits, setHits] = createSignal<{ query: string; hits: SessionSearchHit[] }>({ query: "", hits: [] });
    const [searching, setSearching] = createSignal(false);
    // Past the server's budget: reading older sessions still, or stopped before all were read.
    const [older, setOlder] = createSignal<"more" | "incomplete">();
    let asked = 0;
    let wait: ReturnType<typeof setTimeout> | undefined;
    createEffect(
        on([q, sessionPresenceVersion], ([raw, version], prev) => {
            clearTimeout(wait);
            // Undo can clear a marker; don't let pre-delete hits reappear with it.
            // Refresh this query too, so restored sessions need no extra typing.
            if (prev && version !== prev[1]) setHits({ query: "", hits: [] });
            const query = raw.trim();
            const mine = ++asked;
            setOlder(undefined);
            if (query.length < MIN_SEARCH || query.length > MAX_SEARCH) {
                setHits({ query: "", hits: [] });
                setSearching(false);
                return;
            }
            setSearching(true);
            wait = setTimeout(async () => {
                try {
                    await searchRounds(
                        () => rpc.call("sessions.search", { query, limit: MAX_HITS }),
                        () => mine === asked && version === sessionPresenceVersion(),
                        (r) => {
                            setHits({ query, hits: r.hits });
                            setOlder(r.more ? "more" : r.incomplete ? "incomplete" : undefined);
                        },
                    );
                } catch {
                    if (mine === asked) setHits({ query: "", hits: [] });
                } finally {
                    if (mine === asked) setSearching(false);
                }
            }, 140);
        }),
    );
    onCleanup(() => clearTimeout(wait));
    const openHit = (h: SessionSearchHit, query: string) => {
        // Back to the conversation, from wherever the palette was opened over.
        setSettingsTab(undefined);
        setAgentFocus(undefined);
        setJumpTarget({ sessionId: h.id, seg: h.seg, index: h.index, role: h.role, query });
        void activate(h.id, h.cwd);
    };

    const entries = createMemo<Entry[]>(() => {
        const out: Entry[] = [
            { id: "new", section: "Actions", label: "New session", kbd: shortcutHint("app:newSession"), icon: <Plus size={15} />, run: () => newSession(app.homeCwd) },
            {
                id: "open",
                section: "Actions",
                label: "Open project…",
                icon: <FolderOpen size={15} />,
                run: async () => {
                    const p = await chooseProject();
                    if (p) void openProject(p);
                },
            },
            { id: "model", section: "Actions", label: "Switch model…", kbd: shortcutHint("chat:modelPicker"), icon: <Sparkles size={15} />, run: () => setModelPickerOpen(true) },
            { id: "sidebar", section: "Actions", label: "Toggle sidebar", kbd: shortcutHint("app:toggleSidebar"), icon: <PanelLeft size={15} />, run: toggleSidebar },
            { id: "terminal", section: "Actions", label: "Toggle terminal", kbd: shortcutHint("app:toggleTerminal"), icon: <SquareTerminal size={15} />, run: () => setTerminalOpen(!terminalOpen()) },
            { id: "panel", section: "Actions", label: "Toggle side panel", kbd: shortcutHint("app:togglePanel"), icon: <PanelRight size={15} />, run: () => togglePanel() },
            { id: "settings", section: "Actions", label: "Settings", kbd: shortcutHint("app:settings"), icon: <Settings size={15} />, run: () => setSettingsTab("general") },
            { id: "providers", section: "Actions", label: "Add an API key…", keywords: "providers login keys", icon: <Settings size={15} />, run: () => setSettingsTab("providers") },
            { id: "usage", section: "Actions", label: "Usage and plan limits", keywords: "cost tokens spend limits plan quota", icon: <ChartColumn size={15} />, run: () => setSettingsTab("usage") },
        ];
        if (id()) {
            out.push(
                { id: "changes", section: "Session", label: "Review changes", icon: <FileDiff size={15} />, run: () => openReview() },
                { id: "rewind", section: "Session", label: "Rewind…", icon: <History size={15} />, run: () => setRewindOpen(true) },
                { id: "fork", section: "Session", label: "Fork session", desc: "From the latest response", keywords: "branch copy duplicate", icon: <GitFork size={15} />, run: () => void fork(id()!) },
                { id: "compact", section: "Session", label: "Compact conversation", icon: <Shrink size={15} />, run: () => void rpc.call("session.compact", { id: id()! }).catch(reportError) },
                { id: "export", section: "Session", label: "Copy conversation as Markdown", icon: <Share size={15} />, run: () => void exportSession(id()!) },
                { id: "archive", section: "Session", label: "Archive session", icon: <Archive size={15} />, run: () => void archive(id()!, true) },
                { id: "delete", section: "Session", label: "Delete session", icon: <Trash2 size={15} />, run: () => deleteOpen(handleFor(id())) },
            );
            for (const m of MODES) out.push({ id: `mode-${m}`, section: "Permission mode", label: `Mode: ${MODE_LABELS[m].label}`, desc: MODE_LABELS[m].description, icon: <ModeIcon mode={m} size={15} />, run: () => void setMode(m) });
        }
        out.push(
            { id: "theme-light", section: "Theme", label: "Theme: Light", keywords: "appearance color scheme", icon: <Sun size={15} />, run: () => setPrefs("scheme", "light") },
            { id: "theme-dark", section: "Theme", label: "Theme: Dark", keywords: "appearance color scheme", icon: <Moon size={15} />, run: () => setPrefs("scheme", "dark") },
            { id: "theme-system", section: "Theme", label: "Theme: Match system", keywords: "appearance color scheme auto", icon: <Sun size={15} />, run: () => setPrefs("scheme", "system") },
        );
        for (const s of app.sessions) out.push({ id: `s-${s.id}`, section: "Sessions", label: s.title, end: `${s.projectName} · ${ago(s.updatedAt)}`, keywords: s.projectName, icon: <MessageSquare size={15} />, run: () => void activate(s.id) });
        for (const p of app.projects) out.push({ id: `p-${p.path}`, section: "Projects", label: `New session in ${p.name}`, desc: tildify(p.path, app.hello?.homeDir), keywords: p.path, icon: <FolderGit2 size={15} />, run: () => void openProject(p.path) });
        return out;
    });

    const results = createMemo(() => {
        const query = q().trim();
        if (!query) {
            // Recent sessions first, then the actions.
            const recent = entries().filter((e) => e.section === "Sessions").slice(0, 6);
            const actions = entries().filter((e) => e.section === "Actions" || e.section === "Session");
            return [...recent.map((e) => ({ ...e, section: "Recent sessions" })), ...actions];
        }
        const found = entries()
            .map((e) => ({ e, s: entryScore(query, e) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 40)
            .map((x) => x.e);
        // As they come: the messages that say it, between the sessions and the actions.
        const said = hits();
        // Fresh answers are authoritative, even if a capped session list missed
        // an Undo. The generation check above drops answers predating deletion.
        // What was said, as it reads (no Markdown syntax), with the session it's in under it.
        const messages: Entry[] = said.hits.map((h, i) => {
            const sn = plainSnippet(h.snippet, h.match);
            return {
                id: `m-${h.id}-${h.seg}-${h.index}-${i}`,
                section: "Messages",
                label: sn.text,
                desc: `${h.title} · ${h.projectName}${h.archived ? " · archived" : ""} · ${ago(h.at)}`,
                icon: h.role === "user" ? <User size={15} /> : <Bot size={15} />,
                snippet: sn,
                run: () => openHit(h, said.query),
            };
        });
        // The first few, so the actions under them stay in sight; the rest a click away.
        const shown = messagesShown(messages.length, found.length, allMessages());
        const more: Entry[] =
            shown < messages.length
                ? [{ id: "messages-more", section: "Messages", label: `Show ${messages.length - shown} more`, icon: <MoreHorizontal size={15} />, stay: true, run: () => setAllMessages(true) }]
                : [];
        return groupSections([...found, ...messages.slice(0, shown), ...more], SECTION_ORDER);
    });

    createEffect(on(paletteOpen, (o) => o && (setQ(""), setSel(0))));
    createEffect(on(q, () => setAllMessages(false), { defer: true }));
    // A new query starts at the top. Otherwise (message hits arriving, a list
    // that shrinks) the selection stays on its entry, or as near as it can.
    let shownFor = q();
    createEffect(
        on(
            results,
            (r, prev) => {
                const newQuery = q() !== shownFor;
                shownFor = q();
                setSel((s) => keepSelection(prev, r, s, newQuery));
            },
            { defer: true },
        ),
    );

    const runAt = (i: number) => {
        const e = results()[i];
        if (!e) return;
        if (e.stay) {
            e.run();
            input?.focus();
            return;
        }
        close();
        e.run();
    };
    const onKey = (e: KeyboardEvent) => {
        const n = results().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".pal-row.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            runAt(sel());
        }
    };

    return (
        <Dialog open={paletteOpen()} onClose={close} bare top width={620} class="palette">
            <div class="pal-in">
                <Search size={17} class="pal-search" />
                <input ref={input} autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search sessions, messages, projects and actions" aria-label="Search sessions, messages, projects and actions" spellcheck={false} />
                <Show when={searching()}>
                    <Spinner size={13} class="muted" />
                </Show>
                <kbd>Esc</kbd>
            </div>
            <div class="pal-list" ref={list}>
                <For each={results()} fallback={<div class="pal-empty">{older() === "more" ? "Searching older sessions…" : older() === "incomplete" ? "Nothing found. Some older sessions weren't searched." : searching() ? "Searching messages…" : "Nothing matches."}</div>}>
                    {(e, i) => (
                        <>
                            <Show when={i() === 0 || results()[i() - 1]!.section !== e.section}>
                                <div class="pal-h">{e.section}</div>
                            </Show>
                            <button class={`pal-row ${sel() === i() ? "sel" : ""} ${e.desc ? "two" : ""}`} onMouseMove={() => setSel(i())} onClick={() => runAt(i())}>
                                <span class="pal-ic">{e.icon}</span>
                                <span class="pal-text">
                                    {/* A message hit's words are marked .pal-snippet (the palette fixture finds them by it). */}
                                    <span class={`pal-l ${e.snippet ? "pal-snippet" : ""}`}>
                                        <Show when={e.snippet} fallback={e.label}>
                                            {(sn) => <Snippet text={sn().text} match={sn().match} />}
                                        </Show>
                                    </span>
                                    <Show when={e.desc}>
                                        <span class="pal-d">{e.desc}</span>
                                    </Show>
                                </span>
                                <Show when={e.kbd || e.end}>
                                    <span class="pal-end">
                                        <Show when={e.kbd} fallback={e.end}>
                                            <kbd>{e.kbd}</kbd>
                                        </Show>
                                    </span>
                                </Show>
                            </button>
                        </>
                    )}
                </For>
                <Show when={results().length && older()}>
                    <div class="pal-note">{older() === "more" ? "Searching older sessions…" : "Some older sessions weren't searched."}</div>
                </Show>
            </div>
        </Dialog>
    );
}
