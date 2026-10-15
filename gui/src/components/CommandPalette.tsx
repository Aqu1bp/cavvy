import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { Archive, ArrowRight, FolderGit2, FolderOpen, History, MessageSquare, Moon, PanelLeft, PanelRight, Plus, Settings, Share, Shrink, Sparkles, Sun } from "lucide-solid";
import { MODE_LABELS } from "@shared/protocol";
import { activate, app, reportError, rpc } from "../state/app";
import { archive, chooseProject, exportSession, newSession, openProject, setMode, togglePanel, toggleSidebar } from "../state/actions";
import { setPrefs, THEMES } from "../state/prefs";
import { paletteOpen, setModelPickerOpen, setPaletteOpen, setRewindOpen, setSettingsTab } from "../state/ui";
import { ago, tildify } from "../lib/format";
import { mod } from "../lib/platform";
import { ModeIcon, MODES } from "./ModePicker";
import { Dialog } from "./ui/Dialog";

interface Entry {
    id: string;
    section: string;
    label: string;
    hint?: string;
    icon: JSX.Element;
    keywords?: string;
    run: () => void;
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
            { id: "panel", section: "Actions", label: "Toggle side panel", hint: `${mod} .`, icon: <PanelRight size={15} />, run: () => togglePanel() },
            { id: "settings", section: "Actions", label: "Settings", hint: `${mod} ,`, icon: <Settings size={15} />, run: () => setSettingsTab("general") },
            { id: "providers", section: "Actions", label: "Add an API key…", keywords: "providers login keys", icon: <Settings size={15} />, run: () => setSettingsTab("providers") },
        ];
        if (id()) {
            out.push(
                { id: "changes", section: "Session", label: "Show changes", icon: <PanelRight size={15} />, run: () => togglePanel("changes") },
                { id: "rewind", section: "Session", label: "Rewind…", icon: <History size={15} />, run: () => setRewindOpen(true) },
                { id: "compact", section: "Session", label: "Compact conversation", icon: <Shrink size={15} />, run: () => void rpc.call("session.compact", { id: id()! }).catch(reportError) },
                { id: "export", section: "Session", label: "Copy conversation as Markdown", icon: <Share size={15} />, run: () => void exportSession(id()!) },
                { id: "archive", section: "Session", label: "Archive session", icon: <Archive size={15} />, run: () => void archive(id()!, true) },
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
        return entries()
            .map((e) => ({ e, s: Math.max(score(query, e.label), score(query, e.keywords ?? "") * 0.6, score(query, e.hint ?? "") * 0.4) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 40)
            .map((x) => x.e);
    });

    createEffect(on(paletteOpen, (o) => o && (setQ(""), setSel(0))));
    createEffect(on(q, () => setSel(0), { defer: true }));

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
                <input autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Search sessions, projects and actions…" spellcheck={false} />
            </div>
            <div class="pal-list" ref={list}>
                <For each={results()} fallback={<div class="panel-empty">Nothing matches.</div>}>
                    {(e, i) => (
                        <>
                            <Show when={i() === 0 || results()[i() - 1]!.section !== e.section}>
                                <div class="pal-section">{e.section}</div>
                            </Show>
                            <button class={`pal-item ${sel() === i() ? "sel" : ""}`} onMouseMove={() => setSel(i())} onClick={() => runAt(i())}>
                                <span class="pal-icon">{e.icon}</span>
                                <span class="pal-label truncate">{e.label}</span>
                                <Show when={e.hint}>
                                    <span class="pal-hint truncate">{e.hint}</span>
                                </Show>
                            </button>
                        </>
                    )}
                </For>
            </div>
        </Dialog>
    );
}
