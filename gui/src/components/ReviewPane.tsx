// Reviewing what the agent changed: docked on the right, files on its left,
// the chosen file's diff beside them. Opened from the panel's Changes row or
// a turn's Review changes.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { FolderOpen, RefreshCw, X } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { reportError } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { review, setReview } from "../state/ui";
import { useChanges } from "../state/changes";
import { canReveal, revealPath } from "../lib/platform";
import { plural } from "../lib/format";
import { DiffView } from "./blocks/DiffView";
import { Segmented, Spinner } from "./ui/bits";

/** Kept while the app runs, so the pane opens the way you left it. */
const [split, setSplit] = createSignal(false);

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");
const nameOf = (path: string) => path.split("/").pop() ?? path;

export function ReviewPane(p: { handle: SessionHandle }) {
    const [changes, { refetch }] = useChanges(() => p.handle);
    const [picked, setPicked] = createSignal<string>();
    const files = () => changes()?.files ?? [];
    const file = createMemo(() => files().find((f) => f.path === picked()) ?? files()[0]);
    // Start on the file it was opened for; a new request moves there.
    createEffect(on(() => review()?.path, (path) => setPicked(path)));
    const absolute = (path: string) => (path.startsWith("/") ? path : `${p.handle.view.state.cwd}/${path}`);

    let dragStart = 0;
    let widthStart = 0;
    const onResize = (e: PointerEvent) => {
        dragStart = e.clientX;
        widthStart = prefs.reviewWidth;
        const move = (ev: PointerEvent) => setPrefs("reviewWidth", Math.round(Math.max(420, Math.min(1200, widthStart - (ev.clientX - dragStart)))));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    return (
        <section class="review" aria-label="Review changes">
            <div class="resize-handle left" onPointerDown={onResize} onDblClick={() => setPrefs("reviewWidth", 720)} />
            <div class="review-head" data-tauri-drag-region>
                <span class="review-title">Changes</span>
                <Show when={files().length}>
                    <span class="review-count">{plural(files().length, "file")}</span>
                    <span class="stat">
                        <span class="add">+{changes()!.added}</span>
                        <span class="del">−{changes()!.removed}</span>
                    </span>
                </Show>
                <span class="grow" data-tauri-drag-region />
                <Segmented
                    size="sm"
                    value={split() ? "split" : "unified"}
                    onChange={(v) => setSplit(v === "split")}
                    options={[
                        { value: "unified", label: "Unified" },
                        { value: "split", label: "Split" },
                    ]}
                />
                <Show when={canReveal && file()}>
                    <button class="hb" title="Reveal in Finder" aria-label="Reveal in Finder" onClick={() => void revealPath(absolute(file()!.path)).catch(reportError)}>
                        <FolderOpen size={16} />
                    </button>
                </Show>
                <button class="hb" title="Refresh" aria-label="Refresh" disabled={changes.loading} onClick={() => void refetch()}>
                    <Show when={changes.loading} fallback={<RefreshCw size={15} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
                <button class="hb" title="Close (Esc)" aria-label="Close review" onClick={() => setReview(undefined)}>
                    <X size={16} />
                </button>
            </div>
            <Show
                when={files().length}
                fallback={
                    <div class="review-empty">
                        <Show when={changes()} fallback={<Spinner size={16} />}>
                            {changes()!.tracked === false ? "This session isn't saved yet." : "No file changes yet. Edits the agent makes show up here as a reviewable diff."}
                        </Show>
                    </div>
                }
            >
                <div class="review-body">
                    <nav class="review-files" aria-label="Changed files">
                        <For each={files()}>
                            {(f) => (
                                <button class={`rf ${file()?.path === f.path ? "on" : ""}`} aria-current={file()?.path === f.path} title={f.path} onClick={() => setPicked(f.path)}>
                                    <span class="rf-text">
                                        <span class="rf-name mono truncate">{nameOf(f.path)}</span>
                                        <Show when={dirOf(f.path)}>
                                            <span class="rf-dir mono truncate">{dirOf(f.path)}</span>
                                        </Show>
                                    </span>
                                    <span class="stat rf-stat">
                                        <span class="add">+{f.added}</span>
                                        <span class="del">−{f.removed}</span>
                                    </span>
                                </button>
                            )}
                        </For>
                    </nav>
                    <div class="review-diff">
                        <Show when={file()} keyed>
                            {(f) => (
                                <>
                                    <div class="review-file-head">
                                        <span class="path truncate">{f.path}</span>
                                        <Show when={f.status !== "modified"}>
                                            <span class={`file-tag ${f.status}`}>{f.status === "added" ? "New file" : "Deleted"}</span>
                                        </Show>
                                        <span class="grow" />
                                        <span class="stat">
                                            <span class="add">+{f.added}</span>
                                            <span class="del">−{f.removed}</span>
                                        </span>
                                    </div>
                                    <DiffView diff={f} split={split()} />
                                </>
                            )}
                        </Show>
                    </div>
                </div>
                <div class="review-note">Changes made by the agent's edit tools in this session. Shell commands' changes aren't tracked.</div>
            </Show>
        </section>
    );
}
