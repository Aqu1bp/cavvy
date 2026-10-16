// The browser has no folder picker that reveals a path, so the GUI has its own,
// browsing the server's file system. (The desktop app uses the native one.)

import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowUp, Folder, Home as HomeIcon } from "lucide-solid";
import { app, rpc } from "../state/app";
import { folderPickerOpen, setFolderPickerOpen } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function FolderPicker() {
    const [path, setPath] = createSignal("");
    const [typed, setTyped] = createSignal("");
    const [listing] = createResource(
        () => (folderPickerOpen() ? path() || "~" : undefined),
        (p) => rpc.call("fs.dirs", { path: p }).catch(() => undefined),
    );
    createEffect(
        on(folderPickerOpen, (o) => {
            if (o) setPath(o.start ?? (app.homeCwd ? app.homeCwd.replace(/\/[^/]+\/?$/, "") || "~" : "~"));
        }),
    );
    createEffect(on(listing, (l) => l && setTyped(l.path)));
    const choose = (p: string | undefined) => {
        const request = folderPickerOpen();
        setFolderPickerOpen(undefined);
        request?.then(p);
    };
    const close = () => choose(undefined);
    return (
        <Dialog open={Boolean(folderPickerOpen())} onClose={close} title={folderPickerOpen()?.title ?? "Open a project folder"} width={560}>
            <div class="fp-bar">
                <button class="icon-btn" title="Home" onClick={() => setPath("~")}>
                    <HomeIcon size={15} />
                </button>
                <button class="icon-btn" title="Up" disabled={!listing()?.parent} onClick={() => listing()?.parent && setPath(listing()!.parent!)}>
                    <ArrowUp size={15} />
                </button>
                <input class="input mono" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && setPath(typed())} spellcheck={false} />
            </div>
            <div class="fp-list">
                <Show when={!listing.loading} fallback={<Spinner />}>
                    <For each={listing()?.dirs} fallback={<div class="panel-empty">No folders here.</div>}>
                        {(d) => (
                            <button class="fp-item" onClick={() => setPath(`${listing()!.path}/${d}`)} onDblClick={() => choose(`${listing()!.path}/${d}`)}>
                                <Folder size={15} />
                                <span class="truncate">{d}</span>
                            </button>
                        )}
                    </For>
                </Show>
            </div>
            <div class="dialog-actions">
                <span class="muted small truncate">{listing()?.path}</span>
                <span class="grow" />
                <button class="btn ghost" onClick={close}>
                    Cancel
                </button>
                <button class="btn primary" disabled={!listing()} onClick={() => choose(listing()!.path)}>
                    {folderPickerOpen()?.action ?? "Open this folder"}
                </button>
            </div>
        </Dialog>
    );
}
