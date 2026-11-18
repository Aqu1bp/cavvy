// The session's branch in its title bar, with how far it is ahead of and behind its upstream (from what was last
// fetched: no network), and the branch dialog it opens: Fetch, Pull (fast-forward only), switch to a local or remote
// branch, or create one at HEAD. A chunk of its own: the title bar shows the plain branch until it's loaded.

import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowDown, ArrowUp, Check, CloudDownload, FolderGit2, GitBranch, Globe, Plus, Search } from "lucide-solid";
import type { GitBranchEntry, GitBranchList, GitSyncInfo } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, handleFor, rpc, toast } from "../state/app";
import { changedOutside, refreshGitChanges, sessionReadReady } from "../state/changes";
import { withShortcut } from "../state/keybindings";
import { gitDialog, setGitDialog } from "../state/ui";
import { ago, plural, tildify } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** Bumped after a fetch, pull, switch or new branch: every chip reads its counts again. */
const [moved, setMoved] = createSignal(0);
const afterGit = () => {
    setMoved((n) => n + 1);
    refreshGitChanges();
};

/** "↑2 ↓3" as words, for the chip's label and the dialog. */
export function syncWords(s: GitSyncInfo | undefined): string {
    if (!s?.upstream) return s && !s.detached ? "No upstream" : "";
    if (s.gone) return `${s.upstream} is gone`;
    if (!s.ahead && !s.behind) return `Up to date with ${s.upstream}`;
    return `${s.upstream}: ${[s.ahead ? `${s.ahead} ahead` : "", s.behind ? `${s.behind} behind` : ""].filter(Boolean).join(", ")}`;
}

function Counts(p: { sync?: GitSyncInfo }) {
    return (
        <>
            <Show when={p.sync?.ahead}>{(n) => <span class="br-n"><ArrowUp size={11} />{n()}</span>}</Show>
            <Show when={p.sync?.behind}>{(n) => <span class="br-n"><ArrowDown size={11} />{n()}</span>}</Show>
        </>
    );
}

/** The title bar's branch: a button that opens the branch dialog, with the upstream counts beside the name. */
export function BranchChip(p: { handle: SessionHandle; branch: string }) {
    const st = () => p.handle.view.state;
    // Read when a turn starts or ends, as edits land, on coming back to the window, and after a Git action here.
    // A signal, not a resource: the title bar's Suspense (for this chunk) would show the plain branch at each read.
    const [sync, setSync] = createSignal<GitSyncInfo>();
    let asked = 0;
    createEffect(on(
        () => sessionReadReady(p.handle) && { cwd: st().cwd, id: p.handle.id, branch: p.branch, n: st().filesChanged, busy: st().busy, outside: changedOutside(), moved: moved() },
        (k) => {
            if (!k) return;
            const mine = ++asked;
            void rpc.call("git.sync", { cwd: k.cwd, sessionId: k.id }).then((r) => mine === asked && setSync(r), () => mine === asked && setSync(undefined));
        },
    ));
    const words = () => syncWords(sync());
    return (
        <button
            class="br br-btn"
            title={withShortcut(`${p.branch}${words() ? ` · ${words()}` : ""}. Switch branch`, "app:switchBranch")}
            aria-label={`Branch ${p.branch}${words() ? `, ${words()}` : ""}. Switch branch`}
            onClick={() => setGitDialog({ kind: "branch", cwd: st().cwd, sessionId: p.handle.id })}
        >
            <GitBranch size={13} />
            <span class="truncate">{p.branch}</span>
            <Counts sync={sync()} />
        </button>
    );
}

/** The branch dialog, for the folder of the session in front, or Home's. */
export function openBranches() {
    const h = handleFor(app.activeId);
    const cwd = h?.view.state.cwd ?? app.homeCwd;
    if (cwd) setGitDialog({ kind: "branch", cwd, ...(h ? { sessionId: h.id } : {}) });
}

/** The dialogs opened from the branch chip, the palette and the keyboard (mounted by App while one is asked for). */
export function GitDialogs() {
    return <Show when={gitDialog()} keyed>{(r) => <BranchDialog cwd={r.cwd} sessionId={r.sessionId} query={r.query} />}</Show>;
}

type Row = { key: string; label: string; desc?: string; end?: string; icon: "local" | "remote" | "current" | "create" | "worktree"; run: () => void; disabled?: boolean };

function BranchDialog(p: { cwd: string; sessionId?: string; query?: string }) {
    const [q, setQ] = createSignal(p.query ?? "");
    const [sel, setSel] = createSignal(0);
    const [busy, setBusy] = createSignal<"fetch" | "pull" | "switch" | undefined>();
    /** What the last action said: its outcome, or git's reason it couldn't. */
    const [note, setNote] = createSignal<{ text: string; level: "info" | "warn" | "error" }>();
    const where = { cwd: p.cwd, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
    const [sync, { mutate: setSync, refetch: refetchSync }] = createResource(() => app.conn === "open" && moved() + 1, () => rpc.call("git.sync", where).catch(() => undefined));
    const [list, { refetch }] = createResource(
        () => app.conn === "open",
        (): Promise<GitBranchList & { error?: string }> => rpc.call("git.branches", where).catch((e: unknown) => ({ local: [], remote: [], error: e instanceof Error ? e.message : String(e) })),
    );
    let input: HTMLInputElement | undefined;
    let listEl: HTMLDivElement | undefined;
    const close = () => !busy() && setGitDialog(undefined);
    const failed = (e: unknown) => setNote({ text: e instanceof Error ? e.message : String(e), level: "error" });

    const act = async <T,>(kind: "fetch" | "pull" | "switch", work: () => Promise<T>, done: (r: T) => void) => {
        if (busy()) return;
        setBusy(kind);
        setNote(undefined);
        try {
            done(await work());
            afterGit();
        } catch (e) {
            failed(e);
        } finally {
            setBusy(undefined);
            input?.focus();
        }
    };
    const fetchNow = () =>
        act("fetch", () => rpc.call("git.fetch", where), (r) => {
            setSync(r);
            void refetch();
            setNote({ text: `Fetched ${r.remote}. ${syncWords(r)}.`, level: "info" });
        });
    const pull = () =>
        act("pull", () => rpc.call("git.pull", where), (r) => {
            void refetch();
            void refetchSync();
            if (r.result === "pulled") setNote({ text: `Pulled ${plural(r.pulled ?? r.behind, "commit")} from ${r.upstream}.`, level: "info" });
            else if (r.result === "current") setNote({ text: `Already up to date with ${r.upstream}.`, level: "info" });
            else setNote({ text: `Diverged: ${r.ahead} ahead, ${r.behind} behind ${r.upstream}. Merge or rebase it in a terminal.`, level: "warn" });
        });
    const switchTo = (branch: string, remote?: boolean) =>
        act("switch", () => rpc.call("git.switch", { ...where, branch, ...(remote ? { remote } : {}) }), (r) => {
            setGitDialog(undefined);
            toast(r.created ? `Switched to new branch ${r.branch}` : `Switched to ${r.branch}`, "success");
        });
    const create = (name: string) =>
        act("switch", () => rpc.call("git.createBranch", { ...where, name }), (r) => {
            setGitDialog(undefined);
            toast(`Created ${r.branch}`, "success");
        });

    const rows = createMemo<Row[]>(() => {
        const l = list();
        if (!l) return [];
        const query = q().trim().toLowerCase();
        const match = (b: GitBranchEntry) => !query || b.name.toLowerCase().includes(query);
        const when = (b: GitBranchEntry) => (b.at ? ago(b.at) : undefined);
        const out: Row[] = [];
        for (const b of l.local.filter(match)) {
            const current = b.name === l.current;
            out.push({
                key: `l:${b.name}`,
                label: b.name,
                desc: current ? "Current branch" : b.worktree ? `Checked out in ${tildify(b.worktree, app.hello?.homeDir)}` : b.upstream,
                end: when(b),
                icon: current ? "current" : b.worktree ? "worktree" : "local",
                disabled: current || Boolean(b.worktree),
                run: () => void switchTo(b.name),
            });
        }
        // A remote branch whose local one is listed is the same choice, once.
        const tracked = new Set(l.local.map((b) => b.upstream).filter(Boolean));
        for (const b of l.remote.filter((b) => match(b) && !tracked.has(b.name))) out.push({ key: `r:${b.name}`, label: b.name, end: when(b), icon: "remote", run: () => void switchTo(b.name, true) });
        const name = q().trim();
        if (name && !l.local.some((b) => b.name === name)) out.push({ key: "create", label: `Create branch “${name}”`, desc: `From ${l.current ?? "HEAD"}`, icon: "create", run: () => void create(name) });
        return out;
    });
    // On the first row that can be picked (not the current branch), for each new query and new list.
    createEffect(on(rows, (r) => setSel(Math.max(0, r.findIndex((x) => !x.disabled)))));
    const runAt = (i: number) => {
        const r = rows()[i];
        if (r && !r.disabled) r.run();
    };
    const onKey = (e: KeyboardEvent) => {
        const n = rows().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            const step = e.key === "ArrowDown" ? 1 : -1;
            setSel((s) => {
                for (let i = 1; i <= n; i++) if (!rows()[(s + step * i + n * i) % n]!.disabled) return (s + step * i + n * i) % n;
                return s;
            });
            requestAnimationFrame(() => listEl?.querySelector(".pal-row.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            runAt(sel());
        }
    };
    const group = (r: Row) => (r.icon === "remote" ? "Remote branches" : r.icon === "create" ? "New branch" : "Branches");
    const icon = (r: Row) => {
        switch (r.icon) {
            case "current": return <Check size={15} />;
            case "remote": return <Globe size={15} />;
            case "create": return <Plus size={15} />;
            case "worktree": return <FolderGit2 size={15} />;
            default: return <GitBranch size={15} />;
        }
    };

    return (
        <Dialog open onClose={close} bare top width={600} class="palette branch-dialog" labelledBy="branch-dialog-h">
            <h2 id="branch-dialog-h" class="sr-only">Switch branch</h2>
            <div class="pal-in">
                <Search size={17} class="pal-search" />
                <input ref={input} autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Switch to a branch, or name a new one" aria-label="Branch" spellcheck={false} autocomplete="off" disabled={busy() === "switch"} />
                <Show when={busy() === "switch"}><Spinner size={13} class="muted" /></Show>
                <kbd>Esc</kbd>
            </div>
            <div class="br-sync">
                <GitBranch size={14} />
                <span class="br-sync-t truncate">
                    <b>{sync()?.branch ?? (sync()?.detached ? "Detached HEAD" : list()?.current ?? "")}</b>
                    <Show when={syncWords(sync())}>{(w) => <span class="muted"> · {w()}</span>}</Show>
                </span>
                <button class="btn sm" disabled={Boolean(busy())} onClick={() => void fetchNow()} title="Fetch from the remote">
                    <Show when={busy() === "fetch"} fallback={<CloudDownload size={14} />}><Spinner size={13} /></Show> Fetch
                </button>
                <button class="btn sm" disabled={Boolean(busy()) || !sync()?.upstream || sync()?.gone} onClick={() => void pull()} title={sync()?.upstream ? `Fast-forward to ${sync()!.upstream}` : "This branch has no upstream"}>
                    <Show when={busy() === "pull"} fallback={<ArrowDown size={14} />}><Spinner size={13} /></Show> Pull
                </button>
            </div>
            <Show when={note()}>{(n) => <div class={`br-note ${n().level}`} role={n().level === "info" ? "status" : "alert"}>{n().text}</div>}</Show>
            <div class="pal-list" ref={listEl}>
                <Show when={!list.loading || list()} fallback={<div class="pal-empty">Loading branches…</div>}>
                    <Show when={!list()?.error} fallback={<div class="pal-empty">{list()?.error}</div>}>
                        <For each={rows()} fallback={<div class="pal-empty">No branch matches.</div>}>
                            {(r, i) => (
                                <>
                                    <Show when={i() === 0 || group(rows()[i() - 1]!) !== group(r)}>
                                        <div class="pal-h">{group(r)}</div>
                                    </Show>
                                    <button class={`pal-row ${sel() === i() ? "sel" : ""} ${r.desc ? "two" : ""}`} disabled={r.disabled || Boolean(busy())} onMouseMove={() => setSel(i())} onClick={() => runAt(i())}>
                                        <span class="pal-ic">{icon(r)}</span>
                                        <span class="pal-text">
                                            <span class="pal-l mono">{r.label}</span>
                                            <Show when={r.desc}><span class="pal-d">{r.desc}</span></Show>
                                        </span>
                                        <Show when={r.end}><span class="pal-end">{r.end}</span></Show>
                                    </button>
                                </>
                            )}
                        </For>
                    </Show>
                </Show>
            </div>
        </Dialog>
    );
}
