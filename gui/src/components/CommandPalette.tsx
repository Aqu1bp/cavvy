import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Component } from "solid-js";
import { Archive, Bot, ChartColumn, FileDiff, FolderGit2, FolderOpen, GitBranch, GitFork, GitPullRequest, History, MessageSquare, Moon, MoreHorizontal, PanelLeft, PanelRight, Plus, Search, Settings, SquareTerminal, Share, Shrink, Sparkles, Sun, Trash2, User } from "lucide-solid";
import { MODE_LABELS, type SessionSearchHit } from "@shared/protocol";
import { machine as windowMachine, os } from "../lib/platform";
import { activate, app, handleFor, reportError, restoredFrom, rpc, sessionPresenceVersion } from "../state/app";
import { archive, chooseProject, exportSession, fork, newSession, openProject, openReview, setMode, togglePanel, toggleSidebar } from "../state/actions";
import { setPrefs } from "../state/prefs";
import { openGit, terminalOpen, setTerminalOpen, paletteOpen, setAgentFocus, setJumpTarget, setModelPickerOpen, setPaletteOpen, setRewindOpen, setSettingsTab } from "../state/ui";
import { ago, tildify } from "../lib/format";
import { ModeIcon, MODES } from "./ModePicker";
import { Dialog } from "./ui/Dialog";
import { deleteOpen } from "./Header";
import { Spinner } from "./ui/bits";
import { searchRounds } from "../lib/search";
import { plainSnippet } from "../lib/plain-snippet";
import { entryScore, groupSections, keepSelection, messagesShown } from "../lib/palette-order";

/** "box · " before a server's session's project; nothing for this computer's. */
const atMachine = (machine?: string) => (machine ? `${machine} · ` : "");
/** A message hit's machine, as it's named in a window on a server: its own server's by name, this computer's ("") too. */
const hitMachine = (machine?: string) => (!windowMachine ? machine : machine === undefined ? windowMachine : machine || (os === "macos" ? "This Mac" : "This computer"));
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
    /** Drawn when its row is (the list is built for every session, the rows only for what's shown). */
    icon: Component<{ size?: number }>;
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

/** `files`: opens Go to file or Search in project (App.tsx). */
export function CommandPalette(p: { files: (mode: "files" | "search") => void }) {
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
    const [older, setOlder] = createSignal<"more" | "servers" | "incomplete">();
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
            // Asked at once (a task later, so a paste or keys in one go ask once): each keystroke's search stops the
            // one before it on the server, which takes 1-8 ms with 10,000 sessions. Waited for 140 ms, a key's
            // results showed 160-170 ms after it (on a Mac).
            wait = setTimeout(async () => {
                try {
                    await searchRounds(
                        (rest) => rpc.call("sessions.search", { query, limit: MAX_HITS, ...(rest ? { rest } : {}) }),
                        () => mine === asked && version === sessionPresenceVersion(),
                        (r) => {
                            // A message is selected: every message stays in sight, so later hits that join them
                            // (a slow server's) can't push it out from under the selection.
                            if (results()[sel()]?.section === "Messages") setAllMessages(true);
                            setHits({ query, hits: r.hits });
                            setOlder(r.servers ? "servers" : r.more ? "more" : r.incomplete ? "incomplete" : undefined);
                        },
                    );
                } catch {
                    if (mine === asked) (setHits({ query: "", hits: [] }), setOlder(undefined));
                } finally {
                    if (mine === asked) setSearching(false);
                }
            }, 0);
        }),
    );
    onCleanup(() => clearTimeout(wait));
    // Opened: the server reads what search looks through while the query's typed (the first search after a start
    // would otherwise read every session then).
    createEffect(on(paletteOpen, (open) => {
        if (open) void rpc.call("sessions.searchWarm", {}).catch(() => undefined);
    }));
    const openHit = (h: SessionSearchHit, query: string) => {
        // Back to the conversation, from wherever the palette was opened over.
        setSettingsTab(undefined);
        setAgentFocus(undefined);
        setJumpTarget({ sessionId: h.id, seg: h.seg, index: h.index, role: h.role, query });
        // One on a server, maybe not in the list: opened from there.
        if (h.machine !== undefined) restoredFrom(h.id, h.machine);
        void activate(h.id, h.cwd);
    };

    // Built while it's open: closed, nothing shows them (a session list's change would rebuild them for nothing).
    const entries = createMemo<Entry[]>(() => {
        if (!paletteOpen()) return [];
        const out: Entry[] = [
            { id: "new", section: "Actions", label: "New session", kbd: shortcutHint("app:newSession"), icon: Plus, run: () => newSession(app.homeCwd) },
            {
                id: "open",
                section: "Actions",
                label: "Open project…",
                icon: FolderOpen,
                run: async () => {
                    const p = await chooseProject();
                    if (p) void openProject(p);
                },
            },
            { id: "branch", section: "Actions", label: "Switch branch…", keywords: "git checkout pull", kbd: shortcutHint("app:switchBranch"), icon: GitBranch, run: () => openGit("openBranches") },
            { id: "pr", section: "Actions", label: "Work on a pull request…", keywords: "github pr checkout", icon: GitPullRequest, run: () => openGit("openPullRequests") },
            { id: "model", section: "Actions", label: "Switch model…", kbd: shortcutHint("chat:modelPicker"), icon: Sparkles, run: () => setModelPickerOpen(true) },
            { id: "sidebar", section: "Actions", label: "Toggle sidebar", kbd: shortcutHint("app:toggleSidebar"), icon: PanelLeft, run: toggleSidebar },
            { id: "terminal", section: "Actions", label: "Toggle terminal", kbd: shortcutHint("app:toggleTerminal"), icon: SquareTerminal, run: () => setTerminalOpen(!terminalOpen()) },
            { id: "panel", section: "Actions", label: "Toggle side panel", kbd: shortcutHint("app:togglePanel"), icon: PanelRight, run: () => togglePanel() },
            { id: "settings", section: "Actions", label: "Settings", kbd: shortcutHint("app:settings"), icon: Settings, run: () => setSettingsTab("general") },
            { id: "providers", section: "Actions", label: "Add an API key…", keywords: "providers login keys", icon: Settings, run: () => setSettingsTab("providers") },
            { id: "usage", section: "Actions", label: "Usage and plan limits", keywords: "cost tokens spend limits plan quota", icon: ChartColumn, run: () => setSettingsTab("usage") },
        ];
        if (id()) {
            for (const [m, label, key] of [["files", "Go to file…", "app:goToFile"], ["search", "Search in project…", "app:searchFiles"]] as const) out.push({ id: m, section: "Session", label, kbd: shortcutHint(key), icon: Search, run: () => p.files(m) });
            out.push(
                { id: "changes", section: "Session", label: "Review changes", kbd: shortcutHint("app:toggleReview"), icon: FileDiff, run: () => openReview() },
                { id: "rewind", section: "Session", label: "Rewind…", icon: History, run: () => setRewindOpen(true) },
                { id: "fork", section: "Session", label: "Fork session", desc: "From the latest response", keywords: "branch copy duplicate", icon: GitFork, run: () => void fork(id()!) },
                { id: "compact", section: "Session", label: "Compact conversation", icon: Shrink, run: () => void rpc.call("session.compact", { id: id()! }).catch(reportError) },
                { id: "export", section: "Session", label: "Copy conversation as Markdown", icon: Share, run: () => void exportSession(id()!) },
                { id: "archive", section: "Session", label: "Archive session", icon: Archive, run: () => void archive(id()!, true) },
                { id: "delete", section: "Session", label: "Delete session", icon: Trash2, run: () => deleteOpen(handleFor(id())) },
            );
            for (const m of MODES) out.push({ id: `mode-${m}`, section: "Permission mode", label: `Mode: ${MODE_LABELS[m].label}`, desc: MODE_LABELS[m].description, icon: (p) => <ModeIcon mode={m} size={p.size} />, run: () => void setMode(m) });
        }
        out.push(
            { id: "theme-light", section: "Theme", label: "Theme: Light", keywords: "appearance color scheme", icon: Sun, run: () => setPrefs("scheme", "light") },
            { id: "theme-dark", section: "Theme", label: "Theme: Dark", keywords: "appearance color scheme", icon: Moon, run: () => setPrefs("scheme", "dark") },
            { id: "theme-system", section: "Theme", label: "Theme: Match system", keywords: "appearance color scheme auto", icon: Sun, run: () => setPrefs("scheme", "system") },
        );
        for (const s of app.sessions) out.push({ id: `s-${s.id}`, section: "Sessions", label: s.title, end: `${atMachine(s.machine)}${s.projectName} · ${ago(s.updatedAt)}`, keywords: `${s.projectName} ${s.machine ?? ""}`, icon: MessageSquare, run: () => void activate(s.id) });
        for (const p of app.projects) out.push({ id: `p-${p.path}`, section: "Projects", label: `New session in ${p.name}`, desc: tildify(p.path, app.hello?.homeDir), keywords: p.path, icon: FolderGit2, run: () => void openProject(p.path) });
        return out;
    });

    const results = createMemo<Entry[]>(() => {
        if (!paletteOpen()) return [];
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
        // Named by what it is, not where it stands: hits that arrive later (a slow server's) move it, and the
        // selection goes with it. Several in one message are told apart by their order there.
        const seen = new Map<string, number>();
        const messages: Entry[] = said.hits.map((h) => {
            const sn = plainSnippet(h.snippet, h.match);
            const at = `m-${JSON.stringify([h.machine ?? "", h.id, h.seg, h.index])}`;
            const nth = seen.get(at) ?? 0;
            seen.set(at, nth + 1);
            return {
                id: `${at}-${nth}`,
                section: "Messages",
                label: sn.text,
                desc: `${h.title} · ${atMachine(hitMachine(h.machine))}${h.projectName}${h.archived ? " · archived" : ""} · ${ago(h.at)}`,
                icon: h.role === "user" ? User : Bot,
                snippet: sn,
                run: () => openHit(h, said.query),
            };
        });
        // The first few, so the actions under them stay in sight; the rest a click away.
        const shown = messagesShown(messages.length, found.length, allMessages());
        const more: Entry[] =
            shown < messages.length
                ? [{ id: "messages-more", section: "Messages", label: `Show ${messages.length - shown} more`, icon: MoreHorizontal, stay: true, run: () => setAllMessages(true) }]
                : [];
        return groupSections([...found, ...messages.slice(0, shown), ...more], SECTION_ORDER);
    });

    // Each opening starts empty; closed, an old query isn't searched again (a session deleted or restored).
    createEffect(on(paletteOpen, (o) => (setQ(""), o && setSel(0))));
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
                <For each={results()} fallback={<div class="pal-empty">{older() === "servers" ? "Searching your servers…" : older() === "more" ? "Searching older sessions…" : older() === "incomplete" ? "Nothing found. Some older sessions weren't searched." : searching() ? "Searching messages…" : "Nothing matches."}</div>}>
                    {(e, i) => (
                        <>
                            <Show when={i() === 0 || results()[i() - 1]!.section !== e.section}>
                                <div class="pal-h">{e.section}</div>
                            </Show>
                            <button class={`pal-row ${sel() === i() ? "sel" : ""} ${e.desc ? "two" : ""}`} onMouseMove={() => setSel(i())} onClick={() => runAt(i())}>
                                <span class="pal-ic">
                                    <e.icon size={15} />
                                </span>
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
                    <div class="pal-note">{older() === "servers" ? "Searching your servers…" : older() === "more" ? "Searching older sessions…" : "Some older sessions weren't searched."}</div>
                </Show>
            </div>
        </Dialog>
    );
}
