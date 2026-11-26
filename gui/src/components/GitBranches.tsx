// The session's branch in its title bar, with how far it is ahead of and behind its upstream (from what was last
// fetched: no network), and the branch dialog it opens: Fetch, Pull (fast-forward only), switch to a local or remote
// branch, or create one at HEAD. A chunk of its own: the title bar shows the plain branch until it's loaded.

import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { syncReadSkipped } from "../lib/branch-sync";
import { ArrowDown, ArrowUp, Check, CloudDownload, FolderGit2, GitBranch, GitPullRequest, Globe, Plus, Search } from "lucide-solid";
import type { GitBranchEntry, GitBranchList, GitPrListInfo, GitPrWorktree, GitSyncInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import type { SessionHandle } from "../state/app";
import { app, connFor, createSession, handleFor, homeAt, linkedMachine, requestTrust, rpc, setApp, toast, type HomeAt } from "../state/app";
import { changedOutside, refreshGitChanges, sessionReadReady } from "../state/changes";
import { withShortcut } from "../state/keybindings";
import { gitDialog, requestComposerFocus, setGitDialog } from "../state/ui";
import { ago, plural, tildify } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** Bumped after a fetch, pull, switch or new branch: every chip reads its counts again. */
const [moved, setMoved] = createSignal(0);
const afterGit = () => {
    setMoved((n) => n + 1);
    refreshGitChanges();
};

/**
 * The machine the dialog's folder is on, as it was when the dialog opened: the session's (another machine's, opened
 * here), else Home's. `link` takes its calls; a pull request's session is made there too.
 */
function folderAt(sessionId: string | undefined): HomeAt & { link: typeof rpc } {
    const home = homeAt();
    const at = sessionId === undefined ? home : { ...home, there: linkedMachine(sessionId) };
    return { ...at, link: at.there?.link ?? rpc };
}

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
    // Read when a turn ends (it may have committed), on coming back to the window, and after a Git action here: what
    // moves the counts. Not as a turn starts or as its edits land: uncommitted changes don't move them, and each read
    // is a git process on the server.
    // A signal, not a resource: the title bar's Suspense (for this chunk) would show the plain branch at each read.
    const [sync, setSync] = createSignal<GitSyncInfo>();
    let asked = 0;
    createEffect(on(
        () => sessionReadReady(p.handle) && { cwd: st().cwd, id: p.handle.id, branch: p.branch, busy: st().busy, outside: changedOutside(), moved: moved() },
        (k, was) => {
            if (!k) return;
            if (syncReadSkipped(k, was || undefined)) return;
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

/** A dialog for the folder of the session in front, or Home's. */
function openFor(kind: "branch" | "pr") {
    const h = handleFor(app.activeId);
    const cwd = h?.view.state.cwd ?? app.homeCwd;
    if (cwd) setGitDialog({ kind, cwd, ...(h ? { sessionId: h.id } : {}) });
    else toast("Choose a project folder first", "warn");
}
export const openBranches = () => openFor("branch");
export const openPullRequests = () => openFor("pr");

/** The dialogs opened from the branch chip, the palette and the keyboard (mounted by App while one is asked for). */
export function GitDialogs() {
    return (
        <Show when={gitDialog()} keyed>
            {(r) => (r.kind === "pr" ? <PrDialog cwd={r.cwd} sessionId={r.sessionId} query={r.query} start={r.start} /> : <BranchDialog cwd={r.cwd} sessionId={r.sessionId} query={r.query} />)}
        </Show>
    );
}

/** `label`: a branch's name (in the code font); `verb`, before it in the text's own: "Create branch". */
type Row = { key: string; label: string; verb?: string; desc?: string; end?: string; icon: "local" | "remote" | "current" | "create" | "worktree" | "pr"; run: () => void; disabled?: boolean };

/** The number of the pull request `s` names (#123, 123, or its github.com URL); git-pr.ts checks it again. */
function prRef(s: string): number | undefined {
    const m = /^#(\d{1,9})$/.exec(s.trim()) ?? /^(?:https?:\/\/)?(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d{1,9})(?:[/?#].*)?$/i.exec(s.trim());
    return m ? Number(m[1]) : undefined;
}

function BranchDialog(p: { cwd: string; sessionId?: string; query?: string }) {
    const [q, setQ] = createSignal(p.query ?? "");
    const [sel, setSel] = createSignal(0);
    const [busy, setBusy] = createSignal<"fetch" | "pull" | "switch" | undefined>();
    /** What the last action said: its outcome, or git's reason it couldn't. */
    const [note, setNote] = createSignal<{ text: string; level: "info" | "warn" | "error" }>();
    const where = { cwd: p.cwd, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
    // The folder's machine: another machine's session, or Home on one, is asked there.
    const { link: rpc } = folderAt(p.sessionId);
    const [sync, { mutate: setSync, refetch: refetchSync }] = createResource(() => connFor(p.sessionId) === "open" && moved() + 1, () => rpc.call("git.sync", where).catch(() => undefined));
    const [list, { refetch }] = createResource(
        () => connFor(p.sessionId) === "open",
        (): Promise<GitBranchList & { error?: string }> => rpc.call("git.branches", where).catch((e: unknown) => ({ local: [], remote: [], error: e instanceof Error ? e.message : String(e) })),
    );
    let input: HTMLInputElement | undefined;
    let listEl: HTMLDivElement | undefined;
    const close = () => !busy() && setGitDialog(undefined);
    /** Why `what` ("Can't pull") didn't happen: git's reason after it, so a blocked switch doesn't read as a blocked pull. */
    const failed = (what: string, e: unknown) => {
        const why = e instanceof Error ? e.message : String(e);
        setNote({ text: `${what}: ${/^[A-Z][a-z]/.test(why) ? why[0]!.toLowerCase() + why.slice(1) : why}`, level: "error" });
    };

    const act = async <T,>(kind: "fetch" | "pull" | "switch", what: string, work: () => Promise<T>, done: (r: T) => void) => {
        if (busy()) return;
        setBusy(kind);
        setNote(undefined);
        try {
            done(await work());
            afterGit();
        } catch (e) {
            failed(what, e);
        } finally {
            setBusy(undefined);
            input?.focus();
        }
    };
    const fetchNow = () =>
        act("fetch", "Can't fetch", () => rpc.call("git.fetch", where), (r) => {
            setSync(r);
            void refetch();
            setNote({ text: `Fetched ${r.remote}.`, level: "info" });
        });
    const pull = () =>
        act("pull", "Can't pull", () => rpc.call("git.pull", where), (r) => {
            void refetch();
            void refetchSync();
            if (r.result === "pulled") setNote({ text: `Pulled ${plural(r.pulled ?? r.behind, "commit")} from ${r.upstream}.`, level: "info" });
            else if (r.result === "current") setNote({ text: "Already up to date.", level: "info" });
            else setNote({ text: `Diverged from ${r.upstream}: merge or rebase in a terminal.`, level: "warn" });
        });
    const switchTo = (branch: string, remote?: boolean) =>
        act("switch", `Can't switch to ${branch}`, () => rpc.call("git.switch", { ...where, branch, ...(remote ? { remote } : {}) }), (r) => {
            setGitDialog(undefined);
            toast(r.created ? `Switched to new branch ${r.branch}` : `Switched to ${r.branch}`, "success");
        });
    const create = (name: string) =>
        act("switch", `Can't create ${name}`, () => rpc.call("git.createBranch", { ...where, name }), (r) => {
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
        const pr = prRef(q());
        if (pr) out.push({ key: "pr", label: `Work on pull request #${pr}`, desc: "In a new worktree", icon: "pr", run: () => setGitDialog({ kind: "pr", cwd: p.cwd, sessionId: p.sessionId, query: q().trim(), start: true }) });
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
        if (name && !pr && !l.local.some((b) => b.name === name)) out.push({ key: "create", verb: "Create branch", label: name, desc: `From ${l.current ?? "HEAD"}`, icon: "create", run: () => void create(name) });
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
    const group = (r: Row) => (r.icon === "remote" ? "Remote branches" : r.icon === "create" ? "New branch" : r.icon === "pr" ? "Pull request" : "Branches");
    const icon = (r: Row) => {
        switch (r.icon) {
            case "current": return <Check size={15} />;
            case "remote": return <Globe size={15} />;
            case "create": return <Plus size={15} />;
            case "worktree": return <FolderGit2 size={15} />;
            case "pr": return <GitPullRequest size={15} />;
            default: return <GitBranch size={15} />;
        }
    };

    return (
        <Dialog open onClose={close} bare top width={600} class="palette branch-dialog" labelledBy="branch-dialog-h">
            <h2 id="branch-dialog-h" class="sr-only">Switch branch</h2>
            <div class="pal-in">
                <Search size={17} class="pal-search" />
                <input ref={input} autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Switch or create a branch" aria-label="Branch" spellcheck={false} autocomplete="off" disabled={busy() === "switch"} />
                <Show when={busy() === "switch"}><Spinner size={13} class="muted" /></Show>
                <kbd>Esc</kbd>
            </div>
            <div class="br-sync">
                <GitBranch size={14} />
                <span class="br-sync-t truncate">
                    <b>{sync()?.branch ?? (sync()?.detached ? "Detached HEAD" : list()?.current ?? "")}</b>
                    <Show when={syncWords(sync())}>{(w) => <span class="muted"> · {w()}</span>}</Show>
                </span>
                <button class="btn sm" disabled={Boolean(busy())} onClick={() => void fetchNow()}>
                    <Show when={busy() === "fetch"} fallback={<CloudDownload size={14} />}><Spinner size={13} /></Show> Fetch
                </button>
                <button class="btn sm" disabled={Boolean(busy()) || !sync()?.upstream || sync()?.gone} onClick={() => void pull()} title={sync()?.upstream ? `Fast-forward to ${sync()!.upstream}` : "No upstream"}>
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
                                            <Show when={r.verb} fallback={<span class="pal-l mono">{r.label}</span>}>
                                                <span class="pal-l">{r.verb} “<span class="mono">{r.label}</span>”</span>
                                            </Show>
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

/** A new session in the pull request's worktree, its composer holding the pull request to work on. */
async function openPrSession(made: GitPrWorktree, at: HomeAt): Promise<void> {
    try {
        const h = await createSession(made.path, at);
        setApp("activeId", h.id);
        h.addDraft({ text: `Pull request #${made.pr.number}: ${made.pr.title}\n${made.pr.url}\n\n` });
        requestComposerFocus();
    } catch (e) {
        // The worktree has project configuration of its own: trusted first, then the session.
        if (e instanceof RpcError && e.code === "needs_trust") return requestTrust(made.path, () => void openPrSession(made, at), undefined, undefined, at.there?.link ?? rpc, at.there?.on);
        throw e;
    }
}

type PrRow = { key: string; label: string; desc?: string; end?: string; ref: string };

/** Work on a pull request: one of the open ones, or any by number or URL, checked out in a worktree with a new session there. */
function PrDialog(p: { cwd: string; sessionId?: string; query?: string; start?: boolean }) {
    const [q, setQ] = createSignal(p.query ?? "");
    const [sel, setSel] = createSignal(0);
    const [busy, setBusy] = createSignal<string>();
    const [failure, setFailure] = createSignal<{ text: string; code?: string; folder?: string; ref?: string }>();
    const where = { cwd: p.cwd, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
    // The folder's machine: the worktree and its session are made there.
    const at = folderAt(p.sessionId);
    const rpc = at.link;
    const [list, { refetch }] = createResource(
        () => connFor(p.sessionId) === "open",
        (): Promise<GitPrListInfo | undefined> =>
            rpc.call("git.pullRequests", where).catch((e: unknown) => {
                setFailure({ text: e instanceof Error ? e.message : String(e), code: e instanceof RpcError ? e.code : undefined });
                return undefined;
            }),
    );
    let input: HTMLInputElement | undefined;
    let listEl: HTMLDivElement | undefined;
    const close = () => !busy() && setGitDialog(undefined);
    // The session the sign-in card goes to: the one this was opened from, or the one in front.
    const signInSession = () => p.sessionId ?? app.activeId;

    const start = async (ref: string, trust?: string) => {
        if (busy()) return;
        setBusy(ref);
        setFailure(undefined);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            const made = await rpc.call("git.prWorktree", { ...where, pr: ref });
            setGitDialog(undefined);
            toast(made.reused ? `Opened #${made.pr.number} in ${made.branch}` : `Checked out #${made.pr.number} on ${made.branch}`, "success");
            afterGit();
            await openPrSession(made, at);
        } catch (e) {
            setFailure({ text: e instanceof Error ? e.message : String(e), code: e instanceof RpcError ? e.code : undefined, folder: e instanceof RpcError ? e.folder : undefined, ref });
        } finally {
            setBusy(undefined);
        }
    };
    if (p.start && p.query) void start(p.query.trim());
    // The session's own sign-in card takes it from here: this closes to let it show, and opens again once signed in.
    const signIn = async () => {
        const id = signInSession();
        if (!id) return;
        setGitDialog(undefined);
        try {
            if ((await rpc.call("session.askSignIn", { id, target: "gh" })) === "signed-in") setGitDialog({ kind: "pr", cwd: p.cwd, sessionId: p.sessionId, query: q() });
        } catch (e) {
            toast(e instanceof Error ? e.message : String(e), "error");
        }
    };

    const rows = createMemo<PrRow[]>(() => {
        const query = q().trim();
        const n = prRef(query) ?? (/^\d{1,9}$/.test(query) ? Number(query) : undefined);
        const words = query.toLowerCase();
        const out: PrRow[] = (list()?.prs ?? [])
            .filter((pr) => !words || pr.number === n || `#${pr.number} ${pr.title} ${pr.branch} ${pr.author}`.toLowerCase().includes(words))
            .map((pr) => ({
                key: String(pr.number),
                label: `#${pr.number} ${pr.title}`,
                desc: [pr.author, pr.branch, pr.draft ? "Draft" : "", pr.fork ? "From a fork" : ""].filter(Boolean).join(" · "),
                end: pr.updatedAt ? ago(pr.updatedAt) : undefined,
                ref: `#${pr.number}`,
            }));
        if (n !== undefined && !out.some((r) => r.key === String(n))) out.unshift({ key: `n${n}`, label: `Pull request #${n}`, ref: query });
        return out;
    });
    createEffect(on(rows, () => setSel(0)));
    const onKey = (e: KeyboardEvent) => {
        const n = rows().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => listEl?.querySelector(".pal-row.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const r = rows()[sel()];
            if (r) void start(r.ref);
        }
    };

    return (
        <Dialog open onClose={close} bare top width={600} class="palette branch-dialog" labelledBy="pr-dialog-h">
            <h2 id="pr-dialog-h" class="sr-only">Work on a pull request</h2>
            <div class="pal-in">
                <GitPullRequest size={17} class="pal-search" />
                <input ref={input} autofocus value={q()} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={onKey} placeholder="Pull request number, URL or title" aria-label="Pull request" spellcheck={false} autocomplete="off" disabled={Boolean(busy())} />
                <Show when={busy()}><Spinner size={13} class="muted" /></Show>
                <kbd>Esc</kbd>
            </div>
            <Show when={busy() && busy() !== "sign-in"}>
                <div class="br-note" role="status">Checking out {busy()!.startsWith("#") ? busy() : "the pull request"}…</div>
            </Show>
            <Show when={failure()}>
                {(f) => (
                    <div class="br-note error br-fail" role="alert">
                        <span>{f().text}<Show when={f().code === "sign_in" && !signInSession()}> Run <code>gh auth login</code> in a terminal.</Show></span>
                        <Show when={f().code === "sign_in" && signInSession()}>
                            <button class="btn sm" disabled={Boolean(busy())} onClick={() => void signIn()}>Sign in to GitHub</button>
                        </Show>
                        <Show when={f().code === "needs_trust" && f().folder && f().ref}>
                            <button class="btn sm" disabled={Boolean(busy())} onClick={() => void start(f().ref!, f().folder)}>Trust and continue</button>
                        </Show>
                    </div>
                )}
            </Show>
            <div class="pal-list" ref={listEl}>
                <Show when={!list.loading || list()} fallback={<div class="pal-empty">Loading pull requests…</div>}>
                    <Show when={list()}>{(l) => <div class="pal-h">Open in {l().repo}</div>}</Show>
                    <For each={rows()} fallback={<Show when={list()}><div class="pal-empty">{q().trim() ? "No match. Enter a number or URL." : "No open pull requests."}</div></Show>}>
                        {(r, i) => (
                            <button class={`pal-row ${sel() === i() ? "sel" : ""} ${r.desc ? "two" : ""}`} disabled={Boolean(busy())} onMouseMove={() => setSel(i())} onClick={() => void start(r.ref)}>
                                <span class="pal-ic"><GitPullRequest size={15} /></span>
                                <span class="pal-text">
                                    <span class="pal-l">{r.label}</span>
                                    <Show when={r.desc}><span class="pal-d">{r.desc}</span></Show>
                                </span>
                                <Show when={r.end}><span class="pal-end">{r.end}</span></Show>
                            </button>
                        )}
                    </For>
                </Show>
            </div>
        </Dialog>
    );
}
