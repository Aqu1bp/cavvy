import { createSignal } from "solid-js";
import { NO_SELECTION, type RailSelection } from "../lib/rail-select";

/** Published by the mounted sidebar after paging and interaction holds. */
export const [sidebarOrder, setSidebarOrder] = createSignal<string[] | undefined>();

/** The sessions picked in the rail (Shift- and ⌘-click), for its selection bar and bulk actions. */
export const [railSelection, setRailSelection] = createSignal<RailSelection>(NO_SELECTION);

/** After a bulk action: the ones it did leave the selection; the ones that failed stay picked. */
export function unselect(done: readonly string[]) {
    if (!done.length) return;
    const gone = new Set(done);
    setRailSelection((sel) => (sel.ids.some((id) => gone.has(id)) ? { ids: sel.ids.filter((id) => !gone.has(id)), anchor: sel.anchor } : sel));
}
