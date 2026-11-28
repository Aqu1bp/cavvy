// Go to file (⌘P) and Search in project (⌘⇧F): one dialog over the session, in the command palette's shape. Loaded
// when first opened; nothing is asked of the server until it is, and a search only once something's typed.
//
// Go to file: the session's files (as the composer's @ lists them) best matching what's typed; "path:12" opens at
// line 12. Search in project: text in the session's folder, by file, with the line each match is on. On a row,
// Enter opens the file viewer, ⌥Enter the editor, ⌘Enter adds the file to the message as an @-mention.

import { batch, createEffect, createMemo, createRoot, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { CaseSensitive, File, Regex, Search, WholeWord } from "lucide-solid";
import type { ProjectSearchResult, SearchHit } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { openInEditor } from "../state/actions";
import { settingsTab } from "../state/ui";
import { actionOf } from "../state/keybindings";
import { dirOf, nameOf } from "../lib/inspector";
import { addToChat, altKey, viewFile, withLine } from "../lib/file-view";
import { isMod, mod } from "../lib/platform";
import { Dialog } from "./ui/Dialog";
import { tip } from "../lib/tip";
import { Spinner } from "./ui/bits";
import "../styles/finder.css";

/** Which is open, if either. */
const [finderOpen, setFinderOpen] = createSignal<"files" | "search">();
let mounted = false;

/**
 * Go to file or Search in project, over the session on screen (the same again closes it). Put in the window the first
 * time (this module is loaded then, state/ui.ts openFinder), and kept: closed, it's an empty dialog.
 */
export function openFinder(mode: "files" | "search") {
    if (!app.activeId || settingsTab()) return;
    if (!mounted) {
        mounted = true;
        const host = document.body.appendChild(document.createElement("div"));
        host.className = "finder-host";
        render(() => <FileFinder />, host);
        // Another session, or Settings: it's closed (it was about the session on screen).
        createRoot(() => createEffect(on([() => app.activeId, settingsTab], () => setFinderOpen(undefined), { defer: true })));
    }
    setFinderOpen(finderOpen() === mode ? undefined : mode);
}

/** A row the keys move over: a file (Go to file), or a line a search found. */
type Row = { path: string; line?: number; hit?: SearchHit };

/** Files asked for (the server caps it too). */
const FILES = 50;

/** What a row's keys and clicks do: open it in the viewer, the editor, or add it to the message. */
function act(sessionId: string, row: Row, how: "view" | "editor" | "chat") {
    setFinderOpen(undefined);
    if (how === "view") viewFile(row.path, row.line);
    else if (how === "editor") void openInEditor(row.path, row.line, { sessionId });
    // Once the dialog has given focus back to where it was: the input takes it then.
    else queueMicrotask(() => addToChat(row.path));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const howOf = (e: KeyboardEvent | MouseEvent) => (e.altKey ? "editor" : isMod(e) ? "chat" : "view");

/** The line, its matches marked. */
function Preview(p: { hit: SearchHit }) {
    const parts = createMemo(() => {
        const { text, ranges } = p.hit.preview;
        const out: { t: string; m?: boolean }[] = [];
        let at = 0;
        for (const [a, b] of ranges) {
            if (a < at) continue;
            if (a > at) out.push({ t: text.slice(at, a) });
            out.push({ t: text.slice(a, b), m: true });
            at = b;
        }
        out.push({ t: text.slice(at) });
        // Its indentation isn't worth the room.
        if (out[0] && !out[0].m) out[0].t = out[0].t.trimStart();
        return out;
    });
    return (
        <>
            <Show when={p.hit.preview.from}>…</Show>
            <For each={parts()}>{(x) => (x.m ? <mark>{x.t}</mark> : x.t)}</For>
        </>
    );
}

function FileFinder() {
    const sessionId = () => app.activeId;
    const mode = () => finderOpen();
    const close = () => setFinderOpen(undefined);
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const [caseSensitive, setCase] = createSignal(false);
    const [wholeWord, setWord] = createSignal(false);
    const [regex, setRegex] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    const [paths, setPaths] = createSignal<string[]>([]);
    const [found, setFound] = createSignal<ProjectSearchResult>();
    /** Enter pressed before what was typed had its answer: it acts on the answer's first row once it comes. */
    let enterWaits: "view" | "editor" | "chat" | undefined;
    const answered = () => {
        const how = enterWaits;
        enterWaits = undefined;
        if (how) queueMicrotask(() => run(0, how));
    };
    let list: HTMLDivElement | undefined;
    let input: HTMLInputElement | undefined;

    // Each mode starts empty; what was typed in the other one isn't carried over.
    createEffect(on(mode, (m) => {
        if (!m) return;
        batch(() => {
            setQ("");
            setSel(0);
            setError(undefined);
            setPaths([]);
            setFound(undefined);
        });
        queueMicrotask(() => input?.focus());
    }));

    // Asked once typing pauses; a newer ask makes an older answer moot (and the server stops the older search).
    let asked = 0;
    let wait: ReturnType<typeof setTimeout> | undefined;
    let searching = false;
    const stopSearch = () => {
        if (!searching) return;
        searching = false;
        void rpc.call("fs.searchCancel", { sessionId: sessionId() }).catch(() => undefined);
    };
    createEffect(on([mode, q, caseSensitive, wholeWord, regex], ([m, raw, cs, ww, re]) => {
        clearTimeout(wait);
        enterWaits = undefined;
        const mine = ++asked;
        const id = sessionId();
        if (!m || !id) return;
        if (m === "files") {
            const { query } = withLine(raw.trim());
            setBusy(true);
            // Typed quickly: asked once per pause. Empty: at once (the shortest paths first).
            wait = setTimeout(() => {
                rpc.call("fs.files", { sessionId: id, query, limit: FILES }).then(
                    (r) => {
                        if (mine !== asked) return;
                        batch(() => (setPaths(r.paths), setError(undefined), setSel(0)));
                        answered();
                    },
                    (e) => mine === asked && setError(errorText(e)),
                ).finally(() => mine === asked && setBusy(false));
            }, query ? 40 : 0);
            return;
        }
        if (!raw) {
            stopSearch();
            batch(() => (setFound(undefined), setError(undefined), setBusy(false)));
            return;
        }
        setBusy(true);
        wait = setTimeout(() => {
            searching = true;
            rpc.call("fs.search", { sessionId: id, query: raw, caseSensitive: cs, wholeWord: ww, regex: re }).then(
                (r) => {
                    if (mine !== asked || r.cancelled) return;
                    batch(() => (setFound(r), setError(undefined), setSel(0)));
                    answered();
                },
                (e) => mine === asked && batch(() => (setFound(undefined), setError(errorText(e)))),
            ).finally(() => {
                if (mine !== asked) return;
                searching = false;
                setBusy(false);
            });
        }, 250);
    }));
    onCleanup(() => {
        clearTimeout(wait);
        stopSearch();
    });
    createEffect(on(mode, (m) => !m && (clearTimeout(wait), stopSearch()), { defer: true }));

    /** The rows the keys go through, in order. */
    const rows = createMemo<Row[]>(() => {
        if (mode() === "files") {
            const line = withLine(q().trim()).line;
            return paths().map((path) => ({ path, line }));
        }
        return (found()?.files ?? []).flatMap((f) => f.hits.map((hit) => ({ path: f.path, line: hit.line, hit })));
    });
    const run = (i: number, how: "view" | "editor" | "chat") => {
        const r = rows()[i];
        const id = sessionId();
        if (r && id) act(id, r, how);
    };
    const onKey = (e: KeyboardEvent) => {
        // ⌘P and ⌘⇧F go from one to the other while it's open (the window's keys don't reach past a dialog).
        const global = actionOf(e, ["Global"]);
        if (global === "app:goToFile" || global === "app:searchFiles") {
            e.preventDefault();
            const to = global === "app:goToFile" ? "files" : "search";
            return to === mode() ? close() : setFinderOpen(to);
        }
        if (mode() === "search" && e.altKey && !isMod(e) && /^Key[CWR]$/.test(e.code)) {
            e.preventDefault();
            ({ KeyC: () => setCase((v) => !v), KeyW: () => setWord((v) => !v), KeyR: () => setRegex((v) => !v) })[e.code as "KeyC"]();
            return;
        }
        const n = rows().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".pal-row[data-active]")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (busy()) enterWaits = howOf(e);
            else run(sel(), howOf(e));
        }
    };

    const summary = () => {
        const r = found();
        if (!r) return undefined;
        const skipped = r.skippedLarge ? ` · ${r.skippedLarge.toLocaleString()} large ${r.skippedLarge === 1 ? "file" : "files"} skipped` : "";
        if (!r.matches) return (r.timedOut || r.truncated ? "Stopped early: narrow the search" : "No results") + skipped;
        const n = `${r.matches.toLocaleString()}${r.truncated ? "+" : ""} ${r.matches === 1 ? "result" : "results"} in ${r.files.length.toLocaleString()} ${r.files.length === 1 ? "file" : "files"}`;
        return (r.timedOut ? `${n} · timed out` : n) + skipped;
    };
    const Toggle = (p: { on: boolean; set: (v: boolean) => void; name: string; key: string; icon: typeof Regex }) => (
        <button class="icon-btn ff-tog" aria-pressed={p.on} aria-label={p.name} {...tip(p.name, `${altKey.replace("+", "")}+${p.key}`)} onClick={() => (p.set(!p.on), input?.focus())}>
            <p.icon size={15} />
        </button>
    );

    const Option = (q: { i: number; class?: string; children: JSX.Element }) => (
        <button
            role="option"
            aria-selected={sel() === q.i}
            data-active={sel() === q.i || undefined}
            class={`pal-row ${q.class ?? ""}`}
            onMouseMove={() => setSel(q.i)}
            onClick={(e) => run(q.i, howOf(e))}
        >
            {q.children}
        </button>
    );

    return (
        <Dialog open={Boolean(mode())} onClose={close} bare top width={mode() === "search" ? 760 : 620} class="palette finder" labelledBy="finder-h">
            <h2 id="finder-h" class="sr-only">{mode() === "files" ? "Go to file" : "Search in project"}</h2>
            <div class="pal-input">
                <Show when={mode() === "files"} fallback={<Search size={15} class="pal-input-icon" />}>
                    <File size={15} class="pal-input-icon" />
                </Show>
                <input
                    ref={input}
                    autofocus
                    value={q()}
                    onInput={(e) => setQ(e.currentTarget.value)}
                    onKeyDown={onKey}
                    placeholder={mode() === "files" ? "Go to file" : "Search in project"}
                    aria-label={mode() === "files" ? "Go to file" : "Search in project"}
                    spellcheck={false}
                    autocomplete="off"
                />
                <Show when={busy()}>
                    <Spinner size={12} />
                </Show>
                <Show when={mode() === "search"}>
                    <Toggle on={caseSensitive()} set={setCase} name="Match case" key="C" icon={CaseSensitive} />
                    <Toggle on={wholeWord()} set={setWord} name="Whole word" key="W" icon={WholeWord} />
                    <Toggle on={regex()} set={setRegex} name="Regular expression" key="R" icon={Regex} />
                </Show>
                <span class="kbd-group" aria-hidden="true"><kbd class="kbd">esc</kbd></span>
            </div>
            <div class="pal-list" ref={list} role="listbox" aria-label={mode() === "files" ? "Files" : "Results"}>
                <Show
                    when={mode() === "files"}
                    fallback={
                        <For each={found()?.files ?? []} fallback={<Show when={!busy() && !error() && found()}><div class="pal-empty">{summary()}</div></Show>}>
                            {(f) => {
                                // The rows' index: the file's hits follow the rows of the files before it.
                                const first = createMemo(() => rows().findIndex((r) => r.path === f.path));
                                return (
                                    <div class="pal-group">
                                        <div class="pal-head ff-file" title={f.path}>
                                            <span class="ff-name">{nameOf(f.path)}</span>
                                            <span class="pal-meta">{dirOf(f.path)}</span>
                                            <span class="ff-count">{f.hits.length}{f.more ? "+" : ""}</span>
                                        </div>
                                        <For each={f.hits}>
                                            {(hit, i) => (
                                                <Option i={first() + i()} class="ff-hit">
                                                    <span class="ff-ln">{hit.line}</span>
                                                    <span class="pal-label ff-pre">
                                                        <Preview hit={hit} />
                                                    </span>
                                                </Option>
                                            )}
                                        </For>
                                    </div>
                                );
                            }}
                        </For>
                    }
                >
                    <For each={rows()} fallback={<Show when={!busy() && !error()}><div class="pal-empty">No matching files</div></Show>}>
                        {(r, i) => (
                            <Option i={i()}>
                                <span class="pal-label">{nameOf(r.path)}</span>
                                <Show when={dirOf(r.path)}>
                                    <span class="pal-meta">{dirOf(r.path)}</span>
                                </Show>
                            </Option>
                        )}
                    </For>
                </Show>
            </div>
            <Show when={error()}>
                <div class="pal-foot selectable" data-tone="error" role="alert"><span class="pal-foot-text">{error()}</span></div>
            </Show>
            <Show when={rows().length}>
                <div class="pal-foot">
                    <Show when={mode() === "search" && summary()}>
                        <span class="pal-foot-text truncate" role="status">{summary()}</span>
                    </Show>
                    <span class="ff-keys" aria-hidden="true">
                        <span><kbd class="kbd">↵</kbd> Open</span>
                        <span><span class="kbd-group"><kbd class="kbd">{altKey.replace("+", "")}</kbd><kbd class="kbd">↵</kbd></span> Open in editor</span>
                        <span><span class="kbd-group"><kbd class="kbd">{mod}</kbd><kbd class="kbd">↵</kbd></span> Add to chat</span>
                        <Show when={mode() === "files"}><span><kbd class="kbd">:</kbd> Go to line</span></Show>
                    </span>
                </div>
            </Show>
        </Dialog>
    );
}
