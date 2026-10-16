import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { Archive, ArrowRight, Bot, FileDiff, FolderGit2, FolderOpen, History, MessageSquare, Moon, PanelLeft, PanelRight, Plus, Settings, SquareTerminal, Share, Shrink, Sparkles, Sun, Trash2, User } from "lucide-solid";
import { MODE_LABELS, type SessionSearchHit } from "@shared/protocol";
import { activate, app, handleFor, reportError, rpc, sessionPresenceVersion } from "../state/app";
import { archive, chooseProject, exportSession, newSession, openProject, openReview, setMode, togglePanel, toggleSidebar } from "../state/actions";
import { setPrefs, THEMES } from "../state/prefs";
import { terminalOpen, setTerminalOpen, paletteOpen, setAgentFocus, setJumpTarget, setModelPickerOpen, setPaletteOpen, setRewindOpen, setSettingsTab } from "../state/ui";
import { ago, tildify } from "../lib/format";
import { mod, terminalShortcut } from "../lib/platform";
import { ModeIcon, MODES } from "./ModePicker";
import { Dialog } from "./ui/Dialog";
import { askDelete } from "./Header";
import { Spinner } from "./ui/bits";
import { searchRounds } from "../lib/search";

interface Entry {
    id: string;
    section: string;
    label: string;
    hint?: string;
    icon: JSX.Element;
    keywords?: string;
    /** A message hit: the words around the match, and where the match is in them. */
    snippet?: { text: string; match?: [number, number] };
    run: () => void;
}

/** Message search starts at this many characters (server: 2–200). */
const MIN_SEARCH = 2;
const MAX_SEARCH = 200;
const MAX_HITS = 50;

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

function score(q: string, text: string): number {
    if (!q) return 1;
    const t = text.toLowerCase();
    const qq = q.toLowerCase();
    const i = t.indexOf(qq);
    if (i >= 0) return 100 - i + (i === 0 || t[i - 1] === " " ? 20 : 0);
    let j = 0;
    let gaps = 0;
    for (let k = 0; k < t.length && j < qq.length; k++) {
        if (t[k] === qq[j]) j++;
        else if (j) gaps++;
    }
    return j === qq.length ? Math.max(1, 50 - gaps) : 0;
}

export function CommandPalette() {
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    let list: HTMLDivElement | undefined;
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
            { id: "new", section: "Actions", label: "New session", hint: `${mod} N`, icon: <Plus size={15} />, run: () => newSession(app.homeCwd) },
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
            { id: "model", section: "Actions", label: "Switch model…", hint: `${mod} /`, icon: <Sparkles size={15} />, run: () => setModelPickerOpen(true) },
            { id: "sidebar", section: "Actions", label: "Toggle sidebar", hint: `${mod} B`, icon: <PanelLeft size={15} />, run: toggleSidebar },
            { id: "terminal", section: "Actions", label: "Toggle terminal", hint: terminalShortcut.replace("+", " "), icon: <SquareTerminal size={15} />, run: () => setTerminalOpen(!terminalOpen()) },
            { id: "panel", section: "Actions", label: "Toggle side panel", hint: `${mod} .`, icon: <PanelRight size={15} />, run: () => togglePanel() },
            { id: "settings", section: "Actions", label: "Settings", hint: `${mod} ,`, icon: <Settings size={15} />, run: () => setSettingsTab("general") },
            { id: "providers", section: "Actions", label: "Add an API key…", keywords: "providers login keys", icon: <Settings size={15} />, run: () => setSettingsTab("providers") },
        ];
        if (id()) {
            out.push(
                { id: "changes", section: "Session", label: "Review changes", icon: <FileDiff size={15} />, run: () => openReview() },
                { id: "rewind", section: "Session", label: "Rewind…", icon: <History size={15} />, run: () => setRewindOpen(true) },
                { id: "compact", section: "Session", label: "Compact conversation", icon: <Shrink size={15} />, run: () => void rpc.call("session.compact", { id: id()! }).catch(reportError) },
                { id: "export", section: "Session", label: "Copy conversation as Markdown", icon: <Share size={15} />, run: () => void exportSession(id()!) },
                { id: "archive", section: "Session", label: "Archive session", icon: <Archive size={15} />, run: () => void archive(id()!, true) },
                { id: "delete", section: "Session", label: "Delete session…", icon: <Trash2 size={15} />, run: () => askDelete(handleFor(id())) },
            );
            for (const m of MODES) out.push({ id: `mode-${m}`, section: "Permission mode", label: `Mode: ${MODE_LABELS[m].label}`, hint: MODE_LABELS[m].description, icon: <ModeIcon mode={m} size={15} />, run: () => void setMode(m) });
        }
        for (const t of THEMES) out.push({ id: `theme-${t.id}`, section: "Theme", label: `Theme: ${t.name}`, keywords: "appearance color dark light", icon: t.scheme === "dark" ? <Moon size={15} /> : <Sun size={15} />, run: () => setPrefs("theme", t.id) });
        out.push({ id: "theme-system", section: "Theme", label: "Theme: Match system", keywords: "appearance auto", icon: <Sun size={15} />, run: () => setPrefs("theme", "system") });
        for (const s of app.sessions) out.push({ id: `s-${s.id}`, section: "Sessions", label: s.title, hint: `${s.projectName} · ${ago(s.updatedAt)}`, keywords: s.projectName, icon: <MessageSquare size={15} />, run: () => void activate(s.id) });
        for (const p of app.projects) out.push({ id: `p-${p.path}`, section: "Projects", label: `New session in ${p.name}`, hint: tildify(p.path, app.hello?.homeDir), keywords: p.path, icon: <FolderGit2 size={15} />, run: () => void openProject(p.path) });
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
            .map((e) => ({ e, s: Math.max(score(query, e.label), score(query, e.keywords ?? "") * 0.6, score(query, e.hint ?? "") * 0.4) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 40)
            .map((x) => x.e);
        // Below the rest, as they come: the messages that say it.
        const said = hits();
        // Fresh answers are authoritative, even if a capped session list missed
        // an Undo. The generation check above drops answers predating deletion.
        const messages: Entry[] = said.hits.map((h, i) => ({
            id: `m-${h.id}-${h.seg}-${h.index}-${i}`,
            section: "Messages",
            label: h.title,
            hint: `${h.projectName}${h.archived ? " · archived" : ""} · ${ago(h.at)}`,
            icon: h.role === "user" ? <User size={15} /> : <Bot size={15} />,
            snippet: { text: h.snippet, match: h.match },
            run: () => openHit(h, said.query),
        }));
        return [...found, ...messages];
    });

    createEffect(on(paletteOpen, (o) => o && (setQ(""), setSel(0))));
    createEffect(on(q, () => setSel(0), { defer: true }));
    // Fewer messages than before: the selection stays on the list.
    createEffect(on(results, (r) => setSel((s) => Math.min(s, Math.max(0, r.length - 1))), { defer: true }));

    const runAt = (i: number) => {
        const e = results()[i];
        if (!e) return;
        close();
        e.run();
    };
    const onKey = (e: KeyboardEvent) => {
        const n = results().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            runAt(sel());
        }
    };

    return (
        <Dialog open={paletteOpen()} onClose={close} bare width={600} class="palette">
            <div class="pal-input">
                <ArrowRight size={16} class="muted" />
                <input autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search sessions, messages, projects and actions…" spellcheck={false} />
                <Show when={searching()}>
                    <Spinner size={13} class="muted" />
                </Show>
            </div>
            <div class="pal-list" ref={list}>
                <For each={results()} fallback={<div class="panel-empty">{older() === "more" ? "Searching older sessions…" : older() === "incomplete" ? "Nothing found in the sessions searched so far; older ones weren't all read." : searching() ? "Searching messages…" : "Nothing matches."}</div>}>
                    {(e, i) => (
                        <>
                            <Show when={i() === 0 || results()[i() - 1]!.section !== e.section}>
                                <div class="pal-section">{e.section}</div>
                            </Show>
                            <button class={`pal-item ${sel() === i() ? "sel" : ""}`} onMouseMove={() => setSel(i())} onClick={() => runAt(i())}>
                                <span class="pal-icon">{e.icon}</span>
                                <Show
                                    when={e.snippet}
                                    fallback={
                                        <>
                                            <span class="pal-label truncate">{e.label}</span>
                                            <Show when={e.hint}>
                                                <span class="pal-hint truncate">{e.hint}</span>
                                            </Show>
                                        </>
                                    }
                                >
                                    {(sn) => (
                                        <span class="pal-body">
                                            <span class="pal-line">
                                                <span class="pal-label truncate">{e.label}</span>
                                                <span class="pal-hint truncate">{e.hint}</span>
                                            </span>
                                            <span class="pal-snippet">
                                                <Snippet text={sn().text} match={sn().match} />
                                            </span>
                                        </span>
                                    )}
                                </Show>
                            </button>
                        </>
                    )}
                </For>
                <Show when={results().length && older()}>
                    <div class="pal-note">{older() === "more" ? "Searching older sessions…" : "Older sessions weren't all read; results may be incomplete."}</div>
                </Show>
            </div>
        </Dialog>
    );
}
