// Cavvy's own folder panel, everywhere (the desktop app too: never the system's), browsing the file system of the
// machine the folder is for. New folder makes one where it's looking, as the system's panel could.

import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowUp, Folder, FolderPlus, Home as HomeIcon } from "lucide-solid";
import { app, rpc } from "../state/app";
import { folderPickerOpen, setFolderPickerOpen } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import "../styles/folder-picker.css";

export function FolderPicker() {
    const [path, setPath] = createSignal("");
    const [typed, setTyped] = createSignal("");
    // New folder: the name being typed (undefined: not naming one), what went wrong, and whether it's being made.
    const [naming, setNaming] = createSignal<string>();
    const [nameError, setNameError] = createSignal<string>();
    const [making, setMaking] = createSignal(false);
    const link = () => folderPickerOpen()?.link ?? rpc;
    const [listing] = createResource(
        () => (app.conn === "open" && folderPickerOpen() ? path() || "~" : undefined),
        (p) => link().call("fs.dirs", { path: p }).catch(() => undefined),
    );
    const stopNaming = () => {
        setNaming(undefined);
        setNameError(undefined);
    };
    createEffect(
        on(folderPickerOpen, (o) => {
            stopNaming();
            if (o) setPath(o.start ?? (app.homeCwd ? app.homeCwd.replace(/\/[^/]+\/?$/, "") || "~" : "~"));
        }),
    );
    createEffect(on(listing, (l) => l && setTyped(l.path)));
    // Somewhere else: a name half-typed for the last folder isn't carried there.
    createEffect(on(path, stopNaming, { defer: true }));
    const choose = (p: string | undefined) => {
        const request = folderPickerOpen();
        setFolderPickerOpen(undefined);
        request?.then(p);
    };
    const close = () => choose(undefined);
    /** Made where it's looking, then gone into: "Open this folder" opens it. */
    const make = async () => {
        const where = listing()?.path;
        const name = naming()?.trim();
        if (!where || making()) return;
        if (!name) return stopNaming();
        setMaking(true);
        try {
            const made = await link().call("fs.mkdir", { path: where, name });
            stopNaming();
            setPath(made.path);
        } catch (e) {
            setNameError(e instanceof Error ? e.message : String(e));
        } finally {
            setMaking(false);
        }
    };
    return (
        <Dialog
            open={Boolean(folderPickerOpen())}
            // Escape while naming a new folder leaves the name, not the panel.
            onClose={() => (naming() !== undefined ? stopNaming() : close())}
            title={folderPickerOpen()?.title ?? "Open a project folder"}
            width={500}
            edge
            footer={
                <>
                    <button type="button" class="btn btn-ghost dlg-foot-left" disabled={!listing() || naming() !== undefined} onClick={() => setNaming("")}>
                        <FolderPlus size={14} />
                        New folder
                    </button>
                    <button type="button" class="btn" onClick={close}>
                        Cancel
                    </button>
                    <button type="button" class="btn btn-primary" disabled={!listing() || making()} onClick={() => choose(listing()!.path)}>
                        {folderPickerOpen()?.action ?? "Open this folder"}
                    </button>
                </>
            }
        >
            <div class="fpick-bar">
                <button type="button" class="icon-btn" aria-label="Home" title="Home" onClick={() => setPath("~")}>
                    <HomeIcon size={15} />
                </button>
                <button type="button" class="icon-btn" aria-label="Up" title="Up" disabled={!listing()?.parent} onClick={() => listing()?.parent && setPath(listing()!.parent!)}>
                    <ArrowUp size={15} />
                </button>
                <input autofocus aria-label="Folder path" class="input mono fpick-path" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && setPath(typed())} spellcheck={false} autocapitalize="off" />
            </div>
            <div class="fpick-list" role="listbox" aria-label="Folders">
                <Show when={naming() !== undefined}>
                    <div class="fpick-new">
                        <div class="fpick-row fpick-naming">
                            <FolderPlus size={15} />
                            <input
                                ref={(el) => requestAnimationFrame(() => el.focus())}
                                class="fpick-name"
                                aria-label="New folder name"
                                aria-invalid={Boolean(nameError()) || undefined}
                                placeholder="Folder name"
                                value={naming() ?? ""}
                                disabled={making()}
                                spellcheck={false}
                                autocapitalize="off"
                                onInput={(e) => (setNaming(e.currentTarget.value), setNameError(undefined))}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        void make();
                                    }
                                }}
                                onBlur={() => !making() && !naming()?.trim() && stopNaming()}
                            />
                        </div>
                        <Show when={nameError()}>{(m) => <p class="fpick-error" role="alert">{m()}</p>}</Show>
                    </div>
                </Show>
                <Show when={!listing.loading} fallback={<p class="fpick-empty">Loading…</p>}>
                    <For each={listing()?.dirs} fallback={<Show when={naming() === undefined}><p class="fpick-empty">No folders here.</p></Show>}>
                        {(d) => (
                            <button type="button" role="option" aria-selected={false} class="fpick-row" onClick={() => setPath(`${listing()!.path}/${d}`)} onDblClick={() => choose(`${listing()!.path}/${d}`)}>
                                <Folder size={15} />
                                <span class="truncate">{d}</span>
                            </button>
                        )}
                    </For>
                </Show>
            </div>
        </Dialog>
    );
}
