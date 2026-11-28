import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { Search } from "lucide-solid";
import { MODE_LABELS, type SessionSearchHit } from "@shared/protocol";
import { machine as windowMachine, os } from "../lib/platform";
import { activate, app, handleFor, reportError, restoredFrom, rpc, sessionPresenceVersion } from "../state/app";
import { archive, chooseProject, exportSession, fork, newSession, openProject, openReview, setMode, togglePanel, toggleSidebar } from "../state/actions";
import { prefs, setPrefs } from "../state/prefs";
import { openGit, terminalOpen, setTerminalOpen, paletteOpen, setAgentFocus, setJumpTarget, setModelPickerOpen, setPaletteOpen, setRewindOpen, setSettingsTab } from "../state/ui";
import { ago, tildify } from "../lib/format";
import { MODES } from "./ModePicker";
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
import { keyText, shortcut } from "../state/keybindings";

interface Entry {
    id: string;
    section: string;
    label: string;
    /** Quiet text at the row's end (a session's project and age, what an action does, Current). */
    meta?: string;
    /** Its shortcut ("⌘+K"), as key caps at the row's end. */
    kbd?: string;
    /** Can't be run now (Bypass while it's off): shown dimmed, skipped by the keys. */
    disabled?: boolean;
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

    const entries = createMemo<Entry[]>(() => {
        const out: Entry[] = [
            { id: "new", section: "Actions", label: "New session", kbd: shortcut("app:newSession"), run: () => newSession(app.homeCwd) },
            {
                id: "open",
                section: "Actions",
                label: "Open project…",
                run: async () => {
                    const p = await chooseProject();
                    if (p) void openProject(p);
                },
            },
            { id: "branch", section: "Actions", label: "Switch branch…", keywords: "git checkout pull", kbd: shortcut("app:switchBranch"), run: () => openGit("openBranches") },
            { id: "pr", section: "Actions", label: "Work on a pull request…", keywords: "github pr checkout", run: () => openGit("openPullRequests") },
            { id: "model", section: "Actions", label: "Switch model…", kbd: shortcut("chat:modelPicker"), run: () => setModelPickerOpen(true) },
            { id: "sidebar", section: "Actions", label: "Toggle sidebar", kbd: shortcut("app:toggleSidebar"), run: toggleSidebar },
            { id: "terminal", section: "Actions", label: "Toggle terminal", kbd: shortcut("app:toggleTerminal"), run: () => setTerminalOpen(!terminalOpen()) },
            { id: "panel", section: "Actions", label: "Toggle side panel", kbd: shortcut("app:togglePanel"), run: () => togglePanel() },
            { id: "settings", section: "Actions", label: "Settings", kbd: shortcut("app:settings"), run: () => setSettingsTab("general") },
            { id: "providers", section: "Actions", label: "Add an API key…", keywords: "providers login keys", run: () => setSettingsTab("providers") },
            { id: "usage", section: "Actions", label: "Usage and plan limits", keywords: "cost tokens spend limits plan quota", run: () => setSettingsTab("usage") },
        ];
        if (id()) {
            for (const [m, label, key] of [["files", "Go to file…", "app:goToFile"], ["search", "Search in project…", "app:searchFiles"]] as const) out.push({ id: m, section: "Session", label, kbd: shortcut(key), run: () => p.files(m) });
            out.push(
                { id: "changes", section: "Session", label: "Review changes", kbd: shortcut("app:toggleReview"), run: () => openReview() },
                { id: "rewind", section: "Session", label: "Rewind…", run: () => setRewindOpen(true) },
                { id: "fork", section: "Session", label: "Fork session", meta: "From the latest response", keywords: "branch copy duplicate", run: () => void fork(id()!) },
                { id: "compact", section: "Session", label: "Compact conversation", run: () => void rpc.call("session.compact", { id: id()! }).catch(reportError) },
                { id: "export", section: "Session", label: "Copy conversation as Markdown", run: () => void exportSession(id()!) },
                { id: "archive", section: "Session", label: "Archive session", run: () => void archive(id()!, true) },
                { id: "delete", section: "Session", label: "Delete session", run: () => deleteOpen(handleFor(id())) },
            );
            const st = handleFor(id())?.view.state;
            const current = st?.mode ?? app.settings.defaultMode ?? "default";
            const bypassOff = !(st?.bypassAllowed || app.settings.allowBypass);
            for (const m of MODES) {
                const off = m === "bypassPermissions" && bypassOff;
                out.push({ id: `mode-${m}`, section: "Permission mode", label: `Mode: ${MODE_LABELS[m].label}`, meta: off ? "Off in Settings" : m === current ? "Current" : undefined, keywords: MODE_LABELS[m].description, disabled: off, run: () => void setMode(m) });
            }
        }
        out.push(
            ...(["light", "dark", "system"] as const).map((v) => ({
                id: `theme-${v}`,
                section: "Theme",
                label: `Theme: ${v === "system" ? "Match system" : v === "light" ? "Light" : "Dark"}`,
                meta: prefs.scheme === v ? "Current" : undefined,
                keywords: `appearance color scheme${v === "system" ? " auto" : ""}`,
                run: () => setPrefs("scheme", v),
            })),
        );
        for (const s of app.sessions) out.push({ id: `s-${s.id}`, section: "Sessions", label: s.title, meta: `${atMachine(s.machine)}${s.projectName} · ${ago(s.updatedAt)}`, keywords: `${s.projectName} ${s.machine ?? ""}`, run: () => void activate(s.id) });
        for (const p of app.projects) out.push({ id: `p-${p.path}`, section: "Projects", label: `New session in ${p.name}`, meta: tildify(p.path, app.hello?.homeDir), keywords: p.path, run: () => void openProject(p.path) });
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
            .map((e) => ({ e, s: entryScore(query, { label: e.label, keywords: e.keywords, end: e.meta, kbd: e.kbd && keyText(e.kbd) }) }))
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
                meta: `${h.title} · ${atMachine(hitMachine(h.machine))}${h.projectName}${h.archived ? " · archived" : ""} · ${ago(h.at)}`,
                snippet: sn,
                run: () => openHit(h, said.query),
            };
        });
        // The first few, so the actions under them stay in sight; the rest a click away.
        const shown = messagesShown(messages.length, found.length, allMessages());
        const more: Entry[] =
            shown < messages.length
                ? [{ id: "messages-more", section: "Messages", label: `Show ${messages.length - shown} more`, stay: true, run: () => setAllMessages(true) }]
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

    /** The rows the keys and Enter go through: the ones that can run. */
    const usable = (i: number) => !results()[i]?.disabled;
    const runAt = (i: number) => {
        const e = results()[i];
        if (!e || e.disabled) return;
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
            const step = e.key === "ArrowDown" ? 1 : -1;
            setSel((s) => {
                let to = s;
                for (let k = 0; k < n; k++) {
                    to = (to + step + n) % n;
                    if (usable(to)) return to;
                }
                return s;
            });
            requestAnimationFrame(() => list?.querySelector(".pal-row[data-active]")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            runAt(sel());
        }
    };
    /** Message search still reading (this computer, older sessions, the servers), or stopped before all were read. */
    const status = () => (older() === "servers" ? "Searching your servers…" : older() === "more" ? "Searching older sessions…" : searching() ? "Searching messages…" : undefined);

    return (
        <Dialog open={paletteOpen()} onClose={close} bare top width={640} class="palette" labelledBy="palette-h">
            <h2 id="palette-h" class="sr-only">Search</h2>
            <div class="pal-input">
                <Search size={15} class="pal-input-icon" />
                <input ref={input} autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search sessions, messages, projects and actions" aria-label="Search sessions, messages, projects and actions" spellcheck={false} autocomplete="off" />
                <span class="kbd-group" aria-hidden="true"><kbd class="kbd">esc</kbd></span>
            </div>
            <div class="pal-list" ref={list} role="listbox" aria-label="Results">
                <For each={results()} fallback={<Show when={!status()}><div class="pal-empty">{older() === "incomplete" ? "Nothing found. Some older sessions weren't searched." : "Nothing matches."}</div></Show>}>
                    {(e, i) => (
                        <div class="pal-group">
                            <Show when={i() === 0 || results()[i() - 1]!.section !== e.section}>
                                <div class="pal-head">{e.section}</div>
                            </Show>
                            <button
                                class={`pal-row ${e.stay ? "pal-row-more" : ""}`}
                                role="option"
                                aria-selected={sel() === i()}
                                data-active={sel() === i() || undefined}
                                aria-disabled={e.disabled || undefined}
                                onMouseMove={() => usable(i()) && setSel(i())}
                                onClick={() => runAt(i())}
                            >
                                {/* A message hit's words are marked .pal-snippet (the palette fixture finds them by it). */}
                                <span class="pal-label">
                                    <Show when={e.snippet} fallback={e.label}>
                                        {(sn) => (
                                            <span class="pal-snippet">
                                                <Snippet text={sn().text} match={sn().match} />
                                            </span>
                                        )}
                                    </Show>
                                </span>
                                <Show when={e.meta}>
                                    <span class="pal-meta">{e.meta}</span>
                                </Show>
                                <Show when={e.kbd}>
                                    {(k) => <span class="kbd-group" aria-hidden="true"><For each={k().split("+")}>{(key) => <kbd class="kbd">{keyText(key)}</kbd>}</For></span>}
                                </Show>
                            </button>
                        </div>
                    )}
                </For>
            </div>
            <Show when={status()} fallback={<Show when={older() === "incomplete" && results().length}><div class="pal-foot">Some older sessions weren't searched.</div></Show>}>
                {(t) => (
                    <div class="pal-foot" role="status">
                        <Spinner size={12} />
                        {t()}
                    </div>
                )}
            </Show>
        </Dialog>
    );
}
