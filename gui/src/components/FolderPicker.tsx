// The browser has no folder picker that reveals a path, so the GUI has its own,
// browsing the server's file system. (The desktop app uses the native one.)

import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { ArrowUp, Folder, Home as HomeIcon } from "lucide-solid";
import { app, rpc } from "../state/app";
import { folderPickerOpen, setFolderPickerOpen } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import "../styles/folder-picker.css";
import { Spinner } from "./ui/bits";

export function FolderPicker() {
    const [path, setPath] = createSignal("");
    const [typed, setTyped] = createSignal("");
    const [listing] = createResource(
        () => (app.conn === "open" && folderPickerOpen() ? path() || "~" : undefined),
        (p) => (folderPickerOpen()?.link ?? rpc).call("fs.dirs", { path: p }).catch(() => undefined),
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
    const foot = (
        <div class="dialog-actions">
            <span class="fpick-at mono truncate" title={listing()?.path}>
                {listing()?.path}
            </span>
            <button class="btn" onClick={close}>
                Cancel
            </button>
            <button class="btn primary" disabled={!listing()} onClick={() => choose(listing()!.path)}>
                {folderPickerOpen()?.action ?? "Open this folder"}
            </button>
        </div>
    );
    return (
        <Dialog open={Boolean(folderPickerOpen())} onClose={close} title={folderPickerOpen()?.title ?? "Open a project folder"} width={500} class="fpick" footer={foot}>
            <div class="fpick-bar">
                <button class="icon-btn" title="Home" aria-label="Home" onClick={() => setPath("~")}>
                    <HomeIcon size={15} />
                </button>
                <button class="icon-btn" title="Up" aria-label="Up" disabled={!listing()?.parent} onClick={() => listing()?.parent && setPath(listing()!.parent!)}>
                    <ArrowUp size={15} />
                </button>
                <input aria-label="Folder path" class="input mono fpick-path" value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && setPath(typed())} spellcheck={false} autocapitalize="off" />
            </div>
            <div class="fpick-list" role="list" aria-label="Folders">
                <Show when={!listing.loading} fallback={<Spinner />}>
                    <For each={listing()?.dirs} fallback={<p class="fpick-empty">No folders here.</p>}>
                        {(d) => (
                            <button class="fpick-row" onClick={() => setPath(`${listing()!.path}/${d}`)} onDblClick={() => choose(`${listing()!.path}/${d}`)}>
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
